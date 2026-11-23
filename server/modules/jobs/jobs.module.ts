import { Router } from 'express';
import { env } from '../../config/env.ts';
import { getDb } from '../../infrastructure/db/index.ts';
import { jobWorker } from '../../infrastructure/queue/PostgresJobWorker.ts';
import {
  isValidUuid,
  requireAuth,
  requirePermission,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';

export function createJobsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', requirePermission('view'), async (req, res, next) => {
    try {
      const db = getDb();
      const uploadId = typeof req.query.uploadId === 'string' && req.query.uploadId ? req.query.uploadId : undefined;
      if (uploadId && !isValidUuid(uploadId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Query parameter "uploadId" must be a valid UUID.' } });
      }
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const conds: string[] = [];
      const params: unknown[] = [];

      if (uploadId) {
        params.push(uploadId);
        conds.push(`j.upload_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conds.push(`j.status = $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rowsRes = await db.query(
        `SELECT j.*, u.original_filename
         FROM jobs j
         LEFT JOIN uploads u ON u.id = j.upload_id
         ${where}
         ORDER BY j.created_at DESC
         LIMIT 100`,
        params
      );
      res.json({ items: rowsRes.rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', requirePermission('view'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const jobRes = await db.query('SELECT * FROM jobs WHERE id = $1', [id]);
      const job = jobRes.rows[0];
      if (!job) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found.' } });
      }
      if (env.isVercel && (job.status === 'QUEUED' || job.status === 'RUNNING')) {
        jobWorker.wake();
      }
      const chunksRes = await db.query(
        `SELECT status::text AS status, COUNT(*)::int AS count
         FROM job_chunks WHERE job_id = $1 GROUP BY status`,
        [id]
      );
      res.json({ job, chunksSummary: chunksRes.rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/stream', requirePermission('view'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const db = getDb();
      const initialCheck = await db.query(
        'SELECT status, processed_records, total_records, completed_chunks, total_chunks, error_summary FROM jobs WHERE id = $1',
        [id]
      );
      if (!initialCheck.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found.' } });
      }
      if (env.isVercel && (initialCheck.rows[0].status === 'QUEUED' || initialCheck.rows[0].status === 'RUNNING')) {
        jobWorker.wake();
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED_DEAD_LETTER', 'CANCELLED']);
      let closed = false;
      let poll: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        jobWorker.events.off(`job:${id}`, listener);
      };

      const emitRow = (j: Record<string, any>) => {
        if (closed) return;
        const progress = j.status === 'COMPLETED'
          ? 100
          : j.total_chunks > 0
            ? Math.min(98, Math.round((j.completed_chunks / j.total_chunks) * 100))
            : 0;
        res.write(`data: ${JSON.stringify({ ...j, progress })}\n\n`);
        if (TERMINAL_STATUSES.has(String(j.status))) {
          cleanup();
          res.end();
        }
      };

      const listener = (payload: Record<string, unknown>) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (TERMINAL_STATUSES.has(String(payload.status || ''))) {
          cleanup();
          res.end();
        }
      };

      emitRow(initialCheck.rows[0]);
      if (closed) return;

      jobWorker.events.on(`job:${id}`, listener);

      poll = setInterval(() => {
        void (async () => {
          if (closed) return;
          try {
            const r = await db.query(
              'SELECT status, processed_records, total_records, completed_chunks, total_chunks, error_summary FROM jobs WHERE id = $1',
              [id]
            );
            if (r.rows[0]) {
              emitRow(r.rows[0]);
            }
          } catch {
            // Ignore transient stream check
          }
        })();
      }, 2000);

      req.on('close', cleanup);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/cancel', requirePermission('process'), validateUuidParams('id'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const r = await db.query(
        `UPDATE jobs SET cancel_requested = true, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!r.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found.' } });
      }
      await db.query(
        `UPDATE job_chunks SET status = 'CANCELLED' WHERE job_id = $1 AND status IN ('PENDING', 'RETRY_SCHEDULED')`,
        [id]
      );
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'JOB_CANCEL',
        resourceType: 'job',
        resourceId: id,
        req,
      });
      res.json({ job: r.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/retry', requirePermission('process'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const r = await db.query(
        `UPDATE jobs SET status = 'RUNNING', cancel_requested = false, error_summary = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!r.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found.' } });
      }
      await db.query(
        `UPDATE job_chunks SET status = 'PENDING', attempt_count = 0, next_retry_at = NOW(), last_error_message = NULL
         WHERE job_id = $1 AND status = 'DEAD_LETTER'`,
        [id]
      );
      jobWorker.wake();
      res.json({ job: r.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
