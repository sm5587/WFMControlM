// ============================================================
// Admin Config — View & edit all AppConfig entries
// ============================================================

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi } from '../../services/api';
import { useConfig } from '../../contexts/ConfigContext';
import { Save, Eye, EyeOff, Search, RotateCcw, AlertTriangle, CheckCircle2, Lock } from 'lucide-react';

type ConfigRow = {
  key: string;
  value: string;
  category: string;
  label: string;
  description: string | null;
  isSecret: boolean;
  updatedBy: string | null;
  updatedAt: string;
};

const CATEGORY_COLORS: Record<string, string> = {
  SECRETS:    'bg-red-100 text-red-700 border-red-200',
  INFRA:      'bg-amber-100 text-amber-700 border-amber-200',
  POLLING:    'bg-sky-100 text-sky-700 border-sky-200',
  THRESHOLDS: 'bg-purple-100 text-purple-700 border-purple-200',
  ENGINE:     'bg-emerald-100 text-emerald-700 border-emerald-200',
  DISPLAY:    'bg-slate-100 text-slate-700 border-slate-200',
};

export default function AdminConfig() {
  const queryClient = useQueryClient();
  const { reload: reloadConfig } = useConfig();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** Keys whose secret values are currently visible (separate from value — empty secrets are valid). */
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'warning'; msg: string } | null>(null);

  const { data: rows = [], isLoading } = useQuery<ConfigRow[]>({
    queryKey: ['admin-config'],
    queryFn: async () => {
      const res = await configApi.getAll();
      const data = res.data;
      // Backend returns a Record<string, ConfigRow> — convert to array
      if (data && !Array.isArray(data)) {
        return Object.values(data) as ConfigRow[];
      }
      return (data ?? []) as ConfigRow[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: (updates: Array<{ key: string; value: string }>) => configApi.update(updates),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['admin-config'] });
      reloadConfig(); // refresh global config context so other pages see new values
      setEdits({});
      const restart = res?.data?.requiresRestart;
      setToast({
        type: restart ? 'warning' : 'success',
        msg: restart
          ? `Saved ${res.data.updated} key(s). Server restart required for INFRA changes.`
          : `Saved ${res.data.updated} key(s) successfully.`,
      });
      setTimeout(() => setToast(null), 5000);
    },
    onError: (err: any) => {
      setToast({ type: 'error', msg: err?.response?.data?.error || 'Save failed' });
      setTimeout(() => setToast(null), 5000);
    },
  });

  const revealMutation = useMutation({
    mutationFn: (key: string) => configApi.reveal(key),
  });

  const isRevealed = (key: string) => revealedKeys.has(key);

  const handleRevealToggle = (key: string) => {
    if (isRevealed(key)) {
      setRevealedKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    revealMutation.mutate(key, {
      onSuccess: (res: any) => {
        const value = res?.data?.value ?? '';
        setRevealedValues(prev => ({ ...prev, [key]: value }));
        setRevealedKeys(prev => new Set(prev).add(key));
      },
      onError: (err: Error) => {
        setToast({ type: 'error', msg: err.message || 'Failed to reveal secret' });
        setTimeout(() => setToast(null), 5000);
      },
    });
  };

  const categories = useMemo(() => {
    const cats = new Set<string>();
    rows.forEach(r => cats.add(r.category));
    return Array.from(cats).sort();
  }, [rows]);

  // Show all config keys, allow show/hide per row
  const [hiddenKeys, setHiddenKeys] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<'all' | 'hidden'>('all');

  const visibleRows = useMemo(() => {
    let result = rows.filter(r => !hiddenKeys[r.key]);
    if (activeCategory) result = result.filter(r => r.category === activeCategory);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r =>
        r.key.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [rows, activeCategory, search, hiddenKeys]);

  const hiddenRows = useMemo(() => {
    let result = rows.filter(r => hiddenKeys[r.key]);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r =>
        r.key.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [rows, search, hiddenKeys]);

  const handleHide = (key: string) => {
    setHiddenKeys(prev => ({ ...prev, [key]: true }));
  };
  const handleShow = (key: string) => {
    setHiddenKeys(prev => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
  };

  const dirtyCount = Object.keys(edits).length;

  const handleSave = () => {
    const updates = Object.entries(edits).map(([key, value]) => ({ key, value }));
    if (updates.length > 0) saveMutation.mutate(updates);
  };

  const handleDiscard = () => {
    setEdits({});
    setRevealedKeys(new Set());
    setRevealedValues({});
  };

  const getDisplayValue = (row: ConfigRow): string => {
    if (edits[row.key] !== undefined) return edits[row.key];
    if (row.isSecret && isRevealed(row.key)) {
      return revealedValues[row.key] ?? '';
    }
    return row.value;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-zebra-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-800">Application Configuration</h1>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <>
              <span className="text-sm text-amber-600 font-medium">{dirtyCount} unsaved change(s)</span>
              <button onClick={handleDiscard} className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 text-sm border border-gray-200">
                <RotateCcw size={14} /> Discard
              </button>
              <button onClick={handleSave} disabled={saveMutation.isPending}
                className="flex items-center gap-1 px-3 py-1.5 rounded bg-zebra-500 text-white hover:bg-zebra-600 text-sm disabled:opacity-50">
                <Save size={14} /> {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`flex items-center gap-2 px-4 py-2 rounded text-sm border ${
          toast.type === 'success' ? 'bg-green-50 text-green-700 border-green-200' :
          toast.type === 'warning' ? 'bg-amber-50 text-amber-700 border-amber-200' :
          'bg-red-50 text-red-700 border-red-200'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {toast.msg}
        </div>
      )}

      {/* Tabs and Filters */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          <button
            className={`px-3 py-1.5 rounded-t text-xs font-bold border-b-2 ${activeTab === 'all' ? 'border-zebra-500 text-zebra-700 bg-white' : 'border-transparent text-gray-400 bg-gray-50'}`}
            onClick={() => setActiveTab('all')}
          >All</button>
          <button
            className={`px-3 py-1.5 rounded-t text-xs font-bold border-b-2 ${activeTab === 'hidden' ? 'border-zebra-500 text-zebra-700 bg-white' : 'border-transparent text-gray-400 bg-gray-50'}`}
            onClick={() => setActiveTab('hidden')}
          >Hidden</button>
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search config..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-white border border-gray-200 rounded text-sm text-gray-800 placeholder:text-gray-400 focus:ring-1 focus:ring-zebra-400 outline-none"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setActiveCategory(null)}
            className={`px-2.5 py-1 rounded text-xs font-medium border ${!activeCategory ? 'bg-zebra-50 text-zebra-700 border-zebra-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
            All
          </button>
          {categories.map(cat => (
            <button key={cat} onClick={() => setActiveCategory(cat === activeCategory ? null : cat)}
              className={`px-2.5 py-1 rounded text-xs font-medium border ${cat === activeCategory ? (CATEGORY_COLORS[cat] || 'bg-gray-100 text-gray-700') : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-auto max-h-[calc(100vh-260px)] scrollbar-visible">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200 text-gray-500 text-xs uppercase">
                <th className="text-left px-3 py-2.5 w-12">Cat</th>
                <th className="text-left px-3 py-2.5 w-56">Label</th>
                <th className="text-left px-3 py-2.5">Value</th>
                <th className="text-left px-3 py-2.5 w-48">Key</th>
                <th className="text-left px-3 py-2.5 w-36">Updated By</th>
                <th className="text-left px-3 py-2.5 w-28">Updated At</th>
                <th className="text-left px-3 py-2.5 w-20">Show/Hide</th>
              </tr>
            </thead>
            <tbody>
              {(activeTab === 'all' ? visibleRows : hiddenRows).map(row => {
                const isDirty = edits[row.key] !== undefined;
                return (
                  <tr key={row.key} className={`border-b border-gray-100 hover:bg-gray-50 ${isDirty ? 'bg-amber-50/50' : ''}`}>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${CATEGORY_COLORS[row.category] || 'bg-gray-100 text-gray-600'}`}>
                        {row.category.slice(0, 4)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {row.isSecret && <Lock size={12} className="text-red-500 shrink-0" />}
                        <div>
                          <div className="text-gray-800 font-medium text-xs">{row.label}</div>
                          {row.description && <div className="text-gray-400 text-[10px] leading-tight">{row.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <input
                          type={row.isSecret && !isRevealed(row.key) && edits[row.key] === undefined ? 'password' : 'text'}
                          value={getDisplayValue(row)}
                          onChange={e => setEdits(prev => ({ ...prev, [row.key]: e.target.value }))}
                          className={`w-full bg-gray-50 border rounded px-2 py-1 text-xs font-mono outline-none focus:ring-1 focus:ring-zebra-400 ${isDirty ? 'border-amber-400 text-amber-800 bg-amber-50' : 'border-gray-200 text-gray-700'}`}
                        />
                        {row.isSecret && (
                          <button
                            type="button"
                            onClick={() => handleRevealToggle(row.key)}
                            disabled={revealMutation.isPending && revealMutation.variables === row.key}
                            className="p-1 text-gray-400 hover:text-gray-700 shrink-0 disabled:opacity-40"
                            title={isRevealed(row.key) ? 'Hide' : 'Reveal'}
                          >
                            {isRevealed(row.key) ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-400 font-mono text-[10px]">{row.key}</td>
                    <td className="px-3 py-2 text-gray-600 text-xs font-medium">{row.updatedBy || '—'}</td>
                    <td className="px-3 py-2 text-gray-400 text-[10px]">
                      {row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {activeTab === 'all' ? (
                        <button
                          className="px-2 py-1 rounded text-xs font-medium border bg-gray-200 text-gray-500"
                          onClick={() => handleHide(row.key)}
                        >Hide</button>
                      ) : (
                        <button
                          className="px-2 py-1 rounded text-xs font-medium border bg-green-100 text-green-700 border-green-200"
                          onClick={() => handleShow(row.key)}
                        >Show</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(activeTab === 'all' ? visibleRows : hiddenRows).length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">No config entries found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-gray-400">
        {rows.length} total entries · {(activeTab === 'all' ? visibleRows.length : hiddenRows.length)} shown · SECRETS are AES-256-GCM encrypted at rest · INFRA changes require server restart
      </div>
    </div>
  );
}
