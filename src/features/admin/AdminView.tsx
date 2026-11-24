import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { apiRequest, ApiError } from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { UserRole } from '../../types/api.ts';

export function AdminView() {
  const { user, hasPermission } = useAuth();
  const [tab, setTab] = useState<'users' | 'settings' | 'audit'>(
    hasPermission('manage_users') ? 'users' : 'settings'
  );

  // Users
  const [users, setUsers] = useState<any[]>([]);
  const [loadingTab, setLoadingTab] = useState(false);
  const [newUser, setNewUser] = useState({
    email: '',
    fullName: '',
    role: 'DATA_PROCESSOR' as UserRole,
  });

  // Settings
  const [maxUploadMb, setMaxUploadMb] = useState<number>(50);
  const [savingSettings, setSavingSettings] = useState(false);

  // Audit
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditActionFilter, setAuditActionFilter] = useState('');

  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setErrMsg(null);
    setLoadingTab(true);
    try {
      if (tab === 'users' && hasPermission('manage_users')) {
        const res = await apiRequest<{ items: any[] }>('/api/v1/users');
        setUsers(res.items);
      } else if (tab === 'settings' && hasPermission('manage_settings')) {
        const res = await apiRequest<{ settings: Record<string, any> }>('/api/v1/settings');
        const configuredMax = Number(res.settings?.['upload.max_mb']);
        if (Number.isFinite(configuredMax) && configuredMax >= 1) {
          setMaxUploadMb(configuredMax);
        }
      } else if (tab === 'audit' && hasPermission('manage_settings')) {
        const qs = auditActionFilter ? `?action=${encodeURIComponent(auditActionFilter)}` : '';
        const res = await apiRequest<{ items: any[] }>(`/api/v1/audit${qs}`);
        setAuditLogs(res.items);
      }
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.message : 'Failed to load admin data');
    } finally {
      setLoadingTab(false);
    }
  }, [tab, hasPermission, auditActionFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrMsg(null);
    setMsg(null);
    try {
      await apiRequest('/api/v1/users', { method: 'POST', body: JSON.stringify(newUser) });
      setNewUser({ email: '', fullName: '', role: 'DATA_PROCESSOR' });
      setMsg('Google user authorized successfully.');
      await loadData();
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.message : 'Could not authorize user');
    }
  };

  const handleToggleUser = async (u: any) => {
    try {
      await apiRequest(`/api/v1/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.is_active }),
      });
      await loadData();
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.message : 'Failed to update user');
    }
  };

  const handleChangeRole = async (u: any, nextRole: UserRole) => {
    setErrMsg(null);
    setMsg(null);
    try {
      await apiRequest(`/api/v1/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      setMsg(`Updated role for ${u.email} to ${nextRole}.`);
      await loadData();
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.message : 'Failed to update role');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrMsg(null);
    setMsg(null);
    const parsedMax = Math.round(Number(maxUploadMb));
    if (!Number.isFinite(parsedMax) || parsedMax < 1 || parsedMax > 200) {
      setErrMsg('Max upload size must be between 1 and 200 MB.');
      return;
    }
    setSavingSettings(true);
    try {
      const res = await apiRequest<{ settings: Record<string, any> }>('/api/v1/settings', {
        method: 'PATCH',
        body: JSON.stringify({ 'upload.max_mb': parsedMax }),
      });
      const updatedMax = Number(res.settings?.['upload.max_mb'] ?? parsedMax);
      setMaxUploadMb(updatedMax);
      setMsg('Max upload size updated.');
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.message : 'Settings save failed');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Administration, Governance & Audit</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Manage RBAC users, upload size limits, and immutable security audit logs.
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          {hasPermission('manage_users') && (
            <button
              type="button"
              onClick={() => setTab('users')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                tab === 'users'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
              }`}
            >
              Users & Roles
            </button>
          )}
          {hasPermission('manage_settings') && (
            <>
                <button
                type="button"
                onClick={() => setTab('settings')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-lg border cursor-pointer whitespace-nowrap shrink-0 ${
                  tab === 'settings'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                }`}
              >
                Upload Settings
              </button>
              <button
                type="button"
                onClick={() => setTab('audit')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                  tab === 'audit'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                }`}
              >
                Audit Logs
              </button>
            </>
          )}
        </div>
      </div>

      {errMsg && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {errMsg}
        </div>
      )}
      {msg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
          {msg}
        </div>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="space-y-5">
          <form
            onSubmit={handleCreateUser}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
          >
            <div className="flex items-center gap-2 text-sm font-bold">
              <UserPlus className="w-4 h-4 text-blue-600" />
              Add Workspace Member
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <input
                type="text"
                required
                placeholder="Full Name"
                value={newUser.fullName}
                onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })}
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                type="email"
                required
                placeholder="Email Address"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {user?.role === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">Super Admin</option>}
                <option value="ADMIN">Admin</option>
                <option value="DATA_PROCESSOR">Data Processing Employee</option>
                <option value="REVIEWER">Reviewer</option>
                <option value="READ_ONLY">Read-only User</option>
              </select>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
              >
                Add Member
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Manage workspace member directory and role assignments for audit tracking.
            </p>
          </form>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2.5 px-4">Name</th>
                  <th className="py-2.5 px-4">Email</th>
                  <th className="py-2.5 px-4">Role</th>
                  <th className="py-2.5 px-4">State</th>
                  <th className="py-2.5 px-4">Last Login</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {loadingTab && users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      Loading users...
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      No users available to display.
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2.5 px-4 font-medium">{u.full_name}</td>
                    <td className="py-2.5 px-4 text-slate-500">{u.email}</td>
                    <td className="py-2.5 px-4">
                      {u.id === user?.id || (u.role === 'SUPER_ADMIN' && user?.role !== 'SUPER_ADMIN') ? (
                        <span>{u.role}</span>
                      ) : (
                        <select
                          aria-label={`Role for ${u.email}`}
                          value={u.role}
                          onChange={(e) => void handleChangeRole(u, e.target.value as UserRole)}
                          className="px-2 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          {user?.role === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">SUPER_ADMIN</option>}
                          <option value="ADMIN">ADMIN</option>
                          <option value="DATA_PROCESSOR">DATA_PROCESSOR</option>
                          <option value="REVIEWER">REVIEWER</option>
                          <option value="READ_ONLY">READ_ONLY</option>
                        </select>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      {u.is_active ? 'Active' : 'Deactivated'}
                      {u.locked_until && new Date(u.locked_until) > new Date() ? ' · Locked' : ''}
                    </td>
                    <td className="py-2.5 px-4 font-mono-tabular text-slate-500">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                    </td>
                    <td className="py-2.5 px-4 text-right space-x-3">
                      {u.id !== user?.id && (
                        <button
                          type="button"
                          onClick={() => void handleToggleUser(u)}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer"
                        >
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </td>
                  </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Upload Settings Tab */}
      {tab === 'settings' && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 max-w-xl space-y-5"
        >
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Upload Size Settings</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Set the maximum spreadsheet file size allowed per upload (1–200 MB).
            </p>
          </div>

          <div className="space-y-1.5 text-xs">
            <label
              htmlFor="max-upload-mb-input"
              className="block font-medium text-slate-700 dark:text-slate-300"
            >
              Max Upload Size (MB)
            </label>
            <input
              id="max-upload-mb-input"
              type="number"
              min={1}
              max={200}
              required
              disabled={loadingTab || savingSettings}
              value={maxUploadMb}
              onChange={(e) => setMaxUploadMb(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono tabular-nums"
            />
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={loadingTab || savingSettings}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white cursor-pointer whitespace-nowrap shrink-0"
            >
              {savingSettings ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      )}

      {/* Audit Logs Tab */}
      {tab === 'audit' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold">Immutable Security & Operational Audit Log</h2>
            <input
              type="text"
              value={auditActionFilter}
              onChange={(e) => setAuditActionFilter(e.target.value)}
              placeholder="Filter by action (e.g. AUTH, EXPORT, MERGE)..."
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 w-64"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">Metadata (PII-Redacted)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      {loadingTab ? 'Loading audit logs...' : 'No audit events match the current filter.'}
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2 px-4 font-mono-tabular text-slate-500 whitespace-nowrap">
                        {new Date(a.created_at).toLocaleString()}
                      </td>
                      <td className="py-2 px-4">
                        {a.actor_name || a.actor_email || 'Anonymous'} ({a.actor_role || '—'})
                      </td>
                      <td className="py-2 px-4 font-mono-tabular font-semibold">{a.action}</td>
                      <td className="py-2 px-4 font-mono-tabular text-slate-500">
                        {a.resource_type} {a.resource_id ? `· ${String(a.resource_id).slice(0, 8)}` : ''}
                      </td>
                      <td className="py-2 px-4 font-mono-tabular text-slate-500 max-w-md truncate">
                        {JSON.stringify(a.metadata || {})}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
