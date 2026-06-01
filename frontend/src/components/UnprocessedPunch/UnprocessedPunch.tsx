import React, { useMemo, useState, useCallback } from 'react';
import {
  Timer, Loader2, RefreshCw, AlertTriangle, CheckCircle,
  Search, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { unprocessedPunchApi } from '../../services/api';
import { useProgressivePunchData, PunchRow } from '../../hooks/useProgressivePunchData';

// ============================================================
// Unprocessed Punch Page
// Progressive loading via SSE - all client rows render immediately
// (in loading state), data fills in as each DB2 query completes.
// ============================================================

function CountBadge({ count, loading }: { count: number | null; loading?: boolean }) {
  if (loading) return <span className="inline-block w-12 h-4 bg-gray-200 rounded animate-pulse" />;
  if (count === null) return <span className="text-xs text-gray-400">-</span>;
  if (count === 0)
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
        <CheckCircle className="w-3 h-3" /> 0
      </span>
    );
  if (count <= 50)
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
        <AlertTriangle className="w-3 h-3" /> {count.toLocaleString()}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
      <AlertTriangle className="w-3 h-3" /> {count.toLocaleString()}
    </span>
  );
}

export default function UnprocessedPunch() {
  const [search, setSearch] = useState('');
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [isHighAlertRefreshing, setIsHighAlertRefreshing] = useState(false);
  const [refreshingRows, setRefreshingRows] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { rows, total, loaded, status, fetchedAt, start } = useProgressivePunchData();

  const isStreaming = status === 'connecting' || status === 'streaming';
  const isDone      = status === 'done';

  // Update a row in the shared React Query cache so it persists across navigation
  const updateCachedRow = useCallback((clientId: string, updated: Partial<PunchRow>) => {
    queryClient.setQueryData<{ data: PunchRow[]; fetchedAt: string }>(['unprocessed-punch-all'], prev => {
      if (!prev) return prev;
      return {
        ...prev,
        data: prev.data.map(r => r.clientId === clientId ? { ...r, ...updated } : r),
      };
    });
  }, [queryClient]);

  const refreshRow = async (clientId: string) => {
    if (refreshingRows.has(clientId)) return;
    setRefreshingRows(prev => new Set(prev).add(clientId));
    try {
      const res = await unprocessedPunchApi.getPunchCount(clientId);
      const data = (res as any)?.data;
      if (data) updateCachedRow(clientId, {
        punchCount: data.punchCount ?? null,
        lastUpdateTime: data.lastUpdateTime ?? null,
        dbCurrentTime: data.dbCurrentTime ?? null,
        executionTimeMs: data.executionTimeMs ?? null,
        error: null,
        loading: false,
      });
    } finally {
      setRefreshingRows(prev => { const s = new Set(prev); s.delete(clientId); return s; });
    }
  };

  // Filter by search
  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return rows;
    return rows.filter(
      r =>
        r.clientId.toLowerCase().includes(term) ||
        (r.name || '').toLowerCase().includes(term) ||
        (r.cluster || '').toLowerCase().includes(term),
    );
  }, [rows, search]);

  // Group by cluster
  const grouped = useMemo(() => {
    const map = new Map<string, PunchRow[]>();
    for (const r of filtered) {
      const key = r.cluster || '(No Cluster)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // Totals (only from loaded rows)
  const loadedRows = rows.filter(r => !r.loading);
  const totalPunches = loadedRows.reduce((s, r) => s + (r.punchCount ?? 0), 0);
  const errorCount   = loadedRows.filter(r => r.error).length;

  const highAlertRows = useMemo(
    () => loadedRows.filter(r => (r.punchCount ?? 0) > 500).sort((a, b) => (b.punchCount ?? 0) - (a.punchCount ?? 0)),
    [loadedRows]
  );
  const visibleHighAlertRows = highAlertRows;

  async function refreshHighAlert() {
    if (isHighAlertRefreshing) return;
    setIsHighAlertRefreshing(true);
    await Promise.all(
      highAlertRows.map(async base => {
        try {
          const resp = await unprocessedPunchApi.getPunchCount(base.clientId);
          const d = (resp as any)?.data;
          if (d) updateCachedRow(base.clientId, {
            punchCount: d.punchCount ?? null,
            lastUpdateTime: d.lastUpdateTime ?? null,
            dbCurrentTime: d.dbCurrentTime ?? null,
            executionTimeMs: d.executionTimeMs ?? null,
            error: null,
          });
        } catch (err: any) {
          updateCachedRow(base.clientId, { error: err.message });
        }
      })
    );
    setIsHighAlertRefreshing(false);
  }

  function toggleCluster(cluster: string) {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      next.has(cluster) ? next.delete(cluster) : next.add(cluster);
      return next;
    });
  }

  const lastRefreshed = fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : null;
  const progressPct   = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* â”€â”€ Header â”€â”€ */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Timer className="w-6 h-6 text-zebra-500 flex-shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Unprocessed Punch</h1>
            <p className="text-xs text-gray-400">
              <span className="font-mono">RWSUSER.TA_UNPROC_PUNCH</span> - PROCESS_FLAG = N, past 2 days - RTA clients only
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Progress bar while streaming */}
          {isStreaming && total > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-32 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 whitespace-nowrap">{loaded}/{total}</span>
            </div>
          )}
          {lastRefreshed && !isStreaming && (
            <span className="text-xs text-gray-400 hidden sm:block">Refreshed {lastRefreshed}</span>
          )}
          <button
            onClick={() => {
              start();
            }}
            disabled={isStreaming}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isStreaming ? 'animate-spin' : ''}`} />
            {isStreaming ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* â”€â”€ Summary Cards â”€â”€ */}
      {rows.length > 0 && (
        <div className="px-6 py-3 grid grid-cols-3 gap-3">
          <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 text-center">
            <p className="text-2xl font-bold text-gray-900">{total}</p>
            <p className="text-xs text-gray-500 mt-0.5">RTA Clients
              {isStreaming && <span className="ml-1 text-indigo-500">({loaded} loaded)</span>}
            </p>
          </div>
          <div className={`rounded-lg border px-4 py-3 text-center ${totalPunches === 0 ? 'bg-green-50 border-green-200' : totalPunches <= 200 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
            <p className={`text-2xl font-bold ${totalPunches === 0 ? 'text-green-700' : totalPunches <= 200 ? 'text-amber-700' : 'text-red-700'}`}>
              {totalPunches.toLocaleString()}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">Total Pending Punches{isStreaming && <span className="text-gray-400"> (partial)</span>}</p>
          </div>
          <div className={`rounded-lg border px-4 py-3 text-center ${errorCount === 0 ? 'bg-white border-gray-200' : 'bg-red-50 border-red-200'}`}>
            <p className={`text-2xl font-bold ${errorCount === 0 ? 'text-gray-900' : 'text-red-700'}`}>{errorCount}</p>
            <p className="text-xs text-gray-500 mt-0.5">Query Errors</p>
          </div>
        </div>
      )}

      {/* â”€â”€ High Alert Section (> 500 pending) â”€â”€ */}
      {visibleHighAlertRows.length > 0 && (
        <div className="px-6 pb-3">
          <div className="rounded-lg border border-amber-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-amber-50 border-b border-amber-100">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                <span className="text-sm font-semibold text-amber-700">High Pending - {visibleHighAlertRows.length} client{visibleHighAlertRows.length !== 1 ? 's' : ''} exceeding 500</span>
              </div>
              <button
                onClick={refreshHighAlert}
                disabled={isHighAlertRefreshing}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-amber-700 border border-amber-200 rounded-md hover:bg-amber-100 disabled:opacity-50 transition-colors bg-white"
              >
                <RefreshCw className={`w-3 h-3 ${isHighAlertRefreshing ? 'animate-spin' : ''}`} />
                {isHighAlertRefreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm resizable-cols">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Cluster</th>
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Client</th>
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Pending Punches</th>
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Update Time</th>
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">DB Current Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleHighAlertRows.map(base => {
                    const r = base;
                    return (
                      <tr key={r.clientId} className="hover:bg-amber-50/40 transition-colors">
                        <td className="px-4 py-2.5 text-xs text-gray-500 font-medium">{r.cluster || '-'}</td>
                        <td className="px-4 py-2.5 font-mono text-xs font-bold text-gray-800">{r.clientId}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-600">{r.name && r.name !== r.clientId ? r.name : ''}</td>
                        <td className="px-4 py-2.5 text-right">
                          {r.error
                            ? <span className="inline-flex items-center gap-1 text-xs text-red-500" title={r.error}><AlertTriangle className="w-3 h-3" /> Error</span>
                            : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                                <AlertTriangle className="w-3 h-3" /> {(r.punchCount ?? 0).toLocaleString()}
                              </span>
                          }
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{r.lastUpdateTime ?? '-'}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{r.dbCurrentTime ?? '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Search â”€â”€ */}
      {rows.length > 0 && (
        <div className="px-6 pb-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search client or cluster..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-zebra-400"
            />
          </div>
        </div>
      )}

      {/* â”€â”€ Initial connecting spinner (only before first row) â”€â”€ */}
      {status === 'connecting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-indigo-400" />
          <p className="text-sm text-gray-500">Connecting...</p>
        </div>
      )}

      {/* â”€â”€ Table â”€â”€ */}
      {rows.length > 0 && (
        <div className="flex-1 overflow-auto px-6 pb-6">
          {grouped.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">No clients found</div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm resizable-cols">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-36">Cluster</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Client</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-40">Pending Punches</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">Last Update Time</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">DB Current Time</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {grouped.map(([cluster, clusterRows]) => {
                    const collapsed = collapsedClusters.has(cluster);
                    const clusterTotal = clusterRows.reduce((s, r) => s + (r.punchCount ?? 0), 0);
                    return (
                      <React.Fragment key={cluster}>
                        <tr
                          className="bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
                          onClick={() => toggleCluster(cluster)}
                        >
                          <td colSpan={3} className="px-4 py-2 font-semibold text-slate-700 text-xs uppercase tracking-wider">
                            <span className="flex items-center gap-2">
                              {collapsed
                                ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                                : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                              }
                              {cluster}
                              <span className="font-normal text-slate-400">({clusterRows.length} clients)</span>
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <CountBadge count={clusterTotal} />
                          </td>
                          <td className="px-4 py-2" />
                          <td className="px-4 py-2" />
                          <td className="px-4 py-2" />
                        </tr>
                        {!collapsed && clusterRows.map(rawR => {
                          const r = rawR;
                          const isRefreshing = refreshingRows.has(r.clientId);
                          return (
                            <tr key={r.clientId} className={`hover:bg-gray-50 transition-colors ${r.loading ? 'animate-pulse' : ''}`}>
                              <td className="px-4 py-2.5 text-gray-400 text-xs pl-10">-</td>
                              <td className="px-4 py-2.5 font-mono text-xs font-semibold text-gray-800">{r.clientId}</td>
                              <td className="px-4 py-2.5 text-gray-600 text-xs">{r.name && r.name !== r.clientId ? r.name : ''}</td>
                              <td className="px-4 py-2.5 text-right">
                                {r.error
                                  ? <span className="inline-flex items-center gap-1 text-xs text-red-500" title={r.error}><AlertTriangle className="w-3 h-3" /> Error</span>
                                  : <CountBadge count={r.punchCount} loading={r.loading} />
                                }
                              </td>
                              <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">
                                {r.loading ? <span className="inline-block w-28 h-3 bg-gray-200 rounded animate-pulse" /> : (r.lastUpdateTime ?? (r.error ? <span className="text-red-400">-</span> : '-'))}
                              </td>
                              <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">
                                {r.loading ? <span className="inline-block w-28 h-3 bg-gray-200 rounded animate-pulse" /> : (r.dbCurrentTime ?? (r.error ? <span className="text-red-400">-</span> : '-'))}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                <button
                                  onClick={() => refreshRow(r.clientId)}
                                  disabled={isRefreshing || !!r.loading}
                                  title="Refresh this client"
                                  className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 transition-colors text-gray-400 hover:text-gray-600"
                                >
                                  <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
