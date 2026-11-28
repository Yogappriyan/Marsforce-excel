import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudUpload,
  Download,
  FileSpreadsheet,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  apiRequest,
  ApiError,
  buildApiUrl,
  downloadAuthenticatedFile,
  generateAndDownloadExport,
} from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { useFirebase } from '../../contexts/FirebaseContext.tsx';
import {
  backupUploadToFirestore,
  restoreUploadFromFirestore,
  setVaultUploadArchived,
  subscribeToVaultUploads,
  type VaultUploadRecord,
} from '../../services/firestoreVault.ts';
import type {
  ColumnMappingItem,
  GeoUploadSummaryDTO,
  JobDTO,
  MappingTemplateDTO,
  TargetField,
  UploadDTO,
  UploadSheetDTO,
} from '../../types/api.ts';

const TARGET_FIELD_OPTIONS: Array<{ value: TargetField; label: string }> = [
  { value: 'consumer_id', label: 'Consumer / Customer ID' },
  { value: 'distributor_id', label: 'Distributor / Account ID' },
  { value: 'full_name', label: 'Full Name' },
  { value: 'name_and_phone', label: 'Combined Name + Phone' },
  { value: 'phone_raw', label: 'Phone (Single)' },
  { value: 'phone_multi', label: 'Phones (Multiple in cell)' },
  { value: 'address_combined', label: 'Combined Address (Auto-Split)' },
  { value: 'street', label: 'Street / Door No' },
  { value: 'sub_area', label: 'SubArea / Locality' },
  { value: 'area', label: 'Area / Zone' },
  { value: 'city', label: 'City / Town' },
  { value: 'district', label: 'District' },
  { value: 'state', label: 'State' },
  { value: 'pin_code', label: 'PIN Code (6-digit)' },
  { value: 'custom', label: 'Custom Field (Preserve)' },
  { value: 'ignore', label: 'Ignore Column' },
];

const TARGET_FIELD_LABELS = new Map(TARGET_FIELD_OPTIONS.map((o) => [o.value, o.label]));

interface UploadWorkspaceProps {
  onOpenReviewForUpload: (uploadId: string) => void;
  onOpenGeoForUpload: (uploadId: string) => void;
  onGoToExports: (uploadId: string) => void;
}

export function UploadWorkspace({
  onOpenReviewForUpload,
  onOpenGeoForUpload,
  onGoToExports,
}: UploadWorkspaceProps) {
  const { hasPermission } = useAuth();
  const {
    firebaseUser,
    isVaultConnected,
    connectingGoogle,
    connectionOffline,
    connectionMessage,
    vaultAuthError,
    connectGoogleBackup,
    disconnectGoogleBackup,
    clearVaultAuthError,
  } = useFirebase();
  const [uploads, setUploads] = useState<UploadDTO[]>([]);
  const [templates, setTemplates] = useState<MappingTemplateDTO[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const [selectedUpload, setSelectedUpload] = useState<UploadDTO | null>(null);
  const [sheets, setSheets] = useState<UploadSheetDTO[]>([]);
  const [activeSheet, setActiveSheet] = useState<UploadSheetDTO | null>(null);
  const [selectedCols, setSelectedCols] = useState<string[]>([]);

  const [mappings, setMappings] = useState<ColumnMappingItem[]>([]);
  const [detectingMapping, setDetectingMapping] = useState(false);
  const [suggestedTemplate, setSuggestedTemplate] = useState<MappingTemplateDTO | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [useAiMapping, setUseAiMapping] = useState(true);
  const [checkMasterDupes, setCheckMasterDupes] = useState(true);
  const [includeHiddenRows, setIncludeHiddenRows] = useState(true);
  const [processAllSheets, setProcessAllSheets] = useState(true);
  const [showAdvancedMapping, setShowAdvancedMapping] = useState(false);

  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [startingProcess, setStartingProcess] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<{ file: File; existingName: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);

  const [activeJob, setActiveJob] = useState<JobDTO | null>(null);
  const [jobProgress, setJobProgress] = useState<number>(0);

  // Ready-to-download Area summary right inside Upload & Convert
  const [areaSummary, setAreaSummary] = useState<GeoUploadSummaryDTO | null>(null);
  const [loadingAreas, setLoadingAreas] = useState(false);
  const [areaSearch, setAreaSearch] = useState('');
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  // Cloud Firestore Vault state
  const [vaultUploads, setVaultUploads] = useState<VaultUploadRecord[]>([]);
  const [vaultSyncStatus, setVaultSyncStatus] = useState<string | null>(null);
  const [vaultSyncWarning, setVaultSyncWarning] = useState<string | null>(null);
  const [syncingUploadId, setSyncingUploadId] = useState<string | null>(null);
  const [syncingAllVault, setSyncingAllVault] = useState(false);
  const [restoringVaultId, setRestoringVaultId] = useState<string | null>(null);
  const [showArchivedVault, setShowArchivedVault] = useState(false);

  // Soft-delete protection state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [recentlyDeletedUpload, setRecentlyDeletedUpload] = useState<{ id: string; name: string } | null>(null);

  const loadUploadsAndTemplates = useCallback(async () => {
    setLoadingList(true);
    try {
      const [uRes, tRes] = await Promise.all([
        apiRequest<{ items: UploadDTO[] }>('/api/v1/uploads?pageSize=25'),
        apiRequest<{ items: MappingTemplateDTO[] }>('/api/v1/templates'),
      ]);
      setUploads(uRes.items);
      setTemplates(tRes.items);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load uploads');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadUploadsAndTemplates();
  }, [loadUploadsAndTemplates]);

  useEffect(() => {
    if (!isVaultConnected || !firebaseUser?.uid) {
      setVaultUploads([]);
      return;
    }
    const unsub = subscribeToVaultUploads(
      firebaseUser.uid,
      (records) => setVaultUploads(records),
      (err) => setErrorMsg(err.message)
    );
    return () => unsub();
  }, [isVaultConnected, firebaseUser?.uid]);

  const loadAreaSummary = useCallback(async (uploadId: string) => {
    setLoadingAreas(true);
    try {
      const res = await apiRequest<GeoUploadSummaryDTO>(`/api/v1/geo/uploads/${uploadId}/summary`);
      setAreaSummary(res);
    } catch {
      setAreaSummary(null);
    } finally {
      setLoadingAreas(false);
    }
  }, []);

  const detectMappingsForSheet = useCallback(
    async (uploadId: string, sheet: UploadSheetDTO, aiEnabled = useAiMapping) => {
      setDetectingMapping(true);
      try {
        const res = await apiRequest<{
          mappings: ColumnMappingItem[];
          suggestedTemplate?: MappingTemplateDTO | null;
          aiWarning?: string | null;
        }>(`/api/v1/processing/uploads/${uploadId}/sheets/${sheet.id}/detect-mapping`, {
          method: 'POST',
          body: JSON.stringify({ useAi: aiEnabled }),
        });
        setMappings(res.mappings);
        setSuggestedTemplate(res.suggestedTemplate || null);
        setAiWarning(res.aiWarning || null);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Column detection failed');
      } finally {
        setDetectingMapping(false);
      }
    },
    [useAiMapping]
  );

  const openUploadDetail = useCallback(
    async (uploadId: string) => {
      setErrorMsg(null);
      setAreaSearch('');
      try {
        const detail = await apiRequest<{
          upload: UploadDTO;
          sheets: UploadSheetDTO[];
          jobs: JobDTO[];
        }>(`/api/v1/uploads/${uploadId}`);
        setSelectedUpload(detail.upload);
        setSheets(detail.sheets);
        const primary = detail.sheets.find((s) => s.is_selected) || detail.sheets[0] || null;
        setActiveSheet(primary);
        if (primary) {
          setSelectedCols(primary.selected_columns?.length ? primary.selected_columns : primary.headers);
          setIncludeHiddenRows(primary.include_hidden_rows ?? true);
          await detectMappingsForSheet(detail.upload.id, primary);
        }
        const latestJob =
          detail.jobs.find((j) => ['QUEUED', 'RUNNING'].includes(j.status)) || detail.jobs[0] || null;
        setActiveJob(latestJob);
        if (latestJob) {
          setJobProgress(
            latestJob.status === 'COMPLETED'
              ? 100
              : latestJob.total_chunks > 0
                ? Math.round((latestJob.completed_chunks / latestJob.total_chunks) * 100)
                : 0
          );
        }
        if (detail.upload.status === 'PROCESSED') {
          await loadAreaSummary(detail.upload.id);
        } else {
          setAreaSummary(null);
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to open upload details');
      }
    },
    [detectMappingsForSheet, loadAreaSummary]
  );

  // Live authenticated SSE progress subscription with polling fallback while job is queued/running
  useEffect(() => {
    if (!activeJob || !['QUEUED', 'RUNNING'].includes(activeJob.status)) return;
    const jobId = activeJob.id;
    const uploadId = selectedUpload?.id;
    const controller = new AbortController();
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const applyPayload = (payload: any) => {
      if (cancelled) return;
      if (typeof payload.progress === 'number') setJobProgress(payload.progress);
      setActiveJob((prev) =>
        prev
          ? {
              ...prev,
              status: payload.status || prev.status,
              processed_records: payload.processed_records ?? payload.processedRecords ?? prev.processed_records,
              total_records: payload.total_records ?? payload.totalRecords ?? prev.total_records,
              completed_chunks: payload.completed_chunks ?? payload.completedChunks ?? prev.completed_chunks,
              total_chunks: payload.total_chunks ?? payload.totalChunks ?? prev.total_chunks,
              error_summary: payload.error_summary ?? prev.error_summary,
            }
          : prev
      );
      if (['COMPLETED', 'FAILED_DEAD_LETTER', 'CANCELLED'].includes(payload.status)) {
        controller.abort();
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        void loadUploadsAndTemplates();
        if (uploadId) {
          void apiRequest<{ upload: UploadDTO; jobs: JobDTO[] }>(`/api/v1/uploads/${uploadId}`)
            .then(async (r) => {
              setSelectedUpload(r.upload);
              const nextRunning = r.jobs?.find((j) => ['QUEUED', 'RUNNING'].includes(j.status));
              if (nextRunning) {
                setActiveJob(nextRunning);
                setJobProgress(10);
              } else if (r.upload.status === 'PROCESSED') {
                setStatusMsg('Data structured and grouped by Area. Your Excel downloads are ready below.');
                await loadAreaSummary(uploadId);
              }
            })
            .catch(() => {});
        }
      }
    };

    const startFallbackPolling = () => {
      if (cancelled || pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const r = await apiRequest<{ job: JobDTO }>(`/api/v1/jobs/${jobId}`);
          const j = r.job;
          const progress =
            j.status === 'COMPLETED'
              ? 100
              : j.total_chunks > 0
                ? Math.min(98, Math.round((j.completed_chunks / j.total_chunks) * 100))
                : 0;
          applyPayload({ ...j, progress });
        } catch {
          // Ignore transient poll errors
        }
      }, 1500);
    };

    const connectStream = async () => {
      try {
        const res = await fetch(buildApiUrl(`/api/v1/jobs/${jobId}/stream`), {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          startFallbackPolling();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';
          for (const evt of events) {
            for (const line of evt.split('\n')) {
              if (line.startsWith('data:')) {
                const jsonStr = line.slice(5).trim();
                if (jsonStr) {
                  try {
                    applyPayload(JSON.parse(jsonStr));
                  } catch {
                    // Ignore malformed chunk
                  }
                }
              }
            }
          }
        }
        if (!cancelled) startFallbackPolling();
      } catch {
        if (!cancelled) startFallbackPolling();
      }
    };

    void connectStream();

    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [activeJob?.id, activeJob?.status, loadAreaSummary, loadUploadsAndTemplates, selectedUpload?.id]);

  const performUpload = async (file: File, overrideDuplicate = false) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setDuplicateWarning(null);
    setShowAdvancedMapping(false);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (overrideDuplicate) form.append('overrideDuplicate', 'true');

      const res = await apiRequest<{ upload: UploadDTO; sheets: UploadSheetDTO[] }>('/api/v1/uploads', {
        method: 'POST',
        body: form,
      });

      let backupNote = '';
      setVaultSyncWarning(null);
      if (isVaultConnected && firebaseUser?.uid) {
        try {
          setSyncingUploadId(res.upload.id);
          await backupUploadToFirestore(firebaseUser.uid, res.upload.id, (msg) => setVaultSyncStatus(msg));
          backupNote = ' and backed up to Google Cloud Firestore';
        } catch (vaultErr) {
          setVaultSyncWarning(
            `Saved to backend storage, but Google Backup needs retry: ${
              vaultErr instanceof Error ? vaultErr.message : 'Backup error'
            }`
          );
        } finally {
          setSyncingUploadId(null);
          setVaultSyncStatus(null);
        }
      }

      setStatusMsg(
        `Saved "${res.upload.original_filename}" (${res.upload.total_rows.toLocaleString()} rows) in backend storage${backupNote}. Review detected fields or click Process & Group by Area.`
      );
      await loadUploadsAndTemplates();
      await openUploadDetail(res.upload.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = Array.isArray(err.details) ? (err.details[0] as any) : null;
        setDuplicateWarning({
          file,
          existingName: details?.existingFilename || 'an earlier upload',
        });
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Upload failed');
      }
    } finally {
      setUploading(false);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void performUpload(file);
  };

  const handleSaveAndStart = async () => {
    if (!selectedUpload || !activeSheet) return;
    if (selectedCols.length === 0) {
      setErrorMsg('Select at least one column to process.');
      return;
    }
    setErrorMsg(null);
    setStatusMsg(null);
    setStartingProcess(true);
    try {
      const effectiveMappings: ColumnMappingItem[] =
        mappings.length > 0
          ? mappings
          : activeSheet.headers.map((col, idx) => ({
              sourceColumn: col,
              sourceIndex: idx,
              targetField: selectedCols.includes(col) ? 'custom' : 'ignore',
              customFieldKey: col,
              detectionSource: 'RULE',
              confidence: 0.7,
            }));

      await apiRequest(`/api/v1/uploads/${selectedUpload.id}/sheets/${activeSheet.id}/select`, {
        method: 'POST',
        body: JSON.stringify({ selectedColumns: selectedCols }),
      });

      await apiRequest(`/api/v1/processing/uploads/${selectedUpload.id}/sheets/${activeSheet.id}/mapping`, {
        method: 'PUT',
        body: JSON.stringify({
          mappings: effectiveMappings.map((m) => ({
            ...m,
            targetField: selectedCols.includes(m.sourceColumn) ? m.targetField : 'ignore',
          })),
          saveAsTemplateName: templateName.trim() || undefined,
        }),
      });

      const nonEmptySheetsCount = sheets.filter((s) => s.row_count > 0).length;
      const shouldProcessAll = nonEmptySheetsCount > 1 && processAllSheets;
      const jobRes = await apiRequest<{ job: JobDTO; jobs?: JobDTO[] }>(
        `/api/v1/processing/uploads/${selectedUpload.id}/sheets/${activeSheet.id}/start`,
        {
          method: 'POST',
          body: JSON.stringify({
            checkDuplicatesAgainstMaster: checkMasterDupes,
            runCategorisation: true,
            includeHiddenRows,
            processAllSheets: shouldProcessAll,
          }),
        }
      );

      setActiveJob(jobRes.job);
      setJobProgress(5);
      setTemplateName('');
      setShowAdvancedMapping(false);
      setStatusMsg(
        shouldProcessAll
          ? `Processing ${nonEmptySheetsCount} worksheets and grouping all customers by Area...`
          : 'Processing spreadsheet and grouping customers by Area...'
      );
      await loadUploadsAndTemplates();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start processing');
    } finally {
      setStartingProcess(false);
    }
  };

  const handleQuickDownload = async (areaKey?: string, mode: 'AREA_WISE' | 'ROUTE_XLSX' = 'AREA_WISE') => {
    if (!selectedUpload) return;
    const key = mode === 'ROUTE_XLSX' ? '__ROUTE_XLSX__' : areaKey || '__ALL_ZIP__';
    setDownloadingKey(key);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const exp = await generateAndDownloadExport({
        exportMode: mode,
        filters: {
          uploadId: selectedUpload.id,
          ...(areaKey && mode === 'AREA_WISE' ? { area: areaKey } : {}),
        },
      });
      setStatusMsg(`Downloaded "${exp.filename}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingKey(null);
    }
  };

  const applyTemplate = (tpl: MappingTemplateDTO) => {
    const bySource = new Map(tpl.mappings.map((m) => [m.sourceColumn.toLowerCase(), m]));
    setMappings((prev) =>
      prev.map((col) => {
        const match = bySource.get(col.sourceColumn.toLowerCase());
        return match
          ? {
              ...col,
              targetField: match.targetField,
              customFieldKey: match.customFieldKey || null,
              detectionSource: 'TEMPLATE',
              confidence: 1,
            }
          : col;
      })
    );
    setStatusMsg(`Applied template "${tpl.name}".`);
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ job: JobDTO }>(`/api/v1/jobs/${activeJob.id}/cancel`, { method: 'POST' });
      setActiveJob(res.job);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel job');
    }
  };

  const handleRetryJob = async () => {
    if (!activeJob) return;
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ job: JobDTO }>(`/api/v1/jobs/${activeJob.id}/retry`, { method: 'POST' });
      setActiveJob(res.job);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to retry job');
    }
  };

  const handleDeleteUpload = async (u: UploadDTO) => {
    setErrorMsg(null);
    try {
      await apiRequest(`/api/v1/uploads/${u.id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setRecentlyDeletedUpload({ id: u.id, name: u.original_filename });
      if (selectedUpload?.id === u.id) {
        setSelectedUpload(null);
        setActiveSheet(null);
        setAreaSummary(null);
      }
      await loadUploadsAndTemplates();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleRestoreLocalUpload = async (id: string) => {
    setErrorMsg(null);
    try {
      await apiRequest(`/api/v1/uploads/${id}/restore`, { method: 'POST' });
      setRecentlyDeletedUpload(null);
      setStatusMsg('Restored file and its structured records to Uploaded Files.');
      await loadUploadsAndTemplates();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const handleSyncSingleToFirestore = async (uploadId: string) => {
    if (!firebaseUser?.uid) return;
    setErrorMsg(null);
    setSyncingUploadId(uploadId);
    try {
      const res = await backupUploadToFirestore(firebaseUser.uid, uploadId, (msg) => setVaultSyncStatus(msg));
      setStatusMsg(
        `Backed up to Cloud Firestore Vault (${res.sheetCount} sheet${res.sheetCount === 1 ? '' : 's'}, ${res.chunkCount} row chunks${
          res.checksumVerified ? ', SHA-256 verified' : ''
        }).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Firestore backup failed');
    } finally {
      setSyncingUploadId(null);
      setVaultSyncStatus(null);
    }
  };

  const vaultByUploadId = useMemo(
    () => new Map(vaultUploads.map((v) => [v.uploadId, v])),
    [vaultUploads]
  );

  const unbackedUploads = useMemo(
    () => uploads.filter((u) => !vaultByUploadId.has(u.id)),
    [uploads, vaultByUploadId]
  );

  const visibleVaultUploads = useMemo(
    () => vaultUploads.filter((v) => (showArchivedVault ? true : !v.isArchived)),
    [vaultUploads, showArchivedVault]
  );

  const handleBackupAllToFirestore = async () => {
    if (!firebaseUser?.uid || unbackedUploads.length === 0) return;
    setErrorMsg(null);
    setSyncingAllVault(true);
    let synced = 0;
    try {
      for (const u of unbackedUploads) {
        setSyncingUploadId(u.id);
        setVaultSyncStatus(`Syncing ${u.original_filename} (${synced + 1}/${unbackedUploads.length})...`);
        await backupUploadToFirestore(firebaseUser.uid, u.id);
        synced++;
      }
      setStatusMsg(`Synced ${synced} Excel/CSV upload${synced === 1 ? '' : 's'} to Cloud Firestore Vault.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Batch Firestore backup failed');
    } finally {
      setSyncingUploadId(null);
      setSyncingAllVault(false);
      setVaultSyncStatus(null);
    }
  };

  const handleRestoreFromVault = async (vaultRec: VaultUploadRecord) => {
    if (!firebaseUser?.uid) return;
    setErrorMsg(null);
    setRestoringVaultId(vaultRec.id);
    try {
      const restored = await restoreUploadFromFirestore(firebaseUser.uid, vaultRec.id);
      setStatusMsg(
        `Restored "${restored.upload.original_filename}" (${restored.upload.total_rows.toLocaleString()} rows) from Cloud Firestore into MARSFORCE.`
      );
      await loadUploadsAndTemplates();
      await openUploadDetail(restored.upload.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Restore from Firestore Vault failed');
    } finally {
      setRestoringVaultId(null);
    }
  };

  const handleToggleArchiveVault = async (vaultRec: VaultUploadRecord) => {
    setErrorMsg(null);
    try {
      await setVaultUploadArchived(vaultRec.id, !vaultRec.isArchived);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to update archive status');
    }
  };

  // Simple 3-step stage index: 0 = Upload File, 1 = Process Data, 2 = Download Area Files
  const simpleStep = !selectedUpload
    ? 0
    : selectedUpload.status === 'PROCESSED' || activeJob?.status === 'COMPLETED'
      ? 2
      : 1;

  const isRunningJob = Boolean(activeJob && ['QUEUED', 'RUNNING'].includes(activeJob.status));
  const nonEmptySheets = sheets.filter((s) => s.row_count > 0);
  const totalRowsToProcess =
    nonEmptySheets.length > 1 && processAllSheets
      ? nonEmptySheets.reduce((acc, s) => acc + s.row_count, 0)
      : activeSheet?.row_count || 0;

  const detectedFieldSummary = useMemo(() => {
    return mappings
      .filter((m) => selectedCols.includes(m.sourceColumn) && m.targetField !== 'ignore')
      .map((m) => ({
        source: m.sourceColumn,
        target: TARGET_FIELD_LABELS.get(m.targetField) || m.targetField,
      }));
  }, [mappings, selectedCols]);

  const validAreas = useMemo(
    () => (areaSummary?.areas || []).filter((a) => !a.isUnassigned),
    [areaSummary]
  );
  const unassignedArea = useMemo(
    () => (areaSummary?.areas || []).find((a) => a.isUnassigned) || null,
    [areaSummary]
  );

  const filteredValidAreas = useMemo(() => {
    const q = areaSearch.trim().toLowerCase();
    if (!q) return validAreas;
    return validAreas.filter((a) => a.areaName.toLowerCase().includes(q));
  }, [validAreas, areaSearch]);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header + Sample Download */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Upload & Download by Area</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Upload your Excel or CSV file, process once, and download structured Excel workbooks for every Area.
          </p>
        </div>

        {hasPermission('upload') && (
          <button
            type="button"
            onClick={() =>
              void downloadAuthenticatedFile('/api/v1/samples/messy-csv', 'marsforce_messy_sample.csv').catch((err) =>
                setErrorMsg(err instanceof Error ? err.message : 'Sample download failed')
              )
            }
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
          >
            <Download className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            Download Sample CSV
          </button>
        )}
      </div>

      {/* Simple 3-Step Indicator */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { title: '1. Upload File', sub: 'Drop Excel (.xlsx/.xls) or CSV' },
            { title: '2. Process & Group', sub: 'Clean columns & detect Areas' },
            { title: '3. Download Area Files', sub: 'One Excel file per Area or full ZIP' },
          ].map((step, idx) => {
            const done = idx < simpleStep;
            const active = idx === simpleStep;
            return (
              <div
                key={step.title}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
                  active
                    ? 'border-blue-600 bg-blue-50/60 dark:bg-blue-950/30'
                    : done
                      ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20'
                      : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 tabular-nums ${
                    done
                      ? 'bg-emerald-600 text-white'
                      : active
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                  }`}
                >
                  {done ? <Check className="w-4 h-4" /> : idx + 1}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">{step.title}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{step.sub}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-4"
        >
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="text-xs underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {statusMsg && (
        <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-sm text-emerald-800 dark:text-emerald-300">
          {statusMsg}
        </div>
      )}

      {aiWarning && (
        <div className="p-3.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-4">
          <span>{aiWarning}</span>
          <button type="button" onClick={() => setAiWarning(null)} className="underline shrink-0 cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {duplicateWarning && (
        <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Duplicate file detected ({duplicateWarning.existingName})
              </div>
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                This file matches an earlier upload. Upload again only if you want a fresh batch.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDuplicateWarning(null)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-300 dark:border-amber-700 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void performUpload(duplicateWarning.file, true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
            >
              Upload Anyway
            </button>
          </div>
        </div>
      )}

      {/* Step 1: Drag & Drop Uploader */}
      {hasPermission('upload') && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleFileDrop}
          className={`border-2 border-dashed rounded-xl p-7 text-center transition-colors bg-white dark:bg-slate-900 ${
            dragOver
              ? 'border-blue-600 bg-blue-50/40 dark:bg-blue-950/20'
              : 'border-slate-300 dark:border-slate-700'
          }`}
        >
          <Upload className="w-7 h-7 mx-auto text-slate-400 mb-2.5" />
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            {uploading ? 'Reading workbook and detecting columns...' : 'Drop your Excel (.xlsx, .xls) or CSV file here'}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">
            Automatically reads multi-sheet workbooks, cleans addresses & phone numbers, and groups customers by Area.
          </p>
          <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer transition-colors">
            <span>{uploading ? 'Uploading...' : 'Choose File'}</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              disabled={uploading}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void performUpload(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      )}

      {/* Step 2 & 3: Selected Upload Workspace */}
      {selectedUpload && activeSheet && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
          {/* File Summary Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-blue-600 shrink-0" />
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  {selectedUpload.original_filename}
                </h2>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                {selectedUpload.total_rows.toLocaleString()} rows
                {sheets.length > 1 ? ` across ${sheets.length} worksheets` : ''} ·{' '}
                {(selectedUpload.file_size_bytes / 1024).toFixed(1)} KB · Status: {selectedUpload.status}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {selectedUpload.status === 'PROCESSED' && (
                <>
                  <button
                    type="button"
                    onClick={() => onOpenGeoForUpload(selectedUpload.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    View Streets Tree
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenReviewForUpload(selectedUpload.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    Review Records
                  </button>
                  <button
                    type="button"
                    onClick={() => onGoToExports(selectedUpload.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    More Export Options
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setShowAdvancedMapping((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                {showAdvancedMapping ? 'Hide Mapping Details' : 'Customize Mapping'}
              </button>
            </div>
          </div>

          {/* Live Job Progress */}
          {activeJob && ['QUEUED', 'RUNNING', 'FAILED_DEAD_LETTER'].includes(activeJob.status) && (
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  {activeJob.status === 'FAILED_DEAD_LETTER'
                    ? 'Processing failed'
                    : 'Structuring and grouping records by Area...'}
                </div>
                <div className="text-xs font-mono-tabular text-slate-600 dark:text-slate-400">
                  {activeJob.processed_records.toLocaleString()} / {activeJob.total_records.toLocaleString()} rows (
                  {jobProgress}%)
                </div>
              </div>
              <div className="w-full h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    activeJob.status === 'FAILED_DEAD_LETTER' ? 'bg-red-600' : 'bg-blue-600'
                  }`}
                  style={{ width: `${jobProgress}%` }}
                />
              </div>
              {activeJob.error_summary && (
                <div className="text-xs text-red-600 dark:text-red-400">{activeJob.error_summary}</div>
              )}
              <div className="flex items-center gap-2">
                {['QUEUED', 'RUNNING'].includes(activeJob.status) && hasPermission('process') && (
                  <button
                    type="button"
                    onClick={() => void handleCancelJob()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Square className="w-3 h-3" />
                    Cancel
                  </button>
                )}
                {activeJob.status === 'FAILED_DEAD_LETTER' && hasPermission('process') && (
                  <button
                    type="button"
                    onClick={() => void handleRetryJob()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Retry Processing
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Step 2 Quick Process Card (Shown when upload has not been processed yet) */}
          {selectedUpload.status !== 'PROCESSED' && !isRunningJob && hasPermission('process') && (
            <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Ready to clean and group into Areas
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300 truncate">
                  {detectedFieldSummary.length > 0
                    ? `Auto-detected fields: ${detectedFieldSummary.map((d) => `${d.source} → ${d.target}`).join(' · ')}`
                    : 'Click Customize Mapping to choose columns'}
                </div>
              </div>

              <button
                type="button"
                disabled={startingProcess || detectingMapping}
                onClick={() => void handleSaveAndStart()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer transition-colors whitespace-nowrap disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                {detectingMapping
                  ? 'Detecting columns...'
                  : startingProcess
                    ? 'Starting...'
                    : `Process & Group by Area (${totalRowsToProcess.toLocaleString()} Rows)`}
              </button>
            </div>
          )}

          {/* Step 3: Instant Area Downloads (Shown immediately once PROCESSED) */}
          {selectedUpload.status === 'PROCESSED' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-[#0B2545] text-white">
                <div>
                  <div className="text-sm font-bold">Route-Optimized Excel &amp; Area Downloads Ready</div>
                  <div className="text-xs text-slate-300 mt-0.5 tabular-nums">
                    {loadingAreas
                      ? 'Loading areas...'
                      : `${validAreas.length} chained Area${validAreas.length === 1 ? '' : 's'} · ${(
                          areaSummary?.reconciliation.totalCustomerRecords ?? selectedUpload.total_rows
                        ).toLocaleString()} customers ordered for field visits`}
                  </div>
                </div>

                {hasPermission('export') && (validAreas.length > 0 || unassignedArea) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={downloadingKey !== null}
                      onClick={() => void handleQuickDownload(undefined, 'ROUTE_XLSX')}
                      className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50 whitespace-nowrap"
                    >
                      <FileSpreadsheet className="w-4 h-4" />
                      {downloadingKey === '__ROUTE_XLSX__' ? 'Optimizing Route...' : 'Download Route Excel (.xlsx)'}
                    </button>
                    {validAreas.length > 0 && (
                      <button
                        type="button"
                        disabled={downloadingKey !== null}
                        onClick={() => void handleQuickDownload(undefined, 'AREA_WISE')}
                        className="inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-white cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <Archive className="w-4 h-4" />
                        {downloadingKey === '__ALL_ZIP__' ? 'Preparing ZIP...' : 'All Areas (ZIP)'}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {loadingAreas ? (
                <div className="py-6 text-center text-xs text-slate-500">Loading Area breakdown...</div>
              ) : validAreas.length === 0 && !unassignedArea ? (
                <div className="py-6 text-center text-xs text-slate-500">
                  No structured Area records found for this file.
                </div>
              ) : (
                <>
                  {validAreas.length > 5 && (
                    <div className="relative max-w-sm">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="search"
                        value={areaSearch}
                        onChange={(e) => setAreaSearch(e.target.value)}
                        placeholder={`Filter ${validAreas.length} areas...`}
                        className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                  )}

                  {filteredValidAreas.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {filteredValidAreas.map((area, aIdx) => {
                        const streetCount = area.streetGroups.filter((s) => s.streetGroup !== 'UNIDENTIFIED').length;
                        const isDownloadingThis = downloadingKey === area.areaKey;
                        const stopNum = area.areaStopNumber ?? aIdx + 1;
                        return (
                          <div
                            key={area.areaKey}
                            className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                                <span className="text-xs font-mono-tabular text-blue-600 dark:text-blue-400 mr-1.5">
                                  #{stopNum}
                                </span>
                                {area.areaName}
                              </div>
                              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                                {area.totalCount.toLocaleString()} customers · {streetCount} street
                                {streetCount === 1 ? '' : 's'}
                                {area.needsReviewCount > 0 ? ` · ${area.needsReviewCount} review` : ''}
                              </div>
                            </div>

                            {hasPermission('export') && (
                              <button
                                type="button"
                                disabled={downloadingKey !== null}
                                onClick={() => void handleQuickDownload(area.areaKey)}
                                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                <Download className="w-3.5 h-3.5" />
                                {isDownloadingThis ? 'Preparing...' : 'Download .xlsx'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {unassignedArea && (
                    <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 text-xs">
                      <div className="text-amber-900 dark:text-amber-200 tabular-nums">
                        <span className="font-semibold">{unassignedArea.totalCount.toLocaleString()} records</span> had
                        no Area detected. They are exported in{' '}
                        <span className="font-mono-tabular">UNASSIGNED_AREA_RECORDS.csv</span> inside the ZIP download, or
                        you can assign Areas in Review Records.
                      </div>
                      <button
                        type="button"
                        onClick={() => onOpenGeoForUpload(selectedUpload.id)}
                        className="font-semibold text-amber-800 dark:text-amber-300 hover:underline cursor-pointer"
                      >
                        Fix Unassigned Areas
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Optional Advanced Column Mapping & Raw Preview (Collapsed by default for simplicity) */}
          {showAdvancedMapping && (
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-5">
              {sheets.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <span className="text-xs font-medium text-slate-500 shrink-0">Worksheets:</span>
                  {sheets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setActiveSheet(s);
                        setSelectedCols(s.selected_columns?.length ? s.selected_columns : s.headers);
                        setIncludeHiddenRows(s.include_hidden_rows ?? true);
                        void detectMappingsForSheet(selectedUpload.id, s);
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap cursor-pointer ${
                        activeSheet.id === s.id
                          ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 border-transparent'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {s.sheet_name} ({s.row_count.toLocaleString()})
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">Column Mapping</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Override auto-detected fields or apply a saved column template before reprocessing.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {templates.length > 0 && (
                      <select
                        aria-label="Apply saved mapping template"
                        defaultValue=""
                        onChange={(e) => {
                          const tpl = templates.find((t) => t.id === e.target.value);
                          if (tpl) applyTemplate(tpl);
                        }}
                        className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value="" disabled>
                          Apply saved template...
                        </option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    )}

                    {suggestedTemplate && (
                      <button
                        type="button"
                        onClick={() => applyTemplate(suggestedTemplate)}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer"
                      >
                        Use matching template: {suggestedTemplate.name}
                      </button>
                    )}

                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer px-2">
                      <input
                        type="checkbox"
                        checked={useAiMapping}
                        onChange={(e) => setUseAiMapping(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                      AI Fallback
                    </label>

                    <button
                      type="button"
                      onClick={() => void detectMappingsForSheet(selectedUpload.id, activeSheet, useAiMapping)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Re-detect
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                        <th className="py-2.5 px-3 font-semibold w-10">Include</th>
                        <th className="py-2.5 px-3 font-semibold">Source Column</th>
                        <th className="py-2.5 px-3 font-semibold">Sample Value</th>
                        <th className="py-2.5 px-3 font-semibold">Target Field</th>
                        <th className="py-2.5 px-3 font-semibold">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {mappings.map((m) => {
                        const included = selectedCols.includes(m.sourceColumn);
                        const sampleVal = activeSheet.preview_rows?.[0]?.[m.sourceColumn] ?? '';
                        return (
                          <tr key={m.sourceIndex} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-2 px-3">
                              <input
                                type="checkbox"
                                checked={included}
                                onChange={(e) => {
                                  setSelectedCols((prev) =>
                                    e.target.checked
                                      ? [...prev, m.sourceColumn]
                                      : prev.filter((c) => c !== m.sourceColumn)
                                  );
                                }}
                              />
                            </td>
                            <td className="py-2 px-3 font-medium text-slate-900 dark:text-white">{m.sourceColumn}</td>
                            <td className="py-2 px-3 text-slate-500 dark:text-slate-400 max-w-xs truncate">
                              {sampleVal || '—'}
                            </td>
                            <td className="py-2 px-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  aria-label={`Target field for ${m.sourceColumn}`}
                                  disabled={!included || !hasPermission('process')}
                                  value={included ? m.targetField : 'ignore'}
                                  onChange={(e) => {
                                    const nextField = e.target.value as TargetField;
                                    setMappings((prev) =>
                                      prev.map((item) =>
                                        item.sourceIndex === m.sourceIndex
                                          ? { ...item, targetField: nextField, detectionSource: 'MANUAL', confidence: 1 }
                                          : item
                                      )
                                    );
                                  }}
                                  className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                                >
                                  {TARGET_FIELD_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                                {included && m.targetField === 'custom' && (
                                  <input
                                    type="text"
                                    aria-label={`Custom field key for ${m.sourceColumn}`}
                                    disabled={!hasPermission('process')}
                                    value={m.customFieldKey ?? m.sourceColumn}
                                    onChange={(e) => {
                                      const nextKey = e.target.value;
                                      setMappings((prev) =>
                                        prev.map((item) =>
                                          item.sourceIndex === m.sourceIndex
                                            ? { ...item, customFieldKey: nextKey }
                                            : item
                                        )
                                      );
                                    }}
                                    placeholder="Custom key"
                                    className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs w-32"
                                  />
                                )}
                              </div>
                            </td>
                            <td className="py-2 px-3 text-slate-600 dark:text-slate-400 font-mono-tabular">
                              {m.detectionSource} · {(m.confidence * 100).toFixed(0)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {hasPermission('process') && (
                  <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="text"
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        placeholder="Optional: save mapping as template"
                        className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-56"
                      />
                      <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checkMasterDupes}
                          onChange={(e) => setCheckMasterDupes(e.target.checked)}
                        />
                        Check master duplicates
                      </label>
                      <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeHiddenRows}
                          onChange={(e) => setIncludeHiddenRows(e.target.checked)}
                        />
                        Include hidden rows
                      </label>
                      {nonEmptySheets.length > 1 && (
                        <label className="inline-flex items-center gap-2 text-xs font-medium text-blue-700 dark:text-blue-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={processAllSheets}
                            onChange={(e) => setProcessAllSheets(e.target.checked)}
                          />
                          Process all {nonEmptySheets.length} worksheets
                        </label>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={startingProcess}
                      onClick={() => void handleSaveAndStart()}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Save Mapping & Reprocess ({totalRowsToProcess.toLocaleString()} Rows)
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Raw Preview (First {Math.min(50, activeSheet.preview_rows.length)} rows)
                </h3>
                <div className="overflow-auto max-h-64 border border-slate-200 dark:border-slate-800 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2 px-3 font-semibold text-slate-500">#</th>
                        {activeSheet.headers.map((h) => (
                          <th key={h} className="py-2 px-3 font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {activeSheet.preview_rows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                          <td className="py-1.5 px-3 font-mono-tabular text-slate-400">{idx + 1}</td>
                          {activeSheet.headers.map((h) => (
                            <td key={h} className="py-1.5 px-3 text-slate-700 dark:text-slate-300 max-w-xs truncate">
                              {row[h] || ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Cloud Firestore Backup Vault (Optional Google Sign-In strictly for Excel backup) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck
              className={`w-4 h-4 shrink-0 ${
                isVaultConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'
              }`}
            />
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Google Cloud Excel Backup
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Every Excel uploaded is stored automatically in backend storage. Connect Google Sign-In strictly to mirror backups in Cloud Firestore.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isVaultConnected ? (
              <>
                <span className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                  <Cloud className="w-3.5 h-3.5 text-emerald-600" />
                  {firebaseUser?.email}
                </span>
                {unbackedUploads.length > 0 && (
                  <button
                    type="button"
                    disabled={syncingAllVault}
                    onClick={() => void handleBackupAllToFirestore()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer disabled:opacity-50"
                  >
                    <CloudUpload className="w-3.5 h-3.5" />
                    {syncingAllVault
                      ? 'Syncing...'
                      : `Back Up ${unbackedUploads.length} Backend File${unbackedUploads.length === 1 ? '' : 's'}`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void disconnectGoogleBackup()}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={connectingGoogle}
                onClick={() => void connectGoogleBackup()}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 text-white cursor-pointer disabled:opacity-50"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                {connectingGoogle ? 'Connecting Google...' : 'Connect Google Backup'}
              </button>
            )}
          </div>
        </div>

        {(connectionOffline || vaultAuthError || vaultSyncWarning || vaultSyncStatus) && (
          <div
            className={`px-5 py-2.5 border-b text-xs flex items-center justify-between gap-3 ${
              connectionOffline || vaultAuthError || vaultSyncWarning
                ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300'
            }`}
          >
            <span className="flex items-center gap-2">
              {(connectionOffline || vaultAuthError || vaultSyncWarning) && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
              <span>
                {connectionOffline
                  ? connectionMessage
                  : vaultAuthError
                    ? vaultAuthError
                    : vaultSyncWarning || vaultSyncStatus}
              </span>
            </span>
            {(vaultAuthError || vaultSyncWarning) && (
              <button
                type="button"
                onClick={() => {
                  clearVaultAuthError();
                  setVaultSyncWarning(null);
                }}
                className="underline cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            )}
          </div>
        )}

        {isVaultConnected && (
          <div className="p-4 space-y-3">
            {vaultUploads.length === 0 ? (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Connected. Every new Excel or CSV uploaded automatically saves to Cloud Firestore Vault, or click &ldquo;Back Up&rdquo; on any backend file below.
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="tabular-nums">
                    {visibleVaultUploads.length} backed-up workbook{visibleVaultUploads.length === 1 ? '' : 's'}
                  </span>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showArchivedVault}
                      onChange={(e) => setShowArchivedVault(e.target.checked)}
                    />
                    Show archived backups
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {visibleVaultUploads.map((v) => (
                    <div
                      key={v.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                          {v.originalFilename}
                          {v.isArchived ? ' (Archived)' : ''}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
                          {v.totalRows.toLocaleString()} rows · {v.sheetCount} sheet{v.sheetCount === 1 ? '' : 's'} ·{' '}
                          {v.chunkCount} chunks · SHA {v.fileSha256.slice(0, 8)}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {hasPermission('upload') && (
                          <button
                            type="button"
                            disabled={restoringVaultId === v.id}
                            onClick={() => void handleRestoreFromVault(v)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white cursor-pointer disabled:opacity-50"
                          >
                            <RotateCcw className="w-3 h-3" />
                            {restoringVaultId === v.id ? 'Restoring...' : 'Restore'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleToggleArchiveVault(v)}
                          className="px-2 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          {v.isArchived ? 'Unarchive' : 'Archive'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {recentlyDeletedUpload && (
        <div className="p-3.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-4">
          <span>
            Removed &ldquo;{recentlyDeletedUpload.name}&rdquo; from active view (soft-deleted safely).
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleRestoreLocalUpload(recentlyDeletedUpload.id)}
              className="font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Undo & Restore
            </button>
            <button type="button" onClick={() => setRecentlyDeletedUpload(null)} className="underline cursor-pointer">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Upload History Table */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Uploaded Files</h2>
          <button
            type="button"
            onClick={() => void loadUploadsAndTemplates()}
            className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
          >
            Refresh
          </button>
        </div>

        {loadingList ? (
          <div className="p-6 text-sm text-slate-500">Loading uploaded files...</div>
        ) : uploads.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No files uploaded yet. Drop an Excel/CSV file above or click &ldquo;Download Sample CSV&rdquo; to try it out.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                  <th className="py-2.5 px-4 font-semibold">Filename</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Rows</th>
                  <th className="py-2.5 px-4 font-semibold">Status</th>
                  {isVaultConnected && <th className="py-2.5 px-4 font-semibold">Firestore Vault</th>}
                  <th className="py-2.5 px-4 font-semibold">Date</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {uploads.map((u) => {
                  const isBackedUp = vaultByUploadId.has(u.id);
                  return (
                    <tr
                      key={u.id}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                        selectedUpload?.id === u.id ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''
                      }`}
                    >
                      <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-white">
                        <button
                          type="button"
                          onClick={() => void openUploadDetail(u.id)}
                          className="hover:underline text-left cursor-pointer inline-flex items-center gap-1.5"
                        >
                          {selectedUpload?.id === u.id ? (
                            <ChevronDown className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          )}
                          {u.original_filename}
                        </button>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular">{u.total_rows.toLocaleString()}</td>
                      <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300">{u.status}</td>
                      {isVaultConnected && (
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        {isBackedUp ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                            <Check className="w-3.5 h-3.5" />
                            Backed Up
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={syncingUploadId === u.id}
                            onClick={() => void handleSyncSingleToFirestore(u.id)}
                            className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer disabled:opacity-50"
                          >
                            <CloudUpload className="w-3.5 h-3.5" />
                            {syncingUploadId === u.id ? 'Saving...' : 'Back Up'}
                          </button>
                        )}
                      </td>
                      )}
                      <td className="py-2.5 px-4 font-mono-tabular text-slate-500">
                        {new Date(u.created_at).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4 text-right space-x-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            void downloadAuthenticatedFile(
                              `/api/v1/uploads/${u.id}/download`,
                              u.original_filename
                            ).catch((err) => setErrorMsg(err instanceof Error ? err.message : 'Download failed'))
                          }
                          className="text-slate-600 dark:text-slate-300 hover:underline font-medium cursor-pointer inline-flex items-center gap-1"
                        >
                          <Download className="w-3 h-3" />
                          Original
                        </button>
                        <button
                          type="button"
                          onClick={() => void openUploadDetail(u.id)}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer"
                        >
                          {u.status === 'PROCESSED' ? 'Download Areas' : 'Open & Process'}
                        </button>
                        {u.status === 'PROCESSED' && (
                          <button
                            type="button"
                            onClick={() => onOpenReviewForUpload(u.id)}
                            className="text-slate-600 dark:text-slate-300 hover:underline font-medium cursor-pointer"
                          >
                            Review
                          </button>
                        )}
                        {hasPermission('delete') && (
                          confirmDeleteId === u.id ? (
                            <span className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleDeleteUpload(u)}
                                className="text-red-600 dark:text-red-400 font-semibold hover:underline cursor-pointer"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-slate-500 hover:underline cursor-pointer"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(u.id)}
                              aria-label={`Delete ${u.original_filename}`}
                              className="text-red-600 dark:text-red-400 hover:underline cursor-pointer inline-flex items-center"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
