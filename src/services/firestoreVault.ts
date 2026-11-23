import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { apiRequest } from '../api/client.ts';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import type { UploadDTO, UploadSheetDTO } from '../types/api.ts';

export interface VaultUploadRecord {
  id: string;
  uploadId: string;
  ownerUid: string;
  originalFilename: string;
  fileExtension: '.xlsx' | '.xls' | '.csv';
  fileSizeBytes: number;
  fileSha256: string;
  detectedEncoding: string;
  totalRows: number;
  sheetCount: number;
  chunkCount: number;
  localStatus: string;
  isArchived: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

interface BackupSheetPayload {
  sheetIndex: number;
  sheetName: string;
  rowCount: number;
  physicalRowCount: number;
  headerRowNumber: number;
  headers: string[];
  rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
}

interface BackupPayloadResponse {
  upload: UploadDTO;
  checksumVerified: boolean;
  sheets: BackupSheetPayload[];
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
const MAX_ROWS_PER_CHUNK = 80;
const MAX_CHUNK_BYTES = 450_000;

function sanitizeDocId(rawId: string): string {
  const clean = rawId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
  if (!clean || !VALID_ID_REGEX.test(clean)) {
    throw new Error('Invalid document identifier for Firestore Backup Vault.');
  }
  return clean;
}

function sanitizeStr(value: unknown, maxLen: number, fallback = ''): string {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return (text || fallback).slice(0, maxLen);
}

function normalizeExtension(ext: string): '.xlsx' | '.xls' | '.csv' {
  const lower = ext.toLowerCase();
  if (lower === '.xlsx' || lower === '.xls' || lower === '.csv') return lower;
  return '.xlsx';
}

function buildRowChunks(
  sheet: BackupSheetPayload
): Array<{
  chunkId: string;
  chunkIndex: number;
  rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
}> {
  const chunks: Array<{
    chunkId: string;
    chunkIndex: number;
    rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
  }> = [];
  let currentRows: Array<{ rowNumber: number; cells: Record<string, string> }> = [];
  let currentBytes = 0;
  let chunkIndex = 0;

  for (const row of sheet.rows) {
    const cleanCells: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.cells || {})) {
      const safeKey = sanitizeStr(k, 160);
      if (!safeKey) continue;
      cleanCells[safeKey] = sanitizeStr(v, 4000);
    }
    const cleanRow = {
      rowNumber: Math.max(1, Math.trunc(Number(row.rowNumber || 1))),
      cells: cleanCells,
    };
    const rowBytes = JSON.stringify(cleanRow).length;

    if (
      currentRows.length > 0 &&
      (currentRows.length >= MAX_ROWS_PER_CHUNK || currentBytes + rowBytes > MAX_CHUNK_BYTES)
    ) {
      chunks.push({
        chunkId: sanitizeDocId(`s${sheet.sheetIndex}_c${chunkIndex}`),
        chunkIndex,
        rows: currentRows,
      });
      chunkIndex++;
      currentRows = [];
      currentBytes = 0;
    }

    currentRows.push(cleanRow);
    currentBytes += rowBytes;
  }

  if (currentRows.length > 0) {
    chunks.push({
      chunkId: sanitizeDocId(`s${sheet.sheetIndex}_c${chunkIndex}`),
      chunkIndex,
      rows: currentRows,
    });
  }

  return chunks;
}

export async function backupUploadToFirestore(
  ownerUid: string,
  uploadId: string,
  onProgress?: (label: string) => void
): Promise<{
  uploadDocId: string;
  sheetCount: number;
  chunkCount: number;
  checksumVerified: boolean;
}> {
  if (!ownerUid) {
    throw new Error('Sign in with Google Backup first to sync uploads to Cloud Firestore.');
  }

  const uploadDocId = sanitizeDocId(uploadId);
  onProgress?.('Fetching full Excel/CSV sheets from workspace...');
  const payload = await apiRequest<BackupPayloadResponse>(
    `/api/v1/uploads/${uploadId}/backup-payload`
  );

  const sheets = payload.sheets.length > 0 ? payload.sheets : [];
  if (sheets.length === 0) {
    throw new Error('No worksheets found to back up.');
  }

  const allSheetChunks = sheets.map((s) => ({
    sheet: s,
    chunks: buildRowChunks(s),
  }));
  const totalChunks = allSheetChunks.reduce((sum, item) => sum + item.chunks.length, 0);

  const uploadPath = `uploads/${uploadDocId}`;
  const uploadRef = doc(db, 'uploads', uploadDocId);
  const sha = /^[a-f0-9]{64}$/.test(payload.upload.file_sha256 || '')
    ? payload.upload.file_sha256
    : '0'.repeat(64);

  const uploadDocBody = {
    uploadId: uploadDocId,
    ownerUid,
    originalFilename: sanitizeStr(payload.upload.original_filename, 200, 'workbook.xlsx'),
    fileExtension: normalizeExtension(payload.upload.file_extension || '.xlsx'),
    fileSizeBytes: Math.max(0, Math.min(210_000_000, Math.trunc(Number(payload.upload.file_size_bytes || 0)))),
    fileSha256: sha,
    detectedEncoding: sanitizeStr(payload.upload.detected_encoding || '', 32),
    totalRows: Math.max(0, Math.min(250_000, Math.trunc(Number(payload.upload.total_rows || 0)))),
    sheetCount: Math.max(1, Math.min(100, sheets.length)),
    chunkCount: Math.max(0, Math.min(5000, totalChunks)),
    localStatus: sanitizeStr(payload.upload.status, 40, 'READY_TO_MAP'),
    isArchived: false,
  };

  onProgress?.('Saving workbook metadata to Firestore...');
  let existingUploadSnap;
  try {
    existingUploadSnap = await getDoc(uploadRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, uploadPath);
  }

  try {
    if (!existingUploadSnap.exists()) {
      await setDoc(uploadRef, {
        ...uploadDocBody,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(uploadRef, {
        localStatus: uploadDocBody.localStatus,
        chunkCount: uploadDocBody.chunkCount,
        isArchived: false,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, uploadPath);
  }

  // Write sheet schemas
  for (const { sheet } of allSheetChunks) {
    const sheetDocId = sanitizeDocId(`sheet_${sheet.sheetIndex}`);
    const sheetPath = `uploads/${uploadDocId}/sheets/${sheetDocId}`;
    const sheetRef = doc(db, 'uploads', uploadDocId, 'sheets', sheetDocId);
    const cleanHeaders = (sheet.headers.length > 0 ? sheet.headers : ['Column_1'])
      .slice(0, 500)
      .map((h, i) => sanitizeStr(h, 160, `Column_${i + 1}`));

    const sheetPayload = {
      uploadId: uploadDocId,
      ownerUid,
      sheetIndex: Math.max(0, Math.min(100, Math.trunc(sheet.sheetIndex))),
      sheetName: sanitizeStr(sheet.sheetName, 160, `Sheet${sheet.sheetIndex + 1}`),
      rowCount: Math.max(0, Math.min(250_000, Math.trunc(sheet.rowCount))),
      physicalRowCount: Math.max(0, Math.min(250_000, Math.trunc(sheet.physicalRowCount))),
      headerRowNumber: Math.max(1, Math.min(100, Math.trunc(sheet.headerRowNumber))),
      headers: cleanHeaders,
    };

    try {
      const existingSheet = await getDoc(sheetRef);
      if (!existingSheet.exists()) {
        await setDoc(sheetRef, {
          ...sheetPayload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(sheetRef, {
          headers: sheetPayload.headers,
          rowCount: sheetPayload.rowCount,
          physicalRowCount: sheetPayload.physicalRowCount,
          headerRowNumber: sheetPayload.headerRowNumber,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, sheetPath);
    }
  }

  // Write immutable row chunks (only create missing chunks)
  const existingChunkIds = new Set<string>();
  const chunksColPath = `uploads/${uploadDocId}/rowChunks`;
  try {
    const existingChunksSnap = await getDocs(
      query(collection(db, 'uploads', uploadDocId, 'rowChunks'), where('ownerUid', '==', ownerUid))
    );
    existingChunksSnap.forEach((d) => existingChunkIds.add(d.id));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, chunksColPath);
  }

  let writtenChunks = 0;
  for (const { sheet, chunks } of allSheetChunks) {
    const safeSheetName = sanitizeStr(sheet.sheetName, 160, `Sheet${sheet.sheetIndex + 1}`);
    for (const chunk of chunks) {
      writtenChunks++;
      if (existingChunkIds.has(chunk.chunkId)) continue;
      onProgress?.(`Backing up rows to Firestore (${writtenChunks}/${totalChunks} chunks)...`);

      const chunkPath = `uploads/${uploadDocId}/rowChunks/${chunk.chunkId}`;
      const chunkRef = doc(db, 'uploads', uploadDocId, 'rowChunks', chunk.chunkId);
      try {
        await setDoc(chunkRef, {
          uploadId: uploadDocId,
          ownerUid,
          sheetIndex: Math.max(0, Math.min(100, Math.trunc(sheet.sheetIndex))),
          sheetName: safeSheetName,
          chunkIndex: Math.max(0, Math.min(5000, chunk.chunkIndex)),
          rowCount: chunk.rows.length,
          rows: chunk.rows,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, chunkPath);
      }
    }
  }

  return {
    uploadDocId,
    sheetCount: sheets.length,
    chunkCount: totalChunks,
    checksumVerified: payload.checksumVerified,
  };
}

export function subscribeToVaultUploads(
  ownerUid: string,
  onData: (uploads: VaultUploadRecord[]) => void,
  onError?: (error: Error) => void
): () => void {
  const q = query(collection(db, 'uploads'), where('ownerUid', '==', ownerUid));
  return onSnapshot(
    q,
    (snapshot) => {
      const records: VaultUploadRecord[] = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<VaultUploadRecord, 'id'>),
      }));
      records.sort((a, b) => {
        const aSec = a.createdAt?.seconds ?? 0;
        const bSec = b.createdAt?.seconds ?? 0;
        return bSec - aSec;
      });
      onData(records);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, 'uploads');
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error('Failed to load Firestore Vault'));
      }
    }
  );
}

export async function setVaultUploadArchived(
  uploadDocId: string,
  isArchived: boolean
): Promise<void> {
  const safeId = sanitizeDocId(uploadDocId);
  const path = `uploads/${safeId}`;
  try {
    await updateDoc(doc(db, 'uploads', safeId), {
      isArchived,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function restoreUploadFromFirestore(
  ownerUid: string,
  uploadDocId: string
): Promise<{ upload: UploadDTO; sheets: UploadSheetDTO[] }> {
  const safeId = sanitizeDocId(uploadDocId);
  const uploadPath = `uploads/${safeId}`;
  let uploadSnap;
  try {
    uploadSnap = await getDoc(doc(db, 'uploads', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, uploadPath);
  }
  if (!uploadSnap.exists()) {
    throw new Error('Backed-up upload record not found in Firestore.');
  }
  const uploadData = uploadSnap.data() as Omit<VaultUploadRecord, 'id'>;

  let sheetsSnap;
  try {
    sheetsSnap = await getDocs(
      query(collection(db, 'uploads', safeId, 'sheets'), where('ownerUid', '==', ownerUid))
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `uploads/${safeId}/sheets`);
  }

  let chunksSnap;
  try {
    chunksSnap = await getDocs(
      query(collection(db, 'uploads', safeId, 'rowChunks'), where('ownerUid', '==', ownerUid))
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `uploads/${safeId}/rowChunks`);
  }

  const expectedChunks = Math.max(0, Number(uploadData.chunkCount || 0));
  if (expectedChunks > 0 && chunksSnap.size < expectedChunks) {
    throw new Error(
      `Incomplete backup snapshot: retrieved ${chunksSnap.size} of ${expectedChunks} row chunks from Firestore. Please retry.`
    );
  }

  const sheetDocs = sheetsSnap.docs
    .map((d) => d.data() as {
      sheetIndex: number;
      sheetName: string;
      headers: string[];
    })
    .sort((a, b) => a.sheetIndex - b.sheetIndex);

  const chunksBySheet = new Map<
    number,
    Array<{ chunkIndex: number; rows: Array<{ rowNumber: number; cells: Record<string, string> }> }>
  >();

  chunksSnap.forEach((d) => {
    const c = d.data() as {
      sheetIndex: number;
      chunkIndex: number;
      rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
    };
    const arr = chunksBySheet.get(c.sheetIndex) || [];
    arr.push({ chunkIndex: c.chunkIndex, rows: c.rows || [] });
    chunksBySheet.set(c.sheetIndex, arr);
  });

  const assembledSheets = sheetDocs.map((s) => {
    const chunks = (chunksBySheet.get(s.sheetIndex) || []).sort(
      (a, b) => a.chunkIndex - b.chunkIndex
    );
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].chunkIndex !== i) {
        throw new Error(
          `Backup integrity check failed for worksheet "${s.sheetName}": missing chunk #${i}.`
        );
      }
    }
    const allRows = chunks.flatMap((c) => c.rows).sort((a, b) => a.rowNumber - b.rowNumber);
    return {
      sheetName: s.sheetName,
      headers: s.headers,
      rows: allRows,
    };
  });

  if (assembledSheets.length === 0) {
    throw new Error('No backed-up worksheets found in Firestore.');
  }

  return apiRequest<{ upload: UploadDTO; sheets: UploadSheetDTO[] }>(
    '/api/v1/uploads/restore-from-vault',
    {
      method: 'POST',
      body: JSON.stringify({
        originalFilename: uploadData.originalFilename,
        detectedEncoding: uploadData.detectedEncoding || null,
        sheets: assembledSheets,
      }),
    }
  );
}
