import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import {
  canonicalizeGeoLabel,
  naturalGeoCompare,
  normalizeGeoGroupKey,
} from '../processing/geoIntelligence.engine.ts';

export function neutralizeExcelCell(val: unknown): string | number | null {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return val;
  const str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

export function safeFileSegment(raw: string, used: Set<string>, fallback = 'Unspecified'): string {
  const cleaned = (raw || fallback)
    .normalize('NFC')
    .replace(/[\/\\:*?"<>|\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 72) || fallback;

  let candidate = cleaned;
  let idx = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `__${idx++}`;
    candidate = `${cleaned.slice(0, 72 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function safeWorksheetName(raw: string, used: Set<string>, fallback = 'Sheet'): string {
  const cleaned = (raw || fallback)
    .replace(/[\\/?*\[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || fallback;

  let candidate = cleaned;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${counter++}`;
    candidate = `${cleaned.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function colNumberToLetter(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

function isTextIdColumn(colName: string): boolean {
  return /(?:consumer|customer|account|card|distributor|member|ref|id|phone|mobile|cell|contact|pin|zip|postal)/i.test(
    colName
  );
}

const DERIVED_COLUMNS: Array<{ key: string; header: string; width: number; isTextId?: boolean }> = [
  { key: 'consumer_id', header: 'Consumer ID', width: 18, isTextId: true },
  { key: 'full_name', header: 'Customer Name', width: 24 },
  { key: 'phone_e164', header: 'Phone (E.164)', width: 16, isTextId: true },
  { key: 'phone_display', header: 'Phone (Display)', width: 16, isTextId: true },
  { key: 'detected_area', header: 'Detected Area', width: 20 },
  { key: 'detected_sub_area', header: 'Detected SubArea / Locality', width: 22 },
  { key: 'detected_street', header: 'Detected Street', width: 26 },
  { key: 'street_group', header: 'Street / Locality Group', width: 24 },
  { key: 'group_type', header: 'Group Type', width: 16 },
  { key: 'city', header: 'City', width: 16 },
  { key: 'district', header: 'District', width: 16 },
  { key: 'state', header: 'State', width: 16 },
  { key: 'pin_code', header: 'PIN Code', width: 12, isTextId: true },
  { key: 'original_sheet_name', header: 'Original Sheet', width: 18 },
  { key: 'original_row_number', header: 'Original Row #', width: 14 },
  { key: 'section_heading_context', header: 'Section Heading Context', width: 24 },
  { key: 'classification_source', header: 'Classification Source', width: 22 },
  { key: 'classification_confidence', header: 'Classification Confidence', width: 18 },
  { key: 'geographic_review_status', header: 'Review Status', width: 16 },
  { key: 'geographic_conflict_reason', header: 'Review / Conflict Reason', width: 34 },
  { key: 'precision_loss_detected', header: 'Precision Loss Flag', width: 16 },
  { key: 'status', header: 'Record Status', width: 16 },
];

export interface GeoExportRecord {
  id: string;
  consumer_id: string | null;
  distributor_id: string | null;
  full_name: string | null;
  street: string | null;
  sub_area: string | null;
  locality: string | null;
  area: string | null;
  street_group: string | null;
  group_type: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pin_code: string | null;
  phone_e164: string | null;
  phone_display: string | null;
  section_heading_context: string | null;
  classification_source: string | null;
  classification_confidence: number | string | null;
  geographic_review_status: string | null;
  geographic_conflict_reason: string | null;
  original_sheet_name: string | null;
  original_row_number: number | null;
  precision_loss_detected: boolean;
  has_inferred_fields: boolean;
  status: string;
  issues: Array<{ code: string; field: string; severity: string; message: string }>;
  row_number: number;
  raw_data: Record<string, string>;
}

export interface SourceRowAuditExportItem {
  sheet_name: string;
  physical_row_number: number;
  row_type: string;
  active_section_heading: string | null;
  detected_area: string | null;
  detected_sub_area: string | null;
  detected_street: string | null;
  street_group: string | null;
  group_type: string | null;
  classification_source: string | null;
  classification_confidence: number | string;
  review_status: string;
  conflict_reason: string | null;
  heading_detection_reason: string | null;
  precision_loss_detected: boolean;
  raw_cells: Record<string, string>;
  format_meta: Record<string, any>;
  validation_issues: Array<{ code: string; message: string }>;
}

export interface AreaWorkbookStats {
  areaName: string;
  totalCount: number;
  identifiedStreetGroupsCount: number;
  unidentifiedStreetCount: number;
  needsReviewCount: number;
  conflictCount: number;
  structuredDataCount: number;
  allRecordsCount: number;
  summaryTotalCount: number;
  worksheetNames: string[];
}

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
};

const LIGHT_BLUE_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF93C5FD' } },
  left: { style: 'thin', color: { argb: 'FF93C5FD' } },
  bottom: { style: 'thin', color: { argb: 'FF93C5FD' } },
  right: { style: 'thin', color: { argb: 'FF93C5FD' } },
};

function buildOriginalAndDerivedHeaders(records: GeoExportRecord[], preferredOrder: string[] = []): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const h of preferredOrder) {
    if (h && !seen.has(h)) {
      seen.add(h);
      ordered.push(h);
    }
  }
  for (const r of records) {
    const raw = r.raw_data || {};
    for (const k of Object.keys(raw)) {
      if (!seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }
  }
  return ordered;
}

function isNeedsReviewRow(r: GeoExportRecord): boolean {
  return (
    r.geographic_review_status === 'NEEDS_REVIEW' ||
    r.geographic_review_status === 'CONFLICT' ||
    r.geographic_review_status === 'UNIDENTIFIED' ||
    r.status === 'NEEDS_REVIEW' ||
    r.status === 'INVALID' ||
    Boolean(r.precision_loss_detected) ||
    Boolean(r.has_inferred_fields)
  );
}

function getDerivedCellVal(r: GeoExportRecord, key: string): string | number | null {
  switch (key) {
    case 'consumer_id':
      return neutralizeExcelCell(r.consumer_id ?? '');
    case 'full_name':
      return neutralizeExcelCell(r.full_name ?? '');
    case 'phone_e164':
      return neutralizeExcelCell(r.phone_e164 ?? '');
    case 'phone_display':
      return neutralizeExcelCell(r.phone_display ?? '');
    case 'detected_area':
      return neutralizeExcelCell(r.area || 'UNASSIGNED');
    case 'detected_sub_area':
      return neutralizeExcelCell(r.sub_area || '');
    case 'detected_street':
      return neutralizeExcelCell(r.street || '');
    case 'street_group':
      return neutralizeExcelCell(r.street_group || 'UNIDENTIFIED');
    case 'group_type':
      return neutralizeExcelCell(r.group_type || 'UNIDENTIFIED');
    case 'city':
      return neutralizeExcelCell(r.city || '');
    case 'district':
      return neutralizeExcelCell(r.district || '');
    case 'state':
      return neutralizeExcelCell(r.state || '');
    case 'pin_code':
      return neutralizeExcelCell(r.pin_code || '');
    case 'original_sheet_name':
      return neutralizeExcelCell(r.original_sheet_name || '');
    case 'original_row_number':
      return Number(r.original_row_number || r.row_number || 0);
    case 'section_heading_context':
      return neutralizeExcelCell(r.section_heading_context || '');
    case 'classification_source':
      return neutralizeExcelCell(r.classification_source || '');
    case 'classification_confidence':
      return Number(r.classification_confidence ?? 0);
    case 'geographic_review_status':
      return neutralizeExcelCell(r.geographic_review_status || 'AUTO');
    case 'geographic_conflict_reason':
      return neutralizeExcelCell(r.geographic_conflict_reason || '');
    case 'precision_loss_detected':
      return r.precision_loss_detected ? 'YES' : 'NO';
    case 'status':
      return neutralizeExcelCell(r.status);
    default:
      return '';
  }
}

function writeMachineReadableRecordsSheet(
  ws: ExcelJS.Worksheet,
  records: GeoExportRecord[],
  originalHeaders: string[]
) {
  const colsSpec = [
    ...originalHeaders.map((h) => ({
      header: `Orig: ${h}`,
      key: `orig__${h}`,
      width: 20,
      isTextId: isTextIdColumn(h),
    })),
    ...DERIVED_COLUMNS.map((d) => ({
      header: d.header,
      key: d.key,
      width: d.width,
      isTextId: Boolean(d.isTextId),
    })),
  ];

  ws.columns = colsSpec.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
    style: c.isTextId ? { numFmt: '@' } : undefined,
  }));

  const hdr = ws.getRow(1);
  hdr.height = 24;
  hdr.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = THIN_BORDER;
  });

  records.forEach((r, idx) => {
    const rowObj: Record<string, unknown> = {};
    const raw = r.raw_data || {};
    for (const h of originalHeaders) {
      rowObj[`orig__${h}`] = neutralizeExcelCell(raw[h] ?? '');
    }
    for (const d of DERIVED_COLUMNS) {
      rowObj[d.key] = getDerivedCellVal(r, d.key);
    }
    const row = ws.addRow(rowObj);
    const zebra = idx % 2 === 1;
    row.eachCell((cell, colNumber) => {
      const spec = colsSpec[colNumber - 1];
      if (spec?.isTextId) cell.numFmt = '@';
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'top', wrapText: true };
      if (zebra) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
    });
  });

  if (colsSpec.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, records.length + 1), column: colsSpec.length },
    };
  }
}

export async function buildAreaWorkbookWithStats(params: {
  areaName: string;
  records: GeoExportRecord[];
  originalHeaders: string[];
}): Promise<{ buffer: Buffer; stats: AreaWorkbookStats }> {
  if (params.records.length === 0) {
    throw new Error(`Cannot create empty Area workbook for "${params.areaName}"`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MARSFORCE';
  wb.created = new Date();

  // Consolidate street/locality groups case-insensitively inside this Area
  const groupedByStreet = new Map<string, { displayName: string; groupType: string; rows: GeoExportRecord[] }>();
  for (const r of params.records) {
    const rawSg = (r.street_group || '').trim();
    const isUnidentified = !rawSg || rawSg.toUpperCase() === 'UNIDENTIFIED';
    const sgKey = isUnidentified ? '__UNIDENTIFIED__' : normalizeGeoGroupKey(rawSg);
    const displayName = isUnidentified ? 'UNIDENTIFIED' : canonicalizeGeoLabel(rawSg) || rawSg;
    const existing = groupedByStreet.get(sgKey);
    if (existing) {
      existing.rows.push(r);
    } else {
      groupedByStreet.set(sgKey, {
        displayName,
        groupType: r.group_type || (isUnidentified ? 'UNIDENTIFIED' : 'STREET'),
        rows: [r],
      });
    }
  }

  // Sort street groups naturally (alphabetical + numeric Cross 4 < Cross 5 < Cross 10), UNIDENTIFIED LAST
  const sortedStreets = Array.from(groupedByStreet.entries()).sort((a, b) => {
    if (a[0] === '__UNIDENTIFIED__') return 1;
    if (b[0] === '__UNIDENTIFIED__') return -1;
    return naturalGeoCompare(a[1].displayName, b[1].displayName);
  });

  const needsReviewRows = params.records.filter(isNeedsReviewRow);
  const unidentifiedRows = groupedByStreet.get('__UNIDENTIFIED__')?.rows || [];
  const identifiedStreetGroupsCount = sortedStreets.filter(([key]) => key !== '__UNIDENTIFIED__').length;
  const conflictCount = params.records.filter((r) => r.geographic_review_status === 'CONFLICT').length;
  const processingDate = new Date().toISOString();

  // =========================================================================
  // SHEET 1: STRUCTURED_DATA
  // Main Area Banner -> Summary Banner -> Spacer -> Street Sections (Heading + Table Header + Customer Rows + Blank Separator) -> Footer
  // =========================================================================
  const structuredWs = wb.addWorksheet('STRUCTURED_DATA', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  const structuredColsSpec = [
    { key: 'consumer_id', header: 'Consumer ID', width: 18, isTextId: true },
    { key: 'full_name', header: 'Customer Name', width: 24, isTextId: false },
    { key: 'phone_display', header: 'Phone (Display)', width: 16, isTextId: true },
    { key: 'phone_e164', header: 'Phone (E.164)', width: 16, isTextId: true },
    { key: 'street', header: 'Street / Door No', width: 28, isTextId: false },
    { key: 'sub_area', header: 'SubArea / Locality', width: 22, isTextId: false },
    { key: 'detected_area', header: 'Area', width: 20, isTextId: false },
    { key: 'street_group', header: 'Street / Locality Group', width: 24, isTextId: false },
    { key: 'city', header: 'City', width: 16, isTextId: false },
    { key: 'pin_code', header: 'PIN Code', width: 12, isTextId: true },
    { key: 'original_sheet_name', header: 'Source Sheet', width: 16, isTextId: false },
    { key: 'original_row_number', header: 'Source Row #', width: 12, isTextId: false },
    { key: 'geographic_review_status', header: 'Review Status', width: 16, isTextId: false },
    { key: 'geographic_conflict_reason', header: 'Review Notes', width: 32, isTextId: false },
    ...params.originalHeaders.map((h) => ({
      key: `orig__${h}`,
      header: `Orig: ${h}`,
      width: 22,
      isTextId: isTextIdColumn(h),
    })),
  ];

  structuredColsSpec.forEach((c, idx) => {
    structuredWs.getColumn(idx + 1).width = c.width;
    if (c.isTextId) structuredWs.getColumn(idx + 1).numFmt = '@';
  });

  const endLetter = colNumberToLetter(structuredColsSpec.length);

  // Row 1: Main Area Heading Banner
  structuredWs.mergeCells(`A1:${endLetter}1`);
  const areaTitleCell = structuredWs.getCell('A1');
  areaTitleCell.value = neutralizeExcelCell(`AREA: ${params.areaName}`);
  areaTitleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  areaTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  areaTitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  structuredWs.getRow(1).height = 30;

  // Row 2: Total Customers Summary Banner
  structuredWs.mergeCells(`A2:${endLetter}2`);
  const summaryBannerCell = structuredWs.getCell('A2');
  summaryBannerCell.value = neutralizeExcelCell(
    `Total Customers: ${params.records.length} | Street / Locality Groups: ${identifiedStreetGroupsCount} | Unidentified: ${unidentifiedRows.length} | Needs Review: ${needsReviewRows.length}`
  );
  summaryBannerCell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  summaryBannerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  summaryBannerCell.alignment = { vertical: 'middle', horizontal: 'left' };
  structuredWs.getRow(2).height = 22;

  // Row 3: Blank spacing row
  structuredWs.getRow(3).height = 10;

  let curRow = 4;
  let structuredCount = 0;

  for (const [sgKey, info] of sortedStreets) {
    // Street / Locality Heading Row
    structuredWs.mergeCells(`A${curRow}:${endLetter}${curRow}`);
    const streetTitle =
      sgKey === '__UNIDENTIFIED__'
        ? `STREET / LOCALITY NOT IDENTIFIED (${info.rows.length} Customers)`
        : `${info.displayName} [${info.groupType}] (${info.rows.length} Customers)`;
    const stBanner = structuredWs.getCell(`A${curRow}`);
    stBanner.value = neutralizeExcelCell(streetTitle);
    stBanner.font = { bold: true, size: 11, color: { argb: 'FF0B2545' } };
    stBanner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    stBanner.alignment = { vertical: 'middle', horizontal: 'left' };
    stBanner.border = LIGHT_BLUE_BORDER;
    structuredWs.getRow(curRow).height = 24;
    curRow++;

    // Customer Table Header Row
    const tblHdr = structuredWs.getRow(curRow++);
    tblHdr.height = 22;
    structuredColsSpec.forEach((c, idx) => {
      const cell = tblHdr.getCell(idx + 1);
      cell.value = c.header;
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border = THIN_BORDER;
    });

    // Customer Rows (source order preserved)
    info.rows.forEach((r, rIdx) => {
      const row = structuredWs.getRow(curRow++);
      const raw = r.raw_data || {};
      structuredColsSpec.forEach((c, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        let val: string | number | null;
        if (c.key.startsWith('orig__')) {
          val = neutralizeExcelCell(raw[c.key.slice(6)] ?? '');
        } else if (c.key === 'street') {
          val = neutralizeExcelCell(r.street || '');
        } else if (c.key === 'sub_area') {
          val = neutralizeExcelCell(r.sub_area || '');
        } else {
          val = getDerivedCellVal(r, c.key);
        }
        cell.value = val;
        if (c.isTextId) cell.numFmt = '@';
        cell.border = THIN_BORDER;
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: rIdx % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF' },
        };
      });
      structuredCount++;
    });

    // Blank separator row between street sections
    structuredWs.getRow(curRow).height = 10;
    curRow++;
  }

  // Bottom Footer Row
  structuredWs.mergeCells(`A${curRow}:${endLetter}${curRow}`);
  const footerCell = structuredWs.getCell(`A${curRow}`);
  footerCell.value = neutralizeExcelCell(
    `END OF AREA: ${params.areaName} — Total Customers Reconciled: ${structuredCount}`
  );
  footerCell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  footerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  footerCell.alignment = { vertical: 'middle', horizontal: 'left' };
  structuredWs.getRow(curRow).height = 24;

  // =========================================================================
  // SHEET 2: ALL_RECORDS (Continuous machine-readable table with auto-filter)
  // =========================================================================
  const allWs = wb.addWorksheet('ALL_RECORDS', { views: [{ state: 'frozen', ySplit: 1 }] });
  writeMachineReadableRecordsSheet(allWs, params.records, params.originalHeaders);

  // =========================================================================
  // SHEET 3: SUMMARY (Area metrics & per-street breakdown)
  // =========================================================================
  const summaryWs = wb.addWorksheet('SUMMARY');
  summaryWs.getColumn(1).width = 36;
  summaryWs.getColumn(2).width = 20;
  summaryWs.getColumn(3).width = 18;
  summaryWs.getColumn(4).width = 18;
  summaryWs.getColumn(5).width = 18;

  summaryWs.mergeCells('A1:E1');
  const sumTitle = summaryWs.getCell('A1');
  sumTitle.value = neutralizeExcelCell(`MARSFORCE Area Summary — ${params.areaName}`);
  sumTitle.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  sumTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  summaryWs.getRow(1).height = 28;

  summaryWs.addRow(['Area Name', neutralizeExcelCell(params.areaName)]);
  summaryWs.addRow(['Total Customers', params.records.length]);
  summaryWs.addRow(['Identified Street / Locality Groups', identifiedStreetGroupsCount]);
  summaryWs.addRow(['Unidentified Street Count', unidentifiedRows.length]);
  summaryWs.addRow(['Needs Review / Conflict Count', needsReviewRows.length]);
  summaryWs.addRow(['Heading Conflicts Count', conflictCount]);
  summaryWs.addRow(['Processing Date (UTC)', processingDate]);
  summaryWs.addRow([]);

  const brkHdr = summaryWs.addRow([
    'Street / Locality Group',
    'Group Type',
    'Customer Count',
    'Needs Review',
    'Conflicts',
  ]);
  brkHdr.eachCell((c) => {
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    c.border = THIN_BORDER;
  });

  let summaryBreakdownSum = 0;
  for (const [, info] of sortedStreets) {
    const nrCount = info.rows.filter(isNeedsReviewRow).length;
    const cfCount = info.rows.filter((r) => r.geographic_review_status === 'CONFLICT').length;
    const row = summaryWs.addRow([
      neutralizeExcelCell(info.displayName),
      info.groupType,
      info.rows.length,
      nrCount,
      cfCount,
    ]);
    row.eachCell((c) => {
      c.border = THIN_BORDER;
    });
    summaryBreakdownSum += info.rows.length;
  }

  // =========================================================================
  // SHEET 4 (OPTIONAL): NEEDS_REVIEW (Created ONLY when flagged rows exist)
  // =========================================================================
  if (needsReviewRows.length > 0) {
    const nrWs = wb.addWorksheet('NEEDS_REVIEW', { views: [{ state: 'frozen', ySplit: 1 }] });
    writeMachineReadableRecordsSheet(nrWs, needsReviewRows, params.originalHeaders);
  }

  const out = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(out),
    stats: {
      areaName: params.areaName,
      totalCount: params.records.length,
      identifiedStreetGroupsCount,
      unidentifiedStreetCount: unidentifiedRows.length,
      needsReviewCount: needsReviewRows.length,
      conflictCount,
      structuredDataCount: structuredCount,
      allRecordsCount: params.records.length,
      summaryTotalCount: summaryBreakdownSum,
      worksheetNames: wb.worksheets.map((w) => w.name),
    },
  };
}

export async function buildAreaWorkbookBuffer(params: {
  areaName: string;
  records: GeoExportRecord[];
  originalHeaders: string[];
}): Promise<Buffer> {
  const { buffer } = await buildAreaWorkbookWithStats(params);
  return buffer;
}

function buildUnassignedAreaCsvBuffer(records: GeoExportRecord[], originalHeaders: string[]): Buffer {
  const headers = [
    ...originalHeaders.map((h) => `Orig: ${h}`),
    'Consumer ID',
    'Customer Name',
    'Phone (Display)',
    'Street / Door No',
    'SubArea / Locality',
    'Street / Locality Group',
    'City',
    'PIN Code',
    'Original Sheet',
    'Original Row #',
    'Review Status',
    'Review Notes',
  ];
  const escapeCsv = (v: unknown) => `"${String(neutralizeExcelCell(v) ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(escapeCsv).join(',')];

  for (const r of records) {
    const raw = r.raw_data || {};
    const vals: unknown[] = [
      ...originalHeaders.map((h) => raw[h] ?? ''),
      r.consumer_id ?? '',
      r.full_name ?? '',
      r.phone_display ?? r.phone_e164 ?? '',
      r.street ?? '',
      r.sub_area ?? '',
      r.street_group || 'UNIDENTIFIED',
      r.city ?? '',
      r.pin_code ?? '',
      r.original_sheet_name ?? '',
      r.original_row_number ?? r.row_number ?? '',
      r.geographic_review_status || r.status,
      r.geographic_conflict_reason || 'No valid Area detected in source data',
    ];
    lines.push(vals.map(escapeCsv).join(','));
  }

  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
}

export async function buildAreaSummaryReportBuffer(params: {
  records: GeoExportRecord[];
  reconciliation: {
    totalPhysicalRows: number;
    columnHeaders: number;
    sectionHeadings: number;
    emptySeparators: number;
    subtotals: number;
    totalCustomerRecords: number;
    invalidRecords: number;
    needsReviewRows: number;
    precisionLossRows: number;
  };
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MARSFORCE';
  wb.created = new Date();

  const areaStats = new Map<
    string,
    {
      displayName: string;
      isUnassigned: boolean;
      total: number;
      unidentified: number;
      review: number;
      conflicts: number;
      streets: Map<string, { displayName: string; type: string; count: number; review: number }>;
    }
  >();

  for (const r of params.records) {
    const rawArea = r.area && r.area.trim() ? r.area.trim() : '';
    const isUnassigned = !rawArea || rawArea.toUpperCase() === 'UNASSIGNED';
    const areaKey = isUnassigned ? '__UNASSIGNED__' : normalizeGeoGroupKey(rawArea);
    const areaName = isUnassigned ? 'UNASSIGNED' : canonicalizeGeoLabel(rawArea) || rawArea;
    const rawSg = (r.street_group || '').trim();
    const isUnidSg = !rawSg || rawSg.toUpperCase() === 'UNIDENTIFIED';
    const sgKey = isUnidSg ? '__UNIDENTIFIED__' : normalizeGeoGroupKey(rawSg);
    const sgName = isUnidSg ? 'UNIDENTIFIED' : canonicalizeGeoLabel(rawSg) || rawSg;

    let a = areaStats.get(areaKey);
    if (!a) {
      a = {
        displayName: areaName,
        isUnassigned,
        total: 0,
        unidentified: 0,
        review: 0,
        conflicts: 0,
        streets: new Map(),
      };
      areaStats.set(areaKey, a);
    }
    a.total++;
    if (isUnidSg) a.unidentified++;
    if (isNeedsReviewRow(r)) a.review++;
    if (r.geographic_review_status === 'CONFLICT') a.conflicts++;

    const st = a.streets.get(sgKey) || {
      displayName: sgName,
      type: r.group_type || (isUnidSg ? 'UNIDENTIFIED' : 'STREET'),
      count: 0,
      review: 0,
    };
    st.count++;
    if (r.geographic_review_status !== 'CONFIRMED' && r.geographic_review_status !== 'APPROVED') st.review++;
    a.streets.set(sgKey, st);
  }

  const areaWs = wb.addWorksheet('Area_Summary', { views: [{ state: 'frozen', ySplit: 5 }] });
  areaWs.mergeCells('A1:F1');
  areaWs.getCell('A1').value = 'MARSFORCE — Area & Street Categorisation Summary';
  areaWs.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  areaWs.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  areaWs.getRow(1).height = 28;

  areaWs.addRow(['Total Physical Excel Rows', params.reconciliation.totalPhysicalRows, 'Total Customer Records', params.reconciliation.totalCustomerRecords]);
  areaWs.addRow(['Section Headings Detected', params.reconciliation.sectionHeadings, 'Empty / Separator Rows', params.reconciliation.emptySeparators]);
  areaWs.addRow(['Subtotal / Report Rows', params.reconciliation.subtotals, 'Precision-Loss Warnings', params.reconciliation.precisionLossRows]);

  const hdr = areaWs.getRow(5);
  const headers = ['Area Name', 'Total Customers', 'Street/Locality Groups', 'Unidentified Street', 'Needs Review', 'Heading Conflicts'];
  headers.forEach((h, i) => {
    areaWs.getColumn(i + 1).width = i === 0 ? 28 : 20;
    const cell = hdr.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.border = THIN_BORDER;
  });

  const sortedAreas = Array.from(areaStats.values()).sort((a, b) => {
    if (a.isUnassigned) return 1;
    if (b.isUnassigned) return -1;
    return naturalGeoCompare(a.displayName, b.displayName);
  });

  for (const st of sortedAreas) {
    const namedStreetsCount = Array.from(st.streets.keys()).filter((k) => k !== '__UNIDENTIFIED__').length;
    const row = areaWs.addRow([
      neutralizeExcelCell(st.displayName),
      st.total,
      namedStreetsCount,
      st.unidentified,
      st.review,
      st.conflicts,
    ]);
    row.eachCell((c) => {
      c.border = THIN_BORDER;
    });
  }

  const streetWs = wb.addWorksheet('Street_Breakdown', { views: [{ state: 'frozen', ySplit: 1 }] });
  streetWs.columns = [
    { header: 'Area Name', key: 'area', width: 26 },
    { header: 'Street / Locality Group', key: 'street', width: 30 },
    { header: 'Group Type', key: 'type', width: 18 },
    { header: 'Customer Count', key: 'count', width: 16 },
    { header: 'Needs Review Count', key: 'review', width: 18 },
  ];
  streetWs.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  });
  for (const st of sortedAreas) {
    const streetsList = Array.from(st.streets.entries()).sort((a, b) => {
      if (a[0] === '__UNIDENTIFIED__') return 1;
      if (b[0] === '__UNIDENTIFIED__') return -1;
      return naturalGeoCompare(a[1].displayName, b[1].displayName);
    });
    for (const [, sInfo] of streetsList) {
      streetWs.addRow({
        area: neutralizeExcelCell(st.displayName),
        street: neutralizeExcelCell(sInfo.displayName),
        type: sInfo.type,
        count: sInfo.count,
        review: sInfo.review,
      });
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export async function buildProcessingReportBuffer(params: {
  records: GeoExportRecord[];
  sourceRows: SourceRowAuditExportItem[];
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MARSFORCE';
  wb.created = new Date();

  const reconWs = wb.addWorksheet('Reconciliation_Summary');
  reconWs.getColumn(1).width = 38;
  reconWs.getColumn(2).width = 18;
  reconWs.getColumn(3).width = 48;

  reconWs.mergeCells('A1:C1');
  reconWs.getCell('A1').value = 'MARSFORCE — Processing & Reconciliation Report';
  reconWs.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  reconWs.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  reconWs.getRow(1).height = 28;

  const byType = new Map<string, number>();
  for (const sr of params.sourceRows) {
    byType.set(sr.row_type, (byType.get(sr.row_type) || 0) + 1);
  }
  const rows: Array<[string, number, string]> = [
    ['Total Physical Rows Inspected', params.sourceRows.length, 'Every physical row in selected Excel/CSV sheets'],
    ['Column Header Rows', byType.get('COLUMN_HEADER') || 0, 'Detected table header rows'],
    ['Section Heading Rows', byType.get('SECTION_HEADING') || 0, 'Embedded street/locality heading divider rows'],
    ['Empty Separator Rows', byType.get('EMPTY_SEPARATOR') || 0, 'Blank divider rows preserved in Row Audit'],
    ['Subtotal / Report Rows', byType.get('SUBTOTAL_OR_REPORT_ROW') || 0, 'Summary/Total/Report footer rows excluded from customers'],
    ['Total Customer Records Created', params.records.length, 'All non-merged customer records across Areas'],
    ['Customer Rows Flagged Needs Review', params.records.filter(isNeedsReviewRow).length, 'Contextual, inferred, or low-confidence classifications'],
    ['Section Heading Conflicts', params.records.filter((r) => r.geographic_review_status === 'CONFLICT').length, 'Address street disagrees with section heading'],
    ['Unidentified Street / Locality', params.records.filter((r) => !r.street_group || r.street_group === 'UNIDENTIFIED').length, 'No street/locality token found in address'],
    ['Numeric Precision-Loss Rows', params.sourceRows.filter((sr) => sr.precision_loss_detected).length, 'Long numeric IDs truncated to scientific/15-digit float by source Excel'],
  ];

  const hdr = reconWs.addRow(['Metric', 'Count', 'Notes']);
  hdr.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    c.border = THIN_BORDER;
  });
  for (const [m, c, n] of rows) {
    const row = reconWs.addRow([m, c, n]);
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });
  }

  const diagWs = wb.addWorksheet('Diagnostics_And_Conflicts', { views: [{ state: 'frozen', ySplit: 1 }] });
  diagWs.columns = [
    { header: 'Original Row #', key: 'row', width: 14 },
    { header: 'Consumer ID', key: 'consumerId', width: 18, style: { numFmt: '@' } },
    { header: 'Customer Name', key: 'name', width: 22 },
    { header: 'Detected Area', key: 'area', width: 18 },
    { header: 'Section Heading', key: 'heading', width: 24 },
    { header: 'Assigned Street Group', key: 'streetGroup', width: 24 },
    { header: 'Issue / Status', key: 'status', width: 20 },
    { header: 'Precision Loss', key: 'precision', width: 14 },
    { header: 'Details', key: 'reason', width: 48 },
  ];
  diagWs.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  });

  for (const r of params.records) {
    const issueSummary = (r.issues || []).map((i) => `[${i.code}] ${i.message}`).join('; ');
    if (
      r.precision_loss_detected ||
      r.geographic_review_status === 'CONFLICT' ||
      r.geographic_review_status === 'NEEDS_REVIEW' ||
      r.geographic_review_status === 'UNIDENTIFIED' ||
      issueSummary
    ) {
      const row = diagWs.addRow({
        row: r.original_row_number || r.row_number,
        consumerId: neutralizeExcelCell(r.consumer_id || ''),
        name: neutralizeExcelCell(r.full_name || ''),
        area: neutralizeExcelCell(r.area || 'UNASSIGNED'),
        heading: neutralizeExcelCell(r.section_heading_context || ''),
        streetGroup: neutralizeExcelCell(r.street_group || 'UNIDENTIFIED'),
        status: r.geographic_review_status || r.status,
        precision: r.precision_loss_detected ? 'YES' : 'NO',
        reason: neutralizeExcelCell([r.geographic_conflict_reason, issueSummary].filter(Boolean).join(' | ')),
      });
      row.getCell('consumerId').numFmt = '@';
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export async function buildNeedsReviewBuffer(
  records: GeoExportRecord[],
  originalHeaders: string[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MARSFORCE';
  wb.created = new Date();
  const reviewRows = records.filter(isNeedsReviewRow);
  const ws = wb.addWorksheet('NEEDS_REVIEW', { views: [{ state: 'frozen', ySplit: 1 }] });
  writeMachineReadableRecordsSheet(ws, reviewRows, originalHeaders);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export async function buildRowAuditBuffer(sourceRows: SourceRowAuditExportItem[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MARSFORCE';
  wb.created = new Date();

  const writeAuditSheet = (ws: ExcelJS.Worksheet, list: SourceRowAuditExportItem[]) => {
    ws.columns = [
      { header: 'Sheet', key: 'sheet', width: 18 },
      { header: 'Physical Row #', key: 'row', width: 14 },
      { header: 'Row Type', key: 'type', width: 22 },
      { header: 'Active Section Heading', key: 'heading', width: 24 },
      { header: 'Detected Area', key: 'area', width: 18 },
      { header: 'Street Group', key: 'streetGroup', width: 22 },
      { header: 'Review Status', key: 'review', width: 16 },
      { header: 'Precision Loss', key: 'precision', width: 14 },
      { header: 'Reason / Conflict', key: 'reason', width: 38 },
      { header: 'Raw Source Cells', key: 'raw', width: 52, style: { numFmt: '@' } },
    ];
    ws.getRow(1).eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
      c.border = THIN_BORDER;
    });
    for (const sr of list) {
      const rawSummary = Object.entries(sr.raw_cells || {})
        .filter(([, v]) => String(v || '').trim() !== '')
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ');
      const row = ws.addRow({
        sheet: neutralizeExcelCell(sr.sheet_name),
        row: sr.physical_row_number,
        type: sr.row_type,
        heading: neutralizeExcelCell(sr.active_section_heading || ''),
        area: neutralizeExcelCell(sr.detected_area || ''),
        streetGroup: neutralizeExcelCell(sr.street_group || ''),
        review: sr.review_status,
        precision: sr.precision_loss_detected ? 'YES' : 'NO',
        reason: neutralizeExcelCell(sr.conflict_reason || sr.heading_detection_reason || ''),
        raw: neutralizeExcelCell(rawSummary),
      });
      row.getCell('raw').numFmt = '@';
    }
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, list.length + 1), column: 10 },
    };
  };

  writeAuditSheet(
    wb.addWorksheet('All_Physical_Rows', { views: [{ state: 'frozen', ySplit: 1 }] }),
    sourceRows
  );
  writeAuditSheet(
    wb.addWorksheet('Section_Headings', { views: [{ state: 'frozen', ySplit: 1 }] }),
    sourceRows.filter((s) => s.row_type === 'SECTION_HEADING')
  );
  writeAuditSheet(
    wb.addWorksheet('Empty_And_Subtotals', { views: [{ state: 'frozen', ySplit: 1 }] }),
    sourceRows.filter((s) => s.row_type === 'EMPTY_SEPARATOR' || s.row_type === 'SUBTOTAL_OR_REPORT_ROW')
  );
  writeAuditSheet(
    wb.addWorksheet('Problem_And_Conflicts', { views: [{ state: 'frozen', ySplit: 1 }] }),
    sourceRows.filter(
      (s) =>
        s.precision_loss_detected ||
        s.review_status === 'CONFLICT' ||
        s.review_status === 'NEEDS_REVIEW' ||
        s.row_type === 'INVALID_RECORD' ||
        s.row_type === 'NEEDS_REVIEW'
    )
  );

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * NON-NEGOTIABLE BUSINESS RULE:
 * ONE AREA = ONE EXCEL WORKBOOK; MULTIPLE STREET HEADINGS INSIDE THAT WORKBOOK.
 * NEVER generate separate Excel files per street.
 */
export async function buildGeoZipBundle(params: {
  mode: 'COMBINED_ZIP' | 'AREA_WISE';
  records: GeoExportRecord[];
  sourceRows: SourceRowAuditExportItem[];
  onProgress?: (pct: number) => Promise<void>;
}): Promise<{ zipBuffer: Buffer; manifest: Record<string, any> }> {
  const zip = new AdmZip();
  const originalHeaders = buildOriginalAndDerivedHeaders(params.records);

  // Deduplication check on incoming customer records
  const uniqueRecordIds = new Set(params.records.map((r) => r.id));
  if (uniqueRecordIds.size !== params.records.length) {
    throw new Error(
      `EXPORT_RECONCILIATION_FAILED: Duplicate customer record IDs detected (${params.records.length} rows vs ${uniqueRecordIds.size} unique IDs).`
    );
  }

  // Group records strictly by canonical Area (case-insensitive); separate unassigned records
  const validAreasMap = new Map<string, { displayName: string; records: GeoExportRecord[] }>();
  const unassignedRecords: GeoExportRecord[] = [];

  for (const r of params.records) {
    const rawArea = r.area && r.area.trim() ? r.area.trim() : '';
    if (!rawArea || rawArea.toUpperCase() === 'UNASSIGNED') {
      unassignedRecords.push(r);
      continue;
    }
    const areaKey = normalizeGeoGroupKey(rawArea);
    const displayName = canonicalizeGeoLabel(rawArea) || rawArea;
    const existing = validAreasMap.get(areaKey);
    if (existing) {
      existing.records.push(r);
    } else {
      validAreasMap.set(areaKey, { displayName, records: [r] });
    }
  }

  const usedAreaFilenames = new Set<string>();
  const areaFiles: string[] = [];
  const areaBreakdown: Array<{
    areaName: string;
    filePath: string;
    customerCount: number;
    streetGroupCount: number;
    unidentifiedCount: number;
    needsReviewCount: number;
  }> = [];

  if (params.mode === 'COMBINED_ZIP') {
    const reconCounts = {
      totalPhysicalRows: params.sourceRows.length,
      columnHeaders: params.sourceRows.filter((s) => s.row_type === 'COLUMN_HEADER').length,
      sectionHeadings: params.sourceRows.filter((s) => s.row_type === 'SECTION_HEADING').length,
      emptySeparators: params.sourceRows.filter((s) => s.row_type === 'EMPTY_SEPARATOR').length,
      subtotals: params.sourceRows.filter((s) => s.row_type === 'SUBTOTAL_OR_REPORT_ROW').length,
      totalCustomerRecords: params.records.length,
      invalidRecords: params.records.filter((r) => r.status === 'INVALID').length,
      needsReviewRows: params.records.filter(isNeedsReviewRow).length,
      precisionLossRows: params.sourceRows.filter((s) => s.precision_loss_detected).length,
    };
    if (params.onProgress) await params.onProgress(15);

    zip.addFile(
      'AREA_SUMMARY.xlsx',
      await buildAreaSummaryReportBuffer({ records: params.records, reconciliation: reconCounts })
    );
    zip.addFile(
      'PROCESSING_REPORT.xlsx',
      await buildProcessingReportBuffer({ records: params.records, sourceRows: params.sourceRows })
    );
    zip.addFile('NEEDS_REVIEW.xlsx', await buildNeedsReviewBuffer(params.records, originalHeaders));
    zip.addFile('ROW_AUDIT.xlsx', await buildRowAuditBuffer(params.sourceRows));
    if (params.onProgress) await params.onProgress(35);
  }

  const sortedValidAreas = Array.from(validAreasMap.values()).sort((a, b) =>
    naturalGeoCompare(a.displayName, b.displayName)
  );

  let assignedExportedSum = 0;
  const totalAreas = Math.max(1, sortedValidAreas.length);

  for (let aIdx = 0; aIdx < sortedValidAreas.length; aIdx++) {
    const areaGroup = sortedValidAreas[aIdx];
    if (areaGroup.records.length === 0) {
      throw new Error(`EXPORT_RECONCILIATION_FAILED: Empty Area bucket for "${areaGroup.displayName}".`);
    }

    const safeArea = safeFileSegment(areaGroup.displayName, usedAreaFilenames, 'Area');
    const { buffer, stats } = await buildAreaWorkbookWithStats({
      areaName: areaGroup.displayName,
      records: areaGroup.records,
      originalHeaders,
    });

    // Strict per-Area reconciliation check
    if (
      stats.structuredDataCount !== stats.allRecordsCount ||
      stats.allRecordsCount !== stats.summaryTotalCount ||
      stats.allRecordsCount !== areaGroup.records.length
    ) {
      throw new Error(
        `EXPORT_RECONCILIATION_FAILED: Area "${areaGroup.displayName}" mismatch ` +
          `(expected=${areaGroup.records.length}, STRUCTURED_DATA=${stats.structuredDataCount}, ` +
          `ALL_RECORDS=${stats.allRecordsCount}, SUMMARY=${stats.summaryTotalCount}).`
      );
    }

    const expectedSheets = stats.needsReviewCount > 0
      ? ['STRUCTURED_DATA', 'ALL_RECORDS', 'SUMMARY', 'NEEDS_REVIEW']
      : ['STRUCTURED_DATA', 'ALL_RECORDS', 'SUMMARY'];
    if (
      stats.worksheetNames.length !== expectedSheets.length ||
      expectedSheets.some((name, idx) => stats.worksheetNames[idx] !== name)
    ) {
      throw new Error(
        `EXPORT_RECONCILIATION_FAILED: Area "${areaGroup.displayName}" unexpected worksheets [${stats.worksheetNames.join(', ')}].`
      );
    }

    const entryPath = params.mode === 'COMBINED_ZIP' ? `AREA_WISE/${safeArea}.xlsx` : `${safeArea}.xlsx`;
    zip.addFile(entryPath, buffer);
    areaFiles.push(entryPath);
    assignedExportedSum += stats.allRecordsCount;

    areaBreakdown.push({
      areaName: areaGroup.displayName,
      filePath: entryPath,
      customerCount: stats.allRecordsCount,
      streetGroupCount: stats.identifiedStreetGroupsCount,
      unidentifiedCount: stats.unidentifiedStreetCount,
      needsReviewCount: stats.needsReviewCount,
    });

    if (params.onProgress) {
      const pct = Math.min(92, 35 + Math.round(((aIdx + 1) / totalAreas) * 55));
      await params.onProgress(pct);
    }
  }

  let unassignedFile: string | null = null;
  if (unassignedRecords.length > 0) {
    unassignedFile = 'UNASSIGNED_AREA_RECORDS.csv';
    zip.addFile(unassignedFile, buildUnassignedAreaCsvBuffer(unassignedRecords, originalHeaders));
  }

  // Global Reconciliation Assertions
  if (assignedExportedSum + unassignedRecords.length !== params.records.length) {
    throw new Error(
      `EXPORT_RECONCILIATION_FAILED: Global count mismatch (${assignedExportedSum} assigned + ${unassignedRecords.length} unassigned != ${params.records.length} imported).`
    );
  }
  if (areaFiles.length !== sortedValidAreas.length) {
    throw new Error(
      `EXPORT_RECONCILIATION_FAILED: Area workbook count (${areaFiles.length}) != distinct valid Area count (${sortedValidAreas.length}).`
    );
  }

  const totalNeedsReview = params.records.filter(isNeedsReviewRow).length;

  return {
    zipBuffer: zip.toBuffer(),
    manifest: {
      mode: params.mode,
      totalCustomerRecords: params.records.length,
      assignedAreaRecords: assignedExportedSum,
      unassignedAreaRecords: unassignedRecords.length,
      needsReviewCount: totalNeedsReview,
      distinctValidAreaCount: sortedValidAreas.length,
      totalPhysicalRows: params.sourceRows.length,
      areaWorkbookCount: areaFiles.length,
      streetWorkbookCount: 0,
      areaFiles,
      areaBreakdown,
      unassignedFile,
      reconciliation: {
        status: 'VERIFIED',
        checkedAt: new Date().toISOString(),
        formula: `${params.records.length} imported = ${assignedExportedSum} assigned (${areaFiles.length} Area workbooks) + ${unassignedRecords.length} unassigned`,
      },
      rootReports:
        params.mode === 'COMBINED_ZIP'
          ? ['AREA_SUMMARY.xlsx', 'PROCESSING_REPORT.xlsx', 'NEEDS_REVIEW.xlsx', 'ROW_AUDIT.xlsx']
          : [],
    },
  };
}
