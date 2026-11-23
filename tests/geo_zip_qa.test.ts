import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { createApiApp } from '../server/app.ts';
import { getDb, runMigrations } from '../server/infrastructure/db/index.ts';
import { jobWorker } from '../server/infrastructure/queue/PostgresJobWorker.ts';
import { compareGeoTokens, parseAddressHierarchy } from '../server/modules/processing/geoIntelligence.engine.ts';

async function buildScatteredMultiSheetWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('Sheet_Alpha');
  ws1.addRow(['Consumer ID', 'Customer Name', 'Phone', 'Address', 'Area']);
  ws1.addRow(['000100000001', 'Karthik Raja', '9876543210', '12 Gandhi Street, Madurai 625001', 'AREA NORTH']);
  ws1.addRow(['000100000002', 'Meena Devi', '9876543211', '45 Nehru Road, Madurai 625001', 'AREA SOUTH']);

  const ws2 = wb.addWorksheet('Sheet_Beta');
  ws2.addRow(['Consumer ID', 'Customer Name', 'Phone', 'Address', 'Area']);
  ws2.addRow(['000100000003', 'Suresh Babu', '9876543212', '8 Gandhi Street, Madurai 625001', 'area north']);
  ws2.addRow(['000100000004', 'Divya K', '9876543213', '19 Temple Street, Madurai 625001', 'Area  North']);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function buildFiveStreetsOneAreaWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CentralZone');
  ws.addRow(['Consumer ID', 'Customer Name', 'Phone', 'Address', 'Area']);
  ws.addRow(['000200000001', 'C1', '9876501001', '11, Temple Lane, Madurai 625001', 'Zone Central']);
  ws.addRow(['000200000002', 'C2', '9876501002', '22, Cross 2, Anna Nagar, Madurai 625001', 'zone central']);
  ws.addRow(['000200000003', 'C3', '9876501003', '33, Gandhi Street, Madurai 625001', 'ZONE CENTRAL']);
  ws.addRow(['000200000004', 'C4', '9876501004', '44, Cross 1, Anna Nagar, Madurai 625001', 'Zone Central']);
  ws.addRow(['000200000005', 'C5', '9876501005', '55, Nehru Road, Madurai 625001', 'Zone Central']);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function buildFortyAreasWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('FortyAreas');
  ws.addRow(['Consumer ID', 'Customer Name', 'Phone', 'Address', 'Area']);
  let seq = 1;
  for (let a = 1; a <= 40; a++) {
    const areaName = `Sector ${String(a).padStart(2, '0')}`;
    const streets = ['First Cross Street', 'Second Main Road', 'Temple Colony Lane'];
    for (let s = 0; s < 3; s++) {
      const id = String(100000000 + seq++).padStart(10, '0');
      ws.addRow([
        id,
        `Customer ${seq}`,
        `98${String(10000000 + seq).slice(-8)}`,
        `${10 + s}, ${streets[s]}, Madurai 625001`,
        areaName,
      ]);
    }
  }
  // 2 Unassigned-Area customers (must go to UNASSIGNED_AREA_RECORDS.csv, NOT a 41st Area xlsx!)
  ws.addRow(['0099990001', 'Unassigned One', '9876543298', '91 Anna Street, Madurai 625001', '']);
  ws.addRow(['0099990002', 'Unassigned Two', '9876543299', '92 Gandhi Road, Madurai 625001', '']);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function buildMultiAreaHeadingConflictPrecisionWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('MasterSheet');

  // Row 1: Pre-header Title banner (true header is row 2)
  ws.mergeCells('A1:E1');
  ws.getCell('A1').value = 'MONTHLY CONSUMER DISTRIBUTION REPORT';
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  // Row 2: Column Headers
  const hdr = ws.addRow(['Consumer No', 'Customer Name', 'Mobile', 'Address', 'Area']);
  hdr.font = { bold: true };

  // Row 3: Section Heading 1
  ws.mergeCells('A3:E3');
  ws.getCell('A3').value = 'CROSS 4, GANDHI NAGAR';
  ws.getCell('A3').font = { bold: true };
  ws.getCell('A3').alignment = { horizontal: 'center' };

  // Row 4: Matching heading + leading zero ID
  ws.addRow(['001122334455', 'Arun Kumar', '9876500001', '14, Cross 4, Gandhi Nagar, Madurai 625020', 'AREA A - 1']);

  // Row 5: Vague address under heading -> NEEDS_REVIEW
  ws.addRow([700001234567, 'Priya S', '9876500002', 'Door 18, Madurai 625020', 'AREA A - 1']);

  // Row 6: Blank separator row
  ws.addRow([]);

  // Row 7: Section Heading 2 ("CROSS 5, GANDHI NAGAR")
  ws.mergeCells('A7:E7');
  ws.getCell('A7').value = 'CROSS 5, GANDHI NAGAR';
  ws.getCell('A7').font = { bold: true };
  ws.getCell('A7').alignment = { horizontal: 'center' };

  // Row 8: CONFLICT row!
  ws.addRow(['001122334458', 'Vignesh M', '9876500003', '22, Cross 4, Gandhi Nagar, Madurai', 'AREA A - 2']);

  // Row 9: Repeated heading
  ws.mergeCells('A9:E9');
  ws.getCell('A9').value = 'CROSS 5, GANDHI NAGAR';
  ws.getCell('A9').font = { bold: true };

  // Row 10: Tamil address + formula injection in name
  ws.addRow(['001122334459', '=SUM(A1:A2)', '9876500004', '12, அண்ணா தெரு, மதுரை 625001', 'AREA B']);

  // Row 11-12: Case H (Locality within locality) + same street across distinct Areas
  ws.addRow(['001122334460', 'Deepak R', '9876500005', '5, Main Road, West Anna Nagar, Madurai', 'AREA A - 1']);
  ws.addRow(['001122334461', 'Lakshmi N', '9876500006', '9, Main Road, East Anna Nagar, Madurai', 'AREA C']);

  // Row 13: Ambiguous address (UNIDENTIFIED) + precision-loss (>15 digit float stored as number)
  ws.addRow([123456789012345678, 'Kavin P', '9876500007', 'Near Bus Stand, Trichy', 'AREA C']);

  // Row 14: Hidden customer row
  const hiddenRow = ws.addRow(['001122334463', 'Hidden Customer', '9876500008', '7, Nehru Road, Salem', 'AREA C']);
  hiddenRow.hidden = true;

  // Row 15: Subtotal / Report Footer Row (must NOT enter clean_records)
  ws.addRow(['', 'TOTAL CUSTOMERS: 9', '', '', '']);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function waitForJob(api: (p: string, o?: RequestInit) => Promise<any>, jobId: string) {
  for (let i = 0; i < 120; i++) {
    const r = await api(`/api/v1/jobs/${jobId}`);
    if (['COMPLETED', 'FAILED_DEAD_LETTER', 'CANCELLED'].includes(r.data.job.status)) {
      return r.data.job;
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function runGeoZipQA() {
  const testDataDir = path.resolve(process.cwd(), '.data', 'pgdata');
  fs.rmSync(testDataDir, { recursive: true, force: true });

  await runMigrations();
  await jobWorker.start();

  const app = createApiApp();
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let authToken = '';
  let refreshToken = '';
  const api = async (urlPath: string, opts: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      ...opts,
      headers: {
        ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(opts.headers || {}),
      },
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };

  try {
    console.log('QA 0. Geo Rules: Cross 4 != Cross 5, Case H Locality-Within-Locality, Tamil, Ambiguous...');
    assert.equal(compareGeoTokens('22, Cross 4, Gandhi Nagar', 'Cross 5, Gandhi Nagar'), 'CONFLICT');
    assert.equal(compareGeoTokens('14, Cross 4, Gandhi Nagar', 'Cross 4, Gandhi Nagar'), 'MATCH');
    assert.equal(compareGeoTokens('Door 18, Madurai 625020', 'Cross 4, Gandhi Nagar'), 'INSUFFICIENT');

    const westAnna = parseAddressHierarchy('5, Main Road, West Anna Nagar, Madurai');
    const eastAnna = parseAddressHierarchy('9, Main Road, East Anna Nagar, Madurai');
    assert.notEqual(
      westAnna.streetGroup.toLowerCase(),
      eastAnna.streetGroup.toLowerCase(),
      'Case H: Main Road, West Anna Nagar must stay distinct from Main Road, East Anna Nagar'
    );

    const tamilParsed = parseAddressHierarchy('12, அண்ணா தெரு, மதுரை 625001');
    assert.ok(tamilParsed.street?.includes('அண்ணா தெரு'), `Expected Tamil street parsed, got ${tamilParsed.street}`);
    assert.equal(tamilParsed.pinCode, '625001');

    const ambigParsed = parseAddressHierarchy('Near Bus Stand, Trichy');
    assert.equal(ambigParsed.streetGroup, 'UNIDENTIFIED');

    console.log('Bootstrapping Super Admin...');
    const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@structiq.local';
    const adminPass = process.env.SEED_ADMIN_PASSWORD || 'StructIQ!Admin2026';
    const statusRes = await api('/api/v1/auth/status');
    let authRes: any;
    if (statusRes.data?.needsInitialSetup) {
      authRes = await api('/api/v1/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ fullName: 'QA Super Admin', email: adminEmail, password: adminPass }),
      });
      assert.equal(authRes.status, 201);
    } else {
      authRes = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: adminEmail, password: adminPass }),
      });
      assert.equal(authRes.status, 200);
    }
    authToken = authRes.data.accessToken;
    refreshToken = authRes.data.refreshToken;
    assert.ok(authToken);
    assert.ok(refreshToken);

    // =========================================================================
    // TEST 8 (Early): Auth & Admin User Creation under stale-cookie conditions
    // =========================================================================
    console.log('QA TEST 8. Admin User Creation & Stale Cookie / Bearer Precedence...');
    const listUsersRes = await api('/api/v1/users', {
      headers: { Cookie: 'structiq_session=stale_revoked_cookie_value' },
    });
    assert.equal(listUsersRes.status, 200, 'Valid Bearer token must override stale cookie on GET /api/v1/users');

    const createAdminRes = await api('/api/v1/users', {
      method: 'POST',
      headers: { Cookie: 'structiq_session=stale_revoked_cookie_value' },
      body: JSON.stringify({
        fullName: 'Ramesh',
        email: 'vkvkvk@gmail.com',
        password: 'Ramesh!Admin2026',
        role: 'ADMIN',
      }),
    });
    assert.equal(createAdminRes.status, 201, 'Admin creation must succeed with valid Bearer despite stale cookie');
    assert.equal(createAdminRes.data.user.email, 'vkvkvk@gmail.com');

    const refreshWithStaleCookie = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'structiq_refresh=stale_refresh_cookie_value',
      },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(refreshWithStaleCookie.status, 200, 'Refresh with valid body.refreshToken must override stale cookie');
    const refreshedPayload = await refreshWithStaleCookie.json();
    authToken = refreshedPayload.accessToken;
    refreshToken = refreshedPayload.refreshToken;

    // =========================================================================
    // TEST 1: Scattered / Repeated Areas & Multi-Worksheet Consolidation
    // =========================================================================
    console.log('QA TEST 1. Scattered Repeated Areas & Multi-Worksheet Consolidation...');
    const buf1 = await buildScatteredMultiSheetWorkbook();
    const form1 = new FormData();
    form1.append(
      'file',
      new Blob([new Uint8Array(buf1)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'scattered_multisheet.xlsx'
    );
    const up1 = await api('/api/v1/uploads', { method: 'POST', body: form1 });
    assert.equal(up1.status, 201);
    assert.equal(up1.data.sheets.length, 2);
    const up1Id = up1.data.upload.id;
    const sh1Id = up1.data.sheets[0].id;

    const det1 = await api(`/api/v1/processing/uploads/${up1Id}/sheets/${sh1Id}/detect-mapping`, {
      method: 'POST',
      body: JSON.stringify({ useAi: false }),
    });
    await api(`/api/v1/processing/uploads/${up1Id}/sheets/${sh1Id}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({ mappings: det1.data.mappings }),
    });
    const start1 = await api(`/api/v1/processing/uploads/${up1Id}/sheets/${sh1Id}/start`, {
      method: 'POST',
      body: JSON.stringify({ checkDuplicatesAgainstMaster: false, runCategorisation: true, processAllSheets: true }),
    });
    assert.equal(start1.status, 202);
    assert.equal(start1.data.jobs.length, 2, 'Must queue jobs for both worksheets');
    for (const j of start1.data.jobs) {
      const doneJ = await waitForJob(api, j.id);
      assert.equal(doneJ.status, 'COMPLETED');
    }

    const sum1 = await api(`/api/v1/geo/uploads/${up1Id}/summary`);
    assert.equal(sum1.data.reconciliation.totalCustomerRecords, 4);
    assert.equal(sum1.data.reconciliation.distinctAreasCount, 2, 'AREA NORTH / area north / Area  North must consolidate into 1 Area + Area South = 2');

    const exp1 = await api('/api/v1/exports', {
      method: 'POST',
      body: JSON.stringify({ exportMode: 'AREA_WISE', filters: { uploadId: up1Id } }),
    });
    assert.equal(exp1.status, 202);
    const expJob1 = await waitForJob(api, exp1.data.job.id);
    assert.equal(expJob1.status, 'COMPLETED');
    const dl1 = await api(`/api/v1/exports/${exp1.data.exportRecord.id}/download`);
    const zip1 = new AdmZip(dl1.data);
    const entries1 = zip1.getEntries().map((e) => e.entryName);
    assert.equal(entries1.length, 2, `Expected exact 2 Area .xlsx files at ZIP root, got: ${entries1.join(', ')}`);
    assert.ok(entries1.every((n) => n.endsWith('.xlsx') && !n.includes('/')), 'All files must be Area .xlsx at ZIP root (0 street workbooks)');

    // =========================================================================
    // TEST 2: 1 Area with 5 Identifiable Streets -> 1 Workbook with 5 Sections
    // =========================================================================
    console.log('QA TEST 2. 1 Area with 5 Streets -> 1 Workbook (0 street workbooks)...');
    const buf2 = await buildFiveStreetsOneAreaWorkbook();
    const form2 = new FormData();
    form2.append(
      'file',
      new Blob([new Uint8Array(buf2)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'five_streets_one_area.xlsx'
    );
    const up2 = await api('/api/v1/uploads', { method: 'POST', body: form2 });
    const up2Id = up2.data.upload.id;
    const sh2Id = up2.data.sheets[0].id;
    const det2 = await api(`/api/v1/processing/uploads/${up2Id}/sheets/${sh2Id}/detect-mapping`, {
      method: 'POST',
      body: JSON.stringify({ useAi: false }),
    });
    await api(`/api/v1/processing/uploads/${up2Id}/sheets/${sh2Id}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({ mappings: det2.data.mappings }),
    });
    const start2 = await api(`/api/v1/processing/uploads/${up2Id}/sheets/${sh2Id}/start`, {
      method: 'POST',
      body: JSON.stringify({ checkDuplicatesAgainstMaster: false, runCategorisation: true }),
    });
    assert.equal((await waitForJob(api, start2.data.job.id)).status, 'COMPLETED');

    const exp2 = await api('/api/v1/exports', {
      method: 'POST',
      body: JSON.stringify({ exportMode: 'AREA_WISE', filters: { uploadId: up2Id } }),
    });
    assert.equal((await waitForJob(api, exp2.data.job.id)).status, 'COMPLETED');
    const dl2 = await api(`/api/v1/exports/${exp2.data.exportRecord.id}/download`);
    const zip2 = new AdmZip(dl2.data);
    const entries2 = zip2.getEntries().map((e) => e.entryName);
    assert.equal(entries2.length, 1, `Expected exactly 1 Area workbook, got ${entries2.join(', ')}`);

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(zip2.getEntry(entries2[0])!.getData() as any);
    assert.deepEqual(
      wb2.worksheets.map((w) => w.name),
      ['STRUCTURED_DATA', 'ALL_RECORDS', 'SUMMARY'],
      'NEEDS_REVIEW sheet must be omitted when 0 rows need review'
    );
    const struct2Text = JSON.stringify(wb2.getWorksheet('STRUCTURED_DATA')!.getSheetValues());
    assert.ok(struct2Text.includes('Cross 1, Anna Nagar'));
    assert.ok(struct2Text.includes('Cross 2, Anna Nagar'));
    assert.ok(struct2Text.includes('Gandhi Street'));
    assert.ok(struct2Text.includes('Nehru Road'));
    assert.ok(struct2Text.includes('Temple Lane'));
    assert.ok(struct2Text.includes('END OF AREA:'));
    assert.equal(wb2.getWorksheet('ALL_RECORDS')!.rowCount - 1, 5);

    // =========================================================================
    // TEST 3: 40 Distinct Valid Areas -> Exact 40 .xlsx Workbooks + Unassigned CSV
    // =========================================================================
    console.log('QA TEST 3. 40 Distinct Valid Areas -> Exact 40 .xlsx Workbooks + UNASSIGNED_AREA_RECORDS.csv...');
    const buf40 = await buildFortyAreasWorkbook();
    const form40 = new FormData();
    form40.append(
      'file',
      new Blob([new Uint8Array(buf40)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'forty_areas.xlsx'
    );
    const up40 = await api('/api/v1/uploads', { method: 'POST', body: form40 });
    const up40Id = up40.data.upload.id;
    const sh40Id = up40.data.sheets[0].id;
    const det40 = await api(`/api/v1/processing/uploads/${up40Id}/sheets/${sh40Id}/detect-mapping`, {
      method: 'POST',
      body: JSON.stringify({ useAi: false }),
    });
    await api(`/api/v1/processing/uploads/${up40Id}/sheets/${sh40Id}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({ mappings: det40.data.mappings }),
    });
    const start40 = await api(`/api/v1/processing/uploads/${up40Id}/sheets/${sh40Id}/start`, {
      method: 'POST',
      body: JSON.stringify({ checkDuplicatesAgainstMaster: false, runCategorisation: true }),
    });
    assert.equal((await waitForJob(api, start40.data.job.id)).status, 'COMPLETED');

    const exp40 = await api('/api/v1/exports', {
      method: 'POST',
      body: JSON.stringify({ exportMode: 'AREA_WISE', filters: { uploadId: up40Id } }),
    });
    assert.equal((await waitForJob(api, exp40.data.job.id)).status, 'COMPLETED');
    const dl40 = await api(`/api/v1/exports/${exp40.data.exportRecord.id}/download`);
    const zip40 = new AdmZip(dl40.data);
    const entries40 = zip40.getEntries().map((e) => e.entryName);
    const xlsx40 = entries40.filter((n) => n.endsWith('.xlsx'));
    assert.equal(xlsx40.length, 40, `Expected EXACT 40 Area .xlsx workbooks, got ${xlsx40.length}`);
    assert.ok(entries40.includes('UNASSIGNED_AREA_RECORDS.csv'), 'Unassigned records must be exported in UNASSIGNED_AREA_RECORDS.csv');
    assert.equal(entries40.length, 41, 'ZIP must have only 40 Area .xlsx files + 1 UNASSIGNED_AREA_RECORDS.csv');

    let total40Customers = 0;
    for (const fName of xlsx40) {
      const wbA = new ExcelJS.Workbook();
      await wbA.xlsx.load(zip40.getEntry(fName)!.getData() as any);
      const allWs = wbA.getWorksheet('ALL_RECORDS')!;
      const cnt = allWs.rowCount - 1;
      assert.equal(cnt, 3, `${fName} must contain only its 3 customers`);
      total40Customers += cnt;
    }
    assert.equal(total40Customers, 120, '40 areas * 3 customers = 120 assigned customers');

    // =========================================================================
    // TEST 4, 5, 6, 7: Headings, Conflicts, Case H, Tamil, Integrity & Complete Audit ZIP
    // =========================================================================
    console.log('QA TEST 4/5/6/7. Pre-Header, Bold Headings, Conflicts, Case H, Tamil, Precision Loss, Audit ZIP...');
    const complexBuf = await buildMultiAreaHeadingConflictPrecisionWorkbook();
    const formB = new FormData();
    formB.append(
      'file',
      new Blob([new Uint8Array(complexBuf)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'complex_geo.xlsx'
    );
    const upB = await api('/api/v1/uploads', { method: 'POST', body: formB });
    assert.equal(upB.status, 201);
    const upBId = upB.data.upload.id;
    const shB = upB.data.sheets[0];
    assert.equal(shB.header_row_number, 2, 'Should auto-detect Row 2 as header row instead of Row 1 banner');

    await api(`/api/v1/processing/uploads/${upBId}/sheets/${shB.id}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({
        mappings: [
          { sourceIndex: 0, sourceColumn: 'Consumer No', targetField: 'consumer_id', detectionSource: 'MANUAL', confidence: 1 },
          { sourceIndex: 1, sourceColumn: 'Customer Name', targetField: 'full_name', detectionSource: 'MANUAL', confidence: 1 },
          { sourceIndex: 2, sourceColumn: 'Mobile', targetField: 'phone_raw', detectionSource: 'MANUAL', confidence: 1 },
          { sourceIndex: 3, sourceColumn: 'Address', targetField: 'address_combined', detectionSource: 'MANUAL', confidence: 1 },
          { sourceIndex: 4, sourceColumn: 'Area', targetField: 'area', detectionSource: 'MANUAL', confidence: 1 },
        ],
      }),
    });

    const startB = await api(`/api/v1/processing/uploads/${upBId}/sheets/${shB.id}/start`, {
      method: 'POST',
      body: JSON.stringify({ checkDuplicatesAgainstMaster: false, runCategorisation: true, includeHiddenRows: true }),
    });
    assert.equal((await waitForJob(api, startB.data.job.id)).status, 'COMPLETED');

    const sumB = await api(`/api/v1/geo/uploads/${upBId}/summary`);
    const recB = sumB.data.reconciliation;
    assert.equal(recB.SECTION_HEADING, 3);
    assert.equal(recB.EMPTY_SEPARATOR, 1);
    assert.equal(recB.SUBTOTAL_OR_REPORT_ROW, 2);
    assert.equal(recB.totalCustomerRecords, 8);
    assert.equal(recB.distinctAreasCount, 4);
    assert.ok(recB.conflictCount >= 1);
    assert.ok(recB.unidentifiedStreetCount >= 1);
    assert.ok(recB.precisionLossRows >= 1);

    const recListRes = await api(`/api/v1/records?uploadId=${upBId}&pageSize=50`);
    const itemsB = recListRes.data.items;
    const arun = itemsB.find((r: any) => r.full_name === 'Arun Kumar');
    assert.equal(arun.consumer_id, '001122334455', 'Leading zeros must be preserved');
    assert.equal(arun.original_row_number, 4, 'Original physical Excel row number must be preserved');
    const priya = itemsB.find((r: any) => r.full_name === 'Priya S');
    assert.equal(priya.consumer_id, '700001234567');
    assert.equal(priya.geographic_review_status, 'NEEDS_REVIEW');
    const vignesh = itemsB.find((r: any) => r.full_name === 'Vignesh M');
    assert.equal(vignesh.geographic_review_status, 'CONFLICT');

    // Audit ZIP verification (Area workbooks + reports, ZERO street workbooks)
    const expCreate = await api('/api/v1/exports', {
      method: 'POST',
      body: JSON.stringify({ exportMode: 'COMBINED_ZIP', filters: { uploadId: upBId } }),
    });
    assert.equal(expCreate.status, 202);
    const expJob = await waitForJob(api, expCreate.data.job.id);
    assert.equal(expJob.status, 'COMPLETED');

    const dlB = await api(`/api/v1/exports/${expCreate.data.exportRecord.id}/download`);
    const zipB = new AdmZip(dlB.data);
    const entryNames = zipB.getEntries().map((e) => e.entryName);
    assert.ok(entryNames.includes('AREA_SUMMARY.xlsx'));
    assert.ok(entryNames.includes('PROCESSING_REPORT.xlsx'));
    assert.ok(entryNames.includes('NEEDS_REVIEW.xlsx'));
    assert.ok(entryNames.includes('ROW_AUDIT.xlsx'));

    const areaWiseFiles = entryNames.filter((n) => n.startsWith('AREA_WISE/') && n.endsWith('.xlsx'));
    const streetWiseFiles = entryNames.filter((n) => n.startsWith('STREET_WISE/'));
    assert.equal(areaWiseFiles.length, 4, 'Must have exact 4 Area workbooks');
    assert.equal(streetWiseFiles.length, 0, 'Must NEVER produce STREET_WISE workbooks');

    let sumAreaAllRecords = 0;
    for (const af of areaWiseFiles) {
      const wbLoaded = new ExcelJS.Workbook();
      await wbLoaded.xlsx.load(zipB.getEntry(af)!.getData() as any);
      const sheetNames = wbLoaded.worksheets.map((w) => w.name);
      assert.ok(sheetNames.includes('STRUCTURED_DATA'), `${af} missing STRUCTURED_DATA`);
      assert.ok(sheetNames.includes('ALL_RECORDS'), `${af} missing ALL_RECORDS`);
      assert.ok(sheetNames.includes('SUMMARY'), `${af} missing SUMMARY`);
      assert.ok(sheetNames.length <= 4, `${af} must NEVER contain per-street tabs, got ${sheetNames.join(', ')}`);
      const countInArea = wbLoaded.getWorksheet('ALL_RECORDS')!.rowCount - 1;
      assert.ok(countInArea > 0);
      sumAreaAllRecords += countInArea;
    }
    assert.equal(sumAreaAllRecords, 8);

    // Formula neutralization verification in Area B
    const areaBEntry = areaWiseFiles.find((f) => f.toUpperCase().includes('AREA B'));
    assert.ok(areaBEntry);
    const wbAreaB = new ExcelJS.Workbook();
    await wbAreaB.xlsx.load(zipB.getEntry(areaBEntry)!.getData() as any);
    const areaBText = JSON.stringify(wbAreaB.getWorksheet('ALL_RECORDS')!.getSheetValues());
    assert.ok(areaBText.includes("'=SUM(A1:A2)"));

    // Verify Merge/Rename & Split & Hidden Rows toggle
    const mergeRes = await api('/api/v1/geo/groups/rename-merge', {
      method: 'POST',
      body: JSON.stringify({
        uploadId: upBId,
        level: 'AREA',
        sourceLabels: ['AREA A - 2'],
        targetLabel: 'AREA A - 1',
      }),
    });
    assert.equal(mergeRes.status, 200);
    assert.equal(mergeRes.data.updatedCount, 1);

    const repHiddenOff = await api(`/api/v1/geo/uploads/${upBId}/reprocess`, {
      method: 'POST',
      body: JSON.stringify({ includeHiddenRows: false }),
    });
    assert.equal((await waitForJob(api, repHiddenOff.data.job.id)).status, 'COMPLETED');
    const sumHiddenOff = await api(`/api/v1/geo/uploads/${upBId}/summary`);
    assert.equal(sumHiddenOff.data.reconciliation.totalCustomerRecords, 7);

    console.log('ALL 8 AREA-WISE STRUCTURED EXCEL, MULTI-SHEET, RECONCILIATION & AUTH QA TESTS PASSED!');
  } finally {
    await jobWorker.stop();
    await getDb().close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runGeoZipQA().catch((err) => {
  console.error('GEO QA FAILED:', err);
  process.exit(1);
});
