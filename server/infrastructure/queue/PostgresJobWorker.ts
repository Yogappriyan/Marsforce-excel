import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { waitUntil } from '@vercel/functions';
import type { CountryCode } from 'libphonenumber-js';
import { env } from '../../config/env.ts';
import { getDb } from '../db/index.ts';
import { getActiveLLMProvider, type GeoClassifyItem, type TargetField } from '../llm/LLMProvider.ts';
import { getStorageAdapter } from '../storage/StorageAdapter.ts';
import { applyCategorisationBatch, categorisationRepo } from '../../modules/categorisation/categorisation.module.ts';
import { detectDuplicatesForUpload } from '../../modules/duplicates/duplicates.module.ts';
import { cleanAndValidateRow, type ValidationIssue } from '../../modules/processing/cleaning.engine.ts';
import {
  canonicalizeGeoLabel,
  resolveGeographicClassification,
  type GeoDictionaryEntry,
} from '../../modules/processing/geoIntelligence.engine.ts';
import {
  classifyPhysicalRow,
  summarizeMappedColumns,
} from '../../modules/processing/rowIntelligence.engine.ts';
import { settingsService } from '../../modules/settings/settings.module.ts';
import { streamPhysicalSheetRows, type PhysicalRowData } from '../../modules/uploads/fileParser.ts';

export interface JobWorkerInterface {
  start(): Promise<void>;
  stop(): Promise<void>;
  wake(): void;
  events: EventEmitter;
}

interface JobRow {
  id: string;
  job_type: 'INGEST_AND_PROCESS' | 'REPROCESS_CATEGORISE' | 'DETECT_DUPLICATES' | 'EXPORT_DATASET' | 'RETENTION_PURGE';
  status: string;
  upload_id: string | null;
  sheet_id: string | null;
  created_by: string;
  payload: Record<string, any>;
  total_records: number;
  processed_records: number;
  total_chunks: number;
  completed_chunks: number;
  cancel_requested: boolean;
}

interface ChunkRow {
  id: string;
  job_id: string;
  chunk_index: number;
  row_start: number;
  row_end: number;
  attempt_count: number;
  max_attempts: number;
}

const CHUNK_SIZE = 1000;

export class PostgresJobWorker implements JobWorkerInterface {
  public readonly events = new EventEmitter();
  private workerId = `worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  private running = false;
  private busy = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.recoverStaleLocks();

    this.pollTimer = setInterval(() => {
      void this.tick();
    }, 1000);

    this.reaperTimer = setInterval(() => {
      void this.recoverStaleLocks();
    }, 30000);

    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
  }

  wake(): void {
    if (this.running) {
      setImmediate(() => void this.tick());
      return;
    }
    const promise = this.drainPendingWork();
    if (env.isVercel) {
      try {
        waitUntil(promise);
      } catch {
        // Ignore outside active serverless request context
      }
    } else {
      void promise;
    }
  }

  async advanceUntilSettled(maxWaitMs = 3500): Promise<void> {
    if (this.running) return;
    const drain = this.drainPendingWork(15_000);
    if (env.isVercel) {
      try {
        waitUntil(drain);
      } catch {
        // Ignore outside active serverless request context
      }
    }
    await Promise.race([
      drain,
      new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
    ]);
  }

  async drainPendingWork(maxDurationMs = 45_000): Promise<void> {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.drainPromise = (async () => {
      const deadline = Date.now() + maxDurationMs;
      await this.recoverStaleLocks();
      while (Date.now() < deadline) {
        if (this.busy) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        this.busy = true;
        let didWork = false;
        try {
          const initDone = await this.initializePendingJob();
          if (initDone) {
            didWork = true;
          } else {
            const chunk = await this.claimNextChunk();
            if (chunk) {
              await this.processChunk(chunk);
              didWork = true;
            }
          }
        } catch (err) {
          console.error('[Worker] Serverless drain error:', (err as Error).message);
        } finally {
          this.busy = false;
        }
        if (!didWork) break;
      }
    })().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private emitJobUpdate(jobId: string, data: Record<string, unknown>) {
    this.events.emit(`job:${jobId}`, data);
  }

  private async recoverStaleLocks(): Promise<void> {
    const db = getDb();
    try {
      await db.query(
        `UPDATE job_chunks
         SET status = CASE WHEN attempt_count >= max_attempts THEN 'DEAD_LETTER'::chunk_status ELSE 'RETRY_SCHEDULED'::chunk_status END,
             locked_by = NULL,
             locked_at = NULL,
             next_retry_at = NOW() + INTERVAL '3 seconds',
             last_error_code = 'STALE_WORKER_RECOVERED',
             last_error_message = 'Recovered chunk after worker restart or timeout.'
         WHERE status = 'RUNNING'
           AND heartbeat_at < NOW() - INTERVAL '90 seconds'`
      );
    } catch {
      // Ignore if DB not yet migrated
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const initDone = await this.initializePendingJob();
      if (initDone) {
        this.busy = false;
        setImmediate(() => void this.tick());
        return;
      }

      const chunk = await this.claimNextChunk();
      if (chunk) {
        await this.processChunk(chunk);
        this.busy = false;
        setImmediate(() => void this.tick());
        return;
      }
    } catch (err) {
      console.error('[Worker] Tick error:', (err as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private async initializePendingJob(): Promise<boolean> {
    const db = getDb();
    const res = await db.query<JobRow>(
      `WITH next_job AS (
         SELECT id FROM jobs
         WHERE status = 'QUEUED' AND total_chunks = 0 AND cancel_requested = false
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs
       SET status = 'RUNNING',
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       FROM next_job
       WHERE jobs.id = next_job.id
       RETURNING jobs.*`
    );
    const job = res.rows[0];
    if (!job) return false;

    if (job.job_type === 'EXPORT_DATASET') {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE jobs SET status = 'RUNNING', total_chunks = 1, started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`,
          [job.id]
        );
        await tx.query(
          `INSERT INTO job_chunks (job_id, chunk_index, row_start, row_end, status)
           VALUES ($1, 1, 1, 1, 'PENDING')`,
          [job.id]
        );
      });
      return true;
    }

    if (job.job_type === 'REPROCESS_CATEGORISE' && job.upload_id) {
      await db.query(
        `UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
      const sheetRes = await db.query<{ id: string }>(
        `SELECT id FROM upload_sheets WHERE upload_id = $1 AND is_selected = true LIMIT 1`,
        [job.upload_id]
      );
      const sheetId = job.sheet_id || sheetRes.rows[0]?.id || null;
      if (!sheetId) {
        await db.query(
          `UPDATE jobs SET status = 'FAILED_DEAD_LETTER', error_summary = 'No selected worksheet for reprocessing.', updated_at = NOW() WHERE id = $1`,
          [job.id]
        );
        return true;
      }

      if (job.payload?.fullReingest) {
        await db.transaction(async (tx) => {
          await tx.query(
            `DELETE FROM clean_records WHERE raw_record_id IN (SELECT id FROM raw_records WHERE sheet_id = $1) AND deleted_at IS NULL`,
            [sheetId]
          );
          await tx.query(`DELETE FROM raw_records WHERE sheet_id = $1`, [sheetId]);
          await tx.query(`DELETE FROM source_rows WHERE sheet_id = $1`, [sheetId]);
          await tx.query(
            `UPDATE jobs SET job_type = 'INGEST_AND_PROCESS'::job_type, sheet_id = $2, status = 'QUEUED', total_chunks = 0, completed_chunks = 0, processed_records = 0 WHERE id = $1`,
            [job.id, sheetId]
          );
        });
        return true;
      }

      const rawRows = await db.query<{ row_number: number }>(
        `SELECT row_number FROM raw_records WHERE sheet_id = $1 ORDER BY row_number ASC`,
        [sheetId]
      );
      const rowNumbers = rawRows.rows.map((r) => r.row_number);
      const totalChunks = Math.max(1, Math.ceil(rowNumbers.length / CHUNK_SIZE));
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE jobs SET sheet_id = $2, total_records = $3, total_chunks = $4, updated_at = NOW() WHERE id = $1`,
          [job.id, sheetId, rowNumbers.length, totalChunks]
        );
        if (rowNumbers.length === 0) {
          await tx.query(`UPDATE jobs SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [job.id]);
        } else {
          for (let c = 0; c < totalChunks; c++) {
            const slice = rowNumbers.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
            await tx.query(
              `INSERT INTO job_chunks (job_id, chunk_index, row_start, row_end, status)
               VALUES ($1, $2, $3, $4, 'PENDING') ON CONFLICT (job_id, chunk_index) DO NOTHING`,
              [job.id, c + 1, slice[0], slice[slice.length - 1]]
            );
          }
        }
      });
      return true;
    }

    if (job.job_type === 'INGEST_AND_PROCESS' && job.upload_id && job.sheet_id) {
      await db.query(
        `UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
      await db.query(`UPDATE uploads SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`, [job.upload_id]);
      this.emitJobUpdate(job.id, { status: 'RUNNING', phase: 'ANALYSING_PHYSICAL_ROWS', progress: 5 });

      try {
        const upRes = await db.query<{
          file_extension: string;
          storage_key: string;
        }>('SELECT file_extension, storage_key FROM uploads WHERE id = $1', [job.upload_id]);
        const shRes = await db.query<{
          sheet_name: string;
          header_row_number: number;
          include_hidden_rows: boolean;
          column_count: number;
        }>(
          'SELECT sheet_name, header_row_number, include_hidden_rows, column_count FROM upload_sheets WHERE id = $1',
          [job.sheet_id]
        );
        const mapRes = await db.query<{ source_column: string; target_field: TargetField }>(
          'SELECT source_column, target_field FROM column_mappings WHERE sheet_id = $1 ORDER BY source_index ASC',
          [job.sheet_id]
        );

        const upload = upRes.rows[0];
        const sheet = shRes.rows[0];
        if (!upload || !sheet) throw new Error('Upload or worksheet missing.');

        const includeHidden =
          typeof job.payload?.includeHiddenRows === 'boolean'
            ? job.payload.includeHiddenRows
            : sheet.include_hidden_rows ?? true;

        const buffer = await getStorageAdapter().getObjectBuffer(upload.storage_key);
        const mappingSummary = summarizeMappedColumns(
          mapRes.rows.map((m) => ({ sourceColumn: m.source_column, targetField: m.target_field }))
        );

        const existingRawCountRes = await db.query<{ row_number: number }>(
          `SELECT row_number FROM raw_records WHERE sheet_id = $1 ORDER BY row_number ASC`,
          [job.sheet_id]
        );

        let customerRowNumbers = existingRawCountRes.rows.map((r) => r.row_number);

        if (customerRowNumbers.length === 0) {
          const headerRowNum = sheet.header_row_number || 1;
          let activeSectionHeading: string | null = null;
          let activeSectionArea: string | null = null;
          let physicalCount = 0;

          type PendingBatchItem = {
            row: PhysicalRowData;
            rowType: string;
            activeSectionHeading: string | null;
            headingDetectionReason: string | null;
            confidence: number;
            groupType: string | null;
          };

          let batch: PendingBatchItem[] = [];

          const flushBatch = async () => {
            if (batch.length === 0) return;
            await db.transaction(async (tx) => {
              for (const item of batch) {
                const precisionLossDetected = item.row.precisionLossCols.length > 0;
                const formatMeta = {
                  isHidden: item.row.isHidden,
                  isMergedRow: item.row.isMergedRow,
                  isBoldRow: item.row.isBoldRow,
                  isCenteredRow: item.row.isCenteredRow,
                  isUppercaseRow: item.row.isUppercaseRow,
                  nonEmptyCount: item.row.nonEmptyCount,
                  precisionLossCols: item.row.precisionLossCols,
                  formulaCols: item.row.formulaCols,
                };

                await tx.query(
                  `INSERT INTO source_rows (
                     upload_id, sheet_id, sheet_name, physical_row_number, row_type,
                     raw_cells, display_cells, format_meta, active_section_heading,
                     group_type, classification_confidence, heading_detection_reason, precision_loss_detected
                   ) VALUES ($1,$2,$3,$4,$5::row_type,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
                   ON CONFLICT (sheet_id, physical_row_number) DO UPDATE SET
                     row_type = EXCLUDED.row_type,
                     active_section_heading = EXCLUDED.active_section_heading,
                     format_meta = EXCLUDED.format_meta,
                     precision_loss_detected = EXCLUDED.precision_loss_detected`,
                  [
                    job.upload_id,
                    job.sheet_id,
                    sheet.sheet_name,
                    item.row.physicalRowNumber,
                    item.rowType,
                    JSON.stringify(item.row.cellsByHeader),
                    JSON.stringify(item.row.displayByHeader),
                    JSON.stringify(formatMeta),
                    item.activeSectionHeading,
                    item.groupType,
                    item.confidence,
                    item.headingDetectionReason,
                    precisionLossDetected,
                  ]
                );

                if (item.rowType === 'CUSTOMER_RECORD') {
                  const fp = crypto
                    .createHash('sha256')
                    .update(
                      Object.keys(item.row.cellsByHeader)
                        .sort()
                        .map((k) => `${k}:${String(item.row.cellsByHeader[k] ?? '').trim().toLowerCase()}`)
                        .join('|')
                    )
                    .digest('hex');

                  await tx.query(
                    `INSERT INTO raw_records (upload_id, sheet_id, row_number, row_fingerprint, raw_data)
                     VALUES ($1, $2, $3, $4, $5::jsonb)
                     ON CONFLICT (sheet_id, row_number) DO NOTHING`,
                    [
                      job.upload_id,
                      job.sheet_id,
                      item.row.physicalRowNumber,
                      fp,
                      JSON.stringify(item.row.cellsByHeader),
                    ]
                  );
                  customerRowNumbers.push(item.row.physicalRowNumber);
                }
              }
            });
            batch = [];
          };

          // Sliding lookahead window of 6 rows for zero-buffering O(1)-memory section lookahead
          const windowBuf: PhysicalRowData[] = [];
          const processOne = async (target: PhysicalRowData, lookahead: PhysicalRowData[]) => {
            physicalCount++;
            const cls = classifyPhysicalRow({
              row: target,
              headerRowNumber: headerRowNum,
              mappingSummary,
              nextRows: lookahead,
              totalColumns: Math.max(sheet.column_count, target.orderedCells.length),
            });

            let rowContext = activeSectionHeading;
            if (
              (cls.rowType === 'COLUMN_HEADER' && target.physicalRowNumber === headerRowNum) ||
              cls.rowType === 'SUBTOTAL_OR_REPORT_ROW'
            ) {
              activeSectionHeading = null;
              activeSectionArea = null;
              rowContext = null;
            } else if (cls.rowType === 'SECTION_HEADING' && cls.sectionHeadingText) {
              activeSectionHeading = canonicalizeGeoLabel(cls.sectionHeadingText);
              activeSectionArea = null;
              rowContext = activeSectionHeading;
            } else if (cls.rowType === 'CUSTOMER_RECORD' && activeSectionHeading) {
              const rawAreaVal = mappingSummary.areaCols
                .map((c) => String(target.cellsByHeader[c] ?? '').trim())
                .filter(Boolean)
                .join(' ');
              const normRowArea = rawAreaVal ? canonicalizeGeoLabel(rawAreaVal)?.toLowerCase() || rawAreaVal.toLowerCase() : null;
              if (normRowArea) {
                if (!activeSectionArea) {
                  activeSectionArea = normRowArea;
                } else if (normRowArea !== activeSectionArea) {
                  activeSectionHeading = null;
                  activeSectionArea = null;
                  rowContext = null;
                }
              }
            }

            batch.push({
              row: target,
              rowType: cls.rowType,
              activeSectionHeading: rowContext,
              headingDetectionReason: cls.headingDetectionReason,
              confidence: cls.classificationConfidence,
              groupType: cls.sectionHeadingGroupType,
            });
            if (batch.length >= 400) {
              await flushBatch();
            }
          };

          for await (const { row } of streamPhysicalSheetRows(
            buffer,
            upload.file_extension,
            sheet.sheet_name,
            headerRowNum,
            includeHidden
          )) {
            windowBuf.push(row);
            if (windowBuf.length > 6) {
              const head = windowBuf.shift()!;
              await processOne(head, windowBuf);
            }
          }
          while (windowBuf.length > 0) {
            const head = windowBuf.shift()!;
            await processOne(head, windowBuf);
          }
          await flushBatch();

          await db.query(
            `UPDATE upload_sheets SET physical_row_count = $2, row_count = $3 WHERE id = $1`,
            [job.sheet_id, physicalCount, customerRowNumbers.length]
          );
          await db.query(
            `UPDATE uploads
             SET total_rows = COALESCE(
               (SELECT SUM(row_count)::int FROM upload_sheets WHERE upload_id = $1 AND (is_selected = true OR row_count > 0)),
               $2
             ),
             updated_at = NOW()
             WHERE id = $1`,
            [job.upload_id, customerRowNumbers.length]
          );
        }

        const totalCustomerRows = customerRowNumbers.length;
        const totalChunks = Math.max(1, Math.ceil(totalCustomerRows / CHUNK_SIZE));

        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE jobs SET total_records = $2, total_chunks = $3, updated_at = NOW() WHERE id = $1`,
            [job.id, totalCustomerRows, totalChunks]
          );
          if (totalCustomerRows === 0) {
            await tx.query(
              `UPDATE jobs SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [job.id]
            );
            const remRes = await tx.query<{ cnt: string }>(
              `SELECT COUNT(*)::text AS cnt FROM jobs
               WHERE upload_id = $1
                 AND id <> $2
                 AND job_type IN ('INGEST_AND_PROCESS', 'REPROCESS_CATEGORISE')
                 AND status IN ('QUEUED', 'RUNNING')`,
              [job.upload_id, job.id]
            );
            if (Number(remRes.rows[0]?.cnt || 0) === 0) {
              await tx.query(`UPDATE uploads SET status = 'PROCESSED', updated_at = NOW() WHERE id = $1`, [
                job.upload_id,
              ]);
            }
          } else {
            for (let c = 0; c < totalChunks; c++) {
              const slice = customerRowNumbers.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
              const start = slice[0];
              const end = slice[slice.length - 1];
              await tx.query(
                `INSERT INTO job_chunks (job_id, chunk_index, row_start, row_end, status)
                 VALUES ($1, $2, $3, $4, 'PENDING')
                 ON CONFLICT (job_id, chunk_index) DO NOTHING`,
                [job.id, c + 1, start, end]
              );
            }
          }
        });
        this.emitJobUpdate(job.id, {
          status: totalCustomerRows === 0 ? 'COMPLETED' : 'RUNNING',
          totalRecords: totalCustomerRows,
          totalChunks,
          progress: totalCustomerRows === 0 ? 100 : 12,
        });
      } catch (err) {
        await db.query(
          `UPDATE jobs SET status = 'FAILED_DEAD_LETTER', error_summary = $2, updated_at = NOW() WHERE id = $1`,
          [job.id, (err as Error).message]
        );
        await db.query(
          `UPDATE uploads SET status = 'FAILED', error_message = $2, updated_at = NOW() WHERE id = $1`,
          [job.upload_id, (err as Error).message]
        );
        this.emitJobUpdate(job.id, { status: 'FAILED_DEAD_LETTER', error: (err as Error).message });
      }
      return true;
    }

    return false;
  }

  private async claimNextChunk(): Promise<ChunkRow | null> {
    const db = getDb();
    const res = await db.query<ChunkRow>(
      `WITH next_chunk AS (
         SELECT c.id
         FROM job_chunks c
         JOIN jobs j ON j.id = c.job_id
         WHERE c.status IN ('PENDING', 'RETRY_SCHEDULED')
           AND c.next_retry_at <= NOW()
           AND j.cancel_requested = false
           AND j.status IN ('QUEUED', 'RUNNING')
         ORDER BY j.created_at ASC, c.chunk_index ASC
         FOR UPDATE OF c SKIP LOCKED
         LIMIT 1
       )
       UPDATE job_chunks
       SET status = 'RUNNING',
           locked_by = $1,
           locked_at = NOW(),
           heartbeat_at = NOW(),
           attempt_count = attempt_count + 1
       FROM next_chunk
       WHERE job_chunks.id = next_chunk.id
       RETURNING job_chunks.id, job_chunks.job_id, job_chunks.chunk_index, job_chunks.row_start, job_chunks.row_end, job_chunks.attempt_count, job_chunks.max_attempts`,
      [this.workerId]
    );
    return res.rows[0] || null;
  }

  private async processChunk(chunk: ChunkRow): Promise<void> {
    const db = getDb();
    const jobRes = await db.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [chunk.job_id]);
    const job = jobRes.rows[0];
    if (!job) return;

    if (job.cancel_requested) {
      await db.query(`UPDATE job_chunks SET status = 'CANCELLED', locked_by = NULL WHERE id = $1`, [chunk.id]);
      await this.finalizeJobIfDone(job);
      return;
    }

    const heartbeat = setInterval(() => {
      void db.query('UPDATE job_chunks SET heartbeat_at = NOW() WHERE id = $1', [chunk.id]).catch(() => {});
    }, 15000);

    try {
      if (
        (job.job_type === 'INGEST_AND_PROCESS' || job.job_type === 'REPROCESS_CATEGORISE') &&
        job.upload_id &&
        job.sheet_id
      ) {
        await this.executeIngestChunk(job, chunk);
      } else if (job.job_type === 'EXPORT_DATASET') {
        const { runExportJob } = await import('../../modules/exports/exports.module.ts');
        await runExportJob(job.payload.exportId);
      }

      await db.query(
        `UPDATE job_chunks SET status = 'COMPLETED', locked_by = NULL, completed_at = NOW() WHERE id = $1`,
        [chunk.id]
      );
      await this.finalizeJobIfDone(job);
    } catch (err) {
      const msg = (err as Error).message || 'Chunk processing error';
      const isDead = chunk.attempt_count >= chunk.max_attempts;
      const delaySec = Math.pow(2, chunk.attempt_count) * 5 + Math.floor(Math.random() * 3);
      await db.query(
        `UPDATE job_chunks
         SET status = $2::chunk_status,
             locked_by = NULL,
             next_retry_at = NOW() + ($3 || ' seconds')::interval,
             last_error_code = 'CHUNK_FAILED',
             last_error_message = $4
         WHERE id = $1`,
        [chunk.id, isDead ? 'DEAD_LETTER' : 'RETRY_SCHEDULED', String(delaySec), msg.slice(0, 500)]
      );
      if (isDead) {
        await this.finalizeJobIfDone(job);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async executeIngestChunk(job: JobRow, chunk: ChunkRow): Promise<void> {
    const db = getDb();
    const rawRes = await db.query<{
      id: string;
      row_number: number;
      raw_data: Record<string, string>;
      sheet_name: string | null;
      active_section_heading: string | null;
      format_meta: { precisionLossCols?: Array<{ column: string; storedValue: string; displayValue: string; reason: string }> } | null;
      precision_loss_detected: boolean | null;
    }>(
      `SELECT rr.id, rr.row_number, rr.raw_data,
              sr.sheet_name, sr.active_section_heading, sr.format_meta, sr.precision_loss_detected
       FROM raw_records rr
       LEFT JOIN source_rows sr ON sr.sheet_id = rr.sheet_id AND sr.physical_row_number = rr.row_number
       WHERE rr.sheet_id = $1 AND rr.row_number BETWEEN $2 AND $3
       ORDER BY rr.row_number ASC`,
      [job.sheet_id, chunk.row_start, chunk.row_end]
    );

    const mapRes = await db.query<{
      source_column: string;
      target_field: TargetField;
      custom_field_key: string | null;
    }>(
      `SELECT source_column, target_field, custom_field_key
       FROM column_mappings
       WHERE sheet_id = $1
       ORDER BY source_index ASC`,
      [job.sheet_id]
    );
    const mappings = mapRes.rows;
    const defaultRegion = (await settingsService.getSetting<string>('phone.default_region', 'IN')) as CountryCode;
    const activeRules = await categorisationRepo.listRules(true);

    // Load user-approved area/street dictionaries
    const dictRes = await db.query<{
      level: 'AREA' | 'SUB_AREA' | 'STREET';
      parent_area: string | null;
      alias_label: string;
      canonical_label: string;
      group_type: string | null;
    }>(
      `SELECT level, parent_area, alias_label, canonical_label, group_type
       FROM geo_dictionaries
       WHERE is_approved = true AND (upload_id IS NULL OR upload_id = $1)`,
      [job.upload_id]
    );
    const dictionaries: GeoDictionaryEntry[] = dictRes.rows.map((d) => ({
      level: d.level,
      parentArea: d.parent_area,
      aliasLabel: d.alias_label,
      canonicalLabel: d.canonical_label,
      groupType: d.group_type,
    }));

    const addressMappings = mappings.filter((m) => m.target_field === 'address_combined');
    const streetMappings = mappings.filter((m) => m.target_field === 'street');
    const areaMappings = mappings.filter((m) => m.target_field === 'area');

    // Pass 1: Deterministic cleaning + rule-based geo classification to identify ONLY ambiguous address patterns for batched Gemini AI
    const precomputed = rawRes.rows.map((rr) => {
      const precisionLossCols = rr.format_meta?.precisionLossCols || [];
      const structured = cleanAndValidateRow({
        rawRow: rr.raw_data,
        mappings: mappings.map((m) => ({
          sourceColumn: m.source_column,
          targetField: m.target_field,
          customFieldKey: m.custom_field_key,
        })),
        defaultRegion,
        precisionLossCols,
      });

      const joinedAddr = addressMappings
        .map((m) => String(rr.raw_data[m.source_column] ?? '').trim())
        .filter(Boolean)
        .join(', ');
      const explicitStreet = streetMappings
        .map((m) => String(rr.raw_data[m.source_column] ?? '').trim())
        .filter(Boolean)
        .join(', ');
      const explicitArea =
        areaMappings
          .map((m) => String(rr.raw_data[m.source_column] ?? '').trim())
          .filter(Boolean)
          .join(', ') ||
        structured.area ||
        null;

      const geoInitial = resolveGeographicClassification({
        explicitArea,
        explicitSubArea: structured.subArea,
        explicitStreet: explicitStreet || null,
        rawAddress: joinedAddr || null,
        city: structured.city,
        activeSectionHeading: rr.active_section_heading,
        dictionaries,
      });

      return { rr, structured, joinedAddr, explicitStreet, explicitArea, geoInitial };
    });

    // Privacy-minimized Gemini AI batching ONLY for unique ambiguous addresses (ZERO customer names, consumer numbers, or phones sent)
    const uniqueAmbiguousPayloads = new Set<string>();
    for (const item of precomputed) {
      if (
        item.joinedAddr &&
        item.joinedAddr.length >= 6 &&
        (item.geoInitial.streetGroup === 'UNIDENTIFIED' || !item.geoInitial.area)
      ) {
        const privacySafePayload = item.explicitArea
          ? `Area: ${item.explicitArea} | Address: ${item.joinedAddr}`
          : item.joinedAddr;
        uniqueAmbiguousPayloads.add(privacySafePayload);
      }
    }

    let aiGeoMap = new Map<string, GeoClassifyItem>();
    if (uniqueAmbiguousPayloads.size > 0 && uniqueAmbiguousPayloads.size <= 150) {
      const llm = await getActiveLLMProvider();
      if (llm.isConfigured()) {
        aiGeoMap = await llm.classifyAmbiguousAddressesBatch(Array.from(uniqueAmbiguousPayloads));
      }
    }

    await db.transaction(async (tx) => {
      const categorisableBatch = [];
      for (const item of precomputed) {
        const { rr, structured, joinedAddr, explicitStreet, explicitArea } = item;
        const privacySafePayload = explicitArea
          ? `Area: ${explicitArea} | Address: ${joinedAddr}`
          : joinedAddr;
        const aiSuggestion = joinedAddr ? aiGeoMap.get(privacySafePayload) || aiGeoMap.get(joinedAddr) || null : null;

        const geo = aiSuggestion
          ? resolveGeographicClassification({
              explicitArea,
              explicitSubArea: structured.subArea,
              explicitStreet: explicitStreet || null,
              rawAddress: joinedAddr || null,
              city: structured.city,
              activeSectionHeading: rr.active_section_heading,
              dictionaries,
              aiSuggestion,
            })
          : item.geoInitial;

        const rawMergedArea = geo.area || structured.area;
        const mergedArea = rawMergedArea ? canonicalizeGeoLabel(rawMergedArea) || rawMergedArea : null;
        const mergedSubArea = geo.subArea || structured.subArea;
        const mergedStreet = geo.street || structured.street;

        const finalIssues: ValidationIssue[] = [...structured.issues];
        if (geo.geographicReviewStatus === 'CONFLICT' && geo.geographicConflictReason) {
          finalIssues.push({
            code: 'GEO_HEADING_CONFLICT',
            field: 'streetGroup',
            severity: 'WARN',
            message: geo.geographicConflictReason,
          });
        } else if (geo.geographicReviewStatus === 'UNIDENTIFIED' && geo.geographicConflictReason) {
          finalIssues.push({
            code: 'UNIDENTIFIED_STREET',
            field: 'streetGroup',
            severity: 'WARN',
            message: geo.geographicConflictReason,
          });
        } else if (geo.geographicReviewStatus === 'NEEDS_REVIEW' && geo.geographicConflictReason) {
          finalIssues.push({
            code: 'GEO_REVIEW_REQUIRED',
            field: 'streetGroup',
            severity: 'INFO',
            message: geo.geographicConflictReason,
          });
        }

        const hasError = finalIssues.some((i) => i.severity === 'ERROR');
        const hasWarn = finalIssues.some((i) => i.severity === 'WARN');
        let finalStatus = structured.status;
        if (hasError) {
          finalStatus = 'INVALID';
        } else if (
          structured.hasInferredFields ||
          hasWarn ||
          geo.geographicReviewStatus === 'CONFLICT' ||
          geo.geographicReviewStatus === 'UNIDENTIFIED' ||
          geo.geographicReviewStatus === 'NEEDS_REVIEW'
        ) {
          finalStatus = 'NEEDS_REVIEW';
        }

        const insRes = await tx.query<{ id: string }>(
          `INSERT INTO clean_records (
             raw_record_id, upload_id, consumer_id, distributor_id, full_name, normalized_name,
             street, sub_area, locality, area, city, district, state, pin_code,
             phone_e164, phone_display, secondary_phones, other_fields, provenance, field_confidence,
             overall_confidence, status, has_inferred_fields, issues,
             street_group, group_type, section_heading_context, classification_source,
             classification_confidence, geographic_review_status, geographic_conflict_reason,
             original_sheet_name, original_row_number, precision_loss_detected
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22::record_status,$23,$24::jsonb,
             $25,$26,$27,$28,$29,$30,$31,$32,$33,$34
           )
           ON CONFLICT (raw_record_id) DO UPDATE SET
             consumer_id = EXCLUDED.consumer_id,
             distributor_id = EXCLUDED.distributor_id,
             full_name = EXCLUDED.full_name,
             normalized_name = EXCLUDED.normalized_name,
             street = EXCLUDED.street,
             sub_area = EXCLUDED.sub_area,
             locality = EXCLUDED.locality,
             area = EXCLUDED.area,
             city = EXCLUDED.city,
             district = EXCLUDED.district,
             state = EXCLUDED.state,
             pin_code = EXCLUDED.pin_code,
             phone_e164 = EXCLUDED.phone_e164,
             phone_display = EXCLUDED.phone_display,
             secondary_phones = EXCLUDED.secondary_phones,
             other_fields = EXCLUDED.other_fields,
             provenance = EXCLUDED.provenance,
             field_confidence = EXCLUDED.field_confidence,
             overall_confidence = EXCLUDED.overall_confidence,
             status = EXCLUDED.status,
             has_inferred_fields = EXCLUDED.has_inferred_fields,
             issues = EXCLUDED.issues,
             street_group = EXCLUDED.street_group,
             group_type = EXCLUDED.group_type,
             section_heading_context = EXCLUDED.section_heading_context,
             classification_source = EXCLUDED.classification_source,
             classification_confidence = EXCLUDED.classification_confidence,
             geographic_review_status = EXCLUDED.geographic_review_status,
             geographic_conflict_reason = EXCLUDED.geographic_conflict_reason,
             original_sheet_name = EXCLUDED.original_sheet_name,
             original_row_number = EXCLUDED.original_row_number,
             precision_loss_detected = EXCLUDED.precision_loss_detected,
             updated_at = NOW()
           RETURNING id`,
          [
            rr.id,
            job.upload_id,
            structured.consumerId,
            structured.distributorId,
            structured.fullName,
            structured.normalizedName,
            mergedStreet,
            mergedSubArea,
            geo.locality,
            mergedArea,
            structured.city,
            structured.district,
            structured.state,
            structured.pinCode,
            structured.phoneE164,
            structured.phoneDisplay,
            JSON.stringify(structured.secondaryPhones),
            JSON.stringify(structured.otherFields),
            JSON.stringify(structured.provenance),
            JSON.stringify(structured.fieldConfidence),
            structured.overallConfidence,
            finalStatus,
            structured.hasInferredFields,
            JSON.stringify(finalIssues),
            geo.streetGroup,
            geo.groupType,
            geo.sectionHeadingContext,
            geo.classificationSource,
            geo.classificationConfidence,
            geo.geographicReviewStatus,
            geo.geographicConflictReason,
            rr.sheet_name || null,
            rr.row_number,
            Boolean(rr.precision_loss_detected),
          ]
        );

        const cleanId = insRes.rows[0].id;
        const sourceRowType =
          finalStatus === 'INVALID'
            ? 'INVALID_RECORD'
            : finalStatus === 'NEEDS_REVIEW'
              ? 'NEEDS_REVIEW'
              : 'CUSTOMER_RECORD';

        await tx.query(
          `UPDATE source_rows
           SET row_type = $3::row_type,
               detected_area = $4,
               detected_sub_area = $5,
               detected_street = $6,
               street_group = $7,
               group_type = $8,
               classification_source = $9,
               classification_confidence = $10,
               validation_issues = $11::jsonb,
               review_status = $12,
               conflict_reason = $13,
               clean_record_id = $14
           WHERE sheet_id = $1 AND physical_row_number = $2`,
          [
            job.sheet_id,
            rr.row_number,
            sourceRowType,
            mergedArea,
            mergedSubArea,
            mergedStreet,
            geo.streetGroup,
            geo.groupType,
            geo.classificationSource,
            geo.classificationConfidence,
            JSON.stringify(finalIssues),
            geo.geographicReviewStatus,
            geo.geographicConflictReason,
            cleanId,
          ]
        );

        categorisableBatch.push({
          id: cleanId,
          full_name: structured.fullName,
          street: mergedStreet,
          street_group: geo.streetGroup,
          sub_area: mergedSubArea,
          area: mergedArea,
          city: structured.city,
          district: structured.district,
          state: structured.state,
          pin_code: structured.pinCode,
          phone_e164: structured.phoneE164,
          other_fields: structured.otherFields,
        });
      }

      if (job.payload?.runCategorisation !== false) {
        await applyCategorisationBatch(tx, categorisableBatch, activeRules);
      }

      await tx.query(
        `UPDATE jobs
         SET completed_chunks = completed_chunks + 1,
             processed_records = LEAST(total_records, processed_records + $2),
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, rawRes.rows.length]
      );
    });

    const latestJob = await db.query<{ processed_records: number; total_records: number; completed_chunks: number; total_chunks: number }>(
      'SELECT processed_records, total_records, completed_chunks, total_chunks FROM jobs WHERE id = $1',
      [job.id]
    );
    const lj = latestJob.rows[0];
    if (lj) {
      const pct = lj.total_chunks > 0 ? Math.min(95, Math.round((lj.completed_chunks / lj.total_chunks) * 85) + 10) : 50;
      this.emitJobUpdate(job.id, {
        status: 'RUNNING',
        processedRecords: lj.processed_records,
        totalRecords: lj.total_records,
        completedChunks: lj.completed_chunks,
        totalChunks: lj.total_chunks,
        progress: pct,
      });
    }
  }

  private async finalizeJobIfDone(job: JobRow): Promise<void> {
    const db = getDb();
    const countsRes = await db.query<{ status: string; cnt: string }>(
      `SELECT status::text AS status, COUNT(*)::text AS cnt FROM job_chunks WHERE job_id = $1 GROUP BY status`,
      [job.id]
    );
    const counts: Record<string, number> = {};
    for (const r of countsRes.rows) counts[r.status] = Number(r.cnt);

    const active = (counts.PENDING || 0) + (counts.RUNNING || 0) + (counts.RETRY_SCHEDULED || 0);
    if (active > 0) return;

    if (job.cancel_requested) {
      await db.query(
        `UPDATE job_chunks SET status = 'CANCELLED' WHERE job_id = $1 AND status IN ('PENDING', 'RETRY_SCHEDULED')`,
        [job.id]
      );
      await db.query(`UPDATE jobs SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [job.id]);
      this.emitJobUpdate(job.id, { status: 'CANCELLED', progress: 100 });
      return;
    }

    if ((counts.DEAD_LETTER || 0) > 0) {
      await db.query(
        `UPDATE jobs SET status = 'FAILED_DEAD_LETTER', error_summary = 'One or more chunks failed after maximum retries.', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
      if (job.upload_id) {
        await db.query(`UPDATE uploads SET status = 'FAILED', error_message = 'Processing job moved to dead-letter state.', updated_at = NOW() WHERE id = $1`, [job.upload_id]);
      }
      this.emitJobUpdate(job.id, { status: 'FAILED_DEAD_LETTER' });
      return;
    }

    if ((job.job_type === 'INGEST_AND_PROCESS' || job.job_type === 'REPROCESS_CATEGORISE') && job.upload_id) {
      try {
        const remRes = await db.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM jobs
           WHERE upload_id = $1
             AND id <> $2
             AND job_type IN ('INGEST_AND_PROCESS', 'REPROCESS_CATEGORISE')
             AND status IN ('QUEUED', 'RUNNING')`,
          [job.upload_id, job.id]
        );
        const remainingActive = Number(remRes.rows[0]?.cnt || 0);
        if (remainingActive === 0) {
          const nameThresh = Number(await settingsService.getSetting('dedupe.name_similarity_threshold', 0.86));
          const addrThresh = Number(await settingsService.getSetting('dedupe.address_similarity_threshold', 0.80));
          await detectDuplicatesForUpload(job.upload_id, {
            nameThreshold: nameThresh,
            addressThreshold: addrThresh,
            includeApprovedMaster: Boolean(job.payload?.checkDuplicatesAgainstMaster ?? true),
          });
          await db.query(`UPDATE uploads SET status = 'PROCESSED', updated_at = NOW() WHERE id = $1`, [job.upload_id]);
        }
      } catch (err) {
        console.error('[Worker] Post-chunk duplicate detection error:', (err as Error).message);
      }
    }

    await db.query(`UPDATE jobs SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [job.id]);
    this.emitJobUpdate(job.id, { status: 'COMPLETED', progress: 100 });
  }
}

export const jobWorker = new PostgresJobWorker();
