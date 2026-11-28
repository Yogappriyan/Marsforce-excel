import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { getDb } from '../../infrastructure/db/index.ts';
import { jobWorker } from '../../infrastructure/queue/PostgresJobWorker.ts';
import { getActiveLLMProvider, type GeoRouteAreaInput, type GeoRoutePlaceInput } from '../../infrastructure/llm/LLMProvider.ts';
import { getStorageAdapter } from '../../infrastructure/storage/StorageAdapter.ts';
import {
  requireAuth,
  requirePermission,
  validateBody,
  validateUuidParams,
  type AuthenticatedRequest,
} from '../../middleware/security.ts';
import { emitAuditLog } from '../audit/audit.module.ts';
import {
  canonicalizeGeoLabel,
  extractSignificantTokens,
  normalizeGeoGroupKey,
  parseAddressHierarchy,
} from '../processing/geoIntelligence.engine.ts';
import { buildRecordFilterClause } from '../records/records.module.ts';
import {
  buildAreaWorkbookWithStats,
  buildCombinedRouteWorkbookWithStats,
  buildOrderedPlaceGroups,
  buildGeoZipBundle,
  neutralizeExcelCell,
  safeFileSegment,
  safeWorksheetName,
  type GeoExportRecord,
  type SourceRowAuditExportItem,
} from './geoExcelBuilder.ts';

export { neutralizeExcelCell };

export type ExportMode = 'ROUTE_XLSX' | 'AREA_WISE' | 'COMBINED_ZIP' | 'SINGLE_XLSX' | 'CSV';

const AllowedExportColumnEnum = z.enum([
  'consumer_id',
  'distributor_id',
  'full_name',
  'phone_e164',
  'phone_display',
  'street',
  'sub_area',
  'area',
  'street_group',
  'group_type',
  'city',
  'district',
  'state',
  'pin_code',
  'status',
  'geographic_review_status',
  'overall_confidence',
  'provenance',
  'issues',
]);

function sanitizeExportDto<T extends Record<string, any>>(row: T): Omit<T, 'storage_key'> {
  if (!row || typeof row !== 'object') return row;
  const { storage_key: _omittedKey, ...safe } = row;
  return safe;
}

const CreateExportSchema = z.object({
  exportMode: z.enum(['ROUTE_XLSX', 'AREA_WISE', 'COMBINED_ZIP', 'SINGLE_XLSX', 'CSV']).optional(),
  format: z.enum(['XLSX', 'CSV', 'ZIP']).optional(),
  filters: z
    .object({
      uploadId: z.union([z.string().uuid(), z.literal('')]).optional(),
      status: z.string().optional(),
      area: z.string().optional(),
      streetGroup: z.string().optional(),
      geoStatus: z.string().optional(),
      city: z.string().optional(),
      district: z.string().optional(),
      state: z.string().optional(),
      search: z.string().optional(),
      categoryValue: z.string().optional(),
    })
    .default({}),
  columnOrder: z
    .array(AllowedExportColumnEnum)
    .default([
      'full_name',
      'consumer_id',
      'phone_e164',
      'phone_display',
      'street',
      'sub_area',
      'area',
      'street_group',
      'city',
      'district',
      'state',
      'pin_code',
      'status',
      'overall_confidence',
    ]),
  splitBy: z.enum(['NONE', 'CITY', 'DISTRICT', 'STATE', 'CATEGORY']).default('NONE'),
  includeOriginalSheet: z.boolean().default(true),
});

const COLUMN_LABELS: Record<string, string> = {
  consumer_id: 'Consumer ID',
  distributor_id: 'Distributor ID',
  full_name: 'Customer Name',
  phone_e164: 'Phone (E.164)',
  phone_display: 'Phone (Display)',
  street: 'Street',
  sub_area: 'SubArea / Locality',
  area: 'Area',
  street_group: 'Street / Locality Group',
  group_type: 'Group Type',
  city: 'City',
  district: 'District',
  state: 'State',
  pin_code: 'PIN Code',
  status: 'Review Status',
  geographic_review_status: 'Geo Review Status',
  overall_confidence: 'Confidence Score',
  provenance: 'Field Provenance',
  issues: 'Validation Issues',
};

const TEXT_ID_COLS = new Set(['consumer_id', 'distributor_id', 'phone_e164', 'phone_display', 'pin_code']);

function extractRowValue(row: Record<string, any>, colKey: string): string | number | null {
  if (colKey === 'provenance') {
    return neutralizeExcelCell(JSON.stringify(row.provenance || {}));
  }
  if (colKey === 'issues') {
    const arr = Array.isArray(row.issues) ? row.issues : [];
    return neutralizeExcelCell(arr.map((i: any) => `[${i.code}] ${i.message}`).join('; '));
  }
  if (colKey === 'overall_confidence') {
    return Number(row.overall_confidence ?? 0);
  }
  return neutralizeExcelCell(row[colKey] ?? '');
}

async function computeAiPlaceOrdersByArea(records: GeoExportRecord[]): Promise<Map<string, string[]>> {
  const aiOrders = new Map<string, string[]>();
  try {
    const provider = await getActiveLLMProvider();
    if (!provider.isConfigured()) return aiOrders;

    const areaBuckets = new Map<string, { displayName: string; rows: GeoExportRecord[] }>();
    for (const r of records) {
      const rawArea = r.area && r.area.trim() ? r.area.trim() : '';
      if (!rawArea || rawArea.toUpperCase() === 'UNASSIGNED') continue;
      const areaKey = normalizeGeoGroupKey(rawArea);
      const displayName = canonicalizeGeoLabel(rawArea) || rawArea;
      const bucket = areaBuckets.get(areaKey);
      if (bucket) bucket.rows.push(r);
      else areaBuckets.set(areaKey, { displayName, rows: [r] });
    }

    for (const [areaKey, bucket] of areaBuckets.entries()) {
      const preGroups = buildOrderedPlaceGroups(bucket.rows).filter(
        (g) => !g.isUnidentified && g.key !== '__UNIDENTIFIED__'
      );
      if (preGroups.length < 3 || preGroups.length > 80) continue;

      // Privacy-safe payload: only place labels, PINs, postal zones, and non-PII locality context hints
      const placeInputs: GeoRoutePlaceInput[] = preGroups.map((g) => {
        const pins = new Set<string>();
        const zones = new Set<string>();
        const hints = new Set<string>();
        for (const row of g.rows) {
          if (row.pin_code && /^[1-9]\d{5}$/.test(row.pin_code.trim())) {
            pins.add(row.pin_code.trim());
          }
          const rawAddr = Object.entries(row.raw_data || {})
            .filter(([k, v]) => /(addr|address|loc|street|area|place|city|pin)/i.test(k) && v)
            .map(([, v]) => String(v))
            .join(', ');
          const parsed = parseAddressHierarchy(rawAddr);
          if (parsed.pinCode) pins.add(parsed.pinCode);
          if (parsed.postalZoneHint) zones.add(parsed.postalZoneHint);
          if (row.sub_area) hints.add(row.sub_area);
          if (parsed.areaFromAddress) hints.add(parsed.areaFromAddress);
          if (row.city) hints.add(row.city);
          if (row.street && !/\d{6,}/.test(row.street)) {
            const tokens = extractSignificantTokens(row.street).slice(0, 3).join(' ');
            if (tokens) hints.add(tokens);
          }
        }
        return {
          key: g.key,
          label: g.displayName,
          pins: Array.from(pins).slice(0, 6),
          zones: Array.from(zones).slice(0, 6),
          contextHints: Array.from(hints).slice(0, 6),
        };
      });

      const orderedKeys = await provider.orderLocalitiesByProximityBatch(bucket.displayName, placeInputs);
      if (orderedKeys && orderedKeys.length > 0) {
        aiOrders.set(areaKey, orderedKeys);
      }
    }
  } catch {
    // Deterministic spatial proximity graph remains primary fallback
  }
  return aiOrders;
}

async function computeAiAreaOrder(records: GeoExportRecord[]): Promise<string[] | null> {
  try {
    const provider = await getActiveLLMProvider();
    if (!provider.isConfigured()) return null;

    const areaBuckets = new Map<string, { displayName: string; rows: GeoExportRecord[] }>();
    const cityCounts = new Map<string, number>();

    for (const r of records) {
      if (r.city && r.city.trim()) {
        const c = r.city.trim();
        cityCounts.set(c, (cityCounts.get(c) || 0) + 1);
      }
      const rawArea = r.area && r.area.trim() ? r.area.trim() : '';
      if (!rawArea || rawArea.toUpperCase() === 'UNASSIGNED') continue;
      const areaKey = normalizeGeoGroupKey(rawArea);
      const displayName = canonicalizeGeoLabel(rawArea) || rawArea;
      const bucket = areaBuckets.get(areaKey);
      if (bucket) bucket.rows.push(r);
      else areaBuckets.set(areaKey, { displayName, rows: [r] });
    }

    if (areaBuckets.size < 3 || areaBuckets.size > 60) return null;

    const topCity = Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'India Service Region';

    const areaInputs: GeoRouteAreaInput[] = Array.from(areaBuckets.entries()).map(([key, bucket]) => {
      const pins = new Set<string>();
      const zones = new Set<string>();
      const localities = new Set<string>();
      for (const row of bucket.rows) {
        if (row.pin_code && /^[1-9]\d{5}$/.test(row.pin_code.trim())) {
          pins.add(row.pin_code.trim());
        }
        if (row.street_group && row.street_group.toUpperCase() !== 'UNIDENTIFIED') {
          localities.add(row.street_group);
        }
        if (row.sub_area) localities.add(row.sub_area);
        const rawAddr = Object.entries(row.raw_data || {})
          .filter(([k, v]) => /(addr|address|loc|street|area|place|city|pin)/i.test(k) && v)
          .map(([, v]) => String(v))
          .join(', ');
        const parsed = parseAddressHierarchy(rawAddr);
        if (parsed.pinCode) pins.add(parsed.pinCode);
        if (parsed.postalZoneHint) zones.add(parsed.postalZoneHint);
      }
      return {
        key,
        label: bucket.displayName,
        pins: Array.from(pins).slice(0, 6),
        zones: Array.from(zones).slice(0, 6),
        sampleLocalities: Array.from(localities).slice(0, 10),
      };
    });

    return await provider.orderAreasByRouteProximity(topCity, areaInputs);
  } catch {
    return null;
  }
}

export async function runExportJob(exportId: string): Promise<void> {
  const db = getDb();
  const expRes = await db.query<{
    id: string;
    format: 'XLSX' | 'CSV' | 'ZIP';
    export_mode: ExportMode;
    is_zip: boolean;
    filename: string;
    filters: Record<string, unknown>;
    column_order: string[];
    split_by: 'NONE' | 'CITY' | 'DISTRICT' | 'STATE' | 'CATEGORY';
    include_original_sheet: boolean;
  }>('SELECT * FROM exports WHERE id = $1', [exportId]);
  const exp = expRes.rows[0];
  if (!exp) throw new Error('Export record not found');

  await db.query(`UPDATE exports SET status = 'RUNNING', progress = 5 WHERE id = $1`, [exportId]);

  try {
    const filters = exp.filters || {};
    const { whereSql, params } = buildRecordFilterClause(filters);
    const rowsRes = await db.query<GeoExportRecord & { category_values?: string[] }>(
      `SELECT cr.*, rr.row_number, rr.raw_data,
              (SELECT COALESCE(json_agg(rc.category_value), '[]'::json)
               FROM record_categories rc WHERE rc.clean_record_id = cr.id) AS category_values
       FROM clean_records cr
       JOIN raw_records rr ON rr.id = cr.raw_record_id
       ${whereSql}
       ORDER BY COALESCE(cr.original_row_number, rr.row_number) ASC, rr.row_number ASC`,
      params
    );
    const rows = rowsRes.rows;

    const mode: ExportMode =
      exp.export_mode || (exp.format === 'CSV' ? 'CSV' : exp.format === 'ZIP' ? 'AREA_WISE' : 'SINGLE_XLSX');
    const cols =
      exp.column_order.length > 0
        ? exp.column_order
        : ['consumer_id', 'full_name', 'phone_e164', 'street', 'area', 'street_group', 'city', 'state', 'pin_code'];

    let outputBuffer: Buffer;
    let contentType: string;
    let manifest: Record<string, any> = { mode, totalCustomerRecords: rows.length };

    if (mode === 'CSV' || exp.format === 'CSV') {
      const headerLine = cols.map((c) => `"${(COLUMN_LABELS[c] || c).replace(/"/g, '""')}"`).join(',');
      const lines = [headerLine];
      for (const r of rows) {
        const line = cols
          .map((c) => {
            const val = extractRowValue(r, c);
            return `"${String(val ?? '').replace(/"/g, '""')}"`;
          })
          .join(',');
        lines.push(line);
      }
      outputBuffer = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
      contentType = 'text/csv; charset=utf-8';
    } else if (mode === 'AREA_WISE' && typeof filters.area === 'string' && filters.area.trim() && !exp.is_zip) {
      const areaLabel = filters.area === '__UNASSIGNED__' ? 'UNASSIGNED' : filters.area.trim();
      if (rows.length === 0) {
        throw new Error(`No customer records found for Area "${areaLabel}".`);
      }
      const origHeaders = Array.from(new Set(rows.flatMap((r) => Object.keys(r.raw_data || {}))));
      const aiPlaceOrdersByArea = await computeAiPlaceOrdersByArea(rows);
      const areaDisplay = rows[0]?.area || areaLabel;
      const areaAiKeys = aiPlaceOrdersByArea.get(normalizeGeoGroupKey(areaDisplay)) || null;
      const { buffer, stats } = await buildAreaWorkbookWithStats({
        areaName: areaDisplay,
        records: rows,
        originalHeaders: origHeaders,
        aiOrderedKeys: areaAiKeys,
      });
      if (
        stats.structuredDataCount !== stats.allRecordsCount ||
        stats.allRecordsCount !== stats.summaryTotalCount ||
        stats.allRecordsCount !== rows.length
      ) {
        throw new Error(`EXPORT_RECONCILIATION_FAILED: Single area workbook mismatch for "${areaLabel}".`);
      }
      outputBuffer = buffer;
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      manifest = {
        mode: 'SINGLE_AREA_XLSX',
        areaName: stats.areaName,
        totalCustomerRecords: rows.length,
        assignedAreaRecords: rows.length,
        unassignedAreaRecords: 0,
        needsReviewCount: stats.needsReviewCount,
        distinctValidAreaCount: 1,
        areaWorkbookCount: 1,
        streetWorkbookCount: 0,
        reconciliation: {
          status: 'VERIFIED',
          checkedAt: new Date().toISOString(),
          formula: `${rows.length} exported across ${stats.identifiedStreetGroupsCount} street groups + ${stats.unidentifiedStreetCount} unidentified`,
        },
      };
    } else if (mode === 'ROUTE_XLSX') {
      if (rows.length === 0) {
        throw new Error('No customer records matched the selected export filters.');
      }
      const origHeaders = Array.from(new Set(rows.flatMap((r) => Object.keys(r.raw_data || {}))));
      const [aiAreaOrder, aiPlaceOrdersByArea] = await Promise.all([
        computeAiAreaOrder(rows),
        computeAiPlaceOrdersByArea(rows),
      ]);
      const { buffer, stats } = await buildCombinedRouteWorkbookWithStats({
        records: rows,
        originalHeaders: origHeaders,
        aiAreaOrder,
        aiPlaceOrdersByArea,
        onProgress: async (pct) => {
          await db.query(`UPDATE exports SET progress = $2 WHERE id = $1`, [exportId, pct]);
        },
      });
      if (
        stats.structuredDataCount !== stats.allRecordsCount ||
        stats.allRecordsCount !== stats.summaryTotalCount ||
        stats.allRecordsCount !== rows.length
      ) {
        throw new Error(`EXPORT_RECONCILIATION_FAILED: Combined route export row count mismatch.`);
      }
      outputBuffer = buffer;
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      manifest = {
        mode: 'ROUTE_XLSX',
        totalCustomerRecords: rows.length,
        assignedAreaRecords: rows.length - stats.unassignedAreaRecordsCount,
        unassignedAreaRecords: stats.unassignedAreaRecordsCount,
        needsReviewCount: stats.needsReviewCount,
        unidentifiedLocationCount: stats.unidentifiedLocationCount,
        distinctValidAreaCount: stats.distinctValidAreaCount,
        identifiedPlaceStopsCount: stats.identifiedPlaceStopsCount,
        areaWorkbookCount: 1,
        streetWorkbookCount: 0,
        areaRouteOrder: stats.areaRouteOrder,
        reconciliation: {
          status: 'VERIFIED',
          checkedAt: new Date().toISOString(),
          formula: `${rows.length} customers sequenced across ${stats.distinctValidAreaCount} chained Areas & ${stats.identifiedPlaceStopsCount} street/place stops`,
        },
      };
    } else if (mode === 'COMBINED_ZIP' || mode === 'AREA_WISE') {
      let sourceRows: SourceRowAuditExportItem[] = [];
      if (mode === 'COMBINED_ZIP') {
        const srSql = filters.uploadId
          ? `SELECT sheet_name, physical_row_number, row_type::text AS row_type, active_section_heading,
                    detected_area, detected_sub_area, detected_street, street_group, group_type,
                    classification_source, classification_confidence, review_status, conflict_reason,
                    heading_detection_reason, precision_loss_detected, raw_cells, format_meta, validation_issues
             FROM source_rows WHERE upload_id = $1 ORDER BY sheet_name ASC, physical_row_number ASC`
          : `SELECT sheet_name, physical_row_number, row_type::text AS row_type, active_section_heading,
                    detected_area, detected_sub_area, detected_street, street_group, group_type,
                    classification_source, classification_confidence, review_status, conflict_reason,
                    heading_detection_reason, precision_loss_detected, raw_cells, format_meta, validation_issues
             FROM source_rows ORDER BY upload_id, sheet_name ASC, physical_row_number ASC LIMIT 120000`;
        const srRes = await db.query<SourceRowAuditExportItem>(
          srSql,
          filters.uploadId ? [filters.uploadId] : []
        );
        sourceRows = srRes.rows;
      }

      const [aiAreaOrder, aiPlaceOrdersByArea] = await Promise.all([
        computeAiAreaOrder(rows),
        computeAiPlaceOrdersByArea(rows),
      ]);

      const bundle = await buildGeoZipBundle({
        mode,
        records: rows,
        sourceRows,
        aiAreaOrder,
        aiPlaceOrdersByArea,
        onProgress: async (pct) => {
          await db.query(`UPDATE exports SET progress = $2 WHERE id = $1`, [exportId, pct]);
        },
      });
      outputBuffer = bundle.zipBuffer;
      contentType = 'application/zip';
      manifest = bundle.manifest;
    } else {
      // Legacy SINGLE_XLSX streaming writer (Master Data + Summary + Processing Report + Split tabs + Original Data)
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      const bufferDone = new Promise<Buffer>((resolve, reject) => {
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });

      const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
      wb.creator = 'MARSFORCE';
      wb.created = new Date();

      const usedNames = new Set<string>(['summary', 'processing report', 'original data', 'master data']);

      const styleAndWriteSheet = async (ws: ExcelJS.Worksheet, sheetRows: Record<string, any>[]) => {
        ws.columns = cols.map((key) => ({
          header: COLUMN_LABELS[key] || key,
          key,
          width: key === 'street' ? 28 : key === 'full_name' ? 24 : 18,
          style: TEXT_ID_COLS.has(key) ? { numFmt: '@' } : undefined,
        }));
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
        headerRow.height = 24;
        headerRow.commit();

        for (const r of sheetRows) {
          const rowObj: Record<string, unknown> = {};
          for (const c of cols) {
            rowObj[c] = extractRowValue(r, c);
          }
          const added = ws.addRow(rowObj);
          cols.forEach((c, idx) => {
            if (TEXT_ID_COLS.has(c)) {
              added.getCell(idx + 1).numFmt = '@';
            }
          });
          added.commit();
        }
        if (cols.length > 0) {
          ws.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: cols.length },
          };
        }
        await ws.commit();
      };

      const masterWs = wb.addWorksheet('Master Data', { views: [{ state: 'frozen', ySplit: 1 }] });
      await styleAndWriteSheet(masterWs, rows);

      const summaryWs = wb.addWorksheet('Summary');
      const titleRow = summaryWs.addRow(['MARSFORCE Export Summary']);
      titleRow.font = { bold: true, size: 14 };
      titleRow.commit();
      summaryWs.addRow(['Generated At', new Date().toISOString()]).commit();
      summaryWs.addRow(['Total Exported Records', rows.length]).commit();
      summaryWs.addRow(['Split Mode', exp.split_by]).commit();
      summaryWs.addRow([]).commit();
      summaryWs.addRow(['Status Breakdown', 'Count']).commit();
      const statusCounts = new Map<string, number>();
      const cityCounts = new Map<string, number>();
      for (const r of rows) {
        statusCounts.set(r.status, (statusCounts.get(r.status) || 0) + 1);
        const ct = r.city || 'Unspecified';
        cityCounts.set(ct, (cityCounts.get(ct) || 0) + 1);
      }
      for (const [st, cnt] of statusCounts.entries()) summaryWs.addRow([st, cnt]).commit();
      summaryWs.addRow([]).commit();
      summaryWs.addRow(['Top Cities', 'Records']).commit();
      for (const [ct, cnt] of Array.from(cityCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        summaryWs.addRow([neutralizeExcelCell(ct), cnt]).commit();
      }
      await summaryWs.commit();

      const reportWs = wb.addWorksheet('Processing Report');
      const rptHdr = reportWs.addRow(['Issue Code', 'Affected Records']);
      rptHdr.font = { bold: true };
      rptHdr.commit();
      const issueCounts = new Map<string, number>();
      let inferredCount = 0;
      for (const r of rows) {
        if (r.has_inferred_fields) inferredCount++;
        const iss = Array.isArray(r.issues) ? r.issues : [];
        for (const i of iss) {
          issueCounts.set(i.code, (issueCounts.get(i.code) || 0) + 1);
        }
      }
      reportWs.addRow(['INFERRED_FIELDS_PRESENT', inferredCount]).commit();
      for (const [code, cnt] of issueCounts.entries()) {
        reportWs.addRow([code, cnt]).commit();
      }
      await reportWs.commit();

      if (exp.split_by !== 'NONE') {
        const grouped = new Map<string, Record<string, any>[]>();
        for (const r of rows) {
          let groupKey = 'Unspecified';
          if (exp.split_by === 'CITY') groupKey = r.city || 'Unspecified City';
          else if (exp.split_by === 'DISTRICT') groupKey = r.district || 'Unspecified District';
          else if (exp.split_by === 'STATE') groupKey = r.state || 'Unspecified State';
          else if (exp.split_by === 'CATEGORY') {
            const cats = Array.isArray(r.category_values) ? r.category_values : [];
            groupKey = cats[0] || 'Uncategorised';
          }
          const arr = grouped.get(groupKey) || [];
          arr.push(r);
          grouped.set(groupKey, arr);
        }
        for (const [key, grpRows] of Array.from(grouped.entries()).slice(0, 50)) {
          const wsName = safeWorksheetName(key, usedNames);
          const ws = wb.addWorksheet(wsName, { views: [{ state: 'frozen', ySplit: 1 }] });
          await styleAndWriteSheet(ws, grpRows);
        }
      }

      if (exp.include_original_sheet && rows.length > 0) {
        const origWs = wb.addWorksheet('Original Data', { views: [{ state: 'frozen', ySplit: 1 }] });
        const rawKeys = Array.from(
          new Set(rows.flatMap((r) => Object.keys((r.raw_data as Record<string, unknown>) || {})))
        );
        origWs.columns = [
          { header: 'Source Row #', key: '__row_number', width: 12 },
          ...rawKeys.map((k) => ({ header: k, key: k, width: 22, style: { numFmt: '@' } })),
        ];
        origWs.getRow(1).font = { bold: true };
        origWs.getRow(1).commit();
        for (const r of rows) {
          const rawObj: Record<string, unknown> = { __row_number: r.row_number };
          const raw = (r.raw_data as Record<string, unknown>) || {};
          for (const k of rawKeys) {
            rawObj[k] = neutralizeExcelCell(raw[k] ?? '');
          }
          origWs.addRow(rawObj).commit();
        }
        await origWs.commit();
      }

      await wb.commit();
      outputBuffer = await bufferDone;
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    const storage = getStorageAdapter();
    const storageKey = `exports/${new Date().toISOString().slice(0, 10)}/${exportId}_${exp.filename}`;
    await storage.putObject(storageKey, outputBuffer, contentType);

    await db.query(
      `UPDATE exports
       SET status = 'COMPLETED', row_count = $2, file_size_bytes = $3, storage_driver = $4, storage_key = $5,
           progress = 100, artifact_manifest = $6::jsonb, completed_at = NOW(),
           expires_at = NOW() + INTERVAL '30 days'
       WHERE id = $1`,
      [exportId, rows.length, outputBuffer.length, storage.driverName, storageKey, JSON.stringify(manifest)]
    );
  } catch (err) {
    await db.query(`UPDATE exports SET status = 'FAILED', error_message = $2 WHERE id = $1`, [
      exportId,
      (err as Error).message,
    ]);
    throw err;
  }
}

export function createExportsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.post('/', requirePermission('export'), validateBody(CreateExportSchema), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const body = req.body as z.infer<typeof CreateExportSchema>;
      const exportId = crypto.randomUUID();

      // Determine exportMode cleanly while keeping backward compatibility for legacy { format: 'XLSX' } callers
      let exportMode: ExportMode;
      if (body.exportMode) {
        exportMode = body.exportMode;
      } else if (body.format === 'CSV') {
        exportMode = 'CSV';
      } else if (body.format === 'ZIP') {
        exportMode = 'AREA_WISE';
      } else if (body.format === 'XLSX') {
        exportMode = 'SINGLE_XLSX';
      } else {
        exportMode = 'AREA_WISE';
      }

      const isSingleAreaDirect =
        exportMode === 'AREA_WISE' && Boolean(body.filters.area && body.filters.area.trim());
      const isZip =
        exportMode === 'COMBINED_ZIP' || (exportMode === 'AREA_WISE' && !isSingleAreaDirect);

      const dbFormat: 'CSV' | 'XLSX' | 'ZIP' =
        exportMode === 'CSV' ? 'CSV' : isZip ? 'ZIP' : 'XLSX';

      const datePart = new Date().toISOString().slice(0, 10);
      let filename: string;
      if (exportMode === 'CSV') {
        filename = `marsforce_export_${datePart}_${exportId.slice(0, 8)}.csv`;
      } else if (exportMode === 'ROUTE_XLSX') {
        filename = `MARSFORCE_ROUTE_OPTIMIZED_${datePart}_${exportId.slice(0, 6)}.xlsx`;
      } else if (exportMode === 'COMBINED_ZIP') {
        filename = `MARSFORCE_AUDIT_EXPORT_${datePart}_${exportId.slice(0, 6)}.zip`;
      } else if (isSingleAreaDirect) {
        const safeA = safeFileSegment(body.filters.area === '__UNASSIGNED__' ? 'UNASSIGNED' : body.filters.area!, new Set());
        filename = `${safeA}_${datePart}.xlsx`;
      } else if (isZip) {
        filename = `MARSFORCE_AREA_WISE_EXPORT_${datePart}_${exportId.slice(0, 6)}.zip`;
      } else {
        filename = `marsforce_export_${datePart}_${exportId.slice(0, 8)}.xlsx`;
      }

      const expRes = await db.query(
        `INSERT INTO exports (id, requested_by, format, export_mode, is_zip, progress, filename, filters, column_order, split_by, include_original_sheet, status)
         VALUES ($1, $2, $3::export_format, $4, $5, 0, $6, $7::jsonb, $8::jsonb, $9, $10, 'QUEUED')
         RETURNING *`,
        [
          exportId,
          req.authUser!.id,
          dbFormat,
          exportMode,
          isZip,
          filename,
          JSON.stringify(body.filters),
          JSON.stringify(body.columnOrder),
          body.splitBy,
          body.includeOriginalSheet,
        ]
      );

      const jobRes = await db.query(
        `INSERT INTO jobs (job_type, status, upload_id, created_by, payload)
         VALUES ('EXPORT_DATASET', 'QUEUED', $1, $2, $3::jsonb)
         RETURNING *`,
        [body.filters.uploadId || null, req.authUser!.id, JSON.stringify({ exportId })]
      );

      await db.query('UPDATE exports SET job_id = $2 WHERE id = $1', [exportId, jobRes.rows[0].id]);

      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'EXPORT_CREATE',
        resourceType: 'export',
        resourceId: exportId,
        req,
        metadata: { format: dbFormat, exportMode, isZip, splitBy: body.splitBy },
      });

      if (jobWorker.isRunning) {
        jobWorker.wake();
        return res.status(202).json({
          exportRecord: sanitizeExportDto({ ...expRes.rows[0], job_id: jobRes.rows[0].id }),
          job: jobRes.rows[0],
        });
      }

      await jobWorker.advanceUntilSettled(3500);
      const updatedExp = await db.query(
        `SELECT e.*, u.full_name AS requested_by_name
         FROM exports e LEFT JOIN users u ON u.id = e.requested_by
         WHERE e.id = $1`,
        [exportId]
      );
      res.status(202).json({
        exportRecord: sanitizeExportDto(updatedExp.rows[0] || { ...expRes.rows[0], job_id: jobRes.rows[0].id }),
        job: jobRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', requirePermission('view'), async (_req, res, next) => {
    try {
      const db = getDb();
      const r = await db.query(
        `SELECT e.*, u.full_name AS requested_by_name
         FROM exports e
         LEFT JOIN users u ON u.id = e.requested_by
         ORDER BY e.created_at DESC
         LIMIT 100`
      );
      res.json({ items: r.rows.map((row) => sanitizeExportDto(row)) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', requirePermission('view'), validateUuidParams('id'), async (req, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      let r = await db.query(
        `SELECT e.*, u.full_name AS requested_by_name
         FROM exports e
         LEFT JOIN users u ON u.id = e.requested_by
         WHERE e.id = $1`,
        [id]
      );
      if (!r.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Export not found.' } });
      }
      if (!jobWorker.isRunning && (r.rows[0].status === 'QUEUED' || r.rows[0].status === 'RUNNING')) {
        await jobWorker.advanceUntilSettled(2500);
        r = await db.query(
          `SELECT e.*, u.full_name AS requested_by_name
           FROM exports e
           LEFT JOIN users u ON u.id = e.requested_by
           WHERE e.id = $1`,
          [id]
        );
      } else if (env.isVercel && (r.rows[0].status === 'QUEUED' || r.rows[0].status === 'RUNNING')) {
        jobWorker.wake();
      }
      res.json({ exportRecord: sanitizeExportDto(r.rows[0]) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/download', requirePermission('export'), validateUuidParams('id'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const db = getDb();
      const id = String(req.params.id);
      const r = await db.query<{
        id: string;
        filename: string;
        format: 'XLSX' | 'CSV' | 'ZIP';
        is_zip: boolean;
        status: string;
        storage_key: string | null;
      }>('SELECT id, filename, format, is_zip, status, storage_key FROM exports WHERE id = $1', [id]);
      const exp = r.rows[0];
      if (!exp || exp.status !== 'COMPLETED' || !exp.storage_key) {
        return res.status(404).json({ error: { code: 'EXPORT_NOT_READY', message: 'Export file is not available.' } });
      }

      const buf = await getStorageAdapter().getObjectBuffer(exp.storage_key);
      await emitAuditLog({
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'EXPORT_DOWNLOAD',
        resourceType: 'export',
        resourceId: id,
        req,
      });

      const contentType =
        exp.format === 'CSV'
          ? 'text/csv; charset=utf-8'
          : exp.is_zip || exp.format === 'ZIP'
            ? 'application/zip'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const safeHeaderFilename = exp.filename.replace(/["\r\n\\]/g, '_');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeHeaderFilename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store, private');
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
