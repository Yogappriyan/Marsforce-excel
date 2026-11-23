import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../infrastructure/db/index.ts';
import { requireAuth, requirePermission, type AuthenticatedRequest, type UserRole } from '../../middleware/security.ts';

const PII_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'sessiontoken',
  'secret',
  'authorization',
  'email',
  'actor_email',
  'raw_data',
  'rawdata',
  'fullname',
  'full_name',
  'phone',
  'phone_e164',
  'phone_display',
  'consumer_id',
  'pin_code',
  'address',
  'street',
]);

function redactPii(input: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (PII_KEYS.has(k.toLowerCase())) {
      clean[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      clean[k] = redactPii(v as Record<string, unknown>);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export interface AuditInput {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  req?: AuthenticatedRequest | { ip?: string; headers?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
}

export class AuditRepository {
  async insert(input: AuditInput) {
    const db = getDb();
    const ip = input.req && 'ip' in input.req ? input.req.ip || null : null;
    const uaHeader = input.req?.headers?.['user-agent'];
    const ua = typeof uaHeader === 'string' ? uaHeader.slice(0, 300) : null;
    const safeMetadata = redactPii(input.metadata || {});

    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.actorId || null,
        input.actorRole || null,
        input.action,
        input.resourceType,
        input.resourceId || null,
        ip,
        ua,
        JSON.stringify(safeMetadata),
      ]
    );
  }

  async list(filters: {
    actorId?: string;
    action?: string;
    resourceType?: string;
    page: number;
    pageSize: number;
  }) {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.actorId) {
      params.push(filters.actorId);
      conditions.push(`a.actor_id = $${params.length}`);
    }
    if (filters.action) {
      params.push(`%${filters.action}%`);
      conditions.push(`a.action ILIKE $${params.length}`);
    }
    if (filters.resourceType) {
      params.push(filters.resourceType);
      conditions.push(`a.resource_type = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs a ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0]?.count || 0);

    const offset = (filters.page - 1) * filters.pageSize;
    params.push(filters.pageSize, offset);

    const rowsRes = await db.query(
      `SELECT a.id, a.actor_id, u.email AS actor_email, u.full_name AS actor_name,
              a.actor_role, a.action, a.resource_type, a.resource_id, a.ip_address,
              a.metadata, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { items: rowsRes.rows, total };
  }
}

const auditRepo = new AuditRepository();

export async function emitAuditLog(input: AuditInput): Promise<void> {
  try {
    await auditRepo.insert(input);
  } catch (err) {
    console.error('[AuditLog] Failed to record audit entry:', (err as Error).message);
  }
}

const AuditQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  resourceType: z.string().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export function createAuditRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', requirePermission('manage_settings'), async (req, res, next) => {
    try {
      const q = AuditQuerySchema.parse(req.query);
      const data = await auditRepo.list(q);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
