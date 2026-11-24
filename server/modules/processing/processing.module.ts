import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../infrastructure/db/index.ts';
import { getActiveLLMProvider, TargetFieldEnum } from '../../infrastructure/llm/LLMProvider.ts';
import { jobWorker } from '../../infrastructure/queue/PostgresJobWorker.ts';
import {
  requireAuth,
  requirePermission,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';
import { detectColumnsDeterministic } from './cleaning.engine.ts';

const DetectMappingSchema = z.object({
  useAi: z.boolean().default(true),
});

const SaveMappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        sourceColumn: z.string().min(1),
        sourceIndex: z.number().int().min(0),
        targetField: TargetFieldEnum,
        customFieldKey: z.string().max(80).nullable().optional(),
        detectionSource: z.enum(['RULE', 'AI', 'TEMPLATE', 'MANUAL']).default('MANUAL'),
        confidence: z.number().min(0).max(1).default(1),
      })
    )
    .min(1),
  saveAsTemplateName: z.string().trim().min(2).max(100).optional(),
  templateDescription: z.string().max(300).optional(),
});

const StartProcessingSchema = z.object({
  checkDuplicatesAgainstMaster: z.boolean().default(true),
  runCategorisation: z.boolean().default(true),
  includeHiddenRows: z.boolean().optional(),
  processAllSheets: z.boolean().default(false),
});

const CreateTemplateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(300).optional(),
  mappings: z.array(
    z.object({
      sourceColumn: z.string(),
      targetField: TargetFieldEnum,
      customFieldKey: z.string().nullable().optional(),
    })
  ),
});

function computeHeaderSignature(headers: string[]): string {
  return crypto
    .createHash('sha256')
    .update(headers.map((h) => h.trim().toLowerCase()).sort().join('|'))
    .digest('hex');
}

export function createProcessingRouter() {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/uploads/:uploadId/sheets/:sheetId/detect-mapping',
    requirePermission('process'),
    validateUuidParams('uploadId', 'sheetId'),
    validateBody(DetectMappingSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { uploadId, sheetId } = req.params;
        const shRes = await db.query<{
          id: string;
          headers: string[];
          preview_rows: Record<string, string>[];
        }>(
          'SELECT id, headers, preview_rows FROM upload_sheets WHERE id = $1 AND upload_id = $2',
          [sheetId, uploadId]
        );
        const sheet = shRes.rows[0];
        if (!sheet) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Worksheet not found.' } });
        }

        const headers = sheet.headers || [];
        const sig = computeHeaderSignature(headers);

        // 1. Check saved templates for exact header signature match
        const tplRes = await db.query(
          'SELECT * FROM mapping_templates WHERE header_signature = $1 ORDER BY updated_at DESC LIMIT 1',
          [sig]
        );
        const suggestedTemplate = tplRes.rows[0] || null;

        // 2. Run deterministic rule profiler first
        const ruleMappings = detectColumnsDeterministic(headers, sheet.preview_rows || []);
        let finalMappings = ruleMappings.map((m) => ({
          sourceIndex: m.sourceIndex,
          sourceColumn: m.sourceColumn,
          targetField: m.targetField,
          confidence: m.confidence,
          detectionSource: 'RULE' as 'RULE' | 'AI' | 'TEMPLATE',
          reason: m.reason,
        }));

        // 3. If low-confidence columns exist and useAi is true, send ONLY headers + 30 sampled rows
        let aiWarning: string | null = null;
        const hasLowConf = finalMappings.some((m) => m.confidence < 0.78);
        if (req.body.useAi && hasLowConf) {
          const llm = await getActiveLLMProvider();
          if (llm.isConfigured()) {
            const aiResult = await llm.detectColumnMappings(headers, (sheet.preview_rows || []).slice(0, 30));
            if (aiResult) {
              const aiByIdx = new Map(aiResult.mappings.map((a) => [a.sourceIndex, a]));
              finalMappings = finalMappings.map((fm) => {
                const ai = aiByIdx.get(fm.sourceIndex);
                if (!ai) return fm;
                if (fm.confidence < 0.78 && ai.confidence > fm.confidence) {
                  return {
                    ...fm,
                    targetField: ai.targetField,
                    confidence: Number((0.4 * fm.confidence + 0.6 * ai.confidence).toFixed(3)),
                    detectionSource: 'AI',
                    reason: ai.reason || 'AI-assisted header and sample analysis',
                  };
                }
                return fm;
              });
            } else {
              aiWarning = llm.getLastError();
            }
          }
        }

        res.json({ mappings: finalMappings, suggestedTemplate, aiWarning });
      } catch (err) {
        next(err);
      }
    }
  );

  router.put(
    '/uploads/:uploadId/sheets/:sheetId/mapping',
    requirePermission('process'),
    validateUuidParams('uploadId', 'sheetId'),
    validateBody(SaveMappingSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const db = getDb();
        const { uploadId, sheetId } = req.params;
        const body = req.body as z.infer<typeof SaveMappingSchema>;

        const shRes = await db.query<{ headers: string[] }>(
          'SELECT headers FROM upload_sheets WHERE id = $1 AND upload_id = $2',
          [sheetId, uploadId]
        );
        if (!shRes.rows[0]) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Worksheet not found.' } });
        }

        const out = await db.transaction(async (tx) => {
          let template = null;
          if (body.saveAsTemplateName) {
            const sig = computeHeaderSignature(shRes.rows[0].headers || []);
            const tplRes = await tx.query(
              `INSERT INTO mapping_templates (name, description, header_signature, mappings, created_by)
               VALUES ($1, $2, $3, $4::jsonb, $5)
               ON CONFLICT (name) DO UPDATE SET
                 description = EXCLUDED.description,
                 header_signature = EXCLUDED.header_signature,
                 mappings = EXCLUDED.mappings,
                 updated_at = NOW()
               RETURNING *`,
              [
                body.saveAsTemplateName,
                body.templateDescription || null,
                sig,
                JSON.stringify(body.mappings),
                req.authUser!.id,
              ]
            );
            template = tplRes.rows[0];
          }

          await tx.query('DELETE FROM column_mappings WHERE sheet_id = $1', [sheetId]);
          const savedMappings = [];
          for (const m of body.mappings) {
            const ins = await tx.query(
              `INSERT INTO column_mappings (
                 upload_id, sheet_id, source_column, source_index, target_field,
                 custom_field_key, detection_source, confidence, template_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
              [
                uploadId,
                sheetId,
                m.sourceColumn,
                m.sourceIndex,
                m.targetField,
                m.customFieldKey || null,
                m.detectionSource,
                m.confidence,
                template?.id || null,
              ]
            );
            savedMappings.push(ins.rows[0]);
          }

          await tx.query(`UPDATE uploads SET status = 'MAPPED', updated_at = NOW() WHERE id = $1`, [uploadId]);
          return { mappings: savedMappings, template };
        });

        res.json(out);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/uploads/:uploadId/sheets/:sheetId/start',
    requirePermission('process'),
    validateUuidParams('uploadId', 'sheetId'),
    validateBody(StartProcessingSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const db = getDb();
        const uploadId = String(req.params.uploadId);
        const sheetId = String(req.params.sheetId);
        const body = req.body as z.infer<typeof StartProcessingSchema>;

        const shRes = await db.query<{
          id: string;
          row_count: number;
          headers: string[];
          preview_rows: Record<string, string>[];
        }>(
          'SELECT id, row_count, headers, preview_rows FROM upload_sheets WHERE id = $1 AND upload_id = $2',
          [sheetId, uploadId]
        );
        const primarySheet = shRes.rows[0];
        if (!primarySheet) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Worksheet not found.' } });
        }

        const primaryMappingsRes = await db.query<{
          source_column: string;
          source_index: number;
          target_field: string;
          custom_field_key: string | null;
          detection_source: string;
          confidence: number;
          template_id: string | null;
        }>('SELECT * FROM column_mappings WHERE sheet_id = $1 ORDER BY source_index ASC', [sheetId]);

        if (primaryMappingsRes.rows.length === 0) {
          return res.status(400).json({
            error: { code: 'MAPPING_REQUIRED', message: 'Save column mappings before starting processing.' },
          });
        }

        let targetSheets = [primarySheet];
        if (body.processAllSheets) {
          const allSheetsRes = await db.query<{
            id: string;
            row_count: number;
            headers: string[];
            preview_rows: Record<string, string>[];
          }>(
            `SELECT id, row_count, headers, preview_rows
             FROM upload_sheets
             WHERE upload_id = $1 AND (row_count > 0 OR id = $2)
             ORDER BY sheet_index ASC`,
            [uploadId, sheetId]
          );
          if (allSheetsRes.rows.length > 0) {
            targetSheets = allSheetsRes.rows;
          }

          const primaryByCol = new Map(
            primaryMappingsRes.rows.map((m) => [m.source_column.trim().toLowerCase(), m])
          );

          await db.transaction(async (tx) => {
            await tx.query('UPDATE upload_sheets SET is_selected = true WHERE upload_id = $1 AND row_count > 0', [
              uploadId,
            ]);
            for (const s of targetSheets) {
              if (s.id === sheetId) continue;
              const existingMapRes = await tx.query<{ count: string }>(
                'SELECT COUNT(*)::text AS count FROM column_mappings WHERE sheet_id = $1',
                [s.id]
              );
              if (Number(existingMapRes.rows[0]?.count || 0) === 0) {
                const headers = s.headers || [];
                const ruleDetections = detectColumnsDeterministic(headers, s.preview_rows || []);
                const ruleByCol = new Map(ruleDetections.map((r) => [r.sourceColumn.trim().toLowerCase(), r]));
                const selectedColsForSheet: string[] = [];

                for (let idx = 0; idx < headers.length; idx++) {
                  const colName = headers[idx];
                  const normKey = colName.trim().toLowerCase();
                  const inherited = primaryByCol.get(normKey);
                  const ruleMatch = ruleByCol.get(normKey);
                  const targetField = inherited?.target_field || ruleMatch?.targetField || 'custom';
                  const customKey = inherited?.custom_field_key || (targetField === 'custom' ? colName : null);
                  const detSource = inherited ? inherited.detection_source : 'RULE';
                  const conf = inherited ? Number(inherited.confidence) : Number(ruleMatch?.confidence ?? 0.65);

                  if (targetField !== 'ignore') {
                    selectedColsForSheet.push(colName);
                  }

                  await tx.query(
                    `INSERT INTO column_mappings (
                       upload_id, sheet_id, source_column, source_index, target_field,
                       custom_field_key, detection_source, confidence, template_id
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [
                      uploadId,
                      s.id,
                      colName,
                      idx,
                      targetField,
                      customKey,
                      detSource,
                      conf,
                      inherited?.template_id || null,
                    ]
                  );
                }

                await tx.query(
                  `UPDATE upload_sheets
                   SET is_selected = true,
                       selected_columns = $2::jsonb,
                       include_hidden_rows = COALESCE($3, include_hidden_rows)
                   WHERE id = $1`,
                  [
                    s.id,
                    JSON.stringify(selectedColsForSheet.length > 0 ? selectedColsForSheet : headers),
                    body.includeHiddenRows ?? null,
                  ]
                );
              } else {
                await tx.query(
                  `UPDATE upload_sheets
                   SET is_selected = true,
                       include_hidden_rows = COALESCE($2, include_hidden_rows)
                   WHERE id = $1`,
                  [s.id, body.includeHiddenRows ?? null]
                );
              }
            }
          });
        }

        const jobs = [];
        for (const s of targetSheets) {
          const jobRes = await db.query(
            `INSERT INTO jobs (job_type, status, upload_id, sheet_id, created_by, payload, total_records)
             VALUES ('INGEST_AND_PROCESS', 'QUEUED', $1, $2, $3, $4::jsonb, $5)
             RETURNING *`,
            [uploadId, s.id, req.authUser!.id, JSON.stringify(body), s.row_count]
          );
          jobs.push(jobRes.rows[0]);
        }

        const primaryJob = jobs.find((j) => j.sheet_id === sheetId) || jobs[0];

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'PROCESSING_JOB_START',
          resourceType: 'job',
          resourceId: primaryJob.id,
          req,
          metadata: {
            uploadId,
            sheetId,
            sheetCount: targetSheets.length,
            processAllSheets: body.processAllSheets,
            totalRowCount: targetSheets.reduce((acc, s) => acc + s.row_count, 0),
          },
        });

        if (jobWorker.isRunning) {
          jobWorker.wake();
          return res.status(202).json({ job: primaryJob, jobs });
        }

        await jobWorker.advanceUntilSettled(3500);
        const refreshedRes = await db.query('SELECT * FROM jobs WHERE id = $1', [primaryJob.id]);
        res.status(202).json({ job: refreshedRes.rows[0] || primaryJob, jobs });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export function createTemplatesRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', requirePermission('view'), async (_req, res, next) => {
    try {
      const db = getDb();
      const r = await db.query('SELECT * FROM mapping_templates ORDER BY updated_at DESC');
      res.json({ items: r.rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requirePermission('process'), validateBody(CreateTemplateSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const sig = computeHeaderSignature(req.body.mappings.map((m: { sourceColumn: string }) => m.sourceColumn));
      const r = await db.query(
        `INSERT INTO mapping_templates (name, description, header_signature, mappings, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
        [req.body.name, req.body.description || null, sig, JSON.stringify(req.body.mappings), req.authUser!.id]
      );
      res.status(201).json({ template: r.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requirePermission('process'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      await db.query('DELETE FROM mapping_templates WHERE id = $1', [String(req.params.id)]);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
