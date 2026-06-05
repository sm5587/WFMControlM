import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database, Server, RefreshCw, Search, CheckCircle, XCircle,
  AlertTriangle, ChevronDown, ChevronRight, Loader2, Clock, BarChart3,
  Activity, WifiOff, Layers
} from 'lucide-react';
import { dbMonitorApi } from '../../services/api';
import { useProgressiveBatchData } from '../../hooks/useProgressiveBatchData';
import { useBatchLookbackDays } from '../../hooks/useBatchLookbackDays';
import { useDbClientConnections } from '../../hooks/useDbClientConnections';
import { useTimezone } from '../../hooks/useTimezone';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { SortableHeader, useSortState } from '../ui/SortableHeader';

// ============================================================
// DB Monitor Page — Batch Status from DB2
// ============================================================

const THIRTY_MINUTES = 30 * 60 * 1000;

export default function DBMonitor() {
  const { fmt } = useTimezone();
  const { getInt } = useConfig();
  const batchCacheTtlMins = getInt('polling.batchCacheTtlMins', 30);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [expandedJob, setExpandedJob] = useState<{ jobType: string; planType: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const configBatchDays = useBatchLookbackDays();
  const [days, setDays] = useState(configBatchDays);
  const [clusterFilter, setClusterFilter] = useState('');
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());

  // Resizable left panel
  const { width: leftWidth, dragHandleProps } = useResizablePanel('dbMonitor-leftPanel', 260, 180, 480);

  // Sortable columns for job groups
  const { sortColumn: grpSort, sortDirection: grpDir, handleSort: handleGrpSort } = useSortState('jobType');

  // Sync from master header filter
  const { selectedCluster, selectedClientId, clients: globalClients } = useGlobalFilter();
  useEffect(() => { setClusterFilter(selectedCluster); }, [selectedCluster]);
  useEffect(() => {
    if (!selectedClientId) { setSelectedClient(null); return; }
    const gc = globalClients.find(c => c.id === selectedClientId);
    if (!gc) return;
    // clients from useDbClientConnections keyed by clientId short code
    setSelectedClient((prev: any) => prev?.clientId === gc.clientId ? prev : { clientId: gc.clientId, name: gc.name, cluster: gc.cluster });
  }, [selectedClientId, globalClients]);

  // Cached client list + connection status (30 min)
  const {
    clients,
    clientsLoading,
    connStatus,
    connTesting,
    refetchConnections,
  } = useDbClientConnections();

  // Progressive all-clients batch data
  const {
    clients: batchClients,
    clientNames: batchClientNames,
    pendingAlerts: batchPendingAlerts,
    total: batchTotal,
    loaded: batchLoaded,
    status: batchStatus,
    fetchedAt: batchFetchedAt,
    start: startBatch,
  } = useProgressiveBatchData(days);

  const allBatchFetching = batchStatus === 'connecting' || batchStatus === 'streaming';
  const allBatchLoading = batchStatus === 'connecting';
  const allBatchData = batchStatus === 'done' || batchLoaded > 0 ? {
    clients: batchClients,
    pendingAlerts: batchPendingAlerts,
    clientNames: batchClientNames,
    fetchedAt: batchFetchedAt,
  } : null;

  // Per-client refresh: fetch just one client's batch data and merge into cache
  const queryClient = useQueryClient();
  const [refreshingClient, setRefreshingClient] = useState(false);

  // Recompute pendingAlerts from the full clients map
  const recomputeAlerts = useCallback((clientsMap: Record<string, any>, clientNames: Record<string, string>) => {
    const alerts: any[] = [];
    for (const [cid, data] of Object.entries(clientsMap)) {
      const groups = (data as any)?.groups || [];
      const totalPending = groups.reduce((s: number, g: any) => s + (g.pending || 0), 0);
      const stalePendingCount = groups.reduce((s: number, g: any) => s + (g.stalePending || 0), 0);
      if (stalePendingCount > 0) {
        alerts.push({ clientId: cid, clientName: clientNames[cid] || cid, stalePendingCount, totalPending });
      }
    }
    return alerts.sort((a, b) => b.stalePendingCount - a.stalePendingCount);
  }, []);

  const refreshSelectedClient = useCallback(async () => {
    if (!selectedClient) return;
    setRefreshingClient(true);
    try {
      const res = await dbMonitorApi.getBatchStatus(selectedClient.clientId, days);
      const groups = res?.data || [];
      // Merge into the shared batch cache (same key as Alerts / Dashboard)
      queryClient.setQueryData(['all-batch-status', days], (old: any) => {
        const base = old ?? { clients: {}, clientNames: {}, pendingAlerts: [], fetchedAt: null };
        const updatedClients = {
          ...base.clients,
          [selectedClient.clientId]: { clientId: selectedClient.clientId, groups, loading: false },
        };
        const clientNames = base.clientNames?.[selectedClient.clientId]
          ? base.clientNames
          : { ...base.clientNames, [selectedClient.clientId]: selectedClient.name || selectedClient.clientId };
        return {
          ...base,
          clients: updatedClients,
          clientNames,
          pendingAlerts: recomputeAlerts(updatedClients, clientNames),
          fetchedAt: new Date().toISOString(),
        };
      });
      // Escalation processing runs on the backend after batch-status — invalidate so Escalated tab updates
      queryClient.invalidateQueries({ queryKey: ['escalated-alerts'] });
    } catch (err: any) {
      queryClient.setQueryData(['all-batch-status', days], (old: any) => {
        if (!old) return old;
        const updatedClients = {
          ...old.clients,
          [selectedClient.clientId]: { clientId: selectedClient.clientId, groups: [], error: err.message, loading: false },
        };
        return {
          ...old,
          clients: updatedClients,
          pendingAlerts: recomputeAlerts(updatedClients, old.clientNames || {}),
        };
      });
    } finally {
      setRefreshingClient(false);
    }
  }, [selectedClient, days, queryClient, recomputeAlerts]);

  // Filtered clients
  const filtered = clients.filter((c: any) => {
    if (!searchTerm) return true;
    return c.clientId.toLowerCase().includes(searchTerm.toLowerCase()) || c.name?.toLowerCase().includes(searchTerm.toLowerCase());
  });

  // Build unique cluster list
  const clusterList = useMemo(() => {
    const set = new Set(clients.map((c: any) => c.cluster).filter(Boolean) as string[]);
    return [...set].sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB;
    });
  }, [clients]);

  // Group sidebar clients by cluster
  const sidebarClusterGroups = useMemo(() => {
    let list = filtered;
    if (clusterFilter) {
      list = list.filter((c: any) => (c.cluster || 'Unassigned') === clusterFilter);
    }
    const groups: Record<string, any[]> = {};
    for (const c of list) {
      const cl = c.cluster || 'Unassigned';
      if (!groups[cl]) groups[cl] = [];
      groups[cl].push(c);
    }
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB;
    });
    return { groups, keys: sortedKeys };
  }, [filtered, clusterFilter]);

  const toggleSidebarCluster = (cl: string) => {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      if (next.has(cl)) next.delete(cl); else next.add(cl);
      return next;
    });
  };

  // Get batch data for selected client from the global cache
  const selectedClientGroups = selectedClient && allBatchData?.clients?.[selectedClient.clientId];
  const jobGroups = selectedClientGroups?.groups || [];
  const batchLoading = allBatchLoading && !allBatchData;
  const clientStillLoading = selectedClientGroups?.loading === true;
  const batchError = selectedClientGroups?.error;

  // Fetch details when a job group is expanded — cached 30 min
  const { data: detailsData, isLoading: detailsLoading, isError: detailsError, error: detailsErrorObj } = useQuery({
    queryKey: ['batch-details', selectedClient?.clientId, expandedJob?.jobType, expandedJob?.planType, days],
    queryFn: () => dbMonitorApi.getBatchDetails(selectedClient!.clientId, expandedJob!.jobType, expandedJob!.planType, days),
    enabled: !!selectedClient && !!expandedJob,
    staleTime: THIRTY_MINUTES,
    gcTime: 60 * 60 * 1000,
    refetchInterval: THIRTY_MINUTES,
    refetchOnWindowFocus: false,
  });

  const jobDetails = detailsData?.data || [];

  // Summary stats
  const totalRuns = jobGroups.reduce((s: number, g: any) => s + g.totalRuns, 0);
  const totalCompleted = jobGroups.reduce((s: number, g: any) => s + g.completed, 0);
  const totalFailed = jobGroups.reduce((s: number, g: any) => s + g.failed, 0);
  const totalActive = jobGroups.reduce((s: number, g: any) => s + g.active + g.pending, 0);

  const groupKey = (g: any) => `${g.jobType}|${g.planType}`;
  const isExpanded = (g: any) => expandedJob?.jobType === g.jobType && expandedJob?.planType === g.planType;

  const toggleExpand = (group: any) => {
    setExpandedJob(isExpanded(group) ? null : { jobType: group.jobType, planType: group.planType });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Database className="w-7 h-7 text-indigo-600" />
            DB Jobs Monitor
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Batch job status from client DB2 databases (BATCH_STATUS table)
            {batchFetchedAt && (
              <span className="ml-2 text-gray-400">
                . Last refreshed: {fmt(batchFetchedAt, 'time')}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => startBatch()}
            disabled={allBatchFetching}
            title={`Reloads the cached batch summary (last full DB2 fetch, up to ${batchCacheTtlMins} min old). For live data, refresh one client below.`}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${allBatchFetching ? 'animate-spin' : ''}`} />
            {allBatchFetching ? 'Reloading cache...' : 'Reload All (cached)'}
          </button>
          <label className="text-sm text-gray-500">Period:</label>
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value, 10))}
            className="px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
          >
            <option value={1}>Last 1 day</option>
            <option value={2}>Last 2 days</option>
            <option value={3}>Last 3 days</option>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
          </select>
        </div>
      </div>

      {/* Global Loading Indicator */}
      {allBatchFetching && !allBatchData && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
          <div>
            <p className="text-sm font-medium text-indigo-700">Fetching batch data for all clients...</p>
            <p className="text-xs text-indigo-500">This may take a few minutes on first load. Data is cached on the server for about {batchCacheTtlMins} minutes.</p>
          </div>
        </div>
      )}

      {/* Progressive Loading Bar */}
      {allBatchFetching && batchTotal > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium text-indigo-700">Loading batch data...</p>
              <span className="text-xs text-indigo-500">{batchLoaded} / {batchTotal} clients</span>
            </div>
            <div className="w-full h-1.5 bg-indigo-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${Math.round((batchLoaded / batchTotal) * 100)}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Global Summary */}
      {allBatchData && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
              <Server className="w-4 h-4" /> Clients Loaded
            </div>
            <p className="text-2xl font-bold text-gray-900">
              {Object.keys(allBatchData.clients).filter(c => !allBatchData.clients[c].error).length}
              <span className="text-sm font-normal text-gray-400 ml-1">/ {Object.keys(allBatchData.clients).length}</span>
            </p>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
              <BarChart3 className="w-4 h-4" /> Total Runs (All Clients)
            </div>
            <p className="text-2xl font-bold text-gray-900">
              {Object.values(allBatchData.clients)
                .reduce((sum, c) => sum + (c.groups?.reduce((s, g) => s + g.totalRuns, 0) || 0), 0)
                .toLocaleString()}
            </p>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> Pending &gt; 30min
            </div>
            <p className="text-2xl font-bold text-amber-600">
              {allBatchData.pendingAlerts.reduce((sum, a) => sum + a.stalePendingCount, 0)}
              <span className="text-sm font-normal text-gray-400 ml-1">across {allBatchData.pendingAlerts.length} clients</span>
            </p>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
              <XCircle className="w-4 h-4 text-red-500" /> Errors
            </div>
            <p className="text-2xl font-bold text-red-600">
              {Object.values(allBatchData.clients).filter(c => c.error).length}
              <span className="text-sm font-normal text-gray-400 ml-1">clients unreachable</span>
            </p>
          </div>
        </div>
      )}

      {/* Main Layout: Client List + Batch Status Panel */}
      <div className="flex gap-0">
        {/* Left: Client List */}
        <div style={{ width: leftWidth, minWidth: 180, maxWidth: 480, flexShrink: 0 }} className="bg-white rounded-xl border overflow-hidden">
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search clients..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <select
              value={clusterFilter}
              onChange={e => setClusterFilter(e.target.value)}
              className="w-full mt-2 px-2 py-1.5 text-xs border rounded-lg focus:ring-2 focus:ring-indigo-300"
            >
              <option value="">All Clusters</option>
              {clusterList.map(cl => (
                <option key={cl} value={cl}>{cl}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-2">
              {clients.length} clients
              {Object.keys(connStatus).length > 0 && (() => {
                const connected = Object.values(connStatus).filter(s => s === 'connected').length;
                const failed = Object.values(connStatus).filter(s => s === 'failed').length;
                return (
                  <span className="ml-1">
                    {connected > 0 && <span className="text-green-600">· {connected} connected</span>}
                    {failed > 0 && <span className="text-red-500 ml-1">· {failed} failed</span>}
                    {connTesting && <span className="text-gray-400 ml-1">· testing...</span>}
                  </span>
                );
              })()}
            </p>
          </div>

          <div className="overflow-auto max-h-[calc(100vh-300px)]">
            {clientsLoading ? (
              <div className="flex items-center justify-center py-12 text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : sidebarClusterGroups.keys.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No clients found</p>
            ) : (
              sidebarClusterGroups.keys.map(clName => {
                const clClients = sidebarClusterGroups.groups[clName];
                const isCollapsed = collapsedClusters.has(clName);
                return (
                  <div key={clName}>
                    <button
                      onClick={() => toggleSidebarCluster(clName)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b text-xs font-semibold text-gray-500 hover:bg-gray-100"
                    >
                      {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      <Layers className="w-3 h-3 text-indigo-400" />
                      {clName}
                      <span className="ml-auto text-gray-400 font-normal">{clClients.length}</span>
                    </button>
                    {!isCollapsed && clClients.map((client: any) => {
                      const clientBatch = allBatchData?.clients?.[client.clientId];
                      const clientStalePending = clientBatch?.groups?.reduce((s: number, g: any) => s + g.stalePending, 0) || 0;
                      const clientHasData = clientBatch && !clientBatch.error && clientBatch.groups?.length > 0;
                      return (
                        <button
                          key={client.clientId}
                          onClick={() => { setSelectedClient(client); setExpandedJob(null); }}
                          className={`w-full text-left px-4 py-2.5 border-b hover:bg-gray-50 transition-colors ${
                            selectedClient?.clientId === client.clientId ? 'bg-indigo-50 border-l-4 border-l-indigo-500' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {connStatus[client.clientId] === 'connected' ? (
                              <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" title="Connected" />
                            ) : connStatus[client.clientId] === 'failed' ? (
                              <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" title="Connection failed" />
                            ) : connTesting ? (
                              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" title="Testing..." />
                            ) : (
                              <span className="w-2.5 h-2.5 rounded-full bg-gray-300 flex-shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm text-gray-900">{client.name || client.clientId}</span>
                                {clientStalePending > 0 && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 text-amber-700" title={`${clientStalePending} pending > 30min`}>
                                    {clientStalePending}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-400 truncate">
                                {client.clientId}
                                {clientHasData
                                  ? ` · ${clientBatch.groups.reduce((s: number, g: any) => s + g.totalRuns, 0)} runs`
                                  : ''}
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div {...dragHandleProps} className="mx-1 flex-shrink-0 w-1.5 rounded-full bg-transparent hover:bg-zebra-300 active:bg-zebra-400 transition-colors cursor-col-resize select-none" />

        {/* Right: Batch Status Panel */}
        <div className="flex-1 min-w-0">
          {!selectedClient ? (
            <div className="bg-white rounded-xl border flex items-center justify-center h-96">
              <div className="text-center text-gray-400">
                <Database className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-lg font-medium">Select a client</p>
                <p className="text-sm">Choose a client from the list to view batch job statuses</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Client Header */}
              <div className="bg-white rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-gray-900">{selectedClient.name || selectedClient.clientId}</h2>
                    <p className="text-sm text-gray-500">
                      {selectedClient.clientId} &middot; {selectedClient.host}/{selectedClient.database} &middot; Port {selectedClient.port}
                    </p>
                  </div>
                  <button
                    onClick={() => refreshSelectedClient()}
                    disabled={refreshingClient}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${refreshingClient ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>
              </div>

              {/* Summary Cards */}
              {jobGroups.length > 0 && (
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-white rounded-xl border p-4">
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                      <BarChart3 className="w-4 h-4" /> Total Runs
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{totalRuns.toLocaleString()}</p>
                  </div>
                  <div className="bg-white rounded-xl border p-4">
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                      <CheckCircle className="w-4 h-4 text-green-500" /> Completed
                    </div>
                    <p className="text-2xl font-bold text-green-600">{totalCompleted.toLocaleString()}</p>
                  </div>
                  <div className="bg-white rounded-xl border p-4">
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                      <XCircle className="w-4 h-4 text-red-500" /> Failed
                    </div>
                    <p className="text-2xl font-bold text-red-600">{totalFailed.toLocaleString()}</p>
                  </div>
                  <div className="bg-white rounded-xl border p-4">
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                      <Activity className="w-4 h-4 text-blue-500" /> Active / Pending
                    </div>
                    <p className="text-2xl font-bold text-blue-600">{totalActive.toLocaleString()}</p>
                  </div>
                </div>
              )}

              {/* Job Groups */}
              <div className="bg-white rounded-xl border">
                <div className="px-4 py-3 border-b">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-sm font-medium text-gray-700">
                      Batch Jobs — Last {days} {days === 1 ? 'Day' : 'Days'}
                    </h3>
                    <span className="text-xs text-gray-400">{jobGroups.length} job types</span>
                  </div>
                  {jobGroups.length > 0 && (
                    <div className="flex items-center gap-1 text-[10px] text-gray-400">
                      Sort:
                      {(['jobType','totalRuns','completed','failed','active'] as const).map(col => (
                        <button
                          key={col}
                          onClick={() => handleGrpSort(col)}
                          className={`px-1.5 py-0.5 rounded transition-colors ${
                            grpSort === col ? 'bg-indigo-100 text-indigo-700 font-medium' : 'hover:bg-gray-100'
                          }`}
                        >
                          {col === 'jobType' ? 'Name' : col === 'totalRuns' ? 'Runs' : col.charAt(0).toUpperCase() + col.slice(1)}
                          {grpSort === col ? (grpDir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {(batchLoading || clientStillLoading) && !jobGroups.length ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                    <span className="ml-2 text-sm text-gray-400">
                      {clientStillLoading ? `Fetching batch data for ${selectedClient?.clientId}...` : 'Loading from cache...'}
                    </span>
                  </div>
                ) : batchError ? (
                  <div className="p-6">
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                      <WifiOff className="w-10 h-10 text-red-400 mb-3" />
                      <p className="text-sm font-medium text-red-700 mb-1">Connection Failed</p>
                      <p className="text-xs text-red-500 max-w-md">
                        {batchError || 'Unable to connect to database'}
                      </p>
                      <button
                        onClick={() => refreshSelectedClient()}
                        disabled={refreshingClient}
                        className="mt-4 flex items-center gap-2 px-4 py-2 text-sm bg-red-50 text-red-700 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className={`w-4 h-4 ${refreshingClient ? 'animate-spin' : ''}`} /> Retry
                      </button>
                    </div>
                  </div>
                ) : jobGroups.length === 0 && !allBatchFetching ? (
                  <div className="text-center py-8">
                    <p className="text-sm text-gray-400">No batch records found</p>
                    <button
                      onClick={() => refreshSelectedClient()}
                      disabled={refreshingClient}
                      className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${refreshingClient ? 'animate-spin' : ''}`} /> Fetch from DB2
                    </button>
                  </div>
                ) : jobGroups.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                    <span className="ml-2 text-sm text-gray-400">Loading batch data...</span>
                  </div>
                ) : (
                  <div className="divide-y">
                    {[...jobGroups]
                      .sort((a: any, b: any) => {
                        const dir = grpDir === 'asc' ? 1 : -1;
                        switch (grpSort) {
                          case 'jobType': return dir * (a.jobType ?? '').localeCompare(b.jobType ?? '');
                          case 'totalRuns': return dir * (a.totalRuns - b.totalRuns);
                          case 'completed': return dir * (a.completed - b.completed);
                          case 'failed': return dir * (a.failed - b.failed);
                          case 'active': return dir * ((a.active + a.pending) - (b.active + b.pending));
                          default: return 0;
                        }
                      })
                      .map((group: any) => (
                      <div key={groupKey(group)}>
                        {/* Group Header — clickable */}
                        <button
                          onClick={() => toggleExpand(group)}
                          className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors flex items-center gap-3"
                        >
                          {isExpanded(group) ? (
                            <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                          )}

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3">
                              <span className="font-semibold text-sm text-gray-900">{group.jobType}</span>
                              {group.planType && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">{group.planType}</span>
                              )}
                              <span className="text-xs text-gray-400 truncate">{group.description}</span>
                            </div>
                            {group.latestRun && (
                              <div className="flex items-center gap-1 mt-0.5">
                                <Clock className="w-3 h-3 text-gray-300" />
                                <span className="text-xs text-gray-400">Latest: {group.latestRun}</span>
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-3 flex-shrink-0">
                            <span className="text-xs font-medium text-gray-500">{group.totalRuns.toLocaleString()} runs</span>
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-medium">
                              <CheckCircle className="w-3 h-3" /> {group.completed.toLocaleString()}
                            </span>
                            {group.failed > 0 && (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 font-medium">
                                <XCircle className="w-3 h-3" /> {group.failed.toLocaleString()}
                              </span>
                            )}
                            {(group.active + group.pending) > 0 && (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">
                                <Activity className="w-3 h-3" /> {(group.active + group.pending).toLocaleString()}
                              </span>
                            )}
                          </div>
                        </button>

                        {/* Expanded Detail Table */}
                        {isExpanded(group) && (
                          <div className="bg-gray-50 border-t px-4 py-3">
                            {detailsLoading ? (
                              <div className="flex items-center justify-center py-6">
                                <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
                                <span className="ml-2 text-sm text-gray-400">Loading details...</span>
                              </div>
                            ) : detailsError ? (
                              <p className="text-sm text-red-600 text-center py-4">
                                Failed to load details: {(detailsErrorObj as Error)?.message || 'Unknown error'}
                              </p>
                            ) : jobDetails.length === 0 ? (
                              <p className="text-sm text-gray-400 text-center py-4">No detail records in the last {days} day{days !== 1 ? 's' : ''}</p>
                            ) : (
                              <>
                              {/* RFX Queue Job Summary */}
                              <div className="flex items-center gap-4 mb-3 px-1">
                                <span className="text-xs font-medium text-gray-500">RFX Queue Jobs:</span>
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-medium">
                                  <CheckCircle className="w-3 h-3" />
                                  {jobDetails.reduce((s: number, d: any) => s + (d.successCount || 0), 0).toLocaleString()} Success
                                </span>
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 font-medium">
                                  <XCircle className="w-3 h-3" />
                                  {jobDetails.reduce((s: number, d: any) => s + (d.failCount || 0), 0).toLocaleString()} Failed
                                </span>
                                {jobDetails.reduce((s: number, d: any) => s + (d.otherCount || 0), 0) > 0 && (
                                  <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">
                                    <AlertTriangle className="w-3 h-3" />
                                    {jobDetails.reduce((s: number, d: any) => s + (d.otherCount || 0), 0).toLocaleString()} Other
                                  </span>
                                )}
                              </div>
                              <div className="overflow-auto max-h-96 rounded-lg border bg-white">
                                <table className="w-full text-sm resizable-cols">
                                  <thead className="bg-gray-100 sticky top-0">
                                    <tr>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">ID</th>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">Status</th>
                                      <th className="text-right px-3 py-2 font-medium text-gray-600">Total Jobs</th>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">Unit SKEY</th>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">Submitted</th>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">Completed</th>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">Duration</th>
                                      <th className="text-left px-3 py-2 font-medium text-gray-600">Description</th>
                                      <th className="text-right px-3 py-2 font-medium text-green-600">Success</th>
                                      <th className="text-right px-3 py-2 font-medium text-red-600">Failed</th>
                                      <th className="text-right px-3 py-2 font-medium text-gray-600">Other</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y">
                                    {jobDetails.map((detail: any) => (
                                      <tr key={detail.batchStatusId} className="hover:bg-gray-50">
                                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{detail.batchStatusId}</td>
                                        <td className="px-3 py-2">
                                          <StatusBadge status={detail.status} label={detail.statusLabel} />
                                        </td>
                                        <td className="px-3 py-2 text-xs text-right text-gray-600">{detail.totalJobs ?? '—'}</td>
                                        <td className="px-3 py-2 text-xs text-gray-600">{detail.unitSkey || '—'}</td>
                                        <td className="px-3 py-2 text-xs text-gray-600">{detail.timeSubmitted || '—'}</td>
                                        <td className="px-3 py-2 text-xs text-gray-600">{detail.timeCompleted || '—'}</td>
                                        <td className="px-3 py-2 text-xs text-gray-600">
                                          {detail.durationSec != null ? formatDuration(detail.durationSec) : '—'}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-gray-500 max-w-xs truncate">{detail.description || '—'}</td>
                                        <td className="px-3 py-2 text-xs text-right">
                                          {detail.successCount > 0 ? (
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">
                                              {detail.successCount}
                                            </span>
                                          ) : <span className="text-gray-300">0</span>}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-right">
                                          {detail.failCount > 0 ? (
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                                              {detail.failCount}
                                            </span>
                                          ) : <span className="text-gray-300">0</span>}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-right text-gray-500">
                                          {detail.otherCount || 0}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Helpers ----

function StatusBadge({ status, label }: { status: string; label: string }) {
  const s = status.toUpperCase();
  let color = 'bg-gray-100 text-gray-600';
  if (s === 'C') color = 'bg-green-100 text-green-700';
  else if (s === 'E' || s === 'F') color = 'bg-red-100 text-red-700';
  else if (s === 'I' || s === 'A') color = 'bg-blue-100 text-blue-700';
  else if (s === 'N') color = 'bg-amber-100 text-amber-700';
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{label}</span>;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
