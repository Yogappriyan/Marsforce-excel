import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../infrastructure/db/index.ts';
import {
  isValidUuid,
  requireAuth,
  requirePermission,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';
import {
  cleanText,
  normalizeForMatch,
  parseAndStandardizePhones,
  smartTitleCase,
} from '../processing/cleaning.engine.ts';
import { canonicalizeGeoLabel, normalizeGeoGroupKey } from '../processing/geoIntelligence.engine.ts';
import { settingsService } from '../settings/settings.module.ts';

const InlineEditSchema = z.object({
  fullName: z.string().max(250).nullable().optional(),
  consumerId: z.string().max(120).nullable().optional(),
  street: z.string().max(300).nullable().optional(),
  subArea: z.string().max(200).nullable().optional(),
  streetGroup: z.string().max(250).nullable().optional(),
  area: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  district: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  pinCode: z.string().max(10).nullable().optional(),
  phoneRaw: z.string().max(60).nullable().optional(),
  otherFields: z.record(z.string(), z.string()).optional(),
  customCategories: z.array(z.object({ type: z.string().min(1), value: z.string().min(1) })).optional(),
});

const BulkEditSchema = z.object({
  recordIds: z.array(z.string().uuid()).min(1).max(2000),
  patch: z
    .object({
      city: z.string().max(120).optional(),
      district: z.string().max(120).optional(),
      state: z.string().max(120).optional(),
      pinCode: z.string().max(10).optional(),
      addCategory: z.object({ type: z.string().min(1), value: z.string().min(1) }).optional(),
    })
    .refine(
      (p) => Object.values(p).some((v) => v !== undefined),
      'Provide at least one field or category to update.'
    ),
});

const ApproveSchema = z.object({
  recordIds: z.array(z.string().uuid()).min(1).max(5000),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(500).optional(),
});

const SORT_WHITELIST: Record<string, string> = {
  created_at: 'cr.created_at',
  full_name: 'cr.full_name',
  city: 'cr.city',
  district: 'cr.district',
  state: 'cr.state',
  pin_code: 'cr.pin_code',
  status: 'cr.status',
  overall_confidence: 'cr.overall_confidence',
  row_number: 'rr.row_number',
};

export function buildRecordFilterClause(query: Record<string, unknown>) {
  const conds: string[] = ['cr.deleted_at IS NULL', 'cr.is_merged = false'];
  const params: unknown[] = [];

  if (typeof query.uploadId === 'string' && query.uploadId) {
    if (!isValidUuid(query.uploadId)) {
      const err = new Error('Query parameter "uploadId" must be a valid UUID.') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_ID';
      throw err;
    }
    params.push(query.uploadId);
    conds.push(`cr.upload_id = $${params.length}`);
  }
  if (typeof query.status === 'string' && query.status && query.status !== 'ALL') {
    params.push(query.status);
    conds.push(`cr.status = $${params.length}`);
  }
  if (typeof query.area === 'string' && query.area.trim()) {
    const a = query.area.trim();
    if (a === '__UNASSIGNED__' || a.toUpperCase() === 'UNASSIGNED') {
      conds.push(`(cr.area IS NULL OR TRIM(cr.area) = '')`);
    } else {
      params.push(normalizeGeoGroupKey(a));
      conds.push(
        `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(cr.area, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = $${params.length}`
      );
    }
  }
  if (typeof query.streetGroup === 'string' && query.streetGroup.trim()) {
    params.push(normalizeGeoGroupKey(query.streetGroup));
    conds.push(
      `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(NULLIF(cr.street_group, ''), 'UNIDENTIFIED')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = $${params.length}`
    );
  }
  if (typeof query.geoStatus === 'string' && query.geoStatus.trim()) {
    params.push(query.geoStatus.trim());
    conds.push(`cr.geographic_review_status = $${params.length}`);
  }
  if (typeof query.city === 'string' && query.city.trim()) {
    params.push(`%${query.city.trim()}%`);
    conds.push(`cr.city ILIKE $${params.length}`);
  }
  if (typeof query.district === 'string' && query.district.trim()) {
    params.push(`%${query.district.trim()}%`);
    conds.push(`cr.district ILIKE $${params.length}`);
  }
  if (typeof query.state === 'string' && query.state.trim()) {
    params.push(`%${query.state.trim()}%`);
    conds.push(`cr.state ILIKE $${params.length}`);
  }
  if (typeof query.pinCode === 'string' && query.pinCode.trim()) {
    params.push(`${query.pinCode.trim()}%`);
    conds.push(`cr.pin_code LIKE $${params.length}`);
  }
  if (typeof query.phone === 'string' && query.phone.trim()) {
    const digits = query.phone.replace(/\D/g, '');
    params.push(`%${digits || query.phone.trim()}%`);
    conds.push(`(cr.phone_e164 ILIKE $${params.length} OR cr.phone_display ILIKE $${params.length})`);
  }
  if (query.hasInferred === 'true') {
    conds.push('cr.has_inferred_fields = true');
  }
  if (query.hasIssues === 'true') {
    conds.push(`jsonb_array_length(cr.issues) > 0`);
  }
  if (typeof query.categoryValue === 'string' && query.categoryValue.trim()) {
    params.push(query.categoryValue.trim());
    let typeCond = '';
    if (typeof query.categoryType === 'string' && query.categoryType.trim()) {
      params.push(query.categoryType.trim());
      typeCond = `AND rc.category_type = $${params.length}`;
    }
    const valIdx = typeof query.categoryType === 'string' && query.categoryType.trim() ? params.length - 1 : params.length;
    conds.push(
      `EXISTS (SELECT 1 FROM record_categories rc WHERE rc.clean_record_id = cr.id AND rc.category_value = $${valIdx} ${typeCond})`
    );
  }
  if (typeof query.search === 'string' && query.search.trim()) {
    const s = query.search.trim();
    params.push(`%${s}%`);
    const likeIdx = params.length;
    params.push(s);
    const trgmIdx = params.length;
    conds.push(
      `(cr.full_name ILIKE $${likeIdx} OR COALESCE(cr.consumer_id, '') ILIKE $${likeIdx} OR cr.street ILIKE $${likeIdx} OR COALESCE(cr.street_group, '') ILIKE $${likeIdx} OR COALESCE(cr.sub_area, '') ILIKE $${likeIdx} OR cr.area ILIKE $${likeIdx} OR cr.city ILIKE $${likeIdx} OR cr.district ILIKE $${likeIdx} OR cr.phone_e164 ILIKE $${likeIdx} OR cr.pin_code ILIKE $${likeIdx} OR cr.full_name % $${trgmIdx} OR cr.city % $${trgmIdx} OR cr.street % $${trgmIdx} OR cr.district % $${trgmIdx})`
    );
  }

  return { whereSql: `WHERE ${conds.join(' AND ')}`, params };
}

export function createRecordsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/stats', requirePermission('view'), async (req, res, next) => {
    try {
      const db = getDb();
      const uploadId = typeof req.query.uploadId === 'string' && req.query.uploadId ? req.query.uploadId : null;
      if (uploadId && !isValidUuid(uploadId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Query parameter "uploadId" must be a valid UUID.' } });
      }
      const params: unknown[] = [];
      let uploadFilter = '';
      if (uploadId) {
        params.push(uploadId);
        uploadFilter = 'AND upload_id = $1';
      }

      const resStats = await db.query<{ status: string; count: string }>(
        `SELECT status::text AS status, COUNT(*)::text AS count
         FROM clean_records
         WHERE deleted_at IS NULL AND is_merged = false ${uploadFilter}
         GROUP BY status`,
        params
      );

      const counts: Record<string, number> = {
        PROCESSED: 0,
        VERIFIED: 0,
        NEEDS_REVIEW: 0,
        INVALID: 0,
        POTENTIAL_DUPLICATE: 0,
        APPROVED: 0,
        REJECTED: 0,
        TOTAL: 0,
      };
      for (const row of resStats.rows) {
        const n = Number(row.count);
        counts[row.status] = n;
        counts.TOTAL += n;
      }
      res.json(counts);
    } catch (err) {
      next(err);
    }
  });

  router.get('/', requirePermission('view'), async (req, res, next) => {
    try {
      const db = getDb();
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 50)));
      const sortBy = SORT_WHITELIST[String(req.query.sortBy || '')] || 'rr.row_number';
      const sortDir = String(req.query.sortDir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

      const { whereSql, params } = buildRecordFilterClause(req.query as Record<string, unknown>);

      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM clean_records cr
         JOIN raw_records rr ON rr.id = cr.raw_record_id
         ${whereSql}`,
        params
      );
      const total = Number(countRes.rows[0]?.count || 0);

      const offset = (page - 1) * pageSize;
      const listParams = [...params, pageSize, offset];

      const rowsRes = await db.query(
        `SELECT cr.*, rr.row_number, rr.raw_data, u.original_filename,
                (SELECT COALESCE(json_agg(json_build_object(
                  'type', rc.category_type,
                  'value', rc.category_value,
                  'path', rc.hierarchy_path,
                  'source', rc.source
                )), '[]'::json)
                FROM record_categories rc WHERE rc.clean_record_id = cr.id) AS categories
         FROM clean_records cr
         JOIN raw_records rr ON rr.id = cr.raw_record_id
         JOIN uploads u ON u.id = cr.upload_id
         ${whereSql}
         ORDER BY ${sortBy} ${sortDir}, cr.id ASC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      );

      res.json({ items: rowsRes.rows, total, page, pageSize });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', requirePermission('view'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const recRes = await db.query(
        `SELECT cr.*, rr.row_number, rr.raw_data, rr.row_fingerprint, u.original_filename
         FROM clean_records cr
         JOIN raw_records rr ON rr.id = cr.raw_record_id
         JOIN uploads u ON u.id = cr.upload_id
         WHERE cr.id = $1 AND cr.deleted_at IS NULL`,
        [id]
      );
      if (!recRes.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } });
      }
      const catsRes = await db.query(
        'SELECT category_type, category_value, hierarchy_path, source, confidence FROM record_categories WHERE clean_record_id = $1',
        [id]
      );
      const histRes = await db.query(
        `SELECT rh.*, u.full_name AS actor_name
         FROM record_history rh
         LEFT JOIN users u ON u.id = rh.actor_id
         WHERE rh.clean_record_id = $1
         ORDER BY rh.created_at DESC`,
        [id]
      );

      res.json({
        record: recRes.rows[0],
        categories: catsRes.rows,
        history: histRes.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', requirePermission('edit'), validateUuidParams('id'), validateBody(InlineEditSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const body = req.body as z.infer<typeof InlineEditSchema>;
      const defaultRegion = (await settingsService.getSetting<string>('phone.default_region', 'IN')) as any;

      const updated = await db.transaction(async (tx) => {
        const curRes = await tx.query<Record<string, any>>(
          'SELECT * FROM clean_records WHERE id = $1 AND deleted_at IS NULL',
          [id]
        );
        const cur = curRes.rows[0];
        if (!cur) return null;

        const beforeState = { ...cur };
        const changedFields: string[] = [];
        const provenance = { ...(cur.provenance || {}) };
        let issues: Array<{ code: string; field: string; severity: string; message: string }> = Array.isArray(cur.issues)
          ? [...cur.issues]
          : [];

        const fullName = body.fullName !== undefined ? (body.fullName ? smartTitleCase(cleanText(body.fullName) || '') : null) : cur.full_name;
        if (body.fullName !== undefined) {
          changedFields.push('full_name');
          provenance.fullName = 'STANDARDISED';
          issues = issues.filter((i) => i.code !== 'MISSING_NAME');
        }

        const consumerId = body.consumerId !== undefined ? cleanText(body.consumerId) : cur.consumer_id;
        if (body.consumerId !== undefined) {
          changedFields.push('consumer_id');
          provenance.consumerId = 'STANDARDISED';
        }
        const street = body.street !== undefined ? cleanText(body.street) : cur.street;
        if (body.street !== undefined) {
          changedFields.push('street');
          provenance.street = 'STANDARDISED';
        }
        const subArea = body.subArea !== undefined ? canonicalizeGeoLabel(body.subArea) : cur.sub_area;
        if (body.subArea !== undefined) {
          changedFields.push('sub_area');
        }
        const area = body.area !== undefined ? canonicalizeGeoLabel(body.area) : cur.area;
        if (body.area !== undefined) {
          changedFields.push('area');
          provenance.area = 'STANDARDISED';
        }
        const streetGroup =
          body.streetGroup !== undefined
            ? canonicalizeGeoLabel(body.streetGroup) || 'UNIDENTIFIED'
            : body.street !== undefined && street
              ? canonicalizeGeoLabel(street) || street
              : cur.street_group;
        if (body.streetGroup !== undefined) {
          changedFields.push('street_group');
        }
        const city = body.city !== undefined ? cleanText(body.city) : cur.city;
        if (body.city !== undefined) {
          changedFields.push('city');
          provenance.city = 'STANDARDISED';
        }
        const district = body.district !== undefined ? cleanText(body.district) : cur.district;
        if (body.district !== undefined) {
          changedFields.push('district');
          provenance.district = 'STANDARDISED';
        }
        const state = body.state !== undefined ? cleanText(body.state) : cur.state;
        if (body.state !== undefined) {
          changedFields.push('state');
          provenance.state = 'STANDARDISED';
        }

        let pinCode = cur.pin_code;
        if (body.pinCode !== undefined) {
          changedFields.push('pin_code');
          issues = issues.filter((i) => i.code !== 'INVALID_PIN_CODE');
          const rawPin = cleanText(body.pinCode);
          if (!rawPin) {
            pinCode = null;
          } else if (/^[1-9]\d{5}$/.test(rawPin)) {
            pinCode = rawPin;
            provenance.pinCode = 'STANDARDISED';
          } else {
            pinCode = rawPin.slice(0, 6);
            issues.push({
              code: 'INVALID_PIN_CODE',
              field: 'pinCode',
              severity: 'ERROR',
              message: `PIN code "${rawPin}" must be 6 digits.`,
            });
          }
        }

        let phoneE164 = cur.phone_e164;
        let phoneDisplay = cur.phone_display;
        if (body.phoneRaw !== undefined) {
          changedFields.push('phone_e164');
          issues = issues.filter((i) => i.code !== 'INVALID_PHONE_FORMAT' && i.code !== 'MISSING_PHONE');
          if (!body.phoneRaw || !body.phoneRaw.trim()) {
            phoneE164 = null;
            phoneDisplay = null;
            issues.push({
              code: 'MISSING_PHONE',
              field: 'phoneE164',
              severity: 'WARN',
              message: 'Phone number is missing.',
            });
          } else {
            const parsed = parseAndStandardizePhones(body.phoneRaw, defaultRegion);
            const valid = parsed.find((p) => p.valid);
            if (valid) {
              phoneE164 = valid.e164;
              phoneDisplay = valid.display;
              provenance.phoneE164 = 'STANDARDISED';
            } else {
              phoneE164 = null;
              phoneDisplay = body.phoneRaw.trim();
              issues.push({
                code: 'INVALID_PHONE_FORMAT',
                field: 'phoneE164',
                severity: 'ERROR',
                message: parsed[0]?.reason || 'Invalid phone number.',
              });
            }
          }
        }

        const otherFields = body.otherFields !== undefined ? body.otherFields : cur.other_fields;
        const hasError = issues.some((i) => i.severity === 'ERROR');
        const nextStatus = hasError
          ? 'INVALID'
          : cur.status === 'APPROVED'
            ? 'APPROVED'
            : 'VERIFIED';

        const geoChanged =
          body.area !== undefined ||
          body.subArea !== undefined ||
          body.street !== undefined ||
          body.streetGroup !== undefined;
        const nextGeoStatus = geoChanged
          ? streetGroup && streetGroup !== 'UNIDENTIFIED'
            ? 'CONFIRMED'
            : 'UNIDENTIFIED'
          : cur.geographic_review_status;

        const upRes = await tx.query(
          `UPDATE clean_records
           SET full_name = $2, normalized_name = $3, consumer_id = $4, street = $5, sub_area = $6, locality = $6,
               street_group = $7, area = $8, city = $9, district = $10, state = $11, pin_code = $12,
               phone_e164 = $13, phone_display = $14, other_fields = $15::jsonb, provenance = $16::jsonb,
               issues = $17::jsonb, has_inferred_fields = false, status = $18::record_status,
               geographic_review_status = $19,
               classification_source = CASE WHEN $20::boolean THEN 'MANUAL_REVIEW' ELSE classification_source END,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            id,
            fullName,
            normalizeForMatch(fullName),
            consumerId,
            street,
            subArea,
            streetGroup,
            area,
            city,
            district,
            state,
            pinCode,
            phoneE164,
            phoneDisplay,
            JSON.stringify(otherFields || {}),
            JSON.stringify(provenance),
            JSON.stringify(issues),
            nextStatus,
            nextGeoStatus,
            geoChanged,
          ]
        );

        if (geoChanged) {
          await tx.query(
            `UPDATE source_rows
             SET detected_area = $2, detected_sub_area = $3, detected_street = $4, street_group = $5,
                 review_status = $6, classification_source = 'MANUAL_REVIEW'
             WHERE clean_record_id = $1`,
            [id, area, subArea, street, streetGroup, nextGeoStatus]
          );
        }

        if (body.customCategories) {
          await tx.query(`DELETE FROM record_categories WHERE clean_record_id = $1 AND source = 'MANUAL'`, [id]);
          for (const cat of body.customCategories) {
            await tx.query(
              `INSERT INTO record_categories (clean_record_id, category_type, category_value, hierarchy_path, source, confidence)
               VALUES ($1, $2, $3, $3, 'MANUAL', 1.000)
               ON CONFLICT (clean_record_id, category_type, category_value) DO NOTHING`,
              [id, cat.type, cat.value]
            );
          }
        }

        await tx.query(
          `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, actor_id)
           VALUES ($1, 'INLINE_EDIT', $2::jsonb, $3::jsonb, $4, $5)`,
          [id, JSON.stringify(beforeState), JSON.stringify(upRes.rows[0]), changedFields, req.authUser!.id]
        );

        return upRes.rows[0];
      });

      if (!updated) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } });
      }
      res.json({ record: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/bulk-edit', requirePermission('edit'), validateBody(BulkEditSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const { recordIds, patch } = req.body as z.infer<typeof BulkEditSchema>;
      let updatedCount = 0;

      await db.transaction(async (tx) => {
        for (const id of recordIds) {
          const curRes = await tx.query<Record<string, any>>('SELECT * FROM clean_records WHERE id = $1 AND deleted_at IS NULL', [id]);
          const cur = curRes.rows[0];
          if (!cur) continue;

          const provenance = { ...(cur.provenance || {}) };
          let issues: Array<{ code: string; field: string; severity: string; message: string }> = Array.isArray(cur.issues)
            ? [...cur.issues]
            : [];

          const nextCity = patch.city !== undefined ? cleanText(patch.city) : cur.city;
          if (patch.city !== undefined) provenance.city = 'STANDARDISED';
          const nextDistrict = patch.district !== undefined ? cleanText(patch.district) : cur.district;
          if (patch.district !== undefined) provenance.district = 'STANDARDISED';
          const nextState = patch.state !== undefined ? cleanText(patch.state) : cur.state;
          if (patch.state !== undefined) provenance.state = 'STANDARDISED';

          let nextPin = cur.pin_code;
          if (patch.pinCode !== undefined) {
            issues = issues.filter((i) => i.code !== 'INVALID_PIN_CODE');
            const rawPin = cleanText(patch.pinCode);
            if (!rawPin) {
              nextPin = null;
            } else if (/^[1-9]\d{5}$/.test(rawPin)) {
              nextPin = rawPin;
              provenance.pinCode = 'STANDARDISED';
            } else {
              nextPin = rawPin.slice(0, 6);
              issues.push({
                code: 'INVALID_PIN_CODE',
                field: 'pinCode',
                severity: 'ERROR',
                message: `PIN code "${rawPin}" must be 6 digits.`,
              });
            }
          }

          const hasError = issues.some((i) => i.severity === 'ERROR');
          const nextStatus = hasError ? 'INVALID' : cur.status === 'APPROVED' ? 'APPROVED' : 'VERIFIED';

          const upRes = await tx.query(
            `UPDATE clean_records
             SET city = $2, district = $3, state = $4, pin_code = $5,
                 provenance = $6::jsonb, issues = $7::jsonb, has_inferred_fields = false,
                 status = $8::record_status, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id, nextCity, nextDistrict, nextState, nextPin, JSON.stringify(provenance), JSON.stringify(issues), nextStatus]
          );

          if (patch.addCategory) {
            await tx.query(
              `INSERT INTO record_categories (clean_record_id, category_type, category_value, hierarchy_path, source, confidence)
               VALUES ($1, $2, $3, $3, 'MANUAL', 1.000)
               ON CONFLICT DO NOTHING`,
              [id, patch.addCategory.type, patch.addCategory.value]
            );
          }

          await tx.query(
            `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, actor_id)
             VALUES ($1, 'BULK_EDIT', $2::jsonb, $3::jsonb, $4, $5)`,
            [id, JSON.stringify(cur), JSON.stringify(upRes.rows[0]), Object.keys(patch), req.authUser!.id]
          );
          updatedCount++;
        }
      });

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'RECORD_BULK_EDIT',
        resourceType: 'clean_record',
        req,
        metadata: { updatedCount, patchedFields: Object.keys(patch) },
      });

      res.json({ updatedCount });
    } catch (err) {
      next(err);
    }
  });

  router.post('/approve', requirePermission('approve'), validateBody(ApproveSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const { recordIds, decision, reason } = req.body as z.infer<typeof ApproveSchema>;

      const updatedCount = await db.transaction(async (tx) => {
        const resUpdate = await tx.query<{ id: string }>(
          `UPDATE clean_records
           SET status = $2::record_status,
               approved_by = $3,
               approved_at = CASE WHEN $2 = 'APPROVED' THEN NOW() ELSE NULL END,
               updated_at = NOW()
           WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND is_merged = false
           RETURNING id`,
          [recordIds, decision, req.authUser!.id]
        );

        for (const r of resUpdate.rows) {
          await tx.query(
            `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, actor_id)
             VALUES ($1, $2, '{}'::jsonb, $3::jsonb, $4, $5)`,
            [r.id, decision, JSON.stringify({ status: decision, reason: reason || null }), ['status'], req.authUser!.id]
          );
        }
        return resUpdate.rows.length;
      });

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: decision === 'APPROVED' ? 'RECORD_APPROVE' : 'RECORD_REJECT',
        resourceType: 'clean_record',
        req,
        metadata: { count: updatedCount },
      });

      res.json({ updatedCount });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requirePermission('delete'), validateUuidParams('id'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const permanent = req.query.permanent === 'true';
      if (permanent && req.authUser!.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Permanent delete requires Super Admin.' } });
      }
      if (permanent) {
        await db.query('DELETE FROM clean_records WHERE id = $1', [id]);
      } else {
        await db.query('UPDATE clean_records SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
      }
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: permanent ? 'RECORD_PERMANENT_DELETE' : 'RECORD_SOFT_DELETE',
        resourceType: 'clean_record',
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
