import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  History,
  X,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { CleanRecordDTO, RecordStats } from '../../types/api.ts';

interface ReviewGridProps {
  initialUploadId?: string;
  initialCategoryFilter?: { type?: string; value: string } | null;
  initialGeoFilter?: { area?: string; streetGroup?: string } | null;
  globalSearch: string;
  onClearInitialFilters: () => void;
}

const STATUS_TABS: Array<{ id: string; label: string; statKey: keyof RecordStats }> = [
  { id: 'ALL', label: 'All Records', statKey: 'TOTAL' },
  { id: 'PROCESSED', label: 'Processed', statKey: 'PROCESSED' },
  { id: 'VERIFIED', label: 'Verified', statKey: 'VERIFIED' },
  { id: 'NEEDS_REVIEW', label: 'Needs Review', statKey: 'NEEDS_REVIEW' },
  { id: 'INVALID', label: 'Invalid', statKey: 'INVALID' },
  { id: 'POTENTIAL_DUPLICATE', label: 'Potential Duplicates', statKey: 'POTENTIAL_DUPLICATE' },
  { id: 'APPROVED', label: 'Approved', statKey: 'APPROVED' },
  { id: 'REJECTED', label: 'Rejected', statKey: 'REJECTED' },
];

export function ReviewGrid({
  initialUploadId,
  initialCategoryFilter,
  initialGeoFilter,
  globalSearch,
  onClearInitialFilters,
}: ReviewGridProps) {
  const { hasPermission } = useAuth();
  const [records, setRecords] = useState<CleanRecordDTO[]>([]);
  const [stats, setStats] = useState<RecordStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('ALL');
  const [uploadIdFilter, setUploadIdFilter] = useState(initialUploadId || '');
  const [areaFilter, setAreaFilter] = useState(initialGeoFilter?.area || '');
  const [streetGroupFilter, setStreetGroupFilter] = useState(initialGeoFilter?.streetGroup || '');
  const [cityFilter, setCityFilter] = useState('');
  const [pinFilter, setPinFilter] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [onlyInferred, setOnlyInferred] = useState(false);
  const [sortBy, setSortBy] = useState('row_number');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [dense, setDense] = useState(true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  // Inspector & Edit Drawer state
  const [inspectRecord, setInspectRecord] = useState<CleanRecordDTO | null>(null);
  const [inspectCategories, setInspectCategories] = useState<Array<{ category_type: string; category_value: string }>>([]);
  const [recordHistory, setRecordHistory] = useState<any[]>([]);
  const [inspectNotice, setInspectNotice] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    consumerId: string;
    fullName: string;
    street: string;
    subArea: string;
    streetGroup: string;
    area: string;
    city: string;
    district: string;
    state: string;
    pinCode: string;
    phoneRaw: string;
  } | null>(null);

  // Bulk Edit modal
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkPatch, setBulkPatch] = useState({ city: '', district: '', state: '', pinCode: '', categoryValue: '' });

  useEffect(() => {
    if (initialUploadId !== undefined) {
      setUploadIdFilter(initialUploadId);
      setPage(1);
    }
  }, [initialUploadId]);

  useEffect(() => {
    setAreaFilter(initialGeoFilter?.area || '');
    setStreetGroupFilter(initialGeoFilter?.streetGroup || '');
    setPage(1);
  }, [initialGeoFilter]);

  useEffect(() => {
    setPage(1);
  }, [globalSearch, initialCategoryFilter]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));
      qs.set('sortBy', sortBy);
      qs.set('sortDir', sortDir);
      if (statusFilter !== 'ALL') qs.set('status', statusFilter);
      if (uploadIdFilter) qs.set('uploadId', uploadIdFilter);
      if (areaFilter.trim()) qs.set('area', areaFilter.trim());
      if (streetGroupFilter.trim()) qs.set('streetGroup', streetGroupFilter.trim());
      if (globalSearch.trim()) qs.set('search', globalSearch.trim());
      if (cityFilter.trim()) qs.set('city', cityFilter.trim());
      if (pinFilter.trim()) qs.set('pinCode', pinFilter.trim());
      if (onlyIssues) qs.set('hasIssues', 'true');
      if (onlyInferred) qs.set('hasInferred', 'true');
      if (initialCategoryFilter?.value) {
        qs.set('categoryValue', initialCategoryFilter.value);
        if (initialCategoryFilter.type) qs.set('categoryType', initialCategoryFilter.type);
      }

      const statsQs = uploadIdFilter ? `?uploadId=${encodeURIComponent(uploadIdFilter)}` : '';
      const [recRes, statRes] = await Promise.all([
        apiRequest<{ items: CleanRecordDTO[]; total: number }>(`/api/v1/records?${qs.toString()}`),
        apiRequest<RecordStats>(`/api/v1/records/stats${statsQs}`),
      ]);

      setRecords(recRes.items);
      setTotal(recRes.total);
      setStats(statRes);
      setFocusedIndex(0);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load records');
    } finally {
      setLoading(false);
    }
  }, [
    page,
    pageSize,
    sortBy,
    sortDir,
    statusFilter,
    uploadIdFilter,
    areaFilter,
    streetGroupFilter,
    globalSearch,
    cityFilter,
    pinFilter,
    onlyIssues,
    onlyInferred,
    initialCategoryFilter,
  ]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openInspector = useCallback(async (rec: CleanRecordDTO) => {
    setInspectNotice(null);
    setInspectError(null);
    setInspectRecord(rec);
    setEditDraft({
      consumerId: rec.consumer_id || '',
      fullName: rec.full_name || '',
      street: rec.street || '',
      subArea: rec.sub_area || '',
      streetGroup: rec.street_group || '',
      area: rec.area || '',
      city: rec.city || '',
      district: rec.district || '',
      state: rec.state || '',
      pinCode: rec.pin_code || '',
      phoneRaw: rec.phone_display || rec.phone_e164 || '',
    });
    try {
      const detail = await apiRequest<{
        record: CleanRecordDTO;
        categories: Array<{ category_type: string; category_value: string }>;
        history: any[];
      }>(`/api/v1/records/${rec.id}`);
      setInspectRecord(detail.record);
      setInspectCategories(detail.categories || []);
      setRecordHistory(detail.history || []);
    } catch {
      setInspectCategories([]);
      setRecordHistory([]);
    }
  }, []);

  const handleDecision = useCallback(
    async (ids: string[], decision: 'APPROVED' | 'REJECTED') => {
      if (ids.length === 0) return;
      try {
        await apiRequest('/api/v1/records/approve', {
          method: 'POST',
          body: JSON.stringify({ recordIds: ids, decision }),
        });
        setSelectedIds(new Set());
        await loadData();
        if (inspectRecord && ids.includes(inspectRecord.id)) {
          setInspectRecord(null);
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Action failed');
      }
    },
    [inspectRecord, loadData]
  );

  // Virtualiser setup for fast rendering
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const rowHeight = dense ? 38 : 48;
  const rowVirtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Reviewer keyboard shortcuts (j/k move, e edit, a approve, x reject)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (records.length === 0) return;

      if (e.key === 'j') {
        e.preventDefault();
        setFocusedIndex((i) => {
          const next = Math.min(records.length - 1, i + 1);
          rowVirtualizer.scrollToIndex(next, { align: 'auto' });
          return next;
        });
      } else if (e.key === 'k') {
        e.preventDefault();
        setFocusedIndex((i) => {
          const next = Math.max(0, i - 1);
          rowVirtualizer.scrollToIndex(next, { align: 'auto' });
          return next;
        });
      } else if (e.key === 'e') {
        e.preventDefault();
        const rec = records[focusedIndex];
        if (rec) void openInspector(rec);
      } else if (e.key === 'a' && hasPermission('approve')) {
        e.preventDefault();
        const rec = records[focusedIndex];
        if (rec) void handleDecision([rec.id], 'APPROVED');
      } else if (e.key === 'x' && hasPermission('approve')) {
        e.preventDefault();
        const rec = records[focusedIndex];
        if (rec) void handleDecision([rec.id], 'REJECTED');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [records, focusedIndex, hasPermission, openInspector, handleDecision, rowVirtualizer]);

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectRecord || !editDraft) return;
    setInspectError(null);
    setInspectNotice(null);
    try {
      await apiRequest(`/api/v1/records/${inspectRecord.id}`, {
        method: 'PATCH',
        body: JSON.stringify(editDraft),
      });
      await loadData();
      await openInspector(inspectRecord);
      setInspectNotice('Corrections saved and logged to version history.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setInspectError(msg);
      setErrorMsg(msg);
    }
  };

  const handleBulkEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const patch: Record<string, unknown> = {};
    if (bulkPatch.city.trim()) patch.city = bulkPatch.city.trim();
    if (bulkPatch.district.trim()) patch.district = bulkPatch.district.trim();
    if (bulkPatch.state.trim()) patch.state = bulkPatch.state.trim();
    if (bulkPatch.pinCode.trim()) patch.pinCode = bulkPatch.pinCode.trim();
    if (bulkPatch.categoryValue.trim()) {
      patch.addCategory = { type: 'CUSTOM', value: bulkPatch.categoryValue.trim() };
    }
    if (Object.keys(patch).length === 0) {
      setErrorMsg('Enter at least one field or category before applying bulk edit.');
      return;
    }
    try {
      await apiRequest('/api/v1/records/bulk-edit', {
        method: 'POST',
        body: JSON.stringify({ recordIds: ids, patch }),
      });
      setBulkModalOpen(false);
      setBulkPatch({ city: '', district: '', state: '', pinCode: '', categoryValue: '' });
      setSelectedIds(new Set());
      await loadData();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Bulk edit failed');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4 max-w-[1500px] mx-auto">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Review & Master Records</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Shortcuts: J / K navigate · E inspect & edit · A approve · X reject
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(uploadIdFilter || initialCategoryFilter || areaFilter || streetGroupFilter) && (
            <button
              type="button"
              onClick={() => {
                setUploadIdFilter('');
                setAreaFilter('');
                setStreetGroupFilter('');
                onClearInitialFilters();
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Clear Batch/Geo Filter
            </button>
          )}
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5">
            <button
              type="button"
              onClick={() => setDense(true)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                dense ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => setDense(false)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                !dense ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Comfortable
            </button>
          </div>
        </div>
      </div>

      {/* Status Segmented Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.id;
          const cnt = stats ? stats[tab.statKey] : 0;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setStatusFilter(tab.id);
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap shrink-0 transition-colors cursor-pointer tabular-nums ${
                active
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {tab.label} ({cnt.toLocaleString()})
            </button>
          );
        })}
      </div>

      {/* Filter Bar & Bulk Actions */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={cityFilter}
            onChange={(e) => {
              setCityFilter(e.target.value);
              setPage(1);
            }}
            placeholder="Filter by city..."
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 w-36"
          />
          <input
            type="text"
            value={pinFilter}
            onChange={(e) => {
              setPinFilter(e.target.value);
              setPage(1);
            }}
            placeholder="PIN prefix..."
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 w-28 font-mono-tabular"
          />
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 px-2 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(e) => {
                setOnlyIssues(e.target.checked);
                setPage(1);
              }}
            />
            Has issues
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 px-2 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyInferred}
              onChange={(e) => {
                setOnlyInferred(e.target.checked);
                setPage(1);
              }}
            />
            Contains inferred fields
          </label>
        </div>

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 tabular-nums">
              {selectedIds.size} selected
            </span>
            {hasPermission('edit') && (
              <button
                type="button"
                onClick={() => setBulkModalOpen(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Bulk Edit
              </button>
            )}
            {hasPermission('approve') && (
              <>
                <button
                  type="button"
                  onClick={() => void handleDecision(Array.from(selectedIds), 'APPROVED')}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                >
                  Approve Selected
                </button>
                <button
                  type="button"
                  onClick={() => void handleDecision(Array.from(selectedIds), 'REJECTED')}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white cursor-pointer"
                >
                  Reject
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {/* Virtualised Data Grid */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div ref={tableContainerRef} className="overflow-auto h-[540px]">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
              <tr>
                <th className="py-2.5 px-3 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on page"
                    checked={records.length > 0 && records.every((r) => selectedIds.has(r.id))}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(new Set(records.map((r) => r.id)));
                      } else {
                        setSelectedIds(new Set());
                      }
                    }}
                  />
                </th>
                <th className="py-2.5 px-3 font-semibold w-14">Row</th>
                <th
                  className="py-2.5 px-3 font-semibold cursor-pointer"
                  onClick={() => {
                    setSortBy('full_name');
                    setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
                  }}
                >
                  Customer Name
                </th>
                <th className="py-2.5 px-3 font-semibold">Phone (E.164)</th>
                <th className="py-2.5 px-3 font-semibold">Area · Street Group</th>
                <th
                  className="py-2.5 px-3 font-semibold cursor-pointer"
                  onClick={() => {
                    setSortBy('city');
                    setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
                  }}
                >
                  City · District
                </th>
                <th className="py-2.5 px-3 font-semibold">State · PIN</th>
                <th className="py-2.5 px-3 font-semibold">Status & Issues</th>
                <th className="py-2.5 px-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    Loading records...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    No records match the current filters.
                  </td>
                </tr>
              ) : (
                <>
                  {rowVirtualizer.getVirtualItems().length > 0 && (
                    <tr style={{ height: `${rowVirtualizer.getVirtualItems()[0].start}px` }} />
                  )}
                  {rowVirtualizer.getVirtualItems().map((vRow) => {
                    const r = records[vRow.index];
                    const isFocused = vRow.index === focusedIndex;
                    return (
                      <tr
                        key={r.id}
                        style={{ height: `${rowHeight}px` }}
                        onClick={() => setFocusedIndex(vRow.index)}
                        className={`border-b border-slate-100 dark:border-slate-800/70 transition-colors ${
                          isFocused
                            ? 'bg-blue-50/70 dark:bg-blue-950/30'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <td className="px-3">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            onChange={(e) => {
                              const next = new Set(selectedIds);
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                              setSelectedIds(next);
                            }}
                          />
                        </td>
                        <td className="px-3 font-mono-tabular text-slate-400">
                          {r.original_row_number || r.row_number}
                        </td>
                        <td className="px-3 font-medium text-slate-900 dark:text-white max-w-[200px] truncate">
                          {r.full_name || <span className="text-slate-400 italic">Missing</span>}
                          {r.consumer_id && (
                            <span className="ml-1.5 text-[11px] font-mono-tabular text-slate-400">
                              #{r.consumer_id}
                            </span>
                          )}
                        </td>
                        <td className="px-3 font-mono-tabular text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {r.phone_display || r.phone_e164 || <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 text-slate-600 dark:text-slate-300 max-w-[220px] truncate">
                          {[r.area || 'UNASSIGNED', r.street_group || r.street].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-3 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {[r.city, r.district].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-3 font-mono-tabular text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {[r.state, r.pin_code].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            {r.status === 'INVALID' ? (
                              <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                            ) : r.status === 'APPROVED' || r.status === 'VERIFIED' ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            ) : r.status === 'REJECTED' ? (
                              <XCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            ) : null}
                            <span
                              className={`font-medium ${
                                r.status === 'INVALID'
                                  ? 'text-red-700 dark:text-red-400'
                                  : r.status === 'NEEDS_REVIEW' || r.status === 'POTENTIAL_DUPLICATE'
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : r.status === 'APPROVED'
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : 'text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {r.status.replace('_', ' ')}
                            </span>
                            {r.issues?.length > 0 && (
                              <span className="text-slate-400 font-mono-tabular">· {r.issues.length} issue(s)</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 text-right whitespace-nowrap space-x-2">
                          <button
                            type="button"
                            onClick={() => void openInspector(r)}
                            className="text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" />
                            Inspect
                          </button>
                          {hasPermission('approve') && r.status !== 'APPROVED' && (
                            <button
                              type="button"
                              onClick={() => void handleDecision([r.id], 'APPROVED')}
                              className="text-emerald-600 dark:text-emerald-400 hover:underline font-medium cursor-pointer"
                            >
                              Approve
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {rowVirtualizer.getVirtualItems().length > 0 && (
                    <tr
                      style={{
                        height: `${
                          rowVirtualizer.getTotalSize() -
                          rowVirtualizer.getVirtualItems()[rowVirtualizer.getVirtualItems().length - 1].end
                        }px`,
                      }}
                    />
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
          <div className="tabular-nums">
            Showing page {page} of {totalPages} ({total.toLocaleString()} total records)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Record Inspector & Inline Edit Drawer */}
      {inspectRecord && editDraft && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setInspectRecord(null)} />
          <div className="relative w-full max-w-xl bg-white dark:bg-slate-900 h-full overflow-y-auto border-l border-slate-200 dark:border-slate-800 p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Record #{inspectRecord.original_row_number || inspectRecord.row_number} Inspector
                </h2>
                <p className="text-xs text-slate-500 font-mono-tabular">
                  {inspectRecord.status} · Confidence {(Number(inspectRecord.overall_confidence) * 100).toFixed(0)}%
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectRecord(null)}
                aria-label="Close inspector"
                className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Issues Explanation */}
            {inspectRecord.issues?.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">Validation Explanations</h3>
                {inspectRecord.issues.map((iss, idx) => (
                  <div
                    key={idx}
                    className={`p-3 rounded-lg border text-xs ${
                      iss.severity === 'ERROR'
                        ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                        : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
                    }`}
                  >
                    <span className="font-mono-tabular font-semibold">{iss.code}</span> · {iss.message}
                  </div>
                ))}
              </div>
            )}

            {/* Inline Edit Form with Per-Field Provenance */}
            <form onSubmit={handleSaveEdit} className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Cleaned Fields & Provenance
              </h3>
              {(
                [
                  ['consumerId', 'Consumer ID'],
                  ['fullName', 'Customer Name'],
                  ['phoneRaw', 'Phone Number'],
                  ['area', 'Area / Zone'],
                  ['subArea', 'SubArea / Locality'],
                  ['streetGroup', 'Street / Locality Group'],
                  ['street', 'Street / Door No'],
                  ['city', 'City'],
                  ['district', 'District'],
                  ['state', 'State'],
                  ['pinCode', 'PIN Code'],
                ] as const
              ).map(([key, label]) => {
                const provKey = key === 'phoneRaw' ? 'phoneE164' : key;
                const prov = inspectRecord.provenance?.[provKey];
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</label>
                      {prov && (
                        <span
                          className={`text-[11px] font-mono-tabular ${
                            prov === 'INFERRED' ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-slate-400'
                          }`}
                        >
                          {prov}
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      disabled={!hasPermission('edit')}
                      value={editDraft[key]}
                      onChange={(e) => setEditDraft({ ...editDraft, [key]: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                );
              })}

              {inspectError && (
                <div role="alert" className="p-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                  {inspectError}
                </div>
              )}

              {inspectNotice && (
                <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300">
                  {inspectNotice}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-3">
                {hasPermission('edit') && (
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                  >
                    Save Corrections
                  </button>
                )}
                {hasPermission('approve') && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleDecision([inspectRecord.id], 'APPROVED')}
                      className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                    >
                      Approve Record
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDecision([inspectRecord.id], 'REJECTED')}
                      className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white cursor-pointer"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </form>

            {/* Assigned Categories */}
            {inspectCategories.length > 0 && (
              <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
                <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">Assigned Categories</h3>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {inspectCategories.map((c, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                    >
                      {c.category_type.replace(/_/g, ' ')}: <strong className="font-semibold">{c.category_value}</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Immutable Original Raw Record */}
            <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Immutable Original Source Data
              </h3>
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5 text-xs">
                {Object.entries(inspectRecord.raw_data || {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4">
                    <span className="text-slate-500 shrink-0">{k}:</span>
                    <span className="text-slate-900 dark:text-slate-200 text-right break-all">{String(v || '—')}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Record Version History */}
            <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" />
                Version History
              </h3>
              {recordHistory.length === 0 ? (
                <p className="text-xs text-slate-500">No manual edits or approvals recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {recordHistory.map((h) => (
                    <div key={h.id} className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
                      <div className="flex justify-between font-medium">
                        <span>{h.action}</span>
                        <span className="font-mono-tabular text-slate-400">
                          {new Date(h.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        Actor: {h.actor_name || 'System'} · Fields: {(h.changed_fields || []).join(', ') || 'status'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk Edit Modal */}
      {bulkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setBulkModalOpen(false)} />
          <form
            onSubmit={handleBulkEditSubmit}
            className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-md space-y-4"
          >
            <h2 className="text-base font-bold">Bulk Edit {selectedIds.size} Selected Records</h2>
            <p className="text-xs text-slate-500">Leave fields blank to keep existing values unchanged.</p>
            <input
              type="text"
              placeholder="Set City"
              value={bulkPatch.city}
              onChange={(e) => setBulkPatch({ ...bulkPatch, city: e.target.value })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              type="text"
              placeholder="Set District"
              value={bulkPatch.district}
              onChange={(e) => setBulkPatch({ ...bulkPatch, district: e.target.value })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              type="text"
              placeholder="Set State"
              value={bulkPatch.state}
              onChange={(e) => setBulkPatch({ ...bulkPatch, state: e.target.value })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              type="text"
              placeholder="Set PIN Code"
              value={bulkPatch.pinCode}
              onChange={(e) => setBulkPatch({ ...bulkPatch, pinCode: e.target.value })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              type="text"
              placeholder="Add Custom Category Tag"
              value={bulkPatch.categoryValue}
              onChange={(e) => setBulkPatch({ ...bulkPatch, categoryValue: e.target.value })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBulkModalOpen(false)}
                className="px-3.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              >
                Apply to {selectedIds.size} Records
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
