import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, CheckCircle2, Download, FileSpreadsheet } from 'lucide-react';
import { apiRequest, downloadAuthenticatedFile, generateAndDownloadExport } from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { ExportDTO, ExportMode, GeoAreaItem, GeoUploadSummaryDTO, UploadDTO } from '../../types/api.ts';

const ALL_COLUMNS = [
  { key: 'consumer_id', label: 'Consumer ID' },
  { key: 'full_name', label: 'Customer Name' },
  { key: 'phone_e164', label: 'Phone (E.164)' },
  { key: 'phone_display', label: 'Phone (Display)' },
  { key: 'street', label: 'Street' },
  { key: 'sub_area', label: 'SubArea / Locality' },
  { key: 'area', label: 'Area' },
  { key: 'street_group', label: 'Street / Locality Group' },
  { key: 'city', label: 'City' },
  { key: 'district', label: 'District' },
  { key: 'state', label: 'State' },
  { key: 'pin_code', label: 'PIN Code' },
  { key: 'status', label: 'Review Status' },
  { key: 'overall_confidence', label: 'Confidence Score' },
  { key: 'provenance', label: 'Field Provenance JSON' },
  { key: 'issues', label: 'Validation Issues' },
];

export function ExportsView({ initialUploadId }: { initialUploadId?: string }) {
  const { hasPermission } = useAuth();
  const [exportsList, setExportsList] = useState<ExportDTO[]>([]);
  const [uploads, setUploads] = useState<UploadDTO[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState<string>(initialUploadId || '');
  const didAutoSelectRef = useRef(Boolean(initialUploadId));
  const [exportMode, setExportMode] = useState<ExportMode>('ROUTE_XLSX');
  const [splitBy, setSplitBy] = useState<'NONE' | 'CITY' | 'DISTRICT' | 'STATE' | 'CATEGORY'>('CITY');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [areaFilter, setAreaFilter] = useState('');
  const [geoAreas, setGeoAreas] = useState<GeoAreaItem[]>([]);
  const [includeOriginal, setIncludeOriginal] = useState(true);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([
    'consumer_id',
    'full_name',
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
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (initialUploadId !== undefined) {
      didAutoSelectRef.current = true;
      setSelectedUploadId(initialUploadId);
    }
  }, [initialUploadId]);

  const loadExports = useCallback(async () => {
    try {
      const [expRes, upRes] = await Promise.all([
        apiRequest<{ items: ExportDTO[] }>('/api/v1/exports'),
        apiRequest<{ items: UploadDTO[] }>('/api/v1/uploads?pageSize=100'),
      ]);
      setExportsList(expRes.items);
      setUploads(upRes.items);
      if (!didAutoSelectRef.current && upRes.items.length > 0) {
        didAutoSelectRef.current = true;
        const processed = upRes.items.find((u) => u.status === 'PROCESSED');
        if (processed) setSelectedUploadId(processed.id);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load exports list');
    }
  }, []);

  const refreshExportsOnly = useCallback(async () => {
    try {
      const expRes = await apiRequest<{ items: ExportDTO[] }>('/api/v1/exports');
      setExportsList(expRes.items);
    } catch {
      // Ignore transient poll error
    }
  }, []);

  useEffect(() => {
    void loadExports();
  }, [loadExports]);

  const hasActiveExport = exportsList.some((e) => e.status === 'QUEUED' || e.status === 'RUNNING');
  useEffect(() => {
    if (!hasActiveExport) return;
    const timer = setInterval(() => {
      void refreshExportsOnly();
    }, 2500);
    return () => clearInterval(timer);
  }, [hasActiveExport, refreshExportsOnly]);

  // Load Area choices when a specific upload is chosen
  useEffect(() => {
    if (!selectedUploadId) {
      setGeoAreas([]);
      setAreaFilter('');
      return;
    }
    void apiRequest<GeoUploadSummaryDTO>(`/api/v1/geo/uploads/${selectedUploadId}/summary`)
      .then((res) => setGeoAreas(res.areas || []))
      .catch(() => setGeoAreas([]));
  }, [selectedUploadId]);

  const moveColumn = (idx: number, dir: -1 | 1) => {
    const next = [...selectedColumns];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setSelectedColumns(next);
  };

  const toggleColumn = (key: string) => {
    setSelectedColumns((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const triggerAreaExport = async (specificAreaKey?: string) => {
    setSubmitting(true);
    setDownloadingKey(specificAreaKey || '__MAIN__');
    setErrorMsg(null);
    try {
      await generateAndDownloadExport({
        exportMode: specificAreaKey ? 'AREA_WISE' : exportMode,
        splitBy: !specificAreaKey && exportMode === 'SINGLE_XLSX' ? splitBy : 'NONE',
        includeOriginalSheet: includeOriginal,
        columnOrder: selectedColumns,
        filters: {
          uploadId: selectedUploadId || undefined,
          status: statusFilter !== 'ALL' ? statusFilter : undefined,
          area: specificAreaKey || (exportMode === 'AREA_WISE' && areaFilter ? areaFilter : undefined),
        },
        onUpdate: () => {
          void loadExports();
        },
      });
      await loadExports();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate & download export');
    } finally {
      setSubmitting(false);
      setDownloadingKey(null);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    await triggerAreaExport();
  };

  const latestCompletedBundle =
    exportsList.find(
      (ex) =>
        ex.status === 'COMPLETED' &&
        (ex.export_mode === 'ROUTE_XLSX' || ex.export_mode === 'AREA_WISE' || ex.export_mode === 'COMBINED_ZIP') &&
        ex.artifact_manifest?.areaWorkbookCount !== undefined &&
        (!selectedUploadId || ex.filters?.uploadId === selectedUploadId)
    ) ||
    exportsList.find(
      (ex) =>
        ex.status === 'COMPLETED' &&
        (ex.export_mode === 'ROUTE_XLSX' || ex.export_mode === 'AREA_WISE' || ex.export_mode === 'COMBINED_ZIP') &&
        ex.artifact_manifest?.areaWorkbookCount !== undefined
    );
  const latestManifest = latestCompletedBundle?.artifact_manifest || null;
  const areaBreakdownList: Array<{
    areaName: string;
    filePath: string;
    customerCount: number;
    streetGroupCount: number;
    unidentifiedCount: number;
    needsReviewCount: number;
  }> = Array.isArray(latestManifest?.areaBreakdown) ? latestManifest.areaBreakdown : [];

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="rounded-xl bg-[#0B2545] text-white p-5">
        <h1 className="text-xl font-bold">Area-Wise Structured Excel & ZIP Exports</h1>
        <p className="text-xs text-slate-300 mt-1">
          One workbook per distinct Area containing all grouped Street/Locality sections inside STRUCTURED_DATA, machine-readable ALL_RECORDS, SUMMARY, and optional NEEDS_REVIEW.
        </p>
      </div>

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {hasPermission('export') && (
        <form
          onSubmit={handleGenerate}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5"
        >
          {/* Mode Selector Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {(
              [
                {
                  id: 'ROUTE_XLSX',
                  title: 'Route-Optimized All-in-One Excel',
                  desc: 'Single .xlsx placing all Areas & Streets one below another by nearest proximity',
                },
                {
                  id: 'AREA_WISE',
                  title: 'Area-Wise Workbooks',
                  desc: 'One .xlsx per Area with grouped Street sections inside (ZIP bundle or single Area)',
                },
                {
                  id: 'COMBINED_ZIP',
                  title: 'Complete Audit ZIP',
                  desc: 'Area workbooks + AREA_SUMMARY, PROCESSING_REPORT, NEEDS_REVIEW & ROW_AUDIT',
                },
                {
                  id: 'SINGLE_XLSX',
                  title: 'Single Consolidated Workbook',
                  desc: 'All records in Master Data + optional split sheets',
                },
                {
                  id: 'CSV',
                  title: 'UTF-8 CSV',
                  desc: 'BOM-safe CSV preserving all selected columns',
                },
              ] as Array<{ id: ExportMode; title: string; desc: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setExportMode(m.id)}
                className={`text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                  exportMode === m.id
                    ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-950'
                }`}
              >
                <div className="text-xs font-bold text-slate-900 dark:text-white">{m.title}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{m.desc}</div>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Dataset Batch</label>
              <select
                value={selectedUploadId}
                onChange={(e) => setSelectedUploadId(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">All Processed Uploads</option>
                {uploads.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.original_filename} ({u.total_rows.toLocaleString()})
                  </option>
                ))}
              </select>
            </div>

            {exportMode === 'AREA_WISE' && geoAreas.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Target Area (Optional)
                </label>
                <select
                  value={areaFilter}
                  onChange={(e) => setAreaFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="">All Valid Areas (ZIP Package)</option>
                  {geoAreas
                    .filter((a) => !a.isUnassigned)
                    .map((a) => (
                      <option key={a.areaKey} value={a.areaKey}>
                        {a.areaName} ({a.totalCount})
                      </option>
                    ))}
                </select>
              </div>
            )}

            {exportMode === 'SINGLE_XLSX' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Worksheet Split Mode
                </label>
                <select
                  value={splitBy}
                  onChange={(e) => setSplitBy(e.target.value as any)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="NONE">Master Sheet Only</option>
                  <option value="CITY">Separate Sheets by City</option>
                  <option value="DISTRICT">Separate Sheets by District</option>
                  <option value="STATE">Separate Sheets by State</option>
                  <option value="CATEGORY">Separate Sheets by Category</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                Record Status Scope
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="ALL">All Non-Merged Records</option>
                <option value="APPROVED">Approved Only</option>
                <option value="VERIFIED">Verified Only</option>
                <option value="NEEDS_REVIEW">Needs Review</option>
              </select>
            </div>

            {exportMode === 'SINGLE_XLSX' && (
              <div className="flex items-end pb-2">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeOriginal}
                    onChange={(e) => setIncludeOriginal(e.target.checked)}
                  />
                  Include Original Data sheet
                </label>
              </div>
            )}
          </div>

          {(exportMode === 'SINGLE_XLSX' || exportMode === 'CSV') && (
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Column Selection & Order
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {selectedColumns.map((colKey, idx) => {
                  const def = ALL_COLUMNS.find((c) => c.key === colKey);
                  return (
                    <div
                      key={colKey}
                      className="flex items-center justify-between px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs"
                    >
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked onChange={() => toggleColumn(colKey)} />
                        <span>{def?.label || colKey}</span>
                      </label>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => moveColumn(idx, -1)} className="p-0.5 hover:text-blue-600">
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" onClick={() => moveColumn(idx, 1)} className="p-0.5 hover:text-blue-600">
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {ALL_COLUMNS.filter((c) => !selectedColumns.includes(c.key)).map((c) => (
                  <div
                    key={c.key}
                    className="flex items-center px-3 py-1.5 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-xs text-slate-500"
                  >
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={false} onChange={() => toggleColumn(c.key)} />
                      <span>{c.label}</span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting || ((exportMode === 'SINGLE_XLSX' || exportMode === 'CSV') && selectedColumns.length === 0)}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {exportMode === 'COMBINED_ZIP' || (exportMode === 'AREA_WISE' && !areaFilter) ? (
                <Archive className="w-4 h-4" />
              ) : (
                <FileSpreadsheet className="w-4 h-4" />
              )}
              {downloadingKey === '__MAIN__'
                ? 'Preparing & Downloading...'
                : exportMode === 'ROUTE_XLSX'
                  ? 'Download Route-Optimized Excel (.xlsx)'
                  : exportMode === 'AREA_WISE'
                    ? areaFilter
                      ? 'Download Area Excel'
                      : 'Download All Areas (ZIP)'
                    : exportMode === 'COMBINED_ZIP'
                      ? 'Download Complete Audit ZIP'
                      : 'Generate & Download'}
            </button>
          </div>
        </form>
      )}

      {/* Direct 1-Click Area Downloads whenever a processed dataset is selected */}
      {hasPermission('export') && geoAreas.filter((a) => !a.isUnassigned).length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Quick Download by Area ({geoAreas.filter((a) => !a.isUnassigned).length} Areas)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Download any single Area&apos;s structured Excel workbook in one click.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-64 overflow-y-auto pr-1">
            {geoAreas
              .filter((a) => !a.isUnassigned)
              .map((area) => {
                const streetCount = area.streetGroups.filter((s) => s.streetGroup !== 'UNIDENTIFIED').length;
                return (
                  <div
                    key={area.areaKey}
                    className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-white truncate">{area.areaName}</div>
                      <div className="text-[11px] text-slate-500 tabular-nums">
                        {area.totalCount.toLocaleString()} customers · {streetCount} streets
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void triggerAreaExport(area.areaKey)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      <Download className="w-3 h-3" />
                      {downloadingKey === area.areaKey ? 'Preparing...' : 'Download .xlsx'}
                    </button>
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {/* Post-Export Area-Wise Summary Card */}
      {latestCompletedBundle && latestManifest && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                Latest Area-Wise Export Ready · {latestCompletedBundle.filename}
              </div>
              {latestManifest.reconciliation?.formula && (
                <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {latestManifest.reconciliation.formula}
                </p>
              )}
            </div>

            {hasPermission('export') && (
              <button
                type="button"
                onClick={() =>
                  void downloadAuthenticatedFile(
                    `/api/v1/exports/${latestCompletedBundle.id}/download`,
                    latestCompletedBundle.filename
                  ).catch((err) => setErrorMsg(err instanceof Error ? err.message : 'Download failed'))
                }
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                {latestCompletedBundle.is_zip ? 'DOWNLOAD ALL AS ZIP' : 'DOWNLOAD AREA EXCEL'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="text-[11px] font-medium text-slate-500">Area Workbooks Created</div>
              <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                {latestManifest.areaWorkbookCount ?? 0}
              </div>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="text-[11px] font-medium text-slate-500">Total Customers Exported</div>
              <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                {(latestManifest.totalCustomerRecords ?? latestCompletedBundle.row_count ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="text-[11px] font-medium text-slate-500">Needs Review</div>
              <div className="text-lg font-bold text-amber-600 dark:text-amber-400 mt-0.5 tabular-nums">
                {(latestManifest.needsReviewCount ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="text-[11px] font-medium text-slate-500">Unassigned Records</div>
              <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                {(latestManifest.unassignedAreaRecords ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="text-[11px] font-medium text-slate-500">Reconciliation Status</div>
              <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                {latestManifest.reconciliation?.status || 'VERIFIED'}
              </div>
            </div>
          </div>

          {areaBreakdownList.length > 0 && hasPermission('export') && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Per-Area Workbook Quick Export ({areaBreakdownList.length} Areas)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
                {areaBreakdownList.map((ab) => (
                  <div
                    key={ab.areaName}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-white truncate">{ab.areaName}</div>
                      <div className="text-[11px] text-slate-500 tabular-nums">
                        {ab.customerCount.toLocaleString()} customers · {ab.streetGroupCount} streets
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void triggerAreaExport(ab.areaName)}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap cursor-pointer"
                    >
                      Generate .xlsx
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Exports History */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Exports History & Downloads</h2>
        </div>

        {exportsList.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No exports generated yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2.5 px-4">Filename</th>
                  <th className="py-2.5 px-4">Mode · Format</th>
                  <th className="py-2.5 px-4 text-right">Records</th>
                  <th className="py-2.5 px-4">Bundle Breakdown</th>
                  <th className="py-2.5 px-4 text-right">Size</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Download</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {exportsList.map((ex) => {
                  const man = ex.artifact_manifest || {};
                  return (
                    <tr key={ex.id}>
                      <td className="py-2.5 px-4 font-medium">{ex.filename}</td>
                      <td className="py-2.5 px-4 text-slate-500">
                        {(ex.export_mode || ex.format).replace('_', ' ')} · {ex.format}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular">{ex.row_count.toLocaleString()}</td>
                      <td className="py-2.5 px-4 text-slate-500 tabular-nums">
                        {man.areaWorkbookCount !== undefined
                          ? `${man.areaWorkbookCount} Area workbook${man.areaWorkbookCount === 1 ? '' : 's'}${
                              man.unassignedAreaRecords ? ` + ${man.unassignedAreaRecords} unassigned CSV` : ''
                            }${man.reconciliation?.status ? ` · ${man.reconciliation.status}` : ''}`
                          : ex.split_by || '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular">
                        {ex.file_size_bytes ? `${(ex.file_size_bytes / 1024).toFixed(1)} KB` : '—'}
                      </td>
                      <td className="py-2.5 px-4">
                        {ex.status} {['QUEUED', 'RUNNING'].includes(ex.status) ? `(${ex.progress ?? 0}%)` : ''}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {ex.status === 'COMPLETED' && hasPermission('export') ? (
                          <button
                            type="button"
                            onClick={() =>
                              void downloadAuthenticatedFile(`/api/v1/exports/${ex.id}/download`, ex.filename).catch(
                                (err) => setErrorMsg(err instanceof Error ? err.message : 'Download failed')
                              )
                            }
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer whitespace-nowrap"
                          >
                            <Download className="w-3.5 h-3.5" />
                            {ex.is_zip || ex.format === 'ZIP' ? 'Download ZIP' : 'Download'}
                          </button>
                        ) : ex.error_message ? (
                          <span className="text-red-500">{ex.error_message}</span>
                        ) : (
                          <span className="text-slate-400">Processing...</span>
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
