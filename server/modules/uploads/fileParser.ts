import path from 'node:path';
import AdmZip from 'adm-zip';
import { parse as parseCsv } from 'csv-parse';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import * as XLSX from 'xlsx';
import { bufferToStream } from '../../infrastructure/storage/StorageAdapter.ts';

export const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
export const BLOCKED_EXTENSIONS = new Set(['.xlsm', '.xlsb', '.xltm', '.exe', '.js', '.sh']);

const MAX_ROWS_CAP = 250_000;
const MAX_COLS_CAP = 500;
const MAX_ZIP_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_RATIO = 50;
const MAX_ZIP_ENTRIES = 500;

export interface ParsedSheetPreview {
  sheetIndex: number;
  sheetName: string;
  rowCount: number;
  physicalRowCount: number;
  headerRowNumber: number;
  columnCount: number;
  headers: string[];
  previewRows: Record<string, string>[];
  hiddenRowCount: number;
  precisionLossRowCount: number;
}

export interface FileInspectionResult {
  extension: string;
  detectedEncoding: string | null;
  sheets: ParsedSheetPreview[];
  totalRows: number;
}

export interface PrecisionLossDetail {
  column: string;
  storedValue: string;
  displayValue: string;
  reason: string;
}

export interface PhysicalRowData {
  physicalRowNumber: number;
  cellsByHeader: Record<string, string>;
  displayByHeader: Record<string, string>;
  orderedCells: string[];
  isBlank: boolean;
  isHidden: boolean;
  isMergedRow: boolean;
  isBoldRow: boolean;
  isCenteredRow: boolean;
  isUppercaseRow: boolean;
  nonEmptyCount: number;
  precisionLossCols: PrecisionLossDetail[];
  formulaCols: Array<{ column: string; formula: string }>;
}

export class FileValidationError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validateUploadMagicAndContainer(filename: string, buffer: Buffer): string {
  const ext = path.extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new FileValidationError(
      'MACRO_OR_UNSAFE_FILE',
      `Files of type "${ext}" (such as macro-enabled workbooks) are rejected for security.`
    );
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new FileValidationError(
      'UNSUPPORTED_EXTENSION',
      `Unsupported file extension "${ext || 'none'}". Allowed formats: .xlsx, .xls, .csv.`
    );
  }
  if (buffer.length < 4) {
    throw new FileValidationError('EMPTY_FILE', 'Uploaded file is empty or too small.');
  }

  if (ext === '.xlsx') {
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      throw new FileValidationError(
        'PASSWORD_PROTECTED',
        'This .xlsx workbook appears to be password-protected or encrypted. Please unprotect it before uploading.'
      );
    }
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) {
      throw new FileValidationError('MAGIC_BYTE_MISMATCH', 'File extension is .xlsx, but file signature is not a valid OOXML ZIP container.');
    }
    inspectZipSafety(buffer);
  } else if (ext === '.xls') {
    const isOle2 =
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0;
    if (!isOle2) {
      throw new FileValidationError('MAGIC_BYTE_MISMATCH', 'File extension is .xls, but file signature is not a valid Excel 97-2003 OLE2 binary.');
    }
  } else if (ext === '.csv') {
    if (
      (buffer[0] === 0x50 && buffer[1] === 0x4b) ||
      (buffer[0] === 0x4d && buffer[1] === 0x5a) ||
      (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46)
    ) {
      throw new FileValidationError('MAGIC_BYTE_MISMATCH', 'Uploaded CSV appears to contain binary executable or archive bytes.');
    }
  }

  return ext;
}

function inspectZipSafety(buffer: Buffer): void {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new FileValidationError('CORRUPTED_XLSX', 'Could not read XLSX ZIP structure; file may be corrupted or encrypted.');
  }

  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new FileValidationError('ZIP_BOMB_SUSPECTED', `XLSX archive contains too many internal entries (${entries.length}).`);
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.entryName.toLowerCase().includes('vbaproject.bin')) {
      throw new FileValidationError('MACRO_OR_UNSAFE_FILE', 'Workbook contains embedded VBA macros (vbaProject.bin) and was rejected.');
    }
    const size = entry.header.size;
    const comp = Math.max(1, entry.header.compressedSize);
    totalUncompressed += size;
    if (size > 20 * 1024 * 1024 && size / comp > MAX_ZIP_RATIO) {
      throw new FileValidationError('ZIP_BOMB_SUSPECTED', 'Abnormal decompression ratio detected in workbook.');
    }
  }

  if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw new FileValidationError('ZIP_BOMB_SUSPECTED', 'Uncompressed workbook size exceeds 250 MB safety threshold.');
  }
}

export function detectCsvEncoding(buffer: Buffer): { encoding: string; text: string } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'UTF-16LE', text: iconv.decode(buffer.subarray(2), 'utf16-le') };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'UTF-16BE', text: iconv.decode(buffer.subarray(2), 'utf16-be') };
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'UTF-8', text: buffer.subarray(3).toString('utf8') };
  }

  const utf8Text = buffer.toString('utf8');
  const reEncoded = Buffer.from(utf8Text, 'utf8');
  if (!utf8Text.includes('\uFFFD') && reEncoded.length === buffer.length) {
    return { encoding: 'UTF-8', text: utf8Text };
  }
  return { encoding: 'WINDOWS-1252', text: iconv.decode(buffer, 'win1252') };
}

function readCellSafely(
  cell: XLSX.CellObject | undefined,
  colHeader: string
): {
  valueText: string;
  displayText: string;
  precisionLoss: PrecisionLossDetail | null;
  formula: string | null;
  isBold: boolean;
  isCentered: boolean;
} {
  if (!cell) {
    return { valueText: '', displayText: '', precisionLoss: null, formula: null, isBold: false, isCentered: false };
  }

  const style = (cell as any).s;
  const isBold = Boolean(style?.font?.bold);
  const isCentered = style?.alignment?.horizontal === 'center';
  const formula = cell.f ? String(cell.f) : null;
  const formattedW = cell.w !== undefined && cell.w !== null ? String(cell.w).trim() : '';

  if (cell.t === 'd' && cell.v instanceof Date) {
    const iso = cell.v.toISOString().slice(0, 10);
    return { valueText: iso, displayText: formattedW || iso, precisionLoss: null, formula, isBold, isCentered };
  }

  if (cell.t === 'n' && typeof cell.v === 'number') {
    const fmt = String(cell.z || '');
    // Detect real Excel date format (avoid treating general/text integer formats as dates)
    if (fmt && /[ymdhs]/i.test(fmt) && !/0{5,}/.test(fmt) && cell.v > 20000 && cell.v < 80000) {
      const parsedDate = XLSX.SSF.parse_date_code(cell.v);
      if (parsedDate && parsedDate.y >= 1950 && parsedDate.y <= 2100) {
        const iso = `${String(parsedDate.y).padStart(4, '0')}-${String(parsedDate.m).padStart(2, '0')}-${String(parsedDate.d).padStart(2, '0')}`;
        return { valueText: iso, displayText: formattedW || iso, precisionLoss: null, formula, isBold, isCentered };
      }
    }

    const isSciDisplay = /^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(formattedW);
    const absVal = Math.abs(cell.v);
    // IEEE-754 float64 loses precision above 15 significant digits (999_999_999_999_999)
    const exceedsExcel15DigitLimit = Number.isInteger(cell.v)
      ? absVal > 999_999_999_999_999
      : absVal > 1e15;

    if (exceedsExcel15DigitLimit) {
      // Irrecoverable Excel numeric precision loss: NEVER invent missing digits
      const bestText = isSciDisplay ? formattedW : String(cell.v);
      return {
        valueText: bestText,
        displayText: formattedW || bestText,
        precisionLoss: {
          column: colHeader,
          storedValue: String(cell.v),
          displayValue: formattedW || String(cell.v),
          reason:
            'Long identifier (>15 digits) was stored as an IEEE-754 floating-point number in Excel; trailing digits cannot be recovered without source text formatting.',
        },
        formula,
        isBold,
        isCentered,
      };
    }

    // Check scientific notation on a <=15 digit safe integer (recoverable from cell.v without precision loss)
    if (isSciDisplay && Number.isSafeInteger(cell.v)) {
      const exactInt = cell.v.toFixed(0);
      return {
        valueText: exactInt,
        displayText: formattedW,
        precisionLoss: {
          column: colHeader,
          storedValue: exactInt,
          displayValue: formattedW,
          reason: 'Cell was displayed in scientific notation in Excel; recovered exact integer digits because precision was within 15 digits.',
        },
        formula,
        isBold,
        isCentered,
      };
    }

    if (Number.isInteger(cell.v)) {
      const textInt = cell.v.toFixed(0);
      // Preserve formatted string if leading zeros exist (e.g. "00123" custom fmt)
      if (formattedW && /^0\d+$/.test(formattedW) && Number(formattedW) === cell.v) {
        return { valueText: formattedW, displayText: formattedW, precisionLoss: null, formula, isBold, isCentered };
      }
      return { valueText: textInt, displayText: formattedW || textInt, precisionLoss: null, formula, isBold, isCentered };
    }

    return {
      valueText: formattedW || String(cell.v),
      displayText: formattedW || String(cell.v),
      precisionLoss: null,
      formula,
      isBold,
      isCentered,
    };
  }

  if (cell.t === 'e') {
    const errDisplay = formattedW || '';
    return {
      valueText: errDisplay,
      displayText: errDisplay,
      precisionLoss: null,
      formula,
      isBold,
      isCentered,
    };
  }

  const rawText = cell.v !== undefined && cell.v !== null ? String(cell.v) : formattedW;
  // Detect literal string cells that already contain scientific notation like "1.23E+15" saved from a prior corrupted export
  if (/^[+-]?\d+(?:\.\d+)?[eE]\+\d{1,3}$/.test(rawText.trim())) {
    return {
      valueText: rawText.trim(),
      displayText: formattedW || rawText.trim(),
      precisionLoss: {
        column: colHeader,
        storedValue: rawText.trim(),
        displayValue: formattedW || rawText.trim(),
        reason: 'Source cell contains literal scientific notation string; trailing identifier digits are unavailable.',
      },
      formula,
      isBold,
      isCentered,
    };
  }

  return {
    valueText: rawText,
    displayText: formattedW || rawText,
    precisionLoss: null,
    formula,
    isBold,
    isCentered,
  };
}

function scoreHeaderRow(cells: string[]): number {
  const nonEmpty = cells.map((c) => c.trim()).filter(Boolean);
  if (nonEmpty.length < 2) return -1;

  // Reject rows that look like a single customer record with phone numbers / 6-digit PINs / addresses with commas
  const phoneOrPinCount = nonEmpty.filter((v) => /\b[6-9]\d{9}\b|\b[1-9]\d{5}\b/.test(v)).length;
  if (phoneOrPinCount > 0) return -5;

  let keywordHits = 0;
  for (const val of nonEmpty) {
    if (
      /^(s\.?no|sl\.?no|id|consumer|customer|client|name|mobile|phone|contact|address|addr|street|road|area|locality|sub.?area|city|town|district|state|pin|pincode|distributor|category|segment|status|notes?)/i.test(
        val
      ) ||
      /(consumer|customer|name|mobile|phone|address|area|street|city|district|pin|distributor)/i.test(val)
    ) {
      keywordHits += 3;
    } else if (val.length <= 35 && !/^\d+$/.test(val)) {
      keywordHits += 1;
    }
  }
  return keywordHits + nonEmpty.length * 0.5;
}

function detectHeaderRowIndex(rows: string[][]): number {
  const limit = Math.min(rows.length, 15);
  let bestIdx = 0;
  let bestScore = -999;
  for (let i = 0; i < limit; i++) {
    const score = scoreHeaderRow(rows[i] || []);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestScore <= 0) {
    // Fallback to first non-empty row
    const firstNonEmpty = rows.findIndex((r) => r.some((c) => c.trim().length > 0));
    return firstNonEmpty >= 0 ? firstNonEmpty : 0;
  }
  return bestIdx;
}

function buildUniqueHeaders(rawCells: string[]): string[] {
  const seen = new Map<string, number>();
  return rawCells.map((cell, i) => {
    const base = String(cell || '').trim() || `Column_${i + 1}`;
    const key = base.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

async function extractXlsxStyleHints(
  buffer: Buffer
): Promise<Map<string, Map<number, { isBold: boolean; isCentered: boolean }>>> {
  const result = new Map<string, Map<number, { isBold: boolean; isCentered: boolean }>>();
  if (buffer.length > 15 * 1024 * 1024) return result;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    wb.eachSheet((ws) => {
      const rowMap = new Map<number, { isBold: boolean; isCentered: boolean }>();
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        let hasBold = false;
        let hasCentered = false;
        let nonEmpty = 0;
        row.eachCell({ includeEmpty: false }, (cell) => {
          const valStr = cell.text?.trim() ?? String(cell.value ?? '').trim();
          if (!valStr) return;
          nonEmpty++;
          if (cell.font?.bold) hasBold = true;
          if (cell.alignment?.horizontal === 'center') hasCentered = true;
        });
        if (nonEmpty > 0 && (hasBold || hasCentered)) {
          rowMap.set(rowNumber, { isBold: hasBold, isCentered: hasCentered });
        }
      });
      result.set(ws.name, rowMap);
    });
  } catch {
    // Safe fallback when ExcelJS style parsing hits uncommon OOXML quirk
  }
  return result;
}

export async function inspectUploadedFile(filename: string, buffer: Buffer): Promise<FileInspectionResult> {
  const extension = validateUploadMagicAndContainer(filename, buffer);

  if (extension === '.csv') {
    const { encoding, text } = detectCsvEncoding(buffer);
    const allPhysicalRows: string[][] = await new Promise((resolve, reject) => {
      const rows: string[][] = [];
      const parser = parseCsv({
        relax_column_count: true,
        skip_empty_lines: false,
        bom: true,
      });
      parser.on('readable', () => {
        let record: string[] | null;
        while ((record = parser.read()) !== null) {
          rows.push(record.map((v) => String(v ?? '')));
          if (rows.length > MAX_ROWS_CAP + 1) {
            parser.destroy(new FileValidationError('ROW_LIMIT_EXCEEDED', `File exceeds maximum allowed ${MAX_ROWS_CAP} rows.`));
            return;
          }
        }
      });
      parser.on('error', (err) => reject(err));
      parser.on('end', () => resolve(rows));
      bufferToStream(Buffer.from(text, 'utf8')).pipe(parser);
    });

    const nonEmptyPhysical = allPhysicalRows.filter((r) => r.some((c) => c.trim().length > 0));
    if (nonEmptyPhysical.length === 0) {
      throw new FileValidationError('EMPTY_CSV', 'CSV file contains no rows.');
    }

    const headerIdx = detectHeaderRowIndex(allPhysicalRows);
    const maxColCount = allPhysicalRows.reduce((m, r) => Math.max(m, r.length), 0);
    if (maxColCount > MAX_COLS_CAP) {
      throw new FileValidationError('COLUMN_LIMIT_EXCEEDED', `CSV exceeds maximum ${MAX_COLS_CAP} columns.`);
    }

    const rawHeaderCells = [...(allPhysicalRows[headerIdx] || [])];
    while (rawHeaderCells.length < maxColCount) rawHeaderCells.push('');
    const rawHeaders = buildUniqueHeaders(rawHeaderCells);

    const dataCandidateRows = allPhysicalRows
      .slice(headerIdx + 1)
      .filter((r) => r.some((c) => c.trim().length > 0));

    const previewRows = dataCandidateRows.slice(0, 50).map((row) => {
      const obj: Record<string, string> = {};
      rawHeaders.forEach((h, idx) => {
        obj[h] = String(row[idx] ?? '');
      });
      return obj;
    });

    return {
      extension,
      detectedEncoding: encoding,
      totalRows: dataCandidateRows.length,
      sheets: [
        {
          sheetIndex: 0,
          sheetName: 'CSV Data',
          rowCount: dataCandidateRows.length,
          physicalRowCount: allPhysicalRows.length,
          headerRowNumber: headerIdx + 1,
          columnCount: rawHeaders.length,
          headers: rawHeaders,
          previewRows,
          hiddenRowCount: 0,
          precisionLossRowCount: 0,
        },
      ],
    };
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellStyles: true,
      cellNF: true,
      cellFormula: true,
      cellDates: false,
      dense: false,
    });
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/password|encrypt/i.test(msg)) {
      throw new FileValidationError('PASSWORD_PROTECTED', 'Password-protected or encrypted Excel files are not supported. Please unprotect the workbook first.');
    }
    throw new FileValidationError('CORRUPTED_WORKBOOK', `Unable to parse workbook: ${msg}`);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new FileValidationError('EMPTY_WORKBOOK', 'Workbook contains no worksheets.');
  }

  const sheets: ParsedSheetPreview[] = [];
  let totalRows = 0;

  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const ws = workbook.Sheets[sheetName];
    if (!ws || !ws['!ref']) return;

    const range = XLSX.utils.decode_range(ws['!ref']);
    const colCount = range.e.c - range.s.c + 1;
    const physicalRowCount = range.e.r - range.s.r + 1;
    if (colCount > MAX_COLS_CAP) {
      throw new FileValidationError('COLUMN_LIMIT_EXCEEDED', `Worksheet "${sheetName}" exceeds ${MAX_COLS_CAP} columns.`);
    }
    if (physicalRowCount > MAX_ROWS_CAP) {
      throw new FileValidationError('ROW_LIMIT_EXCEEDED', `Worksheet "${sheetName}" exceeds ${MAX_ROWS_CAP} rows.`);
    }

    const rowMeta = ws['!rows'] || [];
    let hiddenRowCount = 0;
    let precisionLossRowCount = 0;

    // Sample top 20 rows to locate true header row
    const topRows: string[][] = [];
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 19); r++) {
      const vals: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const parsed = readCellSafely(ws[addr], `Col_${c + 1}`);
        vals.push(parsed.valueText);
      }
      topRows.push(vals);
    }

    if (!topRows.some((r) => r.some((c) => c.trim().length > 0)) && physicalRowCount <= 20) {
      return;
    }

    const relHeaderIdx = detectHeaderRowIndex(topRows);
    const absHeaderR = range.s.r + relHeaderIdx;
    const headerRowNumber = absHeaderR + 1;

    const rawHeaderCells: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: absHeaderR, c });
      rawHeaderCells.push(readCellSafely(ws[addr], `Col_${c + 1}`).valueText);
    }
    const rawHeaders = buildUniqueHeaders(rawHeaderCells);

    let nonEmptyAfterHeader = 0;
    const previewRows: Record<string, string>[] = [];

    for (let r = absHeaderR + 1; r <= range.e.r; r++) {
      if (rowMeta[r]?.hidden) hiddenRowCount++;
      const rowObj: Record<string, string> = {};
      let nonEmptyInRow = 0;
      let hasPrecisionLoss = false;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const hdr = rawHeaders[c - range.s.c];
        const addr = XLSX.utils.encode_cell({ r, c });
        const parsed = readCellSafely(ws[addr], hdr);
        rowObj[hdr] = parsed.valueText;
        if (parsed.valueText.trim().length > 0) nonEmptyInRow++;
        if (parsed.precisionLoss) hasPrecisionLoss = true;
      }
      if (hasPrecisionLoss) precisionLossRowCount++;
      if (nonEmptyInRow > 0) {
        nonEmptyAfterHeader++;
        // Prefer representative multi-column customer rows for Column Mapping preview
        if (previewRows.length < 50 && (nonEmptyInRow >= Math.min(2, rawHeaders.length) || nonEmptyAfterHeader <= 15)) {
          previewRows.push(rowObj);
        }
      }
    }

    if (nonEmptyAfterHeader === 0 && physicalRowCount === 0) return;
    totalRows += nonEmptyAfterHeader;

    sheets.push({
      sheetIndex,
      sheetName,
      rowCount: nonEmptyAfterHeader,
      physicalRowCount: range.e.r + 1,
      headerRowNumber,
      columnCount: rawHeaders.length,
      headers: rawHeaders,
      previewRows,
      hiddenRowCount,
      precisionLossRowCount,
    });
  });

  if (sheets.length === 0) {
    throw new FileValidationError('EMPTY_WORKBOOK', 'All worksheets in the workbook are empty.');
  }

  return {
    extension,
    detectedEncoding: null,
    sheets,
    totalRows,
  };
}

export async function* streamPhysicalSheetRows(
  buffer: Buffer,
  extension: string,
  sheetName: string,
  headerRowNumber = 1,
  includeHiddenRows = true
): AsyncGenerator<{ headers: string[]; row: PhysicalRowData }> {
  if (extension === '.csv') {
    const { text } = detectCsvEncoding(buffer);
    const parser = bufferToStream(Buffer.from(text, 'utf8')).pipe(
      parseCsv({ relax_column_count: true, skip_empty_lines: false, bom: true })
    );
    const allRows: string[][] = [];
    for await (const rawRecord of parser as AsyncIterable<string[]>) {
      allRows.push(rawRecord.map((v) => String(v ?? '')));
    }
    if (allRows.length === 0) return;

    const hdrIdx = Math.max(0, Math.min(allRows.length - 1, headerRowNumber - 1));
    const maxCols = allRows.reduce((m, r) => Math.max(m, r.length), 0);
    const rawHeaderCells = [...(allRows[hdrIdx] || [])];
    while (rawHeaderCells.length < maxCols) rawHeaderCells.push('');
    const headers = buildUniqueHeaders(rawHeaderCells);

    for (let i = 0; i < allRows.length; i++) {
      const cells = allRows[i];
      const cellsByHeader: Record<string, string> = {};
      const displayByHeader: Record<string, string> = {};
      const precisionLossCols: PrecisionLossDetail[] = [];
      let nonEmptyCount = 0;

      headers.forEach((h, idx) => {
        const val = String(cells[idx] ?? '');
        cellsByHeader[h] = val;
        displayByHeader[h] = val;
        if (val.trim().length > 0) nonEmptyCount++;
        if (/^[+-]?\d+(?:\.\d+)?[eE]\+\d{1,3}$/.test(val.trim())) {
          precisionLossCols.push({
            column: h,
            storedValue: val.trim(),
            displayValue: val.trim(),
            reason: 'CSV cell contains scientific notation string; trailing digits unavailable.',
          });
        }
      });

      const joinedUpperCheck = cells.map((c) => c.trim()).filter(Boolean).join(' ');
      const hasAlpha = /[a-zA-Z]/.test(joinedUpperCheck);

      yield {
        headers,
        row: {
          physicalRowNumber: i + 1,
          cellsByHeader,
          displayByHeader,
          orderedCells: headers.map((h) => cellsByHeader[h] ?? ''),
          isBlank: nonEmptyCount === 0,
          isHidden: false,
          isMergedRow: false,
          isBoldRow: false,
          isCenteredRow: false,
          isUppercaseRow: hasAlpha && joinedUpperCheck === joinedUpperCheck.toUpperCase(),
          nonEmptyCount,
          precisionLossCols,
          formulaCols: [],
        },
      };
    }
    return;
  }

  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellStyles: true,
    cellNF: true,
    cellFormula: true,
    cellDates: false,
  });
  const ws = workbook.Sheets[sheetName];
  if (!ws || !ws['!ref']) throw new Error(`Worksheet "${sheetName}" not found`);

  const styleHintsBySheet = extension === '.xlsx' ? await extractXlsxStyleHints(buffer) : new Map();
  const sheetStyleHints: Map<number, { isBold: boolean; isCentered: boolean }> | undefined =
    styleHintsBySheet.get(sheetName);

  const range = XLSX.utils.decode_range(ws['!ref']);
  const merges = ws['!merges'] || [];
  const rowMeta = ws['!rows'] || [];

  const mergedRowsSet = new Set<number>();
  for (const m of merges) {
    if (m.e.c > m.s.c) {
      for (let r = m.s.r; r <= m.e.r; r++) {
        mergedRowsSet.add(r);
      }
    }
  }

  const absHeaderR = Math.max(range.s.r, Math.min(range.e.r, headerRowNumber - 1));
  const rawHeaderCells: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: absHeaderR, c });
    rawHeaderCells.push(readCellSafely(ws[addr], `Col_${c + 1}`).valueText);
  }
  const headers = buildUniqueHeaders(rawHeaderCells);

  for (let r = 0; r <= range.e.r; r++) {
    const physicalRowNumber = r + 1;
    const isHidden = Boolean(rowMeta[r]?.hidden);
    if (isHidden && !includeHiddenRows) {
      continue;
    }

    const cellsByHeader: Record<string, string> = {};
    const displayByHeader: Record<string, string> = {};
    const orderedCells: string[] = [];
    const precisionLossCols: PrecisionLossDetail[] = [];
    const formulaCols: Array<{ column: string; formula: string }> = [];
    let nonEmptyCount = 0;
    let isBoldRow = Boolean(sheetStyleHints?.get(physicalRowNumber)?.isBold);
    let isCenteredRow = Boolean(sheetStyleHints?.get(physicalRowNumber)?.isCentered);

    for (let c = range.s.c; c <= range.e.c; c++) {
      const hdr = headers[c - range.s.c];
      const addr = XLSX.utils.encode_cell({ r, c });
      const parsed = readCellSafely(ws[addr], hdr);
      cellsByHeader[hdr] = parsed.valueText;
      displayByHeader[hdr] = parsed.displayText;
      orderedCells.push(parsed.valueText);

      if (parsed.valueText.trim().length > 0) {
        nonEmptyCount++;
        if (parsed.isBold) isBoldRow = true;
        if (parsed.isCentered) isCenteredRow = true;
      }
      if (parsed.precisionLoss) precisionLossCols.push(parsed.precisionLoss);
      if (parsed.formula) formulaCols.push({ column: hdr, formula: parsed.formula });
    }

    const nonEmptyText = orderedCells.map((x) => x.trim()).filter(Boolean).join(' ');
    const hasAlpha = /[a-zA-Z]/.test(nonEmptyText);

    yield {
      headers,
      row: {
        physicalRowNumber,
        cellsByHeader,
        displayByHeader,
        orderedCells,
        isBlank: nonEmptyCount === 0,
        isHidden,
        isMergedRow: mergedRowsSet.has(r),
        isBoldRow,
        isCenteredRow,
        isUppercaseRow: hasAlpha && nonEmptyText === nonEmptyText.toUpperCase(),
        nonEmptyCount,
        precisionLossCols,
        formulaCols,
      },
    };
  }
}

export async function* streamSheetRows(
  buffer: Buffer,
  extension: string,
  sheetName: string
): AsyncGenerator<{ rowNumber: number; row: Record<string, string> }> {
  let seq = 0;
  for await (const { row } of streamPhysicalSheetRows(buffer, extension, sheetName, 1, true)) {
    if (row.physicalRowNumber === 1 || row.isBlank) continue;
    seq++;
    yield { rowNumber: seq, row: row.cellsByHeader };
  }
}
