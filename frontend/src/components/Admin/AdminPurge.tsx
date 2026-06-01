import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Play, RefreshCw, ToggleLeft, ToggleRight, Clock, Database } from 'lucide-react';
import { adminApi, PurgeConfig } from '../../services/api';
import { usePermission } from '../../context/AuthContext';

function formatAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Never';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function AdminPurge() {
  const canView   = usePermission('DATA_PURGE_VIEW', 'read');
  const canManage = usePermission('DATA_PURGE_RUN',  'write');
  const qc = useQueryClient();
  const [runningAll, setRunningAll] = useState(false);
  const [runningOne, setRunningOne] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<any | null>(null);
  const [editingDays, setEditingDays] = useState<Record<string, string>>({});

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['purge-config'],
    queryFn: adminApi.getPurgeConfig,
    enabled: canView,
  });

  const configs: PurgeConfig[] = data?.data?.configs ?? [];
  const counts: Record<string, number> = data?.data?.counts ?? {};

  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { retainDays?: number; enabled?: boolean } }) =>
      adminApi.updatePurgeConfig(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purge-config'] }),
  });

  const handleDaysBlur = (id: string) => {
    const raw = editingDays[id];
    if (raw === undefined) return;
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= -1) {
      updateMut.mutate({ id, payload: { retainDays: val } });
    }
    setEditingDays(p => { const n = { ...p }; delete n[id]; return n; });
  };

  const handleRunAll = async () => {
    setRunningAll(true);
    setLastSummary(null);
    try {
      const res = await adminApi.runPurgeAll();
      setLastSummary(res.data);
      refetch();
    } finally {
      setRunningAll(false);
    }
  };

  const handleRunOne = async (id: string) => {
    setRunningOne(id);
    try {
      await adminApi.runPurgeOne(id);
      refetch();
    } finally {
      setRunningOne(null);
    }
  };

  if (!canView) {
    return (
      <div className="p-8 text-center text-gray-400 text-sm">
        You don't have permission to view purge settings.
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-red-500" />
            Data Purge Settings
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Nightly purge runs at <span className="font-mono font-medium">02:00</span> server time.
            Configure retention per table or trigger a manual run.
          </p>
        </div>
        {canManage && (
          <button
            onClick={handleRunAll}
            disabled={runningAll}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
          >
            {runningAll
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <Play className="w-4 h-4" />}
            {runningAll ? 'Running…' : 'Run All Now'}
          </button>
        )}
      </div>

      {/* Config table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <table className="w-full resizable-cols">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Table</th>
              <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Rows Now</th>
              <th className="px-5 py-3 text-center text-xs font-semibold text-gray-500 uppercase">Retain (days)</th>
              <th className="px-5 py-3 text-center text-xs font-semibold text-gray-500 uppercase">Enabled</th>
              <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Last Purge</th>
              <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Deleted</th>
              {canManage && <th className="px-5 py-3" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              <tr><td colSpan={7} className="py-8 text-center text-gray-400 text-sm">Loading…</td></tr>
            ) : configs.map(cfg => {
              const rowCount = counts[cfg.id] ?? 0;
              const isEditingDays = editingDays[cfg.id] !== undefined;
              const daysValue = isEditingDays ? editingDays[cfg.id] : String(cfg.retainDays);

              return (
                <tr key={cfg.id} className={`hover:bg-gray-50 transition-colors ${!cfg.enabled ? 'opacity-50' : ''}`}>
                  {/* Table name */}
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Database className="w-3.5 h-3.5 text-gray-400" />
                      <span className="text-sm font-medium text-gray-800">{cfg.label}</span>
                      <span className="text-xs font-mono text-gray-400">{cfg.id}</span>
                    </div>
                  </td>

                  {/* Row count */}
                  <td className="px-5 py-3 text-right">
                    <span className={`text-sm font-mono font-medium ${rowCount > 10000 ? 'text-red-600' : rowCount > 1000 ? 'text-amber-600' : 'text-gray-700'}`}>
                      {rowCount.toLocaleString()}
                    </span>
                  </td>

                  {/* Retain days — editable */}
                  <td className="px-5 py-3 text-center">
                    {canManage ? (
                      <div className="flex items-center justify-center gap-1">
                        <input
                          type="number"
                          min={-1}
                          value={daysValue}
                          onChange={e => setEditingDays(p => ({ ...p, [cfg.id]: e.target.value }))}
                          onBlur={() => handleDaysBlur(cfg.id)}
                          onKeyDown={e => { if (e.key === 'Enter') handleDaysBlur(cfg.id); }}
                          className="w-16 px-2 py-1 text-sm text-center border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-zebra-300"
                        />
                        <span className="text-xs text-gray-400">d</span>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-700">
                        {cfg.retainDays === -1 ? 'Never' : `${cfg.retainDays}d`}
                      </span>
                    )}
                    {cfg.retainDays === -1 && (
                      <p className="text-xs text-gray-400 text-center">keep forever</p>
                    )}
                  </td>

                  {/* Enabled toggle */}
                  <td className="px-5 py-3 text-center">
                    {canManage ? (
                      <button
                        onClick={() => updateMut.mutate({ id: cfg.id, payload: { enabled: !cfg.enabled } })}
                        className="text-gray-500 hover:text-zebra-600 transition-colors"
                        title={cfg.enabled ? 'Disable purge for this table' : 'Enable purge for this table'}
                      >
                        {cfg.enabled
                          ? <ToggleRight className="w-6 h-6 text-green-500" />
                          : <ToggleLeft className="w-6 h-6 text-gray-300" />}
                      </button>
                    ) : (
                      <span className={`text-xs font-medium ${cfg.enabled ? 'text-green-600' : 'text-gray-400'}`}>
                        {cfg.enabled ? 'On' : 'Off'}
                      </span>
                    )}
                  </td>

                  {/* Last purge */}
                  <td className="px-5 py-3 text-right">
                    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                      <Clock className="w-3 h-3" />
                      {formatAgo(cfg.lastPurgeAt)}
                    </span>
                  </td>

                  {/* Last deleted count */}
                  <td className="px-5 py-3 text-right">
                    <span className="text-sm font-mono text-gray-600">
                      {cfg.lastPurgeCount != null ? cfg.lastPurgeCount.toLocaleString() : '—'}
                    </span>
                  </td>

                  {/* Run now button */}
                  {canManage && (
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => handleRunOne(cfg.id)}
                        disabled={!!runningOne || !cfg.enabled}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Run purge for this table now"
                      >
                        {runningOne === cfg.id
                          ? <RefreshCw className="w-3 h-3 animate-spin" />
                          : <Play className="w-3 h-3" />}
                        Run
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Helper note */}
      <div className="text-xs text-gray-400 space-y-1">
        <p><span className="font-medium">Retain days = -1</span> → disabled (keep all rows forever)</p>
        <p><span className="font-medium">Retain days = 0</span> → delete all rows every run</p>
        <p><span className="font-medium text-amber-600">Alert Events</span> — only acknowledged events are purged; open/unacknowledged are kept regardless.</p>
        <p><span className="font-medium text-amber-600">Escalated Alerts</span> — only resolved/suppressed alerts are purged; OPEN alerts are always kept.</p>
      </div>

      {/* Last run summary */}
      {lastSummary && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            Last Manual Run — {lastSummary.totalDeleted.toLocaleString()} rows deleted in {lastSummary.durationMs}ms
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {lastSummary.results?.map((r: any) => (
              <div key={r.table} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-gray-100 text-xs">
                <span className="text-gray-600">{r.label}</span>
                {r.skipped
                  ? <span className="text-gray-400">skipped</span>
                  : r.error
                    ? <span className="text-red-500">{r.error}</span>
                    : <span className="font-mono font-medium text-red-600">−{r.deleted.toLocaleString()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
