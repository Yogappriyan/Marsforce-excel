import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../infrastructure/db/index.ts';
import { jobWorker } from '../../infrastructure/queue/PostgresJobWorker.ts';
import {
  requireAuth,
  requirePermission,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';
import { cleanText } from '../processing/cleaning.engine.ts';
import {
  buildChainedAreaAndPlaceRoute,
  canonicalizeGeoLabel,
  inferGroupType,
  normalizeGeoGroupKey,
  type ProximityRecordSignals,
} from '../processing/geoIntelligence.engine.ts';

const ManualGeoPatchSchema = z.object({
  area: z.string().max(200).nullable().optional(),
  subArea: z.string().max(200).nullable().optional(),
  street: z.string().max(300).nullable().optional(),
  streetGroup: z.string().max(250).nullable().optional(),
  groupType: z.string().max(60).nullable().optional(),
  approveClassification: z.boolean().optional(),
  saveAliasToDictionary: z.boolean().optional(),
});

const RenameMergeGroupSchema = z.object({
  uploadId: z.string().uuid(),
  level: z.enum(['AREA', 'STREET_GROUP']),
  parentArea: z.string().max(200).nullable().optional(),
  sourceLabels: z.array(z.string().min(1).max(250)).min(1).max(50),
  targetLabel: z.string().min(1).max(250),
  targetGroupType: z.string().max(60).optional(),
  saveDictionaryAlias: z.boolean().default(true),
});

const SplitGroupSchema = z.object({
  uploadId: z.string().uuid(),
  recordIds: z.array(z.string().uuid()).min(1).max(2000),
  targetArea: z.string().max(200).nullable().optional(),
  targetSubArea: z.string().max(200).nullable().optional(),
  targetStreetGroup: z.string().min(1).max(250),
  targetGroupType: z.string().max(60).optional(),
});

const ReprocessGeoSchema = z.object({
  includeHiddenRows: z.boolean().optional(),
  fullReingest: z.boolean().optional(),
});

export async function refreshGeoCategoriesForRecords(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  recordIds: string[]
) {
  if (recordIds.length === 0) return;
  await tx.query(
    `DELETE FROM record_categories
     WHERE clean_record_id = ANY($1::uuid[])
       AND category_type IN ('LOCATION_AREA', 'LOCATION_STREET')`,
    [recordIds]
  );

  const recsRes = await tx.query(
    `SELECT id, area, street_group, street FROM clean_records WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [recordIds]
  );
  for (const r of recsRes.rows) {
    if (r.area) {
      await tx.query(
        `INSERT INTO record_categories (clean_record_id, category_type, category_value, hierarchy_path, source, confidence)
         VALUES ($1, 'LOCATION_AREA', $2, $2, 'MANUAL', 1.000)
         ON CONFLICT (clean_record_id, category_type, category_value) DO NOTHING`,
        [r.id, r.area]
      );
    }
    const streetVal = r.street_group || r.street;
    if (streetVal && streetVal !== 'UNIDENTIFIED') {
      const pathVal = [r.area, streetVal].filter(Boolean).join(' > ');
      await tx.query(
        `INSERT INTO record_categories (clean_record_id, category_type, category_value, hierarchy_path, source, confidence)
         VALUES ($1, 'LOCATION_STREET', $2, $3, 'MANUAL', 1.000)
         ON CONFLICT (clean_record_id, category_type, category_value) DO NOTHING`,
        [r.id, streetVal, pathVal]
      );
    }
  }
}

export function createGeoRouter() {
  const router = Router();
  router.use(requireAuth);

  // Full dynamic Area -> Street/Locality tree & physical row reconciliation summary for an upload
  router.get('/uploads/:uploadId/summary', requirePermission('view'), validateUuidParams('uploadId'), async (req, res, next) => {
    try {
      const db = getDb();
      const uploadId = String(req.params.uploadId);

      const upRes = await db.query(
        `SELECT u.id, u.original_filename, u.status, u.total_rows,
                (SELECT s.id FROM upload_sheets s WHERE s.upload_id = u.id AND s.is_selected = true ORDER BY s.sheet_index ASC LIMIT 1) AS sheet_id,
                (SELECT string_agg(s.sheet_name, ', ' ORDER BY s.sheet_index ASC) FROM upload_sheets s WHERE s.upload_id = u.id AND s.is_selected = true) AS sheet_name,
                (SELECT s.header_row_number FROM upload_sheets s WHERE s.upload_id = u.id AND s.is_selected = true ORDER BY s.sheet_index ASC LIMIT 1) AS header_row_number,
                (SELECT COALESCE(SUM(s.physical_row_count), 0)::int FROM upload_sheets s WHERE s.upload_id = u.id AND s.is_selected = true) AS physical_row_count,
                COALESCE((SELECT bool_or(s.include_hidden_rows) FROM upload_sheets s WHERE s.upload_id = u.id AND s.is_selected = true), true) AS include_hidden_rows
         FROM uploads u
         WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [uploadId]
      );
      if (!upRes.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Upload not found.' } });
      }

      const rowTypeStats = await db.query<{ row_type: string; count: string; precision_count: string }>(
        `SELECT row_type::text AS row_type,
                COUNT(*)::text AS count,
                SUM(CASE WHEN precision_loss_detected THEN 1 ELSE 0 END)::text AS precision_count
         FROM source_rows
         WHERE upload_id = $1
         GROUP BY row_type`,
        [uploadId]
      );

      const reconciliation: Record<string, number> = {
        totalPhysicalRows: 0,
        COLUMN_HEADER: 0,
        CUSTOMER_RECORD: 0,
        SECTION_HEADING: 0,
        EMPTY_SEPARATOR: 0,
        SUBTOTAL_OR_REPORT_ROW: 0,
        INVALID_RECORD: 0,
        NEEDS_REVIEW: 0,
        precisionLossRows: 0,
      };
      for (const r of rowTypeStats.rows) {
        const cnt = Number(r.count);
        reconciliation[r.row_type] = cnt;
        reconciliation.totalPhysicalRows += cnt;
        reconciliation.precisionLossRows += Number(r.precision_count || 0);
      }

      const groupRows = await db.query<{
        area_name: string | null;
        street_group: string | null;
        group_type: string | null;
        total_count: string;
        needs_review_count: string;
        conflict_count: string;
        unidentified_count: string;
        confirmed_count: string;
        precision_loss_count: string;
        section_headings: string[];
        min_row_num: number;
        sample_pins: string[];
        sample_sub_areas: string[];
        sample_streets: string[];
        sample_cities: string[];
        sample_raw_rows: Array<Record<string, string>>;
      }>(
        `SELECT
           cr.area AS area_name,
           COALESCE(NULLIF(cr.street_group, ''), 'UNIDENTIFIED') AS street_group,
           COALESCE(NULLIF(cr.group_type, ''), 'UNIDENTIFIED') AS group_type,
           COUNT(*)::text AS total_count,
           SUM(CASE WHEN cr.geographic_review_status IN ('NEEDS_REVIEW', 'CONFLICT', 'UNIDENTIFIED') OR cr.status IN ('NEEDS_REVIEW', 'INVALID') THEN 1 ELSE 0 END)::text AS needs_review_count,
           SUM(CASE WHEN cr.geographic_review_status = 'CONFLICT' THEN 1 ELSE 0 END)::text AS conflict_count,
           SUM(CASE WHEN COALESCE(NULLIF(cr.street_group, ''), 'UNIDENTIFIED') = 'UNIDENTIFIED' THEN 1 ELSE 0 END)::text AS unidentified_count,
           SUM(CASE WHEN cr.geographic_review_status IN ('CONFIRMED', 'APPROVED') THEN 1 ELSE 0 END)::text AS confirmed_count,
           SUM(CASE WHEN cr.precision_loss_detected THEN 1 ELSE 0 END)::text AS precision_loss_count,
           COALESCE(
             array_agg(DISTINCT cr.section_heading_context) FILTER (WHERE cr.section_heading_context IS NOT NULL),
             ARRAY[]::text[]
           ) AS section_headings,
           COALESCE(MIN(COALESCE(cr.original_row_number, rr.row_number)), 0)::int AS min_row_num,
           COALESCE(
             (array_agg(DISTINCT cr.pin_code) FILTER (WHERE cr.pin_code IS NOT NULL))[1:10],
             ARRAY[]::text[]
           ) AS sample_pins,
           COALESCE(
             (array_agg(DISTINCT cr.sub_area) FILTER (WHERE cr.sub_area IS NOT NULL))[1:10],
             ARRAY[]::text[]
           ) AS sample_sub_areas,
           COALESCE(
             (array_agg(DISTINCT cr.street) FILTER (WHERE cr.street IS NOT NULL))[1:10],
             ARRAY[]::text[]
           ) AS sample_streets,
           COALESCE(
             (array_agg(DISTINCT cr.city) FILTER (WHERE cr.city IS NOT NULL))[1:6],
             ARRAY[]::text[]
           ) AS sample_cities,
           COALESCE(
             (array_agg(rr.raw_data ORDER BY COALESCE(cr.original_row_number, rr.row_number) ASC))[1:12],
             ARRAY[]::jsonb[]
           ) AS sample_raw_rows
         FROM clean_records cr
         LEFT JOIN raw_records rr ON rr.id = cr.raw_record_id
         WHERE cr.upload_id = $1 AND cr.deleted_at IS NULL AND cr.is_merged = false
         GROUP BY cr.area, COALESCE(NULLIF(cr.street_group, ''), 'UNIDENTIFIED'), COALESCE(NULLIF(cr.group_type, ''), 'UNIDENTIFIED')
         ORDER BY cr.area ASC NULLS LAST, COUNT(*) DESC, street_group ASC`,
        [uploadId]
      );

      const buildSignalsFromSample = (g: (typeof groupRows.rows)[number]): ProximityRecordSignals[] => {
        const rawList = Array.isArray(g.sample_raw_rows) ? g.sample_raw_rows : [];
        const pins = Array.isArray(g.sample_pins) ? g.sample_pins : [];
        const subAreas = Array.isArray(g.sample_sub_areas) ? g.sample_sub_areas : [];
        const streets = Array.isArray(g.sample_streets) ? g.sample_streets : [];
        const cities = Array.isArray(g.sample_cities) ? g.sample_cities : [];
        const maxLen = Math.max(1, rawList.length, pins.length, subAreas.length, streets.length);
        const signals: ProximityRecordSignals[] = [];
        for (let i = 0; i < maxLen; i++) {
          signals.push({
            pin_code: pins[i] || pins[0] || null,
            sub_area: subAreas[i] || subAreas[0] || null,
            street: streets[i] || streets[0] || null,
            city: cities[i] || cities[0] || null,
            area: g.area_name,
            original_row_number: g.min_row_num || 1,
            raw_data: rawList[i] || null,
          });
        }
        return signals;
      };

      const areaMap = new Map<
        string,
        {
          areaKey: string;
          areaName: string;
          isUnassigned: boolean;
          totalCount: number;
          unidentifiedCount: number;
          needsReviewCount: number;
          conflictCount: number;
          confirmedCount: number;
          precisionLossCount: number;
          signals: ProximityRecordSignals[];
          streetMap: Map<
            string,
            {
              streetGroup: string;
              groupType: string;
              count: number;
              reviewRequiredCount: number;
              conflictCount: number;
              confirmedCount: number;
              sectionHeadings: Set<string>;
              signals: ProximityRecordSignals[];
            }
          >;
        }
      >();

      let totalCustomerRecords = 0;
      let unassignedAreaCount = 0;
      let unidentifiedStreetCount = 0;
      let conflictCount = 0;
      let reviewRequiredCount = 0;

      for (const g of groupRows.rows) {
        const isUnassigned = !g.area_name || !g.area_name.trim();
        const areaName = isUnassigned ? 'UNASSIGNED' : canonicalizeGeoLabel(g.area_name) || g.area_name!.trim();
        const areaKey = isUnassigned ? '__UNASSIGNED__' : normalizeGeoGroupKey(areaName);
        const cnt = Number(g.total_count);
        const nr = Number(g.needs_review_count);
        const cf = Number(g.conflict_count);
        const unid = Number(g.unidentified_count);
        const conf = Number(g.confirmed_count);
        const prec = Number(g.precision_loss_count);
        const rowSignals = buildSignalsFromSample(g);

        totalCustomerRecords += cnt;
        if (isUnassigned) unassignedAreaCount += cnt;
        unidentifiedStreetCount += unid;
        conflictCount += cf;
        reviewRequiredCount += nr;

        let entry = areaMap.get(areaKey);
        if (!entry) {
          entry = {
            areaKey: isUnassigned ? '__UNASSIGNED__' : areaName,
            areaName,
            isUnassigned,
            totalCount: 0,
            unidentifiedCount: 0,
            needsReviewCount: 0,
            conflictCount: 0,
            confirmedCount: 0,
            precisionLossCount: 0,
            signals: [],
            streetMap: new Map(),
          };
          areaMap.set(areaKey, entry);
        }

        entry.totalCount += cnt;
        entry.unidentifiedCount += unid;
        entry.needsReviewCount += nr;
        entry.conflictCount += cf;
        entry.confirmedCount += conf;
        entry.precisionLossCount += prec;
        if (entry.signals.length < 40) entry.signals.push(...rowSignals.slice(0, 6));

        const sgLabel = g.street_group || 'UNIDENTIFIED';
        const sgKey = sgLabel === 'UNIDENTIFIED' ? '__UNIDENTIFIED__' : normalizeGeoGroupKey(sgLabel);
        let sgEntry = entry.streetMap.get(sgKey);
        if (!sgEntry) {
          sgEntry = {
            streetGroup: sgLabel,
            groupType: g.group_type || 'UNIDENTIFIED',
            count: 0,
            reviewRequiredCount: 0,
            conflictCount: 0,
            confirmedCount: 0,
            sectionHeadings: new Set(),
            signals: [],
          };
          entry.streetMap.set(sgKey, sgEntry);
        }
        sgEntry.count += cnt;
        sgEntry.reviewRequiredCount += nr;
        sgEntry.conflictCount += cf;
        sgEntry.confirmedCount += conf;
        sgEntry.signals.push(...rowSignals);
        if (Array.isArray(g.section_headings)) {
          for (const h of g.section_headings) {
            if (h) sgEntry.sectionHeadings.add(h);
          }
        }
      }

      const headingsRes = await db.query(
        `SELECT physical_row_number, sheet_name, detected_street AS heading_text, detected_area, heading_detection_reason, format_meta
         FROM source_rows
         WHERE upload_id = $1 AND row_type = 'SECTION_HEADING'
         ORDER BY physical_row_number ASC
         LIMIT 500`,
        [uploadId]
      );

      const areaList = Array.from(areaMap.entries());
      const areaByNormKey = new Map(areaList);
      const chainedAreas = buildChainedAreaAndPlaceRoute(
        areaList.map(([normKey, entry]) => ({
          key: normKey,
          displayName: entry.areaName,
          isUnassigned: entry.isUnassigned,
          rows: entry.signals,
          places: Array.from(entry.streetMap.entries()).map(([sgNormKey, sg]) => ({
            key: sgNormKey,
            displayName: sg.streetGroup,
            groupType: sg.groupType,
            isUnidentified: sg.streetGroup === 'UNIDENTIFIED',
            rows: sg.signals,
          })),
        })),
        {
          mergePlaceVariants: false,
          sortRowsInsidePlace: false,
        }
      );

      const areas = chainedAreas
        .map((ag) => {
          const entry = areaByNormKey.get(ag.key);
          if (!entry) return null;

          return {
            areaKey: entry.areaKey,
            areaName: entry.areaName,
            isUnassigned: entry.isUnassigned,
            areaStopNumber: ag.areaStopNumber,
            transitionedFrom: ag.transitionedFrom,
            totalCount: entry.totalCount,
            unidentifiedCount: entry.unidentifiedCount,
            needsReviewCount: entry.needsReviewCount,
            conflictCount: entry.conflictCount,
            confirmedCount: entry.confirmedCount,
            precisionLossCount: entry.precisionLossCount,
            streetGroups: ag.orderedPlaces
              .map((pg) => {
                const sg = entry.streetMap.get(pg.key);
                if (!sg) return null;
                return {
                  streetGroup: sg.streetGroup,
                  groupType: sg.groupType,
                  count: sg.count,
                  reviewRequiredCount: sg.reviewRequiredCount,
                  conflictCount: sg.conflictCount,
                  confirmedCount: sg.confirmedCount,
                  sectionHeadings: Array.from(sg.sectionHeadings),
                };
              })
              .filter((x): x is NonNullable<typeof x> => Boolean(x)),
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x));

      const distinctAreasCount = areas.filter((a) => !a.isUnassigned).length;
      const distinctStreetGroupsCount = areas.reduce(
        (acc, a) => acc + a.streetGroups.filter((sg) => sg.streetGroup !== 'UNIDENTIFIED').length,
        0
      );

      res.json({
        upload: upRes.rows[0],
        reconciliation: {
          ...reconciliation,
          totalCustomerRecords,
          distinctAreasCount,
          distinctStreetGroupsCount,
          unassignedAreaCount,
          unidentifiedStreetCount,
          conflictCount,
          reviewRequiredCount,
        },
        areas,
        headings: headingsRes.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  // Paginated Physical Row Audit viewer (every Excel row preserved 1-to-1)
  router.get('/uploads/:uploadId/rows', requirePermission('view'), validateUuidParams('uploadId'), async (req, res, next) => {
    try {
      const db = getDb();
      const uploadId = String(req.params.uploadId);
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 100)));
      const conds: string[] = ['sr.upload_id = $1'];
      const params: unknown[] = [uploadId];

      if (typeof req.query.rowType === 'string' && req.query.rowType && req.query.rowType !== 'ALL') {
        params.push(req.query.rowType);
        conds.push(`sr.row_type::text = $${params.length}`);
      }
      if (typeof req.query.reviewStatus === 'string' && req.query.reviewStatus && req.query.reviewStatus !== 'ALL') {
        params.push(req.query.reviewStatus);
        conds.push(`sr.review_status = $${params.length}`);
      }
      if (req.query.precisionLoss === 'true') {
        conds.push('sr.precision_loss_detected = true');
      }
      if (typeof req.query.area === 'string' && req.query.area) {
        if (req.query.area === '__UNASSIGNED__') {
          conds.push(`(sr.detected_area IS NULL OR sr.detected_area = '')`);
        } else {
          params.push(normalizeGeoGroupKey(req.query.area));
          conds.push(
            `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(sr.detected_area, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = $${params.length}`
          );
        }
      }
      if (typeof req.query.streetGroup === 'string' && req.query.streetGroup) {
        params.push(normalizeGeoGroupKey(req.query.streetGroup));
        conds.push(
          `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(sr.street_group, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = $${params.length}`
        );
      }
      if (typeof req.query.search === 'string' && req.query.search.trim()) {
        params.push(`%${req.query.search.trim()}%`);
        conds.push(
          `(sr.raw_cells::text ILIKE $${params.length} OR COALESCE(sr.active_section_heading, '') ILIKE $${params.length} OR COALESCE(sr.detected_area, '') ILIKE $${params.length} OR COALESCE(sr.street_group, '') ILIKE $${params.length})`
        );
      }

      const whereSql = `WHERE ${conds.join(' AND ')}`;
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM source_rows sr ${whereSql}`,
        params
      );
      const total = Number(countRes.rows[0]?.count || 0);
      const offset = (page - 1) * pageSize;

      const listRes = await db.query(
        `SELECT sr.*, cr.full_name, cr.consumer_id, cr.phone_display, cr.phone_e164, cr.status AS clean_status
         FROM source_rows sr
         LEFT JOIN upload_sheets us ON us.id = sr.sheet_id
         LEFT JOIN clean_records cr ON cr.id = sr.clean_record_id
         ${whereSql}
         ORDER BY COALESCE(us.sheet_index, 0) ASC, sr.physical_row_number ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      );

      res.json({ items: listRes.rows, total, page, pageSize });
    } catch (err) {
      next(err);
    }
  });

  // Manual geographic correction / approval for an individual customer record
  router.patch(
    '/records/:recordId',
    requirePermission('edit'),
    validateUuidParams('recordId'),
    validateBody(ManualGeoPatchSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const db = getDb();
        const recordId = String(req.params.recordId);
        const body = req.body as z.infer<typeof ManualGeoPatchSchema>;

        const updated = await db.transaction(async (tx) => {
          const curRes = await tx.query<Record<string, any>>(
            `SELECT * FROM clean_records WHERE id = $1 AND deleted_at IS NULL`,
            [recordId]
          );
          const cur = curRes.rows[0];
          if (!cur) return null;

          const nextArea = body.area !== undefined ? canonicalizeGeoLabel(body.area) : cur.area;
          const nextSubArea = body.subArea !== undefined ? canonicalizeGeoLabel(body.subArea) : cur.sub_area;
          const nextStreet = body.street !== undefined ? canonicalizeGeoLabel(body.street) : cur.street;
          const nextStreetGroup =
            body.streetGroup !== undefined
              ? canonicalizeGeoLabel(body.streetGroup) || 'UNIDENTIFIED'
              : body.street !== undefined && nextStreet
                ? nextStreet
                : cur.street_group || 'UNIDENTIFIED';
          const nextGroupType =
            body.groupType !== undefined && body.groupType
              ? body.groupType
              : nextStreetGroup === 'UNIDENTIFIED'
                ? 'UNIDENTIFIED'
                : inferGroupType(nextStreetGroup);

          const provenance = { ...(cur.provenance || {}) };
          if (body.area !== undefined) provenance.area = 'STANDARDISED';
          if (body.street !== undefined || body.streetGroup !== undefined) provenance.street = 'STANDARDISED';

          const nextGeoStatus = body.approveClassification
            ? 'APPROVED'
            : nextStreetGroup === 'UNIDENTIFIED'
              ? 'UNIDENTIFIED'
              : 'CONFIRMED';
          const nextRecordStatus =
            body.approveClassification && cur.status !== 'INVALID'
              ? 'APPROVED'
              : cur.status === 'NEEDS_REVIEW' && nextGeoStatus === 'CONFIRMED'
                ? 'VERIFIED'
                : cur.status;

          const upRes = await tx.query(
            `UPDATE clean_records
             SET area = $2,
                 sub_area = $3,
                 locality = $3,
                 street = $4,
                 street_group = $5,
                 group_type = $6,
                 classification_source = 'MANUAL_REVIEW',
                 classification_confidence = 1.000,
                 geographic_review_status = $7,
                 geographic_conflict_reason = NULL,
                 provenance = $8::jsonb,
                 status = $9::record_status,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [
              recordId,
              nextArea,
              nextSubArea,
              nextStreet,
              nextStreetGroup,
              nextGroupType,
              nextGeoStatus,
              JSON.stringify(provenance),
              nextRecordStatus,
            ]
          );

          await tx.query(
            `UPDATE source_rows
             SET detected_area = $2,
                 detected_sub_area = $3,
                 detected_street = $4,
                 street_group = $5,
                 group_type = $6,
                 classification_source = 'MANUAL_REVIEW',
                 classification_confidence = 1.000,
                 review_status = $7,
                 conflict_reason = NULL,
                 row_type = CASE WHEN row_type = 'NEEDS_REVIEW' AND $7 IN ('CONFIRMED', 'APPROVED') THEN 'CUSTOMER_RECORD'::row_type ELSE row_type END
             WHERE clean_record_id = $1`,
            [recordId, nextArea, nextSubArea, nextStreet, nextStreetGroup, nextGroupType, nextGeoStatus]
          );

          if (body.saveAliasToDictionary && cur.street_group && nextStreetGroup !== 'UNIDENTIFIED' && cur.street_group !== nextStreetGroup) {
            await tx.query(
              `INSERT INTO geo_dictionaries (upload_id, level, parent_area, alias_label, canonical_label, group_type, is_approved, created_by)
               VALUES ($1, 'STREET', $2, $3, $4, $5, true, $6)`,
              [cur.upload_id, nextArea, cur.street_group, nextStreetGroup, nextGroupType, req.authUser!.id]
            );
          }

          await refreshGeoCategoriesForRecords(tx, [recordId]);

          await tx.query(
            `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, actor_id)
             VALUES ($1, 'GEO_MANUAL_EDIT', $2::jsonb, $3::jsonb, $4, $5)`,
            [
              recordId,
              JSON.stringify(cur),
              JSON.stringify(upRes.rows[0]),
              ['area', 'sub_area', 'street', 'street_group', 'geographic_review_status'],
              req.authUser!.id,
            ]
          );

          return upRes.rows[0];
        });

        if (!updated) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } });
        }

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'GEO_RECORD_UPDATE',
          resourceType: 'clean_record',
          resourceId: recordId,
          req,
          metadata: {
            area: updated.area,
            streetGroup: updated.street_group,
            reviewStatus: updated.geographic_review_status,
          },
        });

        res.json({ record: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  // Explicit user-approved rename or merge of Area or StreetGroup labels
  router.post(
    '/groups/rename-merge',
    requirePermission('edit'),
    validateBody(RenameMergeGroupSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const db = getDb();
        const body = req.body as z.infer<typeof RenameMergeGroupSchema>;
        const canonicalTarget = canonicalizeGeoLabel(body.targetLabel) || cleanText(body.targetLabel) || body.targetLabel.trim();
        const nextType = body.targetGroupType || inferGroupType(canonicalTarget);

        const result = await db.transaction(async (tx) => {
          let updatedRows: Array<{ id: string }> = [];
          if (body.level === 'AREA') {
            const matchesUnassigned = body.sourceLabels.some((s) => s === '__UNASSIGNED__' || s === 'UNASSIGNED');
            const namedSources = body.sourceLabels
              .filter((s) => s !== '__UNASSIGNED__' && s !== 'UNASSIGNED')
              .map((s) => normalizeGeoGroupKey(s))
              .filter(Boolean);
            const r = await tx.query<{ id: string }>(
              `UPDATE clean_records
               SET area = $2,
                   classification_source = 'MANUAL_MERGE',
                   geographic_review_status = CASE WHEN geographic_review_status = 'UNIDENTIFIED' THEN geographic_review_status ELSE 'CONFIRMED' END,
                   updated_at = NOW()
               WHERE upload_id = $1 AND deleted_at IS NULL AND is_merged = false
                 AND (LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(area, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = ANY($3::text[]) OR ($4::boolean AND (area IS NULL OR TRIM(area) = '')))
               RETURNING id`,
              [body.uploadId, canonicalTarget, namedSources, matchesUnassigned]
            );
            updatedRows = r.rows;

            await tx.query(
              `UPDATE source_rows
               SET detected_area = $2, classification_source = 'MANUAL_MERGE'
               WHERE upload_id = $1
                 AND (LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(detected_area, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = ANY($3::text[]) OR ($4::boolean AND (detected_area IS NULL OR TRIM(detected_area) = '')))`,
              [body.uploadId, canonicalTarget, namedSources, matchesUnassigned]
            );
          } else {
            const normStreetSources = body.sourceLabels.map((s) => normalizeGeoGroupKey(s)).filter(Boolean);
            const areaCond =
              body.parentArea === '__UNASSIGNED__'
                ? `(area IS NULL OR TRIM(area) = '')`
                : body.parentArea
                  ? `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(area, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = $5`
                  : 'TRUE';
            const params: unknown[] = [body.uploadId, canonicalTarget, nextType, normStreetSources];
            if (body.parentArea && body.parentArea !== '__UNASSIGNED__') {
              params.push(normalizeGeoGroupKey(body.parentArea));
            }

            const r = await tx.query<{ id: string }>(
              `UPDATE clean_records
               SET street_group = $2,
                   group_type = $3,
                   classification_source = 'MANUAL_MERGE',
                   geographic_review_status = 'CONFIRMED',
                   geographic_conflict_reason = NULL,
                   updated_at = NOW()
               WHERE upload_id = $1 AND deleted_at IS NULL AND is_merged = false
                 AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(NULLIF(street_group, ''), 'UNIDENTIFIED')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = ANY($4::text[])
                 AND ${areaCond}
               RETURNING id`,
              params
            );
            updatedRows = r.rows;

            const srAreaCond =
              body.parentArea === '__UNASSIGNED__'
                ? `(detected_area IS NULL OR TRIM(detected_area) = '')`
                : body.parentArea
                  ? `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(detected_area, '')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = $5`
                  : 'TRUE';
            await tx.query(
              `UPDATE source_rows
               SET street_group = $2, group_type = $3, classification_source = 'MANUAL_MERGE', review_status = 'CONFIRMED', conflict_reason = NULL
               WHERE upload_id = $1
                 AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(BOTH ' -:;|,.' FROM COALESCE(NULLIF(street_group, ''), 'UNIDENTIFIED')), '\\s*-\\s*', ' - ', 'g'), '\\s+', ' ', 'g')) = ANY($4::text[])
                 AND ${srAreaCond}`,
              params
            );
          }

          if (body.saveDictionaryAlias) {
            for (const src of body.sourceLabels) {
              if (src === '__UNASSIGNED__' || src === 'UNIDENTIFIED' || src === canonicalTarget) continue;
              await tx.query(
                `INSERT INTO geo_dictionaries (upload_id, level, parent_area, alias_label, canonical_label, group_type, is_approved, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
                [
                  body.uploadId,
                  body.level === 'AREA' ? 'AREA' : 'STREET',
                  body.parentArea && body.parentArea !== '__UNASSIGNED__' ? body.parentArea : null,
                  src,
                  canonicalTarget,
                  body.level === 'STREET_GROUP' ? nextType : null,
                  req.authUser!.id,
                ]
              );
            }
          }

          const ids = updatedRows.map((r) => r.id);
          await refreshGeoCategoriesForRecords(tx, ids);
          for (const id of ids.slice(0, 200)) {
            await tx.query(
              `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, actor_id)
               VALUES ($1, 'GEO_GROUP_RENAME_MERGE', $2::jsonb, $3::jsonb, $4, $5)`,
              [
                id,
                JSON.stringify({ sourceLabels: body.sourceLabels }),
                JSON.stringify({ targetLabel: canonicalTarget }),
                [body.level === 'AREA' ? 'area' : 'street_group'],
                req.authUser!.id,
              ]
            );
          }

          return ids.length;
        });

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'GEO_GROUP_RENAME_MERGE',
          resourceType: 'upload',
          resourceId: body.uploadId,
          req,
          metadata: {
            level: body.level,
            sourceLabels: body.sourceLabels,
            targetLabel: canonicalTarget,
            updatedCount: result,
          },
        });

        res.json({ updatedCount: result, targetLabel: canonicalTarget });
      } catch (err) {
        next(err);
      }
    }
  );

  // Split selected records out into a separate Area / StreetGroup
  router.post(
    '/groups/split',
    requirePermission('edit'),
    validateBody(SplitGroupSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const db = getDb();
        const body = req.body as z.infer<typeof SplitGroupSchema>;
        const targetStreetGroup = canonicalizeGeoLabel(body.targetStreetGroup) || body.targetStreetGroup.trim();
        const targetType = body.targetGroupType || inferGroupType(targetStreetGroup);
        const targetArea = body.targetArea !== undefined ? canonicalizeGeoLabel(body.targetArea) : undefined;
        const targetSubArea = body.targetSubArea !== undefined ? canonicalizeGeoLabel(body.targetSubArea) : undefined;

        const updatedCount = await db.transaction(async (tx) => {
          const r = await tx.query<{ id: string }>(
            `UPDATE clean_records
             SET area = CASE WHEN $2::boolean THEN $3 ELSE area END,
                 sub_area = CASE WHEN $4::boolean THEN $5 ELSE sub_area END,
                 locality = CASE WHEN $4::boolean THEN $5 ELSE locality END,
                 street_group = $6,
                 group_type = $7,
                 classification_source = 'MANUAL_SPLIT',
                 classification_confidence = 1.000,
                 geographic_review_status = 'CONFIRMED',
                 geographic_conflict_reason = NULL,
                 updated_at = NOW()
             WHERE upload_id = $1 AND id = ANY($8::uuid[]) AND deleted_at IS NULL
             RETURNING id`,
            [
              body.uploadId,
              targetArea !== undefined,
              targetArea ?? null,
              targetSubArea !== undefined,
              targetSubArea ?? null,
              targetStreetGroup,
              targetType,
              body.recordIds,
            ]
          );

          await tx.query(
            `UPDATE source_rows
             SET detected_area = CASE WHEN $1::boolean THEN $2 ELSE detected_area END,
                 detected_sub_area = CASE WHEN $3::boolean THEN $4 ELSE detected_sub_area END,
                 street_group = $5,
                 group_type = $6,
                 classification_source = 'MANUAL_SPLIT',
                 classification_confidence = 1.000,
                 review_status = 'CONFIRMED',
                 conflict_reason = NULL
             WHERE clean_record_id = ANY($7::uuid[])`,
            [
              targetArea !== undefined,
              targetArea ?? null,
              targetSubArea !== undefined,
              targetSubArea ?? null,
              targetStreetGroup,
              targetType,
              body.recordIds,
            ]
          );

          const ids = r.rows.map((x) => x.id);
          await refreshGeoCategoriesForRecords(tx, ids);
          for (const id of ids) {
            await tx.query(
              `INSERT INTO record_history (clean_record_id, action, before_state, after_state, changed_fields, actor_id)
               VALUES ($1, 'GEO_GROUP_SPLIT', '{}'::jsonb, $2::jsonb, $3, $4)`,
              [id, JSON.stringify({ targetArea, targetStreetGroup }), ['area', 'street_group'], req.authUser!.id]
            );
          }
          return ids.length;
        });

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'GEO_GROUP_SPLIT',
          resourceType: 'upload',
          resourceId: body.uploadId,
          req,
          metadata: { updatedCount, targetArea, targetStreetGroup },
        });

        res.json({ updatedCount, targetStreetGroup });
      } catch (err) {
        next(err);
      }
    }
  );

  // Queue background reprocessing of geographic classification (or full physical re-ingest if hidden-row mode toggled)
  router.post(
    '/uploads/:uploadId/reprocess',
    requirePermission('process'),
    validateUuidParams('uploadId'),
    validateBody(ReprocessGeoSchema),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const db = getDb();
        const uploadId = String(req.params.uploadId);
        const body = req.body as z.infer<typeof ReprocessGeoSchema>;

        const sheetRes = await db.query<{ id: string; include_hidden_rows: boolean }>(
          `SELECT id, include_hidden_rows FROM upload_sheets WHERE upload_id = $1 AND is_selected = true ORDER BY sheet_index ASC`,
          [uploadId]
        );
        const sheets = sheetRes.rows;
        if (sheets.length === 0) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Selected worksheet not found.' } });
        }

        const jobs = [];
        for (const sheet of sheets) {
          const hiddenChanged =
            body.includeHiddenRows !== undefined && body.includeHiddenRows !== sheet.include_hidden_rows;
          if (body.includeHiddenRows !== undefined) {
            await db.query(`UPDATE upload_sheets SET include_hidden_rows = $2 WHERE id = $1`, [
              sheet.id,
              body.includeHiddenRows,
            ]);
          }

          const jobRes = await db.query(
            `INSERT INTO jobs (job_type, status, upload_id, sheet_id, created_by, payload)
             VALUES ('REPROCESS_CATEGORISE', 'QUEUED', $1, $2, $3, $4::jsonb)
             RETURNING *`,
            [
              uploadId,
              sheet.id,
              req.authUser!.id,
              JSON.stringify({ fullReingest: Boolean(body.fullReingest || hiddenChanged) }),
            ]
          );
          jobs.push(jobRes.rows[0]);
        }

        await emitAuditLog({
          actorId: req.authUser!.id,
          actorRole: req.authUser!.role,
          action: 'GEO_REPROCESS_QUEUE',
          resourceType: 'upload',
          resourceId: uploadId,
          req,
          metadata: { jobId: jobs[0].id, sheetCount: jobs.length },
        });

        if (jobWorker.isRunning) {
          jobWorker.wake();
          return res.status(202).json({ job: jobs[0], jobs });
        }

        await jobWorker.advanceUntilSettled(3500);
        const refreshed = await db.query('SELECT * FROM jobs WHERE id = $1', [jobs[0].id]);
        res.status(202).json({ job: refreshed.rows[0] || jobs[0], jobs });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
