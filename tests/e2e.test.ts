import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createApiApp } from '../server/app.ts';
import { env } from '../server/config/env.ts';
import { getDb, runMigrations } from '../server/infrastructure/db/index.ts';
import { jobWorker } from '../server/infrastructure/queue/PostgresJobWorker.ts';
import { decryptStoragePayload, encryptStoragePayload } from '../server/infrastructure/storage/StorageAdapter.ts';
import { cleanAndValidateRow, detectColumnsDeterministic } from '../server/modules/processing/cleaning.engine.ts';
import { neutralizeExcelCell } from '../server/modules/exports/exports.module.ts';
import { FileValidationError, inspectUploadedFile } from '../server/modules/uploads/fileParser.ts';

async function runTests() {
  // Use clean isolated test DB dir
  const testDataDir = path.resolve(process.cwd(), '.data', 'pgdata');
  fs.rmSync(testDataDir, { recursive: true, force: true });

  await runMigrations();
  await jobWorker.start();

  const app = createApiApp();
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let cookieJar = '';
  const api = async (urlPath: string, opts: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      ...opts,
      headers: {
        ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(cookieJar ? { Cookie: cookieJar } : {}),
        ...(opts.headers || {}),
      },
    });
    const setCookies = res.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) {
      const merged = new Map<string, string>();
      for (const pair of cookieJar.split('; ').filter(Boolean)) {
        const [k, ...v] = pair.split('=');
        merged.set(k, v.join('='));
      }
      for (const sc of setCookies) {
        const first = sc.split(';')[0];
        const [k, ...v] = first.split('=');
        merged.set(k, v.join('='));
      }
      cookieJar = Array.from(merged.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };

  try {
    console.log('1. Testing cleaning engine & formula neutralization...');
    assert.equal(neutralizeExcelCell('=CMD|"/C calc"!A0'), '\'=CMD|"/C calc"!A0');
    assert.equal(neutralizeExcelCell('+1+1'), '\'+1+1');
    assert.equal(neutralizeExcelCell('@SUM(A1)'), '\'@SUM(A1)');

    // Ensure smartTitleCase / cleanAndValidateRow preserves exact formula-like strings without case mutation
    const formulaCleaned = cleanAndValidateRow({
      rawRow: {
        'Customer Name': '=CMD|"/C calc"!A0',
        'Contact Number': '9876543210',
        'Full Address': 'Anna Nagar, Chennai 600040',
      },
      mappings: [
        { sourceColumn: 'Customer Name', targetField: 'full_name' },
        { sourceColumn: 'Contact Number', targetField: 'phone_raw' },
        { sourceColumn: 'Full Address', targetField: 'address_combined' },
      ],
      defaultRegion: 'IN',
    });
    assert.equal(formulaCleaned.fullName, '=CMD|"/C calc"!A0');

    const cleaned = cleanAndValidateRow({
      rawRow: {
        'Customer Name': 'kumar s - 9876543210',
        'Contact Number': '+91 98765 43210 / 0452-2345678',
        'Full Address': '14 West Masi St, Anna Nagar, Madurai, TN 625020',
      },
      mappings: [
        { sourceColumn: 'Customer Name', targetField: 'name_and_phone' },
        { sourceColumn: 'Contact Number', targetField: 'phone_multi' },
        { sourceColumn: 'Full Address', targetField: 'address_combined' },
      ],
      defaultRegion: 'IN',
    });
    assert.equal(cleaned.fullName, 'Kumar S');
    assert.equal(cleaned.phoneE164, '+919876543210');
    assert.equal(cleaned.city, 'Madurai');
    assert.equal(cleaned.state, 'Tamil Nadu');
    assert.equal(cleaned.pinCode, '625020');

    console.log('2. Testing file security guards (.xlsm, magic bytes, & OLE2 encrypted xlsx)...');
    await assert.rejects(
      () => inspectUploadedFile('evil.xlsm', Buffer.from('PK\x03\x04dummy')),
      (err: any) => err instanceof FileValidationError && err.code === 'MACRO_OR_UNSAFE_FILE'
    );
    await assert.rejects(
      () => inspectUploadedFile('fake.xlsx', Buffer.from('NOT_A_ZIP_HEADER')),
      (err: any) => err instanceof FileValidationError && err.code === 'MAGIC_BYTE_MISMATCH'
    );
    await assert.rejects(
      () => inspectUploadedFile('locked.xlsx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00])),
      (err: any) => err instanceof FileValidationError && err.code === 'PASSWORD_PROTECTED'
    );

    console.log('3. Testing initial Super Admin setup, RBAC 403, 5-attempt lockout, & refresh token replay revocation...');
    const statusRes = await api('/api/v1/auth/status');
    assert.equal(statusRes.data.needsInitialSetup, true);

    const setupRes = await api('/api/v1/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        email: 'super@structiq.test',
        fullName: 'Test Super Admin',
        password: 'Str0ng!Password#2026',
      }),
    });
    assert.equal(setupRes.status, 201);
    assert.equal(setupRes.data.user.role, 'SUPER_ADMIN');
    assert.ok(setupRes.data.accessToken, 'Setup must return accessToken for iframe Bearer fallback');
    assert.ok(setupRes.data.refreshToken, 'Setup must return refreshToken for iframe Bearer fallback');
    const adminCookieJar = cookieJar;

    // Verify cookie-blocked iframe scenario: Bearer token ONLY (no Cookie header) on /api/v1/users & body /auth/refresh
    const bearerUsersRes = await fetch(`${baseUrl}/api/v1/users`, {
      headers: { Authorization: `Bearer ${setupRes.data.accessToken}` },
    });
    assert.equal(bearerUsersRes.status, 200, 'GET /api/v1/users must succeed with Authorization Bearer token alone');

    const bodyRefreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ refreshToken: setupRes.data.refreshToken }),
    });
    assert.equal(bodyRefreshRes.status, 200, 'POST /api/v1/auth/refresh must accept refreshToken in JSON body');
    const setCookieHdrs = bodyRefreshRes.headers.getSetCookie?.() || [];
    assert.ok(
      setCookieHdrs.some((c) => /SameSite=None/i.test(c) && /Secure/i.test(c) && /Partitioned/i.test(c)),
      'HTTPS requests must set SameSite=None; Secure; Partitioned cookies for cross-site iframes'
    );
    const bodyRefreshJson = (await bodyRefreshRes.json()) as { accessToken: string };
    assert.ok(bodyRefreshJson.accessToken);
    cookieJar = setCookieHdrs.map((sc) => sc.split(';')[0]).join('; ');
    const rotatedAdminCookieJar = cookieJar;

    // Create READ_ONLY user & verify RBAC 403 on upload and approve
    const roRes = await api('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'reader@structiq.test',
        fullName: 'Reader User',
        password: 'Reader!Password#2026',
        role: 'READ_ONLY',
      }),
    });
    assert.equal(roRes.status, 201);
    const readerUserId = roRes.data.user.id;

    // Role update test (PATCH /api/v1/users/:id)
    const promoteRes = await api(`/api/v1/users/${readerUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'REVIEWER' }),
    });
    assert.equal(promoteRes.status, 200);
    assert.equal(promoteRes.data.user.role, 'REVIEWER');
    const demoteRes = await api(`/api/v1/users/${readerUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'READ_ONLY' }),
    });
    assert.equal(demoteRes.status, 200);
    assert.equal(demoteRes.data.user.role, 'READ_ONLY');

    // Login as READ_ONLY user in isolated jar
    cookieJar = '';
    const roLoginRes = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'reader@structiq.test', password: 'Reader!Password#2026' }),
    });
    assert.equal(roLoginRes.status, 200);

    const roUploadForm = new FormData();
    roUploadForm.append('file', new Blob(['Name,Phone\nTest,9876543210'], { type: 'text/csv' }), 'ro.csv');
    const roUploadRes = await api('/api/v1/uploads', { method: 'POST', body: roUploadForm });
    assert.equal(roUploadRes.status, 403);
    assert.equal(roUploadRes.data.error.code, 'FORBIDDEN');

    const roApproveRes = await api('/api/v1/records/approve', {
      method: 'POST',
      body: JSON.stringify({ recordIds: ['00000000-0000-0000-0000-000000000000'], decision: 'APPROVED' }),
    });
    assert.equal(roApproveRes.status, 403);
    assert.equal(roApproveRes.data.error.code, 'FORBIDDEN');

    // Test refresh token rotation & replay family revocation on READ_ONLY jar
    const initialJar = cookieJar;
    const refreshRes = await api('/api/v1/auth/refresh', { method: 'POST' });
    assert.equal(refreshRes.status, 200);
    const rotatedJar = cookieJar;
    assert.notEqual(rotatedJar, initialJar);

    // Replay the old refresh token -> must reject with TOKEN_REUSE_DETECTED & revoke family
    cookieJar = initialJar;
    const replayRes = await api('/api/v1/auth/refresh', { method: 'POST' });
    assert.equal(replayRes.status, 401);
    assert.equal(replayRes.data.error.code, 'TOKEN_REUSE_DETECTED');

    // Rotated token from same family should also now be revoked
    cookieJar = rotatedJar;
    const postReplayRes = await api('/api/v1/auth/refresh', { method: 'POST' });
    assert.equal(postReplayRes.status, 401);

    // Switch back to Super Admin jar and test 5-attempt account lockout on a dedicated user
    cookieJar = rotatedAdminCookieJar;
    const lockUserRes = await api('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'locktest@structiq.test',
        fullName: 'Lockout User',
        password: 'Lock!Password#2026',
        role: 'DATA_PROCESSOR',
      }),
    });
    assert.equal(lockUserRes.status, 201);

    cookieJar = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const failRes = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'locktest@structiq.test', password: 'Wrong!Password#1' }),
      });
      assert.equal(failRes.status, 401);
    }
    const fifthFailRes = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'locktest@structiq.test', password: 'Wrong!Password#1' }),
    });
    assert.equal(fifthFailRes.status, 423);
    assert.equal(fifthFailRes.data.error.code, 'ACCOUNT_LOCKED');

    // Restore Super Admin cookie jar
    cookieJar = rotatedAdminCookieJar;

    // Test sample CSV download & upload flow
    console.log('4. Testing sample CSV download -> upload -> duplicate block -> map -> job process...');
    const sampleRes = await api('/api/v1/samples/messy-csv');
    assert.equal(sampleRes.status, 200);
    const csvBuffer = Buffer.from(sampleRes.data as ArrayBuffer);

    const form = new FormData();
    form.append('file', new Blob([csvBuffer], { type: 'text/csv' }), 'messy_sample.csv');
    const upRes = await api('/api/v1/uploads', { method: 'POST', body: form });
    assert.equal(upRes.status, 201);
    const uploadId = upRes.data.upload.id;
    const sheetId = upRes.data.sheets[0].id;
    assert.equal(upRes.data.upload.total_rows, 10);

    // Duplicate upload blocked without override
    const formDup = new FormData();
    formDup.append('file', new Blob([csvBuffer], { type: 'text/csv' }), 'messy_sample.csv');
    const dupBlockRes = await api('/api/v1/uploads', { method: 'POST', body: formDup });
    assert.equal(dupBlockRes.status, 409);

    // Detect mapping & save
    const detectRes = await api(`/api/v1/processing/uploads/${uploadId}/sheets/${sheetId}/detect-mapping`, {
      method: 'POST',
      body: JSON.stringify({ useAi: false }),
    });
    assert.equal(detectRes.status, 200);

    const saveMapRes = await api(`/api/v1/processing/uploads/${uploadId}/sheets/${sheetId}/mapping`, {
      method: 'PUT',
      body: JSON.stringify({
        mappings: detectRes.data.mappings,
        saveAsTemplateName: 'Sample Customer Template',
      }),
    });
    assert.equal(saveMapRes.status, 200);

    const startRes = await api(`/api/v1/processing/uploads/${uploadId}/sheets/${sheetId}/start`, {
      method: 'POST',
      body: JSON.stringify({ checkDuplicatesAgainstMaster: true, runCategorisation: true }),
    });
    assert.equal(startRes.status, 202);
    const jobId = startRes.data.job.id;

    // Poll job completion
    let jobStatus = 'QUEUED';
    for (let i = 0; i < 40; i++) {
      const jr = await api(`/api/v1/jobs/${jobId}`);
      jobStatus = jr.data.job.status;
      if (jobStatus === 'COMPLETED' || jobStatus === 'FAILED_DEAD_LETTER') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(jobStatus, 'COMPLETED');

    console.log('5. Verifying processed records, Tamil script preservation, pg_trgm search, bulk-edit PIN validation & duplicates...');
    const recRes = await api(`/api/v1/records?uploadId=${uploadId}&pageSize=50`);
    assert.equal(recRes.status, 200);
    assert.equal(recRes.data.total, 10);

    const tamilRec = recRes.data.items.find((r: any) => r.full_name === 'கார்த்திக் ராஜா');
    assert.ok(tamilRec, 'Tamil script record must be preserved intact');
    assert.equal(tamilRec.phone_e164, '+919840112233');

    const inferredRec = recRes.data.items.find((r: any) => r.full_name === 'Deepak Raj');
    assert.ok(inferredRec);
    assert.equal(inferredRec.has_inferred_fields, true);
    assert.equal(inferredRec.provenance.state, 'INFERRED');
    assert.equal(inferredRec.status, 'NEEDS_REVIEW');

    // pg_trgm typo-tolerant search: 'Maduri' -> matches 'Madurai'
    const trgmSearchRes = await api(`/api/v1/records?uploadId=${uploadId}&search=Maduri`);
    assert.equal(trgmSearchRes.status, 200);
    assert.ok(
      trgmSearchRes.data.items.some((r: any) => String(r.city || '').toLowerCase().includes('madurai')),
      'pg_trgm search for "Maduri" should match "Madurai"'
    );

    // Bulk-edit PIN validation: invalid PIN -> INVALID status + INVALID_PIN_CODE issue; valid PIN -> clears issue
    const invalidBulkRes = await api('/api/v1/records/bulk-edit', {
      method: 'POST',
      body: JSON.stringify({
        recordIds: [inferredRec.id],
        patch: { pinCode: '000' },
      }),
    });
    assert.equal(invalidBulkRes.status, 200);
    const afterInvalidRec = await api(`/api/v1/records/${inferredRec.id}`);
    assert.equal(afterInvalidRec.data.record.status, 'INVALID');
    assert.ok(
      afterInvalidRec.data.record.issues.some((i: any) => i.code === 'INVALID_PIN_CODE'),
      'Bulk-edit invalid PIN should flag INVALID_PIN_CODE'
    );

    const validBulkRes = await api('/api/v1/records/bulk-edit', {
      method: 'POST',
      body: JSON.stringify({
        recordIds: [inferredRec.id],
        patch: { pinCode: '600001' },
      }),
    });
    assert.equal(validBulkRes.status, 200);
    const afterValidRec = await api(`/api/v1/records/${inferredRec.id}`);
    assert.equal(afterValidRec.data.record.pin_code, '600001');
    assert.equal(afterValidRec.data.record.has_inferred_fields, false);
    assert.equal(afterValidRec.data.record.status, 'VERIFIED');

    // On-demand duplicate scan
    const scanRes = await api('/api/v1/duplicates/scan', {
      method: 'POST',
      body: JSON.stringify({ uploadId }),
    });
    assert.equal(scanRes.status, 200);
    assert.equal(typeof scanRes.data.groupsCreated, 'number');

    const dupGroupsRes = await api(`/api/v1/duplicates?uploadId=${uploadId}&status=PENDING`);
    assert.ok(dupGroupsRes.data.items.length >= 1, 'Expected at least 1 duplicate group detected');

    const grpId = dupGroupsRes.data.items[0].id;
    const grpDetail = await api(`/api/v1/duplicates/${grpId}`);
    const survivorId = grpDetail.data.members[0].id;
    const mergeRes = await api(`/api/v1/duplicates/${grpId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ survivingRecordId: survivorId, fieldSelections: {} }),
    });
    assert.equal(mergeRes.status, 200);

    // Revert merge and verify reversible record_history
    const revertRes = await api(`/api/v1/duplicates/${grpId}/revert`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(revertRes.status, 200);

    console.log('6. Verifying Excel export, sheets, formula neutralization & retention purge dryRun...');
    const expCreate = await api('/api/v1/exports', {
      method: 'POST',
      body: JSON.stringify({
        format: 'XLSX',
        splitBy: 'CITY',
        includeOriginalSheet: true,
        filters: { uploadId },
      }),
    });
    assert.equal(expCreate.status, 202);
    const expId = expCreate.data.exportRecord.id;

    let expStatus = 'QUEUED';
    for (let i = 0; i < 40; i++) {
      const list = await api('/api/v1/exports');
      const found = list.data.items.find((e: any) => e.id === expId);
      if (found) expStatus = found.status;
      if (expStatus === 'COMPLETED' || expStatus === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(expStatus, 'COMPLETED');

    const dlRes = await api(`/api/v1/exports/${expId}/download`);
    assert.equal(dlRes.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dlRes.data as ArrayBuffer);
    assert.ok(wb.getWorksheet('Master Data'));
    assert.ok(wb.getWorksheet('Summary'));
    assert.ok(wb.getWorksheet('Processing Report'));
    assert.ok(wb.getWorksheet('Original Data'));

    // Ensure =CMD cell was neutralized with leading apostrophe in Master Data and Original Data
    const masterWs = wb.getWorksheet('Master Data')!;
    let foundMasterNeutralized = false;
    masterWs.eachRow((row) => {
      const val = String(row.getCell(1).value || '');
      if (val.startsWith("'=CMD")) foundMasterNeutralized = true;
    });
    assert.equal(foundMasterNeutralized, true, 'Formula cell in Master Data must preserve case and be neutralized with leading apostrophe');

    const origWs = wb.getWorksheet('Original Data')!;
    let foundOrigNeutralized = false;
    origWs.eachRow((row) => {
      row.eachCell((cell) => {
        const val = String(cell.value || '');
        if (val.startsWith("'=CMD")) foundOrigNeutralized = true;
      });
    });
    assert.equal(foundOrigNeutralized, true, 'Formula cell in Original Data must be neutralized with leading apostrophe');

    // Retention purge dryRun
    const purgeRes = await api('/api/v1/settings/retention/purge', {
      method: 'POST',
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(purgeRes.status, 200);
    assert.equal(purgeRes.data.dryRun, true);
    assert.equal(typeof purgeRes.data.purgedUploads, 'number');

    console.log('7. Verifying security hardening (CSRF origin, UUID 400s, empty patch 400, DTO redaction, AES-256-GCM)...');
    // Health endpoint branding & no-store security headers
    const healthRes = await api('/api/v1/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.data.service, 'MARSFORCE');
    assert.match(healthRes.headers.get('cache-control') || '', /no-store/i);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');

    // Internal storage_key and email redacted from upload & export DTOs
    assert.equal(upRes.data.upload.storage_key, undefined, 'storage_key must not leak in upload response');
    const uploadsListRes = await api('/api/v1/uploads');
    assert.equal(uploadsListRes.status, 200);
    assert.equal(uploadsListRes.data.items[0].storage_key, undefined);
    assert.equal(uploadsListRes.data.items[0].uploaded_by_email, undefined);
    assert.equal(expCreate.data.exportRecord.storage_key, undefined, 'storage_key must not leak in export response');

    // Malformed UUID returns 400 cleanly instead of 500
    const badIdRes = await api('/api/v1/uploads/not-a-valid-uuid');
    assert.equal(badIdRes.status, 400);
    assert.equal(badIdRes.data.error.code, 'INVALID_ID');

    const badStatsRes = await api('/api/v1/records/stats?uploadId=bad-uuid');
    assert.equal(badStatsRes.status, 400);
    assert.equal(badStatsRes.data.error.code, 'INVALID_ID');

    // Empty bulk-edit patch rejected with 400
    const emptyBulkRes = await api('/api/v1/records/bulk-edit', {
      method: 'POST',
      body: JSON.stringify({ recordIds: [inferredRec.id], patch: {} }),
    });
    assert.equal(emptyBulkRes.status, 400);

    // Cross-site mutating cookie request blocked by CSRF same-origin guard
    const csrfRes = await api('/api/v1/records/bulk-edit', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
      body: JSON.stringify({ recordIds: [inferredRec.id], patch: { city: 'Chennai' } }),
    });
    assert.equal(csrfRes.status, 403);
    assert.equal(csrfRes.data.error.code, 'CSRF_ORIGIN_MISMATCH');

    // Column allowlist enforcement on export creation
    const badExportColRes = await api('/api/v1/exports', {
      method: 'POST',
      body: JSON.stringify({
        exportMode: 'CSV',
        filters: { uploadId },
        columnOrder: ['nonexistent_internal_column'],
      }),
    });
    assert.equal(badExportColRes.status, 400);

    // AES-256-GCM storage encryption round-trip + plaintext fallback check
    const prevKey = env.dataEncryptionKey;
    try {
      env.dataEncryptionKey = 'marsforce-unit-test-encryption-key-32b';
      const plainBuf = Buffer.from('Sensitive MARSFORCE Customer Sheet Bytes', 'utf8');
      const encryptedBuf = encryptStoragePayload(plainBuf);
      assert.equal(encryptedBuf.subarray(0, 6).toString('ascii'), 'MFENC1');
      assert.equal(encryptedBuf.includes(plainBuf), false);
      const decryptedBuf = decryptStoragePayload(encryptedBuf);
      assert.equal(decryptedBuf.toString('utf8'), plainBuf.toString('utf8'));
      const legacyBuf = Buffer.from('legacy-unencrypted-csv,123', 'utf8');
      assert.equal(decryptStoragePayload(legacyBuf).toString('utf8'), legacyBuf.toString('utf8'));
    } finally {
      env.dataEncryptionKey = prevKey;
    }

    console.log('ALL END-TO-END TESTS PASSED!');
  } finally {
    await jobWorker.stop();
    await getDb().close();
    server.close();
  }
}

runTests().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
