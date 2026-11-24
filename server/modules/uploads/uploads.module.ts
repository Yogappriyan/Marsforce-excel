import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { getDb } from '../../infrastructure/db/index.ts';
import { getStorageAdapter } from '../../infrastructure/storage/StorageAdapter.ts';
import {
  requireAuth,
  requirePermission,
  uploadRateLimiter,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';
import { settingsService } from '../settings/settings.module.ts';
import { FileValidationError, inspectUploadedFile, streamPhysicalSheetRows } from './fileParser.ts';

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 1,
  },
});

const SelectSheetSchema = z.object({
  selectedColumns: z.array(z.string()).min(1, 'Select at least one column.'),
  includeHiddenRows: z.boolean().optional(),
});

const RestoreFromVaultSchema = z.object({
  originalFilename: z.string().min(1).max(200),
  detectedEncoding: z.string().max(32).nullable().optional(),
  sheets: z
    .array(
      z.object({
        sheetName: z.string().min(1).max(160),
        headers: z.array(z.string().max(160)).min(1).max(500),
        rows: z
          .array(
            z.object({
              rowNumber: z.number().int().optional(),
              cells: z.record(z.string(), z.string()),
            })
          )
          .max(250_000),
      })
    )
    .min(1)
    .max(100),
});

function sanitizeUploadDto<T extends Record<string, any>>(row: T): Omit<T, 'storage_key'> {
  if (!row || typeof row !== 'object') return row;
  const { storage_key: _omittedKey, ...safe } = row;
  return safe;
}

export class UploadsRepository {
  async findBySha256(sha256: string) {
    const db = getDb();
    const res = await db.query<{ id: string; original_filename: string; created_at: string }>(
      `SELECT id, original_filename, created_at FROM uploads
       WHERE file_sha256 = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [sha256]
    );
    return res.rows[0] || null;
  }

  async createUploadWithSheets(params: {
    uploadedBy: string;
    originalFilename: string;
    mimeType: string;
    fileExtension: string;
    fileSizeBytes: number;
    fileSha256: string;
    storageDriver: string;
    storageKey: string;
    detectedEncoding: string | null;
    isDuplicateOverride: boolean;
    duplicateOfUploadId: string | null;
    totalRows: number;
    sheets: Array<{
      sheetIndex: number;
      sheetName: string;
      rowCount: number;
      physicalRowCount?: number;
      headerRowNumber?: number;
      columnCount: number;
      headers: string[];
      previewRows: Record<string, string>[];
    }>;
  }) {
    const db = getDb();
    return db.transaction(async (tx) => {
      const upRes = await tx.query(
        `INSERT INTO uploads (
           uploaded_by, original_filename, mime_type, file_extension, file_size_bytes,
           file_sha256, storage_driver, storage_key, detected_encoding,
           is_duplicate_override, duplicate_of_upload_id, status, total_rows
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'READY_TO_MAP',$12)
         RETURNING *`,
        [
          params.uploadedBy,
          params.originalFilename,
          params.mimeType,
          params.fileExtension,
          params.fileSizeBytes,
          params.fileSha256,
          params.storageDriver,
          params.storageKey,
          params.detectedEncoding,
          params.isDuplicateOverride,
          params.duplicateOfUploadId,
          params.totalRows,
        ]
      );
      const upload = upRes.rows[0];
      const insertedSheets = [];

      for (const s of params.sheets) {
        const sRes = await tx.query(
          `INSERT INTO upload_sheets (
             upload_id, sheet_index, sheet_name, row_count, physical_row_count, header_row_number, column_count,
             headers, preview_rows, is_selected, selected_columns
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)
           RETURNING *`,
          [
            upload.id,
            s.sheetIndex,
            s.sheetName,
            s.rowCount,
            s.physicalRowCount ?? s.rowCount + 1,
            s.headerRowNumber ?? 1,
            s.columnCount,
            JSON.stringify(s.headers),
            JSON.stringify(s.previewRows),
            s.sheetIndex === 0,
            JSON.stringify(s.headers),
          ]
        );
        insertedSheets.push(sRes.rows[0]);
      }

      return { upload, sheets: insertedSheets };
    });
  }

  async list(filters: { page: number; pageSize: number; status?: string; search?: string }) {
    const db = getDb();
    const conds: string[] = ['u.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (filters.status) {
      params.push(filters.status);
      conds.push(`u.status = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search.trim()}%`);
      conds.push(`u.original_filename ILIKE $${params.length}`);
    }

    const where = `WHERE ${conds.join(' AND ')}`;
    const countRes = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM uploads u ${where}`,
      params
    );
    const total = Number(countRes.rows[0]?.count || 0);
    const offset = (filters.page - 1) * filters.pageSize;
    params.push(filters.pageSize, offset);

    const rowsRes = await db.query(
      `SELECT u.*, usr.full_name AS uploaded_by_name,
              (SELECT COUNT(*)::int FROM clean_records cr WHERE cr.upload_id = u.id AND cr.deleted_at IS NULL) AS clean_count,
              (SELECT COUNT(*)::int FROM clean_records cr WHERE cr.upload_id = u.id AND cr.deleted_at IS NULL AND cr.status = 'APPROVED') AS approved_count
       FROM uploads u
       LEFT JOIN users usr ON usr.id = u.uploaded_by
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { items: rowsRes.rows.map((r) => sanitizeUploadDto(r)), total };
  }

  async findById(id: string) {
    const db = getDb();
    const upRes = await db.query(
      `SELECT u.*, usr.full_name AS uploaded_by_name,
              (SELECT COUNT(*)::int FROM clean_records cr WHERE cr.upload_id = u.id AND cr.deleted_at IS NULL AND cr.status = 'APPROVED') AS approved_count,
              (SELECT COUNT(*)::int FROM exports e WHERE e.status = 'COMPLETED' AND (e.filters->>'uploadId' = u.id::text OR e.filters->>'uploadId' IS NULL)) AS export_count
       FROM uploads u
       LEFT JOIN users usr ON usr.id = u.uploaded_by
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [id]
    );
    const upload = upRes.rows[0];
    if (!upload) return null;

    const sheetsRes = await db.query(
      'SELECT * FROM upload_sheets WHERE upload_id = $1 ORDER BY sheet_index ASC',
      [id]
    );
    const jobsRes = await db.query(
      'SELECT * FROM jobs WHERE upload_id = $1 ORDER BY created_at DESC',
      [id]
    );
    return { upload, sheets: sheetsRes.rows, jobs: jobsRes.rows };
  }

  async selectSheetAndColumns(
    uploadId: string,
    sheetId: string,
    selectedColumns: string[],
    includeHiddenRows?: boolean
  ) {
    const db = getDb();
    return db.transaction(async (tx) => {
      await tx.query('UPDATE upload_sheets SET is_selected = false WHERE upload_id = $1', [uploadId]);
      const res = await tx.query(
        `UPDATE upload_sheets
         SET is_selected = true,
             selected_columns = $3::jsonb,
             include_hidden_rows = COALESCE($4, include_hidden_rows)
         WHERE id = $1 AND upload_id = $2 RETURNING *`,
        [sheetId, uploadId, JSON.stringify(selectedColumns), includeHiddenRows ?? null]
      );
      return res.rows[0] || null;
    });
  }

  async softDelete(uploadId: string) {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE uploads SET deleted_at = NOW(), status = 'DELETED', updated_at = NOW() WHERE id = $1`, [uploadId]);
      await tx.query(`UPDATE clean_records SET deleted_at = NOW(), updated_at = NOW() WHERE upload_id = $1`, [uploadId]);
    });
  }

  async restoreSoftDeleted(uploadId: string) {
    const db = getDb();
    return db.transaction(async (tx) => {
      const cleanRes = await tx.query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM clean_records WHERE upload_id = $1',
        [uploadId]
      );
      const nextStatus = Number(cleanRes.rows[0]?.cnt || 0) > 0 ? 'PROCESSED' : 'READY_TO_MAP';
      const upRes = await tx.query(
        `UPDATE uploads SET deleted_at = NULL, status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [uploadId, nextStatus]
      );
      if (!upRes.rows[0]) return null;
      await tx.query(`UPDATE clean_records SET deleted_at = NULL, updated_at = NOW() WHERE upload_id = $1`, [uploadId]);
      return upRes.rows[0];
    });
  }

  async getRawRecordsFallback(uploadId: string, sheetId: string) {
    const db = getDb();
    const res = await db.query<{ row_number: number; raw_data: Record<string, string> }>(
      `SELECT row_number, raw_data FROM raw_records
       WHERE upload_id = $1 AND sheet_id = $2
       ORDER BY row_number ASC`,
      [uploadId, sheetId]
    );
    return res.rows;
  }

  async permanentDelete(uploadId: string) {
    const db = getDb();
    const res = await db.query<{ storage_key: string }>('SELECT storage_key FROM uploads WHERE id = $1', [uploadId]);
    const key = res.rows[0]?.storage_key;
    await db.query('DELETE FROM uploads WHERE id = $1', [uploadId]);
    if (key) {
      await getStorageAdapter().deleteObject(key);
    }
  }
}

export function createUploadsRouter() {
  const router = Router();
  const repo = new UploadsRepository();
  router.use(requireAuth);

  router.post(
    '/',
    requirePermission('upload'),
    uploadRateLimiter,
    (req, res, next) => {
      uploadMiddleware.single('file')(req, res, (err: any) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
              error: { code: 'FILE_TOO_LARGE', message: `File exceeds maximum allowed size of ${env.maxUploadMb} MB.` },
            });
          }
          return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
        }
        next();
      });
    },
    async (req: AuthenticatedRequest, res, next) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: { code: 'NO_FILE', message: 'No file attached in request.' } });
        }
        const configuredMaxMb = Number(await settingsService.getSetting<number>('upload.max_mb', env.maxUploadMb));
        if (req.file.size > configuredMaxMb * 1024 * 1024) {
          return res.status(413).json({
            error: {
              code: 'FILE_TOO_LARGE',
              message: `File exceeds configured limit of ${configuredMaxMb} MB.`,
            },
          });
        }

        const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9._\-\u0B80-\u0BFF ]/g, '_').slice(0, 180);
        const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        const overrideDuplicate =
          req.body?.overrideDuplicate === 'true' || req.body?.overrideDuplicate === true;

        const existingDup = await repo.findBySha256(sha256);
        if (existingDup && !overrideDuplicate) {
          return res.status(409).json({
            error: {
              code: 'DUPLICATE_FILE',
              message: `This exact file (SHA-256 match) was already uploaded as "${existingDup.original_filename}". Enable "Override duplicate check" to import again.`,
              details: [{ existingUploadId: existingDup.id, existingFilename: existingDup.original_filename }],
            },
          });
        }

        let inspection;
        try {
          inspection = await inspectUploadedFile(safeOriginalName, req.file.buffer);
        } catch (err) {
          if (err instanceof FileValidationError) {
            return res.status(400).json({ error: { code: err.code, message: err.message } });
          }
          throw err;
        }

        const storage = getStorageAdapter();
        const storageKey = `uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}_${safeOriginalName}`;
        await storage.putObject(storageKey, req.file.buffer, req.file.mimetype || 'application/octet-stream');

        const created = await repo.createUploadWithSheets({
          uploadedBy: req.authUser!.id,
          originalFilename: safeOriginalName,
          mimeType: req.file.mimetype || 'application/octet-stream',
          fileExtension: inspection.extension,
          fileSizeBytes: req.file.size,
          fileSha256: sha256,
          storageDriver: storage.driverName,
          storageKey,
          detectedEncoding: inspection.detectedEncoding,
          isDuplicateOverride: Boolean(existingDup && overrideDuplicate),
          duplicateOfUploadId: existingDup?.id || null,
          totalRows: inspection.totalRows,
          sheets: inspection.sheets,
        });

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: existingDup && overrideDuplicate ? 'UPLOAD_DUPLICATE_OVERRIDE' : 'UPLOAD_CREATE',
          resourceType: 'upload',
          resourceId: created.upload.id,
          req,
          metadata: {
            fileSizeBytes: req.file.size,
            totalRows: inspection.totalRows,
            sheetCount: inspection.sheets.length,
          },
        });

        res.status(201).json({
          upload: sanitizeUploadDto(created.upload),
          sheets: created.sheets,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/', requirePermission('view'), async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const data = await repo.list({ page, pageSize, status, search });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', requirePermission('view'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const data = await repo.findById(String(req.params.id));
      if (!data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Upload not found.' } });
      }
      res.json({
        ...data,
        upload: sanitizeUploadDto(data.upload),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/download', requirePermission('view'), validateUuidParams('id'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const data = await repo.findById(String(req.params.id));
      if (!data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Upload not found.' } });
      }
      const { upload, sheets } = data;
      const storage = getStorageAdapter();
      let fileBuffer: Buffer | null = null;
      let downloadFilename = String(upload.original_filename || 'workbook.xlsx');
      let contentType =
        upload.mime_type ||
        (upload.file_extension === '.csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      if (upload.storage_key) {
        try {
          fileBuffer = await storage.getObjectBuffer(upload.storage_key);
        } catch {
          fileBuffer = null;
        }
      }

      if (!fileBuffer) {
        // Fallback reconstruction from stored raw_records if original file blob is missing
        const wb = new ExcelJS.Workbook();
        wb.creator = 'MARSFORCE';
        const usedNames = new Set<string>();
        for (const sheet of sheets) {
          let sheetTitle = String(sheet.sheet_name || 'Sheet1')
            .replace(/[\\/*?:[\]]/g, '_')
            .slice(0, 31) || 'Sheet1';
          while (usedNames.has(sheetTitle.toLowerCase())) {
            sheetTitle = `${sheetTitle.slice(0, 27)}_${usedNames.size + 1}`;
          }
          usedNames.add(sheetTitle.toLowerCase());
          const headers: string[] = Array.isArray(sheet.headers) && sheet.headers.length > 0 ? sheet.headers.map(String) : ['Column_1'];
          const ws = wb.addWorksheet(sheetTitle);
          ws.addRow(headers);
          const fallbackRows = await repo.getRawRecordsFallback(upload.id, sheet.id);
          for (const fr of fallbackRows) {
            ws.addRow(headers.map((h) => String(fr.raw_data?.[h] ?? '')));
          }
        }
        const ab = await wb.xlsx.writeBuffer();
        fileBuffer = Buffer.from(ab);
        if (!downloadFilename.toLowerCase().endsWith('.xlsx')) {
          downloadFilename = `${downloadFilename.replace(/\.(xls|csv)$/i, '')}.xlsx`;
        }
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'UPLOAD_ORIGINAL_DOWNLOAD',
        resourceType: 'upload',
        resourceId: upload.id,
        req,
      });

      const safeHeaderFilename = downloadFilename.replace(/["\r\n\\]/g, '_');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeHeaderFilename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store, private');
      res.send(fileBuffer);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/backup-payload', requirePermission('view'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const data = await repo.findById(String(req.params.id));
      if (!data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Upload not found.' } });
      }
      const { upload, sheets } = data;
      const storage = getStorageAdapter();
      let fileBuffer: Buffer | null = null;
      let checksumVerified = false;

      try {
        if (upload.storage_key && (await storage.exists(upload.storage_key))) {
          fileBuffer = await storage.getObjectBuffer(upload.storage_key);
          const actualSha = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          checksumVerified = actualSha === upload.file_sha256;
        }
      } catch {
        fileBuffer = null;
      }

      const exportedSheets: Array<{
        sheetIndex: number;
        sheetName: string;
        rowCount: number;
        physicalRowCount: number;
        headerRowNumber: number;
        headers: string[];
        rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
      }> = [];

      for (const sheet of sheets) {
        const rows: Array<{ rowNumber: number; cells: Record<string, string> }> = [];
        const headerRowNum = Number(sheet.header_row_number || 1);
        const headers: string[] = Array.isArray(sheet.headers) ? sheet.headers.map(String) : [];

        if (fileBuffer) {
          let seq = 0;
          for await (const item of streamPhysicalSheetRows(
            fileBuffer,
            upload.file_extension,
            sheet.sheet_name,
            headerRowNum,
            true
          )) {
            if (item.row.physicalRowNumber <= headerRowNum || item.row.isBlank) continue;
            seq++;
            const cleanCells: Record<string, string> = {};
            for (const h of item.headers) {
              const val = item.row.cellsByHeader[h];
              if (val !== undefined && val !== '') {
                cleanCells[h] = String(val);
              }
            }
            rows.push({ rowNumber: seq, cells: cleanCells });
          }
        } else {
          const fallbackRows = await repo.getRawRecordsFallback(upload.id, sheet.id);
          for (const fr of fallbackRows) {
            const cleanCells: Record<string, string> = {};
            for (const [k, v] of Object.entries(fr.raw_data || {})) {
              if (v !== undefined && v !== null && String(v) !== '') {
                cleanCells[k] = String(v);
              }
            }
            rows.push({ rowNumber: fr.row_number, cells: cleanCells });
          }
        }

        exportedSheets.push({
          sheetIndex: Number(sheet.sheet_index || 0),
          sheetName: String(sheet.sheet_name),
          rowCount: Number(sheet.row_count ?? rows.length),
          physicalRowCount: Number(sheet.physical_row_count ?? rows.length + 1),
          headerRowNumber: headerRowNum,
          headers: headers.length > 0 ? headers : ['Column_1'],
          rows,
        });
      }

      res.json({
        upload: sanitizeUploadDto(upload),
        checksumVerified,
        sheets: exportedSheets,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/restore-from-vault',
    requirePermission('upload'),
    validateBody(RestoreFromVaultSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const body = req.body as z.infer<typeof RestoreFromVaultSchema>;
        const wb = new ExcelJS.Workbook();
        wb.creator = 'MARSFORCE Firestore Vault Restore';
        wb.created = new Date();

        const usedNames = new Set<string>();
        for (const s of body.sheets) {
          let sheetTitle = s.sheetName.replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || 'Sheet1';
          while (usedNames.has(sheetTitle.toLowerCase())) {
            sheetTitle = `${sheetTitle.slice(0, 27)}_${usedNames.size + 1}`;
          }
          usedNames.add(sheetTitle.toLowerCase());

          const ws = wb.addWorksheet(sheetTitle);
          ws.addRow(s.headers.map((h) => String(h)));
          for (const r of s.rows) {
            ws.addRow(s.headers.map((h) => String(r.cells?.[h] ?? '')));
          }
        }

        const outArrayBuffer = await wb.xlsx.writeBuffer();
        const buffer = Buffer.from(outArrayBuffer);
        const baseSafe = body.originalFilename
          .replace(/\.(xlsx|xls|csv)$/i, '')
          .replace(/[^a-zA-Z0-9._\-\u0B80-\u0BFF ]/g, '_')
          .slice(0, 160);
        const restoredFilename = `${baseSafe || 'restored_workbook'}.xlsx`;
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const existingDup = await repo.findBySha256(sha256);

        const inspection = await inspectUploadedFile(restoredFilename, buffer);
        const storage = getStorageAdapter();
        const storageKey = `uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}_${restoredFilename}`;
        await storage.putObject(
          storageKey,
          buffer,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        const created = await repo.createUploadWithSheets({
          uploadedBy: req.authUser!.id,
          originalFilename: restoredFilename,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileExtension: '.xlsx',
          fileSizeBytes: buffer.length,
          fileSha256: sha256,
          storageDriver: storage.driverName,
          storageKey,
          detectedEncoding: body.detectedEncoding ?? inspection.detectedEncoding,
          isDuplicateOverride: Boolean(existingDup),
          duplicateOfUploadId: existingDup?.id || null,
          totalRows: inspection.totalRows,
          sheets: inspection.sheets,
        });

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'UPLOAD_VAULT_RESTORE',
          resourceType: 'upload',
          resourceId: created.upload.id,
          req,
          metadata: {
            restoredFilename,
            sheetCount: inspection.sheets.length,
            totalRows: inspection.totalRows,
          },
        });

        res.status(201).json({
          upload: sanitizeUploadDto(created.upload),
          sheets: created.sheets,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post('/:id/restore', requirePermission('delete'), validateUuidParams('id'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const id = String(req.params.id);
      const restored = await repo.restoreSoftDeleted(id);
      if (!restored) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Upload not found.' } });
      }
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'UPLOAD_RESTORE',
        resourceType: 'upload',
        resourceId: id,
        req,
      });
      res.json({ upload: sanitizeUploadDto(restored) });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/:id/sheets/:sheetId/select',
    requirePermission('process'),
    validateUuidParams('id', 'sheetId'),
    validateBody(SelectSheetSchema),
    async (req, res, next) => {
      try {
        const sheet = await repo.selectSheetAndColumns(
          String(req.params.id),
          String(req.params.sheetId),
          req.body.selectedColumns,
          req.body.includeHiddenRows
        );
        if (!sheet) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Worksheet not found.' } });
        }
        res.json({ sheet });
      } catch (err) {
        next(err);
      }
    }
  );

  router.delete('/:id', requirePermission('delete'), validateUuidParams('id'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const permanent = req.query.permanent === 'true';
      if (permanent && req.authUser!.role !== 'SUPER_ADMIN') {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Permanent deletion is restricted to Super Admin.' },
        });
      }
      const id = String(req.params.id);
      if (permanent) {
        await repo.permanentDelete(id);
      } else {
        await repo.softDelete(id);
      }
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: permanent ? 'UPLOAD_PERMANENT_DELETE' : 'UPLOAD_SOFT_DELETE',
        resourceType: 'upload',
        resourceId: id,
        req,
      });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function createSamplesRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/messy-csv', requirePermission('upload'), (_req, res) => {
    const csvRows = [
      ['Customer Name', 'Contact Number', 'Full Address', 'Business Segment', 'Customer Notes'],
      ['kumar s - 9876543210', '+91 98765 43210 / 0452-2345678', '14, West Masi St, Anna Nagar, Madurai, TN 625020', 'Hardware Retail', 'Regular buyer'],
      ['Suresh Kumar', '09876543210', '22 South Veli Street, Madurai 625001', 'Hardware Retail', 'Same mobile test'],
      ['Ravi Shankar', '9443123456', '88 Palayamkottai High Rd, Tirunelveli, Tamil Nadu 627002', 'Textile Wholesale', 'Bulk orders'],
      ['கார்த்திக் ராஜா', '9840112233', '45 Gandhi Nagar 2nd Cross, Chennai 600020', 'Medical Pharmacy', 'Tamil script record'],
      ['Meena Traders', '8123456789; 9000112233', 'Plot 9, SIPCOT Industrial Estate, Coimbatore 641021', 'Wholesale Supplier', 'Multi phone'],
      ['Anand V', '12345', 'Main Road, Salem', 'Services', 'Invalid phone & incomplete address'],
      ['Priya Enterprises', '5123456789', '12 MG Road, Bengaluru 560001', 'Retail Store', 'Invalid IN mobile start digit'],
      ['=CMD|"/C calc"!A0', '9789012345', '7 Temple Rd, Thanjavur 613001', 'Grocery Mart', 'Formula injection test'],
      ['RAVI SHANKAR', '+91-9443123456', '88 Palayamkottai High Road, Tirunelveli 627002', 'Textile Wholesale', 'Fuzzy duplicate test'],
      ['Deepak Raj', '9988776655', '34 Lake View Ave, 625007', 'Logistics', 'PIN inference test (missing city/state)'],
    ];

    const csvString = csvRows
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="marsforce_messy_sample.csv"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send('\uFEFF' + csvString);
  });

  return router;
}
