import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { getDb } from '../../infrastructure/db/index.ts';
import {
  getActiveLLMProvider,
  getGeminiHealthWarning,
  resetGeminiCircuitBreaker,
} from '../../infrastructure/llm/LLMProvider.ts';
import { getStorageAdapter } from '../../infrastructure/storage/StorageAdapter.ts';
import {
  requireAuth,
  requirePermission,
  requireSuperAdmin,
  validateBody,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';

const UpdateSettingsSchema = z.object({
  'llm.provider': z.enum(['gemini', 'claude', 'disabled']).optional(),
  'llm.gemini_model': z.string().min(2).max(100).optional(),
  'llm.claude_model': z.string().min(2).max(100).optional(),
  'phone.default_region': z.string().length(2).toUpperCase().optional(),
  'upload.max_mb': z.number().int().min(1).max(200).optional(),
  'retention.uploads_days': z.number().int().min(7).max(3650).optional(),
  'retention.exports_days': z.number().int().min(1).max(365).optional(),
  'dedupe.name_similarity_threshold': z.number().min(0.5).max(1.0).optional(),
  'dedupe.address_similarity_threshold': z.number().min(0.5).max(1.0).optional(),
});

const PurgeSchema = z.object({
  dryRun: z.boolean().default(true),
});

export class SettingsService {
  async getAll(): Promise<Record<string, unknown>> {
    const db = getDb();
    const res = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key NOT LIKE 'auth.%'`
    );
    const out: Record<string, unknown> = {};
    for (const row of res.rows) {
      out[row.key] = row.value;
    }
    out['_runtime'] = {
      storageDriver: getStorageAdapter().driverName,
      dbEngine: db.engineLabel,
      geminiKeyConfigured: Boolean(env.geminiApiKey),
      claudeKeyConfigured: Boolean(env.anthropicApiKey),
      llmWarning: getGeminiHealthWarning(),
      vercelEphemeralWarning: env.isVercel && !env.databaseUrl && !env.hasExplicitSessionSecret,
    };
    return out;
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const db = getDb();
    const res = await db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1 LIMIT 1', [key]);
    return res.rows[0]?.value ?? fallback;
  }

  async updateMany(patch: Record<string, unknown>, actorId: string) {
    const db = getDb();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k.startsWith('auth.')) continue;
      await db.query(
        `INSERT INTO settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = NOW()`,
        [k, JSON.stringify(v), actorId]
      );
    }
    return this.getAll();
  }

  async purgeExpiredData(dryRun: boolean) {
    const db = getDb();
    const uploadsDays = Number(await this.getSetting<number>('retention.uploads_days', 365));
    const exportsDays = Number(await this.getSetting<number>('retention.exports_days', 30));

    const uploadsToPurgeRes = await db.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM uploads
       WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - ($1 || ' days')::interval`,
      [String(uploadsDays)]
    );

    const recordsToPurgeRes = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM clean_records
       WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - ($1 || ' days')::interval`,
      [String(uploadsDays)]
    );

    const exportsToPurgeRes = await db.query<{ id: string; storage_key: string | null }>(
      `SELECT id, storage_key FROM exports
       WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(exportsDays)]
    );

    if (!dryRun) {
      const storage = getStorageAdapter();
      for (const up of uploadsToPurgeRes.rows) {
        try {
          await storage.deleteObject(up.storage_key);
        } catch {
          // Continue cleanup
        }
        await db.query('DELETE FROM uploads WHERE id = $1', [up.id]);
      }

      await db.query(
        `DELETE FROM clean_records
         WHERE deleted_at IS NOT NULL
           AND deleted_at < NOW() - ($1 || ' days')::interval`,
        [String(uploadsDays)]
      );

      for (const ex of exportsToPurgeRes.rows) {
        if (ex.storage_key) {
          try {
            await storage.deleteObject(ex.storage_key);
          } catch {
            // Continue cleanup
          }
        }
        await db.query('DELETE FROM exports WHERE id = $1', [ex.id]);
      }
    }

    return {
      dryRun,
      retentionDays: { uploadsDays, exportsDays },
      purgedUploads: uploadsToPurgeRes.rows.length,
      purgedRecords: Number(recordsToPurgeRes.rows[0]?.count || 0),
      purgedExports: exportsToPurgeRes.rows.length,
    };
  }
}

export const settingsService = new SettingsService();

export function createSettingsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', requirePermission('view'), async (_req, res, next) => {
    try {
      const settings = await settingsService.getAll();
      res.json({ settings });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/', requirePermission('manage_settings'), validateBody(UpdateSettingsSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      resetGeminiCircuitBreaker();
      const updated = await settingsService.updateMany(req.body, req.authUser!.id);
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'SETTINGS_UPDATE',
        resourceType: 'settings',
        req,
        metadata: { updatedKeys: Object.keys(req.body) },
      });
      res.json({ settings: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/test-llm', requirePermission('manage_settings'), async (_req, res, next) => {
    try {
      const provider = await getActiveLLMProvider();
      const result = await provider.testConnection();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/retention/purge', requireSuperAdmin, validateBody(PurgeSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const summary = await settingsService.purgeExpiredData(req.body.dryRun);
      if (!req.body.dryRun) {
        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'RETENTION_PURGE',
          resourceType: 'retention',
          req,
          metadata: summary,
        });
      }
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
