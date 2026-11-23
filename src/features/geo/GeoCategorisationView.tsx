import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  FileSpreadsheet,
  GitMerge,
  Layers,
  MapPin,
  RefreshCw,
  Scissors,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile, generateAndDownloadExport } from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type {
  CleanRecordDTO,
  ExportDTO,
  GeoAreaItem,
  GeoUploadSummaryDTO,
  SourceRowAuditDTO,
  UploadDTO,
} from '../../types/api.ts';

interface GeoCategorisationViewProps {
  initialUploadId?: string;
  onOpenReviewForGroup?: (uploadId: string, areaKey?: string, streetGroup?: string) => void;
  onGoToExports?: (uploadId: string) => void;
}

export function GeoCategorisationView({
  initialUploadId,
  onOpenReviewForGroup,
  onGoToExports,
}: GeoCategorisationViewProps) {
  const { hasPermission } = useAuth();
  const [uploads, setUploads] = useState<UploadDTO[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState<string>(initialUploadId || '');
  const [summary, setSummary] = useState<GeoUploadSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'audit'>('hierarchy');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Expanded Areas & Street Groups
  const [expandedAreas, setExpandedAreas] = useState<Set<string>>(new Set());
  const [expandedStreets, setExpandedStreets] = useState<Map<string, CleanRecordDTO[]>>(new Map());
  const [loadingStreetKey, setLoadingStreetKey] = useState<string | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());

  // Reprocess & Zip Export progress
  const [includeHiddenRows, setIncludeHiddenRows] = useState(true);
  const [reprocessing, setReprocessing] = useState(false);
  const [activeExport, setActiveExport] = useState<ExportDTO | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [areaSearch, setAreaSearch] = useState('');

  // Inline Edit Modal for a customer record
  const [editingRecord, setEditingRecord] = useState<CleanRecordDTO | null>(null);
  const [editForm, setEditForm] = useState({
    area: '',
    subArea: '',
    street: '',
    streetGroup: '',
    approveClassification: true,
    saveAliasToDictionary: true,
  });

  // Merge/Rename Modal
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeForm, setMergeForm] = useState<{
    level: 'AREA' | 'STREET_GROUP';
    parentArea: string;
    sourceLabelsText: string;
    targetLabel: string;
    saveDictionaryAlias: boolean;
  }>({
    level: 'STREET_GROUP',
    parentArea: '',
    sourceLabelsText: '',
    targetLabel: '',
    saveDictionaryAlias: true,
  });

  // Split Selected Records Modal
  const [splitModalOpen, setSplitModalOpen] = useState(false);
  const [splitForm, setSplitForm] = useState({
    targetArea: '',
    targetSubArea: '',
    targetStreetGroup: '',
  });

  // Physical Row Audit state
  const [auditRows, setAuditRows] = useState<SourceRowAuditDTO[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditRowType, setAuditRowType] = useState('ALL');
  const [auditPrecisionOnly, setAuditPrecisionOnly] = useState(false);
  const [auditSearch, setAuditSearch] = useState('');
  const [loadingAudit, setLoadingAudit] = useState(false);

  useEffect(() => {
    if (initialUploadId) setSelectedUploadId(initialUploadId);
  }, [initialUploadId]);

  const loadUploads = useCallback(async () => {
    try {
      const res = await apiRequest<{ items: UploadDTO[] }>('/api/v1/uploads?pageSize=50');
      setUploads(res.items);
      if (res.items.length > 0) {
        const processed = res.items.find((u) => u.status === 'PROCESSED') || res.items[0];
        setSelectedUploadId((prev) => prev || processed.id);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load uploads');
    }
  }, []);

  useEffect(() => {
    void loadUploads();
  }, [loadUploads]);

  const loadSummary = useCallback(async () => {
    if (!selectedUploadId) {
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await apiRequest<GeoUploadSummaryDTO>(`/api/v1/geo/uploads/${selectedUploadId}/summary`);
      setSummary(res);
      setIncludeHiddenRows(res.upload.include_hidden_rows ?? true);
      if (res.areas.length > 0) {
        setExpandedAreas((prev) => (prev.size === 0 ? new Set([res.areas[0].areaKey]) : prev));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load geographic breakdown');
    } finally {
      setLoading(false);
    }
  }, [selectedUploadId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const loadAuditRows = useCallback(async () => {
    if (!selectedUploadId || activeTab !== 'audit') return;
    setLoadingAudit(true);
    try {
      const qs = new URLSearchParams({
        page: String(auditPage),
        pageSize: '80',
      });
      if (auditRowType !== 'ALL') qs.set('rowType', auditRowType);
      if (auditPrecisionOnly) qs.set('precisionLoss', 'true');
      if (auditSearch.trim()) qs.set('search', auditSearch.trim());
      const res = await apiRequest<{ items: SourceRowAuditDTO[]; total: number }>(
        `/api/v1/geo/uploads/${selectedUploadId}/rows?${qs.toString()}`
      );
      setAuditRows(res.items);
      setAuditTotal(res.total);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load physical row audit');
    } finally {
      setLoadingAudit(false);
    }
  }, [selectedUploadId, activeTab, auditPage, auditRowType, auditPrecisionOnly, auditSearch]);

  useEffect(() => {
    void loadAuditRows();
  }, [loadAuditRows]);

  const toggleArea = (areaKey: string) => {
    setExpandedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(areaKey)) next.delete(areaKey);
      else next.add(areaKey);
      return next;
    });
  };

  const toggleStreetRecords = async (areaKey: string, streetGroup: string) => {
    const key = `${areaKey}::${streetGroup}`;
    if (expandedStreets.has(key)) {
      setExpandedStreets((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setLoadingStreetKey(key);
    try {
      const qs = new URLSearchParams({
        uploadId: selectedUploadId,
        area: areaKey,
        streetGroup,
        pageSize: '200',
      });
      const res = await apiRequest<{ items: CleanRecordDTO[] }>(`/api/v1/records?${qs.toString()}`);
      setExpandedStreets((prev) => {
        const next = new Map(prev);
        next.set(key, res.items);
        return next;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load street records');
    } finally {
      setLoadingStreetKey(null);
    }
  };

  const reloadExpandedStreets = async () => {
    const keys = Array.from(expandedStreets.keys());
    if (keys.length === 0) return;
    try {
      const next = new Map<string, CleanRecordDTO[]>();
      for (const k of keys) {
        const sep = k.indexOf('::');
        if (sep === -1) continue;
        const areaKey = k.slice(0, sep);
        const streetGroup = k.slice(sep + 2);
        const qs = new URLSearchParams({
          uploadId: selectedUploadId,
          area: areaKey,
          streetGroup,
          pageSize: '200',
        });
        const res = await apiRequest<{ items: CleanRecordDTO[] }>(`/api/v1/records?${qs.toString()}`);
        next.set(k, res.items);
      }
      setExpandedStreets(next);
    } catch {
      // Non-fatal street refresh error
    }
  };

  const triggerExport = async (
    exportMode: 'AREA_WISE' | 'COMBINED_ZIP',
    filters: { area?: string } = {}
  ) => {
    if (!selectedUploadId) return;
    const dlKey = filters.area || '__ALL_ZIP__';
    setDownloadingKey(dlKey);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const completed = await generateAndDownloadExport({
        exportMode,
        filters: {
          uploadId: selectedUploadId,
          ...filters,
        },
        onUpdate: (rec) => setActiveExport(rec),
      });
      setStatusMsg(`Downloaded "${completed.filename}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Export request failed');
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleReprocess = async () => {
    if (!selectedUploadId) return;
    setReprocessing(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const queued = await apiRequest<{ job?: { id: string }; jobs?: Array<{ id: string }> }>(
        `/api/v1/geo/uploads/${selectedUploadId}/reprocess`,
        {
          method: 'POST',
          body: JSON.stringify({ includeHiddenRows }),
        }
      );
      const jobIds = (queued.jobs?.length ? queued.jobs : queued.job ? [queued.job] : []).map((j) => j.id);
      setStatusMsg(
        `Queued geographic reprocessing (${jobIds.length || 1} job${jobIds.length === 1 ? '' : 's'}). Waiting for completion...`
      );

      let failedMsg: string | null = null;
      if (jobIds.length > 0) {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1200));
          const checks = await Promise.all(
            jobIds.map((id) =>
              apiRequest<{ job: { status: string; error_summary?: string | null } }>(`/api/v1/jobs/${id}`)
            )
          );
          const pending = checks.some((c) => ['QUEUED', 'RUNNING'].includes(c.job.status));
          const failed = checks.find((c) => c.job.status === 'FAILED_DEAD_LETTER');
          if (failed) {
            failedMsg = failed.job.error_summary || 'Reprocessing job failed.';
          }
          if (!pending) break;
        }
      }

      if (failedMsg) {
        setErrorMsg(failedMsg);
      } else {
        setStatusMsg('Geographic classification reprocessing completed.');
      }
      await loadSummary();
      await reloadExpandedStreets();
      if (activeTab === 'audit') {
        await loadAuditRows();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Reprocess failed');
    } finally {
      setReprocessing(false);
    }
  };

  const handleSaveRecordEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord) return;
    try {
      await apiRequest(`/api/v1/geo/records/${editingRecord.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          area: editForm.area.trim() || null,
          subArea: editForm.subArea.trim() || null,
          street: editForm.street.trim() || null,
          streetGroup: editForm.streetGroup.trim() || 'UNIDENTIFIED',
          approveClassification: editForm.approveClassification,
          saveAliasToDictionary: editForm.saveAliasToDictionary,
        }),
      });
      setEditingRecord(null);
      setStatusMsg('Record classification updated & audited.');
      await loadSummary();
      await reloadExpandedStreets();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save classification');
    }
  };

  const handleApproveQuick = async (recordId: string) => {
    try {
      await apiRequest(`/api/v1/geo/records/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ approveClassification: true }),
      });
      await loadSummary();
      await reloadExpandedStreets();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Approval failed');
    }
  };

  const handleMergeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUploadId) return;
    const sources = mergeForm.sourceLabelsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (sources.length === 0 || !mergeForm.targetLabel.trim()) return;
    try {
      const res = await apiRequest<{ updatedCount: number }>('/api/v1/geo/groups/rename-merge', {
        method: 'POST',
        body: JSON.stringify({
          uploadId: selectedUploadId,
          level: mergeForm.level,
          parentArea: mergeForm.parentArea.trim() || null,
          sourceLabels: sources,
          targetLabel: mergeForm.targetLabel.trim(),
          saveDictionaryAlias: mergeForm.saveDictionaryAlias,
        }),
      });
      setMergeModalOpen(false);
      setMergeForm((prev) => ({ ...prev, sourceLabelsText: '', targetLabel: '' }));
      setStatusMsg(`Updated ${res.updatedCount} customer records to "${mergeForm.targetLabel.trim()}".`);
      await loadSummary();
      await reloadExpandedStreets();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Merge/rename failed');
    }
  };

  const handleSplitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUploadId || selectedRecordIds.size === 0 || !splitForm.targetStreetGroup.trim()) return;
    try {
      const targetStreet = splitForm.targetStreetGroup.trim();
      const res = await apiRequest<{ updatedCount: number }>('/api/v1/geo/groups/split', {
        method: 'POST',
        body: JSON.stringify({
          uploadId: selectedUploadId,
          recordIds: Array.from(selectedRecordIds),
          targetArea: splitForm.targetArea.trim() ? splitForm.targetArea.trim() : undefined,
          targetSubArea: splitForm.targetSubArea.trim() ? splitForm.targetSubArea.trim() : undefined,
          targetStreetGroup: targetStreet,
        }),
      });
      setSplitModalOpen(false);
      setSplitForm({ targetArea: '', targetSubArea: '', targetStreetGroup: '' });
      setSelectedRecordIds(new Set());
      setStatusMsg(`Moved ${res.updatedCount} customer records into "${targetStreet}".`);
      await loadSummary();
      await reloadExpandedStreets();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Split operation failed');
    }
  };

  const recon = summary?.reconciliation;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Navy Brand Header Card */}
      <div className="rounded-xl bg-[#0B2545] text-white p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-200">
            <MapPin className="w-3.5 h-3.5" />
            Areas & Street Breakdown
          </div>
          <h1 className="text-xl font-bold mt-1">Areas & Downloads</h1>
          <p className="text-xs text-slate-300 mt-1">
            Browse each Area and its streets, fix any misclassified rows, and download Excel files in one click.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Select dataset batch"
            value={selectedUploadId}
            onChange={(e) => {
              setExpandedAreas(new Set());
              setExpandedStreets(new Map());
              setSelectedRecordIds(new Set());
              setActiveExport(null);
              setStatusMsg(null);
              setAuditPage(1);
              setAuditRows([]);
              setAreaSearch('');
              setSelectedUploadId(e.target.value);
            }}
            className="px-3 py-2 text-xs rounded-lg bg-slate-900/70 border border-slate-600 text-white max-w-xs"
          >
            {uploads.length === 0 && <option value="">No uploads yet</option>}
            {uploads.map((u) => (
              <option key={u.id} value={u.id}>
                {u.original_filename} ({u.total_rows.toLocaleString()} rows · {u.status})
              </option>
            ))}
          </select>

          {hasPermission('export') && selectedUploadId && (
            <button
              type="button"
              disabled={downloadingKey !== null}
              onClick={() => void triggerExport('AREA_WISE')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer transition-colors whitespace-nowrap disabled:opacity-50"
            >
              <Archive className="w-4 h-4" />
              {downloadingKey === '__ALL_ZIP__' ? 'Preparing ZIP...' : 'Download All Areas (ZIP)'}
            </button>
          )}
        </div>
      </div>

      {/* Live Export Progress / Download Banner */}
      {activeExport && (
        <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/30 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1 flex-1 min-w-[260px]">
            <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-blue-600" />
              {activeExport.filename} · {activeExport.status} ({activeExport.progress ?? (activeExport.status === 'COMPLETED' ? 100 : 15)}%)
            </div>
            {activeExport.artifact_manifest && activeExport.status === 'COMPLETED' && (
              <div className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                {activeExport.artifact_manifest.areaWorkbookCount ?? 0} Area Workbooks Created ·{' '}
                {(activeExport.row_count || 0).toLocaleString()} Total Customers Exported ·{' '}
                {activeExport.artifact_manifest.needsReviewCount ?? 0} Needs Review ·{' '}
                {activeExport.artifact_manifest.unassignedAreaRecords ?? 0} Unassigned ·{' '}
                Reconciliation: {activeExport.artifact_manifest.reconciliation?.status || 'VERIFIED'}
              </div>
            )}
            {activeExport.error_message && activeExport.status === 'FAILED' && (
              <div className="text-xs text-red-600 dark:text-red-400">{activeExport.error_message}</div>
            )}
            {['QUEUED', 'RUNNING'].includes(activeExport.status) && (
              <div className="w-full max-w-md h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden mt-1.5">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${activeExport.progress ?? 25}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeExport.status === 'COMPLETED' && (
              <button
                type="button"
                onClick={() =>
                  void downloadAuthenticatedFile(`/api/v1/exports/${activeExport.id}/download`, activeExport.filename)
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                {activeExport.is_zip ? 'Download All as ZIP' : 'Download Area Workbook'}
              </button>
            )}
            {onGoToExports && selectedUploadId && (
              <button
                type="button"
                onClick={() => onGoToExports(selectedUploadId)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-900 cursor-pointer"
              >
                Exports Center
              </button>
            )}
          </div>
        </div>
      )}

      {errorMsg && (
        <div role="alert" className="p-3.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-300">
          {statusMsg}
        </div>
      )}

      {/* Reconciliation KPI Grid */}
      {recon && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] font-medium text-slate-500">Physical Excel Rows</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
              {recon.totalPhysicalRows.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              {recon.SECTION_HEADING} headings · {recon.EMPTY_SEPARATOR} blank
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] font-medium text-slate-500">Customer Records</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
              {recon.totalCustomerRecords.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              100% reconciled
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] font-medium text-slate-500">Areas Detected</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
              {recon.distinctAreasCount}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              {recon.unassignedAreaCount} unassigned
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] font-medium text-slate-500">Street / Locality Groups</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
              {recon.distinctStreetGroupsCount}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              {recon.unidentifiedStreetCount} unidentified
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] font-medium text-slate-500">Needs Review / Conflicts</div>
            <div className="text-lg font-bold text-amber-600 dark:text-amber-400 mt-0.5 tabular-nums">
              {recon.reviewRequiredCount.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              {recon.conflictCount} heading conflicts
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
            <div className="text-[11px] font-medium text-slate-500">Precision-Loss Alerts</div>
            <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
              {recon.precisionLossRows.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
              Header Row #{summary?.upload.header_row_number ?? 1}
            </div>
          </div>
        </div>
      )}

      {/* Tabs + Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('hierarchy')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg cursor-pointer ${
              activeTab === 'hierarchy'
                ? 'bg-[#0B2545] text-white'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Area & Street Hierarchy ({summary?.areas.length ?? 0})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg cursor-pointer ${
              activeTab === 'audit'
                ? 'bg-[#0B2545] text-white'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            <Table2 className="w-3.5 h-3.5" />
            Physical Row Audit ({recon?.totalPhysicalRows.toLocaleString() ?? 0})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedRecordIds.size > 0 && hasPermission('edit') && (
            <button
              type="button"
              onClick={() => setSplitModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5" />
              Split / Reassign {selectedRecordIds.size} Selected
            </button>
          )}
          {hasPermission('edit') && selectedUploadId && (
            <button
              type="button"
              onClick={() => setMergeModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <GitMerge className="w-3.5 h-3.5 text-blue-600" />
              Merge / Rename Groups
            </button>
          )}
          {hasPermission('process') && selectedUploadId && (
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeHiddenRows}
                  onChange={(e) => setIncludeHiddenRows(e.target.checked)}
                />
                Include hidden rows
              </label>
              <button
                type="button"
                disabled={reprocessing}
                onClick={() => void handleReprocess()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reprocessing ? 'animate-spin' : ''}`} />
                Re-Classify
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tab 1: Dynamic Area -> Street Hierarchy */}
      {activeTab === 'hierarchy' && (
        <div className="space-y-3">
          {summary && summary.areas.length > 4 && (
            <div className="relative max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={areaSearch}
                onChange={(e) => setAreaSearch(e.target.value)}
                placeholder={`Filter ${summary.areas.length} areas...`}
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          )}

          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading geographic hierarchy...</div>
          ) : !summary || summary.areas.length === 0 ? (
            <div className="p-8 text-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-500">
              No processed records found for this upload yet. Upload and process a file in Upload &amp; Convert first.
            </div>
          ) : (
            summary.areas
              .filter((a) => !areaSearch.trim() || a.areaName.toLowerCase().includes(areaSearch.trim().toLowerCase()))
              .map((area: GeoAreaItem) => {
              const isOpen = expandedAreas.has(area.areaKey);
              return (
                <section
                  key={area.areaKey}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
                >
                  <div className="px-4 py-3.5 bg-[#0B2545]/5 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => toggleArea(area.areaKey)}
                      className="flex items-center gap-2.5 text-left cursor-pointer"
                    >
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-500" />
                      )}
                      <span className="text-sm font-bold text-slate-900 dark:text-white">
                        {area.areaName}
                      </span>
                      <span className="text-xs font-mono-tabular text-blue-700 dark:text-blue-300 font-semibold">
                        {area.totalCount.toLocaleString()} customers
                      </span>
                      <span className="text-xs text-slate-500 tabular-nums">
                        · {area.streetGroups.filter((s) => s.streetGroup !== 'UNIDENTIFIED').length} streets
                      </span>
                      {area.needsReviewCount > 0 && (
                        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                          · {area.needsReviewCount} review
                        </span>
                      )}
                    </button>

                    <div className="flex items-center gap-2">
                      {onOpenReviewForGroup && (
                        <button
                          type="button"
                          onClick={() => onOpenReviewForGroup(selectedUploadId, area.areaKey)}
                          className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          Review Rows
                        </button>
                      )}
                      {hasPermission('export') && (
                        <button
                          type="button"
                          disabled={downloadingKey !== null}
                          onClick={() => void triggerExport('AREA_WISE', { area: area.areaKey })}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white cursor-pointer disabled:opacity-50 whitespace-nowrap"
                        >
                          <Download className="w-3 h-3" />
                          {downloadingKey === area.areaKey ? 'Preparing...' : 'Download .xlsx'}
                        </button>
                      )}
                    </div>
                  </div>

                  {isOpen && (
                    <div className="divide-y divide-slate-200 dark:divide-slate-800">
                      {area.streetGroups.map((sg) => {
                        const sKey = `${area.areaKey}::${sg.streetGroup}`;
                        const streetRecords = expandedStreets.get(sKey);
                        const isStreetOpen = Boolean(streetRecords);
                        return (
                          <div key={sg.streetGroup} className="p-4 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => void toggleStreetRecords(area.areaKey, sg.streetGroup)}
                                className="flex items-center gap-2 text-left cursor-pointer"
                              >
                                {isStreetOpen ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                                )}
                                <span
                                  className={`text-xs font-semibold ${
                                    sg.streetGroup === 'UNIDENTIFIED'
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : 'text-slate-900 dark:text-white'
                                  }`}
                                >
                                  {sg.streetGroup}
                                </span>
                                <span className="text-[11px] font-mono-tabular px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                  {sg.groupType}
                                </span>
                                <span className="text-xs font-mono-tabular text-slate-600 dark:text-slate-300">
                                  ({sg.count.toLocaleString()})
                                </span>
                                {sg.conflictCount > 0 && (
                                  <span className="text-[11px] text-red-600 dark:text-red-400 font-medium inline-flex items-center gap-1">
                                    <AlertTriangle className="w-3 h-3" />
                                    {sg.conflictCount} conflict
                                  </span>
                                )}
                                {sg.reviewRequiredCount > 0 && sg.conflictCount === 0 && (
                                  <span className="text-[11px] text-amber-600 dark:text-amber-400">
                                    · {sg.reviewRequiredCount} review
                                  </span>
                                )}
                              </button>

                              <div className="flex items-center gap-2">
                                {loadingStreetKey === sKey && (
                                  <span className="text-xs text-slate-400">Loading rows...</span>
                                )}
                              </div>
                            </div>

                            {isStreetOpen && streetRecords && (
                              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                                <table className="w-full text-left border-collapse text-xs">
                                  <thead>
                                    <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                                      <th className="py-2 px-2.5 w-8">
                                        <input
                                          type="checkbox"
                                          aria-label="Select street rows"
                                          checked={
                                            streetRecords.length > 0 &&
                                            streetRecords.every((r) => selectedRecordIds.has(r.id))
                                          }
                                          onChange={(e) => {
                                            setSelectedRecordIds((prev) => {
                                              const next = new Set(prev);
                                              for (const r of streetRecords) {
                                                if (e.target.checked) next.add(r.id);
                                                else next.delete(r.id);
                                              }
                                              return next;
                                            });
                                          }}
                                        />
                                      </th>
                                      <th className="py-2 px-2.5">Row #</th>
                                      <th className="py-2 px-2.5">Consumer ID</th>
                                      <th className="py-2 px-2.5">Customer Name</th>
                                      <th className="py-2 px-2.5">Phone</th>
                                      <th className="py-2 px-2.5">Street / Address</th>
                                      <th className="py-2 px-2.5">Geo Status & Notes</th>
                                      <th className="py-2 px-2.5 text-right">Actions</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                                    {streetRecords.map((rec) => (
                                      <tr key={rec.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                        <td className="py-2 px-2.5">
                                          <input
                                            type="checkbox"
                                            checked={selectedRecordIds.has(rec.id)}
                                            onChange={(e) => {
                                              setSelectedRecordIds((prev) => {
                                                const next = new Set(prev);
                                                if (e.target.checked) next.add(rec.id);
                                                else next.delete(rec.id);
                                                return next;
                                              });
                                            }}
                                          />
                                        </td>
                                        <td className="py-2 px-2.5 font-mono-tabular text-slate-400">
                                          {rec.original_row_number || rec.row_number}
                                        </td>
                                        <td className="py-2 px-2.5 font-mono-tabular text-slate-700 dark:text-slate-300">
                                          {rec.consumer_id || '—'}
                                        </td>
                                        <td className="py-2 px-2.5 font-medium text-slate-900 dark:text-white">
                                          {rec.full_name || '—'}
                                        </td>
                                        <td className="py-2 px-2.5 font-mono-tabular text-slate-600 dark:text-slate-300">
                                          {rec.phone_display || rec.phone_e164 || '—'}
                                        </td>
                                        <td className="py-2 px-2.5 text-slate-600 dark:text-slate-300 max-w-xs truncate">
                                          {rec.street || rec.sub_area || Object.values(rec.raw_data || {}).join(', ')}
                                        </td>
                                        <td className="py-2 px-2.5">
                                          <div className="flex flex-col">
                                            <span
                                              className={`font-semibold ${
                                                rec.geographic_review_status === 'CONFLICT'
                                                  ? 'text-red-600 dark:text-red-400'
                                                  : rec.geographic_review_status === 'NEEDS_REVIEW' ||
                                                      rec.geographic_review_status === 'UNIDENTIFIED'
                                                    ? 'text-amber-600 dark:text-amber-400'
                                                    : 'text-emerald-600 dark:text-emerald-400'
                                              }`}
                                            >
                                              {rec.geographic_review_status || 'AUTO'} · {rec.classification_source || 'RULE'}
                                            </span>
                                            {rec.geographic_conflict_reason && (
                                              <span className="text-[11px] text-slate-500 max-w-xs truncate">
                                                {rec.geographic_conflict_reason}
                                              </span>
                                            )}
                                          </div>
                                        </td>
                                        <td className="py-2 px-2.5 text-right whitespace-nowrap space-x-2">
                                          {hasPermission('edit') && (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setEditingRecord(rec);
                                                setEditForm({
                                                  area: rec.area || '',
                                                  subArea: rec.sub_area || '',
                                                  street: rec.street || '',
                                                  streetGroup: rec.street_group || '',
                                                  approveClassification: true,
                                                  saveAliasToDictionary: true,
                                                });
                                              }}
                                              className="text-blue-600 dark:text-blue-400 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                                            >
                                              <Edit3 className="w-3 h-3" />
                                              Edit
                                            </button>
                                          )}
                                          {hasPermission('approve') &&
                                            rec.geographic_review_status !== 'APPROVED' && (
                                              <button
                                                type="button"
                                                onClick={() => void handleApproveQuick(rec.id)}
                                                className="text-emerald-600 dark:text-emerald-400 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                                              >
                                                <Check className="w-3 h-3" />
                                                Approve
                                              </button>
                                            )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
      )}

      {/* Tab 2: Physical Row Audit */}
      {activeTab === 'audit' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={auditRowType}
                onChange={(e) => {
                  setAuditRowType(e.target.value);
                  setAuditPage(1);
                }}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              >
                <option value="ALL">All Physical Row Types</option>
                <option value="COLUMN_HEADER">COLUMN_HEADER</option>
                <option value="SECTION_HEADING">SECTION_HEADING</option>
                <option value="CUSTOMER_RECORD">CUSTOMER_RECORD</option>
                <option value="EMPTY_SEPARATOR">EMPTY_SEPARATOR</option>
                <option value="SUBTOTAL_OR_REPORT_ROW">SUBTOTAL_OR_REPORT_ROW</option>
                <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
                <option value="INVALID_RECORD">INVALID_RECORD</option>
              </select>

              <input
                type="search"
                value={auditSearch}
                onChange={(e) => {
                  setAuditSearch(e.target.value);
                  setAuditPage(1);
                }}
                placeholder="Search physical rows or headings..."
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 w-56"
              />

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={auditPrecisionOnly}
                  onChange={(e) => {
                    setAuditPrecisionOnly(e.target.checked);
                    setAuditPage(1);
                  }}
                />
                Precision loss only
              </label>
            </div>

            <div className="text-xs text-slate-500 tabular-nums">
              {auditTotal.toLocaleString()} physical rows matching filter
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2.5 px-3">Row #</th>
                  <th className="py-2.5 px-3">Classification</th>
                  <th className="py-2.5 px-3">Format Signals</th>
                  <th className="py-2.5 px-3">Active Heading</th>
                  <th className="py-2.5 px-3">Area · Street Group</th>
                  <th className="py-2.5 px-3">Raw Cell Values</th>
                  <th className="py-2.5 px-3">Detection / Conflict Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {loadingAudit ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Loading physical rows...
                    </td>
                  </tr>
                ) : auditRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No physical rows match this filter.
                    </td>
                  </tr>
                ) : (
                  auditRows.map((sr) => (
                    <tr key={sr.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                      <td className="py-2 px-3 font-mono-tabular text-slate-500">{sr.physical_row_number}</td>
                      <td className="py-2 px-3 font-semibold whitespace-nowrap">
                        <span
                          className={
                            sr.row_type === 'SECTION_HEADING'
                              ? 'text-blue-700 dark:text-blue-400'
                              : sr.row_type === 'SUBTOTAL_OR_REPORT_ROW'
                                ? 'text-slate-500'
                                : sr.row_type === 'NEEDS_REVIEW' || sr.row_type === 'INVALID_RECORD'
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-slate-900 dark:text-white'
                          }
                        >
                          {sr.row_type}
                        </span>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap text-[11px] text-slate-500">
                        {[
                          sr.format_meta?.isBoldRow ? 'Bold' : null,
                          sr.format_meta?.isMergedRow ? 'Merged' : null,
                          sr.format_meta?.isHidden ? 'Hidden' : null,
                          sr.precision_loss_detected ? 'PrecisionLoss' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                      <td className="py-2 px-3 text-slate-700 dark:text-slate-300 max-w-[180px] truncate">
                        {sr.active_section_heading || '—'}
                      </td>
                      <td className="py-2 px-3 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {[sr.detected_area || '—', sr.street_group || '—'].join(' · ')}
                      </td>
                      <td className="py-2 px-3 text-slate-600 dark:text-slate-300 max-w-xs truncate">
                        {Object.entries(sr.raw_cells || {})
                          .filter(([, v]) => String(v || '').trim() !== '')
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' | ') || '(empty row)'}
                      </td>
                      <td className="py-2 px-3 text-slate-500 max-w-xs truncate">
                        {sr.conflict_reason || sr.heading_detection_reason || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <div>Page {auditPage}</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={auditPage <= 1}
                onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={auditPage * 80 >= auditTotal}
                onClick={() => setAuditPage((p) => p + 1)}
                className="px-3 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Inline Record Geo Edit Modal */}
      {editingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setEditingRecord(null)} />
          <form
            onSubmit={handleSaveRecordEdit}
            className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-md space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">
                Edit Geographic Classification · Row #{editingRecord.original_row_number || editingRecord.row_number}
              </h2>
              <button type="button" onClick={() => setEditingRecord(null)} aria-label="Close modal">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Area</label>
                <input
                  type="text"
                  value={editForm.area}
                  onChange={(e) => setEditForm({ ...editForm, area: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">SubArea / Locality</label>
                <input
                  type="text"
                  value={editForm.subArea}
                  onChange={(e) => setEditForm({ ...editForm, subArea: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Street / Door No</label>
                <input
                  type="text"
                  value={editForm.street}
                  onChange={(e) => setEditForm({ ...editForm, street: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Street / Locality Group</label>
                <input
                  type="text"
                  value={editForm.streetGroup}
                  onChange={(e) => setEditForm({ ...editForm, streetGroup: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editForm.approveClassification}
                  onChange={(e) => setEditForm({ ...editForm, approveClassification: e.target.checked })}
                />
                Approve classification immediately
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer block">
                <input
                  type="checkbox"
                  checked={editForm.saveAliasToDictionary}
                  onChange={(e) => setEditForm({ ...editForm, saveAliasToDictionary: e.target.checked })}
                />
                Save street alias to project dictionary
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingRecord(null)}
                className="px-3.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
              >
                Save Classification
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Merge / Rename Groups Modal */}
      {mergeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setMergeModalOpen(false)} />
          <form
            onSubmit={handleMergeSubmit}
            className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-md space-y-4 text-xs"
          >
            <h2 className="text-sm font-bold">Rename or Merge Equivalent Area / Street Groups</h2>
            <p className="text-slate-500">
              Only merge labels you explicitly confirm are equivalent (never merges distinct numbered streets automatically).
            </p>
            <div>
              <label className="block font-medium mb-1">Hierarchy Level</label>
              <select
                value={mergeForm.level}
                onChange={(e) => setMergeForm({ ...mergeForm, level: e.target.value as 'AREA' | 'STREET_GROUP' })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="STREET_GROUP">Street / Locality Group</option>
                <option value="AREA">Area</option>
              </select>
            </div>
            {mergeForm.level === 'STREET_GROUP' && (
              <div>
                <label className="block font-medium mb-1">Parent Area (optional scope)</label>
                <input
                  type="text"
                  placeholder="Leave empty for all areas"
                  value={mergeForm.parentArea}
                  onChange={(e) => setMergeForm({ ...mergeForm, parentArea: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            )}
            <div>
              <label className="block font-medium mb-1">Source Labels (comma-separated)</label>
              <input
                type="text"
                required
                placeholder="e.g. Gandhi St, Gandhi Street"
                value={mergeForm.sourceLabelsText}
                onChange={(e) => setMergeForm({ ...mergeForm, sourceLabelsText: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Target Canonical Label</label>
              <input
                type="text"
                required
                placeholder="e.g. Gandhi Street"
                value={mergeForm.targetLabel}
                onChange={(e) => setMergeForm({ ...mergeForm, targetLabel: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={mergeForm.saveDictionaryAlias}
                onChange={(e) => setMergeForm({ ...mergeForm, saveDictionaryAlias: e.target.checked })}
              />
              Save approved aliases to dictionary
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMergeModalOpen(false)}
                className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
              >
                Apply Merge / Rename
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Split Selected Records Modal */}
      {splitModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setSplitModalOpen(false)} />
          <form
            onSubmit={handleSplitSubmit}
            className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-md space-y-4 text-xs"
          >
            <h2 className="text-sm font-bold">Split / Reassign {selectedRecordIds.size} Selected Records</h2>
            <div>
              <label className="block font-medium mb-1">Target Area (optional, blank keeps existing)</label>
              <input
                type="text"
                value={splitForm.targetArea}
                onChange={(e) => setSplitForm({ ...splitForm, targetArea: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Target SubArea / Locality (optional)</label>
              <input
                type="text"
                value={splitForm.targetSubArea}
                onChange={(e) => setSplitForm({ ...splitForm, targetSubArea: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Target Street / Locality Group</label>
              <input
                type="text"
                required
                value={splitForm.targetStreetGroup}
                onChange={(e) => setSplitForm({ ...splitForm, targetStreetGroup: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSplitModalOpen(false)}
                className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
              >
                Split Into Group
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
