import React, { useCallback, useEffect, useState } from 'react';
import { GitMerge, RefreshCw, RotateCcw, X } from 'lucide-react';
import { apiRequest } from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { DuplicateGroupDTO } from '../../types/api.ts';

const COMPARE_FIELDS = [
  { key: 'full_name', label: 'Customer Name' },
  { key: 'phone_display', label: 'Phone (Display)' },
  { key: 'phone_e164', label: 'Phone (E.164)' },
  { key: 'street', label: 'Street' },
  { key: 'area', label: 'Area' },
  { key: 'city', label: 'City' },
  { key: 'district', label: 'District' },
  { key: 'state', label: 'State' },
  { key: 'pin_code', label: 'PIN Code' },
];

export function DuplicatesView() {
  const { hasPermission } = useAuth();
  const [groups, setGroups] = useState<DuplicateGroupDTO[]>([]);
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'MERGED' | 'DISMISSED' | 'REVERTED' | 'ALL'>('PENDING');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Side-by-side compare modal state
  const [activeGroup, setActiveGroup] = useState<any | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [survivingId, setSurvivingId] = useState<string>('');
  const [fieldSelections, setFieldSelections] = useState<Record<string, string>>({});

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: DuplicateGroupDTO[] }>(`/api/v1/duplicates?status=${statusFilter}&pageSize=50`);
      setGroups(res.items);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load duplicates');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const openCompare = async (groupId: string) => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ group: any; members: any[] }>(`/api/v1/duplicates/${groupId}`);
      setActiveGroup(res.group);
      setMembers(res.members);
      const primary = res.members.find((m) => m.is_suggested_primary) || res.members[0];
      if (primary) {
        setSurvivingId(primary.id);
        const defaults: Record<string, string> = {};
        for (const f of COMPARE_FIELDS) {
          const best = res.members.find((m) => Boolean(m[f.key])) || primary;
          defaults[f.key] = best.id;
        }
        setFieldSelections(defaults);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load duplicate group details');
    }
  };

  const handleMerge = async () => {
    if (!activeGroup || !survivingId) return;
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiRequest(`/api/v1/duplicates/${activeGroup.id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ survivingRecordId: survivingId, fieldSelections }),
      });
      setActiveGroup(null);
      setStatusMsg('Duplicate group merged safely. You can revert this merge anytime from the MERGED tab.');
      await loadGroups();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Merge failed');
    }
  };

  const handleDismiss = async (groupId: string) => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiRequest(`/api/v1/duplicates/${groupId}/dismiss`, { method: 'POST', body: JSON.stringify({}) });
      if (activeGroup?.id === groupId) setActiveGroup(null);
      setStatusMsg('Group marked as distinct records.');
      await loadGroups();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to dismiss duplicate group');
    }
  };

  const handleRevert = async (groupId: string) => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiRequest(`/api/v1/duplicates/${groupId}/revert`, { method: 'POST', body: JSON.stringify({}) });
      setStatusMsg('Merge reverted and original records restored.');
      await loadGroups();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to revert merge');
    }
  };

  const handleRunScan = async () => {
    setScanning(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ scannedUploads: number; groupsCreated: number }>('/api/v1/duplicates/scan', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatusMsg(`Scanned ${res.scannedUploads} upload batch(es); detected ${res.groupsCreated} duplicate group(s).`);
      await loadGroups();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Duplicate scan failed');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Duplicate Detection & Reversible Merge</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Blocking-key similarity groups. Uncertain merges never run automatically and every merge can be reverted.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasPermission('process') && (
            <button
              type="button"
              disabled={scanning}
              onClick={() => void handleRunScan()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Scanning...' : 'Run Duplicate Scan'}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            {(['PENDING', 'MERGED', 'DISMISSED', 'REVERTED', 'ALL'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                  statusFilter === st
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {statusMsg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
          {statusMsg}
        </div>
      )}

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-sm text-slate-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          Loading duplicate groups...
        </div>
      ) : groups.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          No duplicate groups in status "{statusFilter}".
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((grp) => (
            <div
              key={grp.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4"
            >
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>{grp.match_type.replace(/_/g, ' ')}</span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono-tabular text-blue-600 dark:text-blue-400">
                    {(Number(grp.confidence) * 100).toFixed(0)}% confidence
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-500">{grp.member_count} records</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                  {(grp.members_preview || []).map((m) => (
                    <div
                      key={m.id}
                      className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs"
                    >
                      <div className="font-semibold text-slate-900 dark:text-white truncate">
                        {m.fullName || 'Unnamed'} {m.isSuggestedPrimary ? '(Suggested Primary)' : ''}
                      </div>
                      <div className="text-slate-500 font-mono-tabular mt-0.5 truncate">
                        {m.phoneDisplay || 'No phone'} · {[m.street, m.city, m.pinCode].filter(Boolean).join(', ') || 'No address'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {grp.status === 'PENDING' && (
                  <>
                    <button
                      type="button"
                      onClick={() => void openCompare(grp.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      Compare & Merge
                    </button>
                    {hasPermission('approve') && (
                      <button
                        type="button"
                        onClick={() => void handleDismiss(grp.id)}
                        className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        Not Duplicate
                      </button>
                    )}
                  </>
                )}
                {grp.status === 'MERGED' && hasPermission('approve') && (
                  <button
                    type="button"
                    onClick={() => void handleRevert(grp.id)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Revert Merge
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Side-by-Side Field-Level Merge Modal */}
      {activeGroup && members.length >= 2 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/60" onClick={() => setActiveGroup(null)} />
          <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Side-by-Side Field Merge</h2>
                <p className="text-xs text-slate-500">
                  Choose the surviving primary record and select which value to keep per field.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveGroup(null)}
                className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                    <th className="py-2.5 px-3 font-semibold w-40">Field</th>
                    {members.map((m, idx) => (
                      <th key={m.id} className="py-2.5 px-3 font-semibold">
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="survivingRecord"
                            checked={survivingId === m.id}
                            onChange={() => setSurvivingId(m.id)}
                          />
                          <span>
                            Record #{m.row_number} {idx === 0 ? '(Suggested)' : ''}
                          </span>
                        </label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {COMPARE_FIELDS.map((f) => (
                    <tr key={f.key}>
                      <td className="py-2 px-3 font-medium text-slate-600 dark:text-slate-400">{f.label}</td>
                      {members.map((m) => (
                        <td key={m.id} className="py-2 px-3">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name={`field_${f.key}`}
                              checked={fieldSelections[f.key] === m.id}
                              onChange={() => setFieldSelections({ ...fieldSelections, [f.key]: m.id })}
                            />
                            <span className="text-slate-900 dark:text-slate-100 break-words">
                              {m[f.key] || <span className="text-slate-400 italic">empty</span>}
                            </span>
                          </label>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleDismiss(activeGroup.id)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
              >
                Dismiss as Distinct
              </button>
              {hasPermission('approve') && (
                <button
                  type="button"
                  onClick={() => void handleMerge()}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                >
                  Confirm Merge
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
