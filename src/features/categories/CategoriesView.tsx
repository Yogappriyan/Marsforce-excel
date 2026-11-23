import React, { useCallback, useEffect, useState } from 'react';
import { FolderTree, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiRequest } from '../../api/client.ts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { CategoryRuleDTO } from '../../types/api.ts';

interface CategoriesViewProps {
  onFilterByCategory: (type: string, value: string) => void;
}

export function CategoriesView({ onFilterByCategory }: CategoriesViewProps) {
  const { hasPermission } = useAuth();
  const [rules, setRules] = useState<CategoryRuleDTO[]>([]);
  const [locationTree, setLocationTree] = useState<
    Array<{ state: string; district: string; city: string; count: number }>
  >([]);
  const [categories, setCategories] = useState<
    Array<{ category_type: string; category_value: string; count: number }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [newRule, setNewRule] = useState({
    name: '',
    priority: 50,
    categoryType: 'CUSTOM',
    categoryValue: '',
    field: 'city',
    matchType: 'EQUALS' as 'EQUALS' | 'CONTAINS' | 'REGEX' | 'IN',
    value: '',
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [rulesRes, treeRes] = await Promise.all([
        apiRequest<{ items: CategoryRuleDTO[] }>('/api/v1/categories/rules'),
        apiRequest<{ locationTree: any[]; categories: any[] }>('/api/v1/categories/tree'),
      ]);
      setRules(rulesRes.items);
      setLocationTree(treeRes.locationTree);
      setCategories(treeRes.categories);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load categorisation data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiRequest('/api/v1/categories/rules', {
        method: 'POST',
        body: JSON.stringify({
          name: newRule.name,
          priority: Number(newRule.priority),
          categoryType: newRule.categoryType,
          categoryValue: newRule.categoryValue,
          conditions: {
            operator: 'AND',
            clauses: [{ field: newRule.field, matchType: newRule.matchType, value: newRule.value }],
          },
          isActive: true,
        }),
      });
      setNewRule({
        name: '',
        priority: 50,
        categoryType: 'CUSTOM',
        categoryValue: '',
        field: 'city',
        matchType: 'EQUALS',
        value: '',
      });
      setStatusMsg('Categorisation rule created. Click "Recalculate Categories" to apply to existing records.');
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create rule');
    }
  };

  const handleRecalculate = async () => {
    setRecalculating(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiRequest<{ updatedRecords: number }>('/api/v1/categories/recalculate', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatusMsg(`Recalculated categories across ${res.updatedRecords.toLocaleString()} records.`);
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Category recalculation failed');
    } finally {
      setRecalculating(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiRequest(`/api/v1/categories/rules/${id}`, { method: 'DELETE' });
      setStatusMsg('Categorisation rule deleted.');
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete rule');
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Categorisation & Location Hierarchy</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Explore State &gt; District &gt; City hierarchies and configure priority-ordered classification rules.
          </p>
        </div>

        {hasPermission('process') && (
          <button
            type="button"
            disabled={recalculating}
            onClick={() => void handleRecalculate()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${recalculating ? 'animate-spin' : ''}`} />
            {recalculating ? 'Recalculating...' : 'Recalculate Categories'}
          </button>
        )}
      </div>

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {statusMsg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
          {statusMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hierarchical Location Tree */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <FolderTree className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Hierarchical Location Breakdown (State &gt; District &gt; City)
            </h2>
          </div>

          {loading ? (
            <p className="text-xs text-slate-500">Loading hierarchy...</p>
          ) : locationTree.length === 0 ? (
            <p className="text-xs text-slate-500">No processed records yet.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {locationTree.map((node, i) => (
                <div key={i} className="py-2 flex items-center justify-between gap-3">
                  <div className="truncate">
                    <span className="text-slate-500">{node.state}</span>
                    <span className="mx-1.5 text-slate-400">&gt;</span>
                    <span className="text-slate-700 dark:text-slate-300">{node.district}</span>
                    <span className="mx-1.5 text-slate-400">&gt;</span>
                    {node.city === 'Unspecified City' ? (
                      <span className="font-medium text-slate-400">{node.city}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onFilterByCategory('LOCATION_CITY', node.city)}
                        className="font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                      >
                        {node.city}
                      </button>
                    )}
                  </div>
                  <span className="font-mono-tabular font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                    {node.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Category Groups Summary */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">All Assigned Categories</h2>
          {categories.length === 0 ? (
            <p className="text-xs text-slate-500">No category tags assigned yet.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {categories.map((c, idx) => (
                <div key={idx} className="py-2 flex items-center justify-between gap-3">
                  <div className="truncate">
                    <span className="text-slate-500">{c.category_type.replace('_', ' ')}</span>
                    <span className="mx-1.5 text-slate-400">·</span>
                    <button
                      type="button"
                      onClick={() => onFilterByCategory(c.category_type, c.category_value)}
                      className="font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                    >
                      {c.category_value}
                    </button>
                  </div>
                  <span className="font-mono-tabular font-semibold">{c.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Priority Rule Builder */}
      {hasPermission('process') && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Create Categorisation Rule</h2>
          <form onSubmit={handleCreateRule} className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <input
              type="text"
              required
              placeholder="Rule name (e.g. South TN Hub)"
              value={newRule.name}
              onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 md:col-span-2"
            />
            <input
              type="number"
              min={1}
              required
              placeholder="Priority"
              value={newRule.priority}
              onChange={(e) => setNewRule({ ...newRule, priority: Number(e.target.value) })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono-tabular"
            />
            <select
              value={newRule.categoryType}
              onChange={(e) => setNewRule({ ...newRule, categoryType: e.target.value })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="CUSTOM">Custom Category</option>
              <option value="CUSTOMER_TYPE">Customer Type</option>
              <option value="BUSINESS_CATEGORY">Business Category</option>
            </select>
            <input
              type="text"
              required
              placeholder="Target Category Value"
              value={newRule.categoryValue}
              onChange={(e) => setNewRule({ ...newRule, categoryValue: e.target.value })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 md:col-span-2"
            />

            <select
              value={newRule.field}
              onChange={(e) => setNewRule({ ...newRule, field: e.target.value })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="city">City</option>
              <option value="district">District</option>
              <option value="state">State</option>
              <option value="street">Street</option>
              <option value="pin_code">PIN Code</option>
              <option value="full_name">Customer Name</option>
              <option value="other_fields">Other Fields</option>
            </select>
            <select
              value={newRule.matchType}
              onChange={(e) => setNewRule({ ...newRule, matchType: e.target.value as any })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="EQUALS">Equals</option>
              <option value="CONTAINS">Contains</option>
              <option value="IN">In (comma list)</option>
              <option value="REGEX">Regex</option>
            </select>
            <input
              type="text"
              required
              placeholder="Match value (e.g. Madurai, Tirunelveli)"
              value={newRule.value}
              onChange={(e) => setNewRule({ ...newRule, value: e.target.value })}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 md:col-span-3"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Rule
            </button>
          </form>

          {rules.length > 0 && (
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 px-3">Priority</th>
                    <th className="py-2 px-3">Rule Name</th>
                    <th className="py-2 px-3">Condition</th>
                    <th className="py-2 px-3">Assigns Category</th>
                    <th className="py-2 px-3 text-right">Delete</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 px-3 font-mono-tabular">{r.priority}</td>
                      <td className="py-2 px-3 font-medium">{r.name}</td>
                      <td className="py-2 px-3 font-mono-tabular text-slate-600 dark:text-slate-400">
                        {r.conditions?.clauses?.map((c) => `${c.field} ${c.matchType} "${c.value}"`).join(' AND ')}
                      </td>
                      <td className="py-2 px-3">
                        {r.category_type} · <span className="font-semibold">{r.category_value}</span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        {hasPermission('delete') && (
                          <button
                            type="button"
                            onClick={() => void handleDeleteRule(r.id)}
                            className="text-red-600 hover:underline cursor-pointer"
                            aria-label={`Delete rule ${r.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5 inline" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
