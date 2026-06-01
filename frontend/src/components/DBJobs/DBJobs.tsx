import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, RefreshCw, ChevronDown, ChevronRight, Layers,
  AlertTriangle, Star, StarOff, Crown, Play, CheckCircle,
  XCircle, Clock, Database
} from 'lucide-react';
import { dbJobsApi } from '../../services/api';
import { useTimezone } from '../../hooks/useTimezone';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { SortableHeader, useSortState } from '../ui/SortableHeader';

// Queue status labels (QUEUE_STATUS from RFX_QUEUE)
const JOB_STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  S: { label: 'Success', color: 'text-green-700 bg-green-50', icon: CheckCircle },
  F: { label: 'Failed', color: 'text-red-700 bg-red-50', icon: XCircle },
  A: { label: 'Active', color: 'text-blue-700 bg-blue-50', icon: Play },
  R: { label: 'Running', color: 'text-blue-700 bg-blue-50', icon: Play },
  N: { label: 'New', color: 'text-gray-700 bg-gray-50', icon: Clock },
  W: { label: 'Waiting', color: 'text-yellow-700 bg-yellow-50', icon: Clock },
  E: { label: 'Error', color: 'text-red-700 bg-red-50', icon: XCircle },
};

interface QueueJob {
  [key: string]: any;
  jobType?: string;
  jobInterval?: string;
  param2?: string;
  lastJobTime?: string;
  jobsPending?: string | number;
  isCritical: boolean;
}

interface ClientInfo {
  clientId: string;
  serverCode: string;
  name: string;
  cluster: string;
  whiteGlove: boolean;
}

export default function DBJobs() {
  const { fmt } = useTimezone();
  const [search, setSearch] = useState('');
  const [clusterFilter, setClusterFilter] = useState('');
  const [selectedClient, setSelectedClient] = useState<string | null>(null);

  // Sync from master header filter
  const { selectedCluster, selectedClientId, clients: globalClients } = useGlobalFilter();
  useEffect(() => { setClusterFilter(selectedCluster); }, [selectedCluster]);
  useEffect(() => {
    if (selectedClientId) {
      const gc = globalClients.find(c => c.id === selectedClientId);
      if (gc) setSelectedClient(gc.clientId);
    } else {
      setSelectedClient(null);
    }
  }, [selectedClientId, globalClients]);
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [jobSearch, setJobSearch] = useState('');
  const [jobFilter, setJobFilter] = useState(''); // cross-client job name filter
  const queryClient = useQueryClient();

  // Resizable left panel
  const { width: leftWidth, dragHandleProps } = useResizablePanel('dbJobs-leftPanel', 360, 200, 600);

  // Sortable columns for the jobs table
  const { sortColumn, sortDirection, handleSort } = useSortState('critical');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['db-jobs-queue-all'],
    queryFn: () => dbJobsApi.getAllQueueJobs(),
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 min (daily cache on backend)
    refetchInterval: 30 * 60 * 1000, // Auto-refresh every 30 min while session is active
  });

  // Bulk fetch all clients from DB2 (expensive, user-triggered)
  const fetchAllMutation = useMutation({
    mutationFn: () => dbJobsApi.fetchAll(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['db-jobs-queue-all'] }),
  });

  const markCriticalMutation = useMutation({
    mutationFn: ({ clientId, jobName }: { clientId: string; jobName: string }) =>
      dbJobsApi.markCritical(clientId, jobName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['db-jobs-queue-all'] }),
  });

  const markCriticalBatchMutation = useMutation({
    mutationFn: (jobs: { clientId: string; jobName: string }[]) =>
      dbJobsApi.markCriticalBatch(jobs),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['db-jobs-queue-all'] }),
    onError: (error: any) => {
      // Keep UI responsive and provide immediate feedback when batch update fails.
      const msg = error?.response?.data?.error || error?.message || 'Failed to mark jobs as critical';
      console.error('[DBJobs] markCriticalBatch failed', error);
      window.alert(msg);
    },
  });

  const unmarkCriticalMutation = useMutation({
    mutationFn: ({ clientId, jobName }: { clientId: string; jobName: string }) =>
      dbJobsApi.unmarkCritical(clientId, jobName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['db-jobs-queue-all'] }),
  });

  // Per-client on-demand refresh
  const refreshClientMutation = useMutation({
    mutationFn: (clientId: string) => dbJobsApi.refreshClient(clientId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['db-jobs-queue-all'] }),
  });

  const clientsData = data?.data?.clients || {};
  const clientInfo: ClientInfo[] = data?.data?.clientInfo || [];
  const isCached = data?.data?.cached || false;
  const isStale = data?.data?.stale || false;
  const isEmpty = data?.data?.empty || false;
  const clientFetchTimes: Record<string, string> = data?.data?.clientFetchTimes || {};

  // Build cluster-grouped client list
  const { clusterGroups, clusterList, allClusters, totalJobs, totalClients, criticalCount } = useMemo(() => {
    const filtered = clientInfo.filter(ci => {
      const searchLower = search.toLowerCase();
      const matchesSearch = !search ||
        ci.clientId.toLowerCase().includes(searchLower) ||
        ci.name.toLowerCase().includes(searchLower) ||
        ci.serverCode.toLowerCase().includes(searchLower);
      const matchesCluster = !clusterFilter || ci.cluster === clusterFilter;
      return matchesSearch && matchesCluster;
    });

    const groups: Record<string, ClientInfo[]> = {};
    for (const ci of filtered) {
      const cl = ci.cluster || 'Unassigned';
      if (!groups[cl]) groups[cl] = [];
      groups[cl].push(ci);
    }

    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB;
    });

    const allCl = [...new Set(clientInfo.map(ci => ci.cluster || 'Unassigned'))].sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0);
    });

    let totalJ = 0;
    let criticalC = 0;
    for (const ci of filtered) {
      const jobs = clientsData[ci.clientId]?.jobs || [];
      totalJ += jobs.length;
      criticalC += jobs.filter((j: QueueJob) => j.isCritical).length;
    }

    return {
      clusterGroups: groups,
      clusterList: sortedKeys,
      allClusters: allCl,
      totalJobs: totalJ,
      totalClients: filtered.length,
      criticalCount: criticalC,
    };
  }, [clientInfo, clientsData, search, clusterFilter]);

  const toggleCluster = (cl: string) => {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      if (next.has(cl)) next.delete(cl); else next.add(cl);
      return next;
    });
  };

  const toggleCritical = (clientId: string, jobName: string, isCritical: boolean) => {
    if (isCritical) {
      unmarkCriticalMutation.mutate({ clientId, jobName });
    } else {
      markCriticalMutation.mutate({ clientId, jobName });
    }
  };

  // Cross-client job filter: flat list of all jobs matching jobFilter across all clients
  const crossClientJobs = useMemo(() => {
    if (!jobFilter.trim()) return [];
    const q = jobFilter.toLowerCase();
    const results: { clientId: string; cluster: string; name: string; whiteGlove: boolean; job: QueueJob }[] = [];
    for (const ci of clientInfo) {
      const matchesCluster = !clusterFilter || ci.cluster === clusterFilter;
      if (!matchesCluster) continue;
      const jobs: QueueJob[] = clientsData[ci.clientId]?.jobs || [];
      for (const job of jobs) {
        const jobName = (job.jobType || job.param2 || '').toLowerCase();
        if (jobName.includes(q)) {
          results.push({ clientId: ci.clientId, cluster: ci.cluster || 'Unassigned', name: ci.name, whiteGlove: ci.whiteGlove, job });
        }
      }
    }
    return results.sort((a, b) => {
      if (a.job.isCritical !== b.job.isCritical) return a.job.isCritical ? -1 : 1;
      return a.cluster.localeCompare(b.cluster) || a.clientId.localeCompare(b.clientId);
    });
  }, [jobFilter, clientInfo, clientsData, clusterFilter]);

  const nonCriticalFilteredJobs = useMemo(
    () => crossClientJobs.filter(r => !r.job.isCritical),
    [crossClientJobs]
  );

  const getJobName = (job: QueueJob) => job.jobType || 'unknown';
  const getJobInterval = (job: QueueJob) => job.jobInterval || '—';
  const getLastJobTime = (job: QueueJob) => job.lastJobTime || null;
  const getJobsPending = (job: QueueJob) => job.jobsPending ?? '—';

  // Get jobs for selected client (with optional search)
  const selectedJobsRaw: QueueJob[] = selectedClient ? (clientsData[selectedClient]?.jobs || []) : [];
  const selectedJobs = useMemo(() => {
    if (!jobSearch) return selectedJobsRaw;
    const q = jobSearch.toLowerCase();
    return selectedJobsRaw.filter(j => {
      const name = (j.jobType || j.param2 || '').toLowerCase();
      return name.includes(q);
    });
  }, [selectedJobsRaw, jobSearch]);
  const selectedError = selectedClient ? clientsData[selectedClient]?.error : null;
  const selectedInfo = clientInfo.find(ci => ci.clientId === selectedClient);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">DB Jobs (RFX Queue)</h1>
          <p className="text-sm text-gray-500 mt-1">
            {totalClients} clients
            {data?.data?.fetchedAt && (
              <span className="text-gray-400 ml-1">
                — {isCached ? 'cached today' : isStale ? 'stale cache' : 'no cache'} {data.data.fetchedAt ? fmt(data.data.fetchedAt) : ''}
              </span>
            )}
            {isEmpty && <span className="text-amber-500 ml-1">— no job data yet, click Fetch All</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchAllMutation.mutate()}
            disabled={fetchAllMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-zebra-600 text-white rounded-lg hover:bg-zebra-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${fetchAllMutation.isPending ? 'animate-spin' : ''}`} />
            {fetchAllMutation.isPending ? 'Fetching from DB2...' : 'Fetch All from DB2'}
          </button>
        </div>
      </div>

      {/* Search & Filter */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search clients by ID or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
          />
        </div>
        {/* Cross-client job filter */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Filter by job name (all clients)…"
            value={jobFilter}
            onChange={(e) => setJobFilter(e.target.value)}
            className={`pl-10 pr-4 py-2 w-64 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300 ${
              jobFilter ? 'border-zebra-400 bg-zebra-50' : 'border-gray-200'
            }`}
          />
          {jobFilter && (
            <button
              onClick={() => setJobFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs px-1"
            >✕</button>
          )}
        </div>
        <select
          value={clusterFilter}
          onChange={(e) => setClusterFilter(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
        >
          <option value="">All Clusters</option>
          {allClusters.map(cl => (
            <option key={cl} value={cl}>{cl}</option>
          ))}
        </select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-blue-50 text-blue-600"><Database className="w-5 h-5" /></div>
          <div><p className="text-2xl font-bold text-gray-900">{totalClients}</p><p className="text-xs text-gray-500">Clients</p></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-green-50 text-green-600"><Play className="w-5 h-5" /></div>
          <div><p className="text-2xl font-bold text-gray-900">{totalJobs}</p><p className="text-xs text-gray-500">Running Jobs</p></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-amber-50 text-amber-600"><Star className="w-5 h-5" /></div>
          <div><p className="text-2xl font-bold text-gray-900">{criticalCount}</p><p className="text-xs text-gray-500">Critical Jobs</p></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-50 text-indigo-600"><Layers className="w-5 h-5" /></div>
          <div><p className="text-2xl font-bold text-gray-900">{clusterList.length}</p><p className="text-xs text-gray-500">Clusters</p></div>
        </div>
      </div>

      {/* Main Content: Cluster-grouped clients + Job detail */}
      {isLoading ? (
        <div className="p-12 text-center text-gray-400">Loading client list...</div>
      ) : clientInfo.length === 0 ? (
        <div className="p-12 text-center text-gray-400">No DB connection files found</div>
      ) : (
        <>
          {/* Stale/empty cache banner */}
          {(isEmpty || isStale) && !fetchAllMutation.isPending && (
            <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <span className="text-amber-800">
                {isEmpty
                  ? 'No job data cached yet. Click "Fetch All from DB2" to load running jobs for all clients, or select a client and use its Refresh button.'
                  : 'Cached data is from a previous day. Click "Fetch All from DB2" to refresh, or refresh individual clients.'}
              </span>
            </div>
          )}
          {fetchAllMutation.isPending && (
            <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
              <RefreshCw className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
              <span className="text-blue-800">
                Fetching queue jobs from all DB2 clients... This may take a few minutes.
              </span>
            </div>
          )}

          {/* ── Cross-client job filter view ── */}
          {jobFilter.trim() && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 bg-gradient-to-r from-zebra-50 to-white border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-zebra-500" />
                  <span className="text-sm font-bold text-gray-900">Jobs matching "{jobFilter}"</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zebra-100 text-zebra-700">
                    {crossClientJobs.length} across {new Set(crossClientJobs.map(r => r.clientId)).size} clients
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {nonCriticalFilteredJobs.length > 0 && (
                    <button
                      onClick={() => {
                        const toMark = nonCriticalFilteredJobs.map(r => ({ clientId: r.clientId, jobName: getJobName(r.job) }));
                        markCriticalBatchMutation.mutate(toMark);
                      }}
                      disabled={markCriticalBatchMutation.isPending}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50"
                    >
                      <Star className="w-3.5 h-3.5 fill-current" />
                      {markCriticalBatchMutation.isPending ? 'Marking...' : `Mark All as Critical (${nonCriticalFilteredJobs.length})`}
                    </button>
                  )}
                  <span className="text-xs text-gray-400">Click ★ to toggle critical across any client</span>
                </div>
              </div>
              {crossClientJobs.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">No jobs found matching "{jobFilter}"</div>
              ) : (
                <div className="max-h-[calc(100vh-420px)] overflow-y-auto">
                  <table className="w-full resizable-cols">
                    <thead className="sticky top-0 bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="px-3 py-2 w-8"></th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Cluster</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Client</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Job Name</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Interval</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Job Time</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Pending</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {crossClientJobs.map(({ clientId, cluster, name, whiteGlove, job }, i) => {
                        const jobName = getJobName(job);
                        const lastTime = getLastJobTime(job);
                        const pending = getJobsPending(job);
                        const pendingNum = Number(pending);
                        return (
                          <tr key={`${clientId}-${jobName}-${i}`} className={`hover:bg-gray-50 transition-colors ${job.isCritical ? 'bg-amber-50/40' : ''}`}>
                            <td className="px-3 py-2.5">
                              <button
                                onClick={() => toggleCritical(clientId, jobName, job.isCritical)}
                                className={`p-1 rounded transition-colors ${
                                  job.isCritical
                                    ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50'
                                    : 'text-gray-300 hover:text-amber-400 hover:bg-amber-50'
                                }`}
                                title={job.isCritical ? 'Unmark as critical' : 'Mark as critical'}
                              >
                                {job.isCritical ? <Star className="w-3.5 h-3.5 fill-current" /> : <StarOff className="w-3.5 h-3.5" />}
                              </button>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="text-xs text-gray-500">{cluster}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1">
                                {whiteGlove && <Crown className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                                <span className="text-xs font-semibold text-gray-800">{clientId}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="text-xs font-medium text-gray-900">{jobName}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="text-xs text-gray-500">{getJobInterval(job)}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="text-xs text-gray-500">{lastTime ? fmt(lastTime) : '—'}</span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <span className={`text-xs font-semibold ${
                                pendingNum > 10 ? 'text-red-600' : pendingNum > 0 ? 'text-amber-600' : 'text-gray-400'
                              }`}>{pending}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Per-client split-panel view (when no job filter) ── */}
          {!jobFilter.trim() && (
          <div className="flex gap-0">
          {/* Left: Client list grouped by cluster */}
          <div style={{ width: leftWidth, minWidth: 200, maxWidth: 600 }} className="flex-shrink-0 space-y-3 max-h-[calc(100vh-320px)] overflow-y-auto pr-1">
            {clusterList.map(clusterName => {
              const clusterClients = clusterGroups[clusterName];
              const isCollapsed = collapsedClusters.has(clusterName);
              const clusterJobCount = clusterClients.reduce(
                (sum, ci) => sum + (clientsData[ci.clientId]?.jobs?.length || 0), 0
              );

              return (
                <div key={clusterName} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                  <button
                    onClick={() => toggleCluster(clusterName)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-slate-50 to-white hover:from-slate-100 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                      <Layers className="w-3.5 h-3.5 text-indigo-500" />
                      <span className="text-xs font-bold text-gray-800">{clusterName}</span>
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-indigo-50 text-indigo-600">
                        {clusterClients.length}
                      </span>
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-50 text-green-600">
                        {clusterJobCount} jobs
                      </span>
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="divide-y divide-gray-50">
                      {clusterClients.map(ci => {
                        const jobs = clientsData[ci.clientId]?.jobs || [];
                        const error = clientsData[ci.clientId]?.error;
                        const isSelected = selectedClient === ci.clientId;
                        const criticalJobs = jobs.filter((j: QueueJob) => j.isCritical).length;

                        return (
                          <button
                            key={ci.clientId}
                            onClick={() => setSelectedClient(ci.clientId)}
                            className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors ${
                              isSelected ? 'bg-zebra-50 border-l-2 border-zebra-500' : 'hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {ci.whiteGlove && <Crown className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                              <span className="text-xs font-bold text-gray-900 truncate">{ci.clientId}</span>
                              <span className="text-[10px] text-gray-400 truncate">{ci.name}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {criticalJobs > 0 && (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700">
                                  {criticalJobs} crit
                                </span>
                              )}
                              {error ? (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600">
                                  error
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700">
                                  {jobs.length}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Drag handle */}
          <div {...dragHandleProps} className="mx-1 flex-shrink-0 w-1.5 rounded-full bg-transparent hover:bg-zebra-300 active:bg-zebra-400 transition-colors cursor-col-resize select-none" />

          {/* Right: Job details for selected client */}
          <div className="flex-1 min-w-0">
            {!selectedClient ? (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
                <Database className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">Select a client to view queue jobs</p>
              </div>
            ) : selectedError ? (
              <div className="bg-white rounded-xl shadow-sm border border-red-100 p-8 text-center">
                <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-red-700">{selectedInfo?.clientId} — Connection Error</p>
                <p className="text-xs text-red-500 mt-1">{selectedError}</p>
                <button
                  onClick={() => refreshClientMutation.mutate(selectedClient!)}
                  disabled={refreshClientMutation.isPending}
                  className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 text-xs text-zebra-600 bg-zebra-50 hover:bg-zebra-100 rounded-lg transition-colors disabled:opacity-50"
                  title="Retry this client from DB2 now"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshClientMutation.isPending ? 'animate-spin' : ''}`} />
                  {refreshClientMutation.isPending ? 'Refreshing...' : 'Retry'}
                </button>
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="px-5 py-3 bg-gradient-to-r from-slate-50 to-white border-b border-gray-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedInfo?.whiteGlove && <Crown className="w-4 h-4 text-amber-500" />}
                    <span className="text-sm font-bold text-gray-900">{selectedInfo?.clientId}</span>
                    <span className="text-xs text-gray-400">{selectedInfo?.name}</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-50 text-indigo-600">
                      {selectedInfo?.cluster}
                    </span>
                    {clientFetchTimes[selectedClient!] && (
                      <span className="text-[10px] text-gray-400 ml-1">
                        cached {fmt(clientFetchTimes[selectedClient!])}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''}
                      {jobSearch && ` of ${selectedJobsRaw.length}`}
                    </span>
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Filter jobs..."
                        value={jobSearch}
                        onChange={e => setJobSearch(e.target.value)}
                        className="pl-7 pr-2 py-1.5 w-36 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-zebra-300"
                      />
                    </div>
                    <button
                      onClick={() => refreshClientMutation.mutate(selectedClient!)}
                      disabled={refreshClientMutation.isPending}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-zebra-600 bg-zebra-50 hover:bg-zebra-100 rounded-lg transition-colors disabled:opacity-50"
                      title="Refresh this client from DB2 now"
                    >
                      <RefreshCw className={`w-3 h-3 ${refreshClientMutation.isPending ? 'animate-spin' : ''}`} />
                      {refreshClientMutation.isPending ? 'Refreshing...' : 'Refresh'}
                    </button>
                  </div>
                </div>

                {selectedJobs.length === 0 ? (
                  <div className="p-8 text-center text-gray-400 text-sm">
                    No running/active jobs for this client
                  </div>
                ) : (
                  <div className="max-h-[calc(100vh-420px)] overflow-y-auto">
                    <table className="w-full resizable-cols">
                      <thead className="sticky top-0 bg-gray-50">
                        <tr className="border-b border-gray-100">
                          <th className="px-4 py-2 w-8"></th>
                          <SortableHeader column="name" label="Job Name" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                          <SortableHeader column="param2" label="Param 2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                          <SortableHeader column="interval" label="Interval" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                          <SortableHeader column="lastJobTime" label="Last Job Time" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                          <SortableHeader column="pending" label="Pending" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {[...selectedJobs]
                          .sort((a, b) => {
                            // Critical always first regardless of column sort
                            if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1;
                            const dir = sortDirection === 'asc' ? 1 : -1;
                            switch (sortColumn) {
                              case 'name': return dir * getJobName(a).localeCompare(getJobName(b));
                              case 'param2': return dir * (a.param2 ?? '').localeCompare(b.param2 ?? '');
                              case 'interval': return dir * getJobInterval(a).localeCompare(getJobInterval(b));
                              case 'lastJobTime': return dir * ((getLastJobTime(a) ?? '').localeCompare(getLastJobTime(b) ?? ''));
                              case 'pending': return dir * (Number(b.jobsPending ?? 0) - Number(a.jobsPending ?? 0));
                              default: return Number(b.jobsPending ?? 0) - Number(a.jobsPending ?? 0);
                            }
                          })
                          .map((job, idx) => {
                            const jobName = getJobName(job);
                            const lastTime = getLastJobTime(job);
                            const pending = getJobsPending(job);
                            const pendingNum = Number(pending);
                            return (
                              <tr key={`${jobName}-${idx}`} className={`hover:bg-gray-50 transition-colors ${job.isCritical ? 'bg-amber-50/30' : ''}`}>
                                <td className="px-4 py-2.5">
                                  <button
                                    onClick={() => toggleCritical(selectedClient!, jobName, job.isCritical)}
                                    className={`p-1 rounded transition-colors ${
                                      job.isCritical
                                        ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50'
                                        : 'text-gray-300 hover:text-amber-400 hover:bg-amber-50'
                                    }`}
                                    title={job.isCritical ? 'Unmark as critical' : 'Mark as critical'}
                                  >
                                    {job.isCritical ? <Star className="w-3.5 h-3.5 fill-current" /> : <StarOff className="w-3.5 h-3.5" />}
                                  </button>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className="text-xs font-medium text-gray-900">{jobName}</span>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className="text-xs font-mono text-gray-500">{job.param2 ?? '—'}</span>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className="text-xs text-gray-500">{getJobInterval(job)}</span>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className="text-xs text-gray-500">{lastTime ? fmt(lastTime) : '—'}</span>
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                  <span className={`text-xs font-semibold ${
                                    pendingNum > 10 ? 'text-red-600' : pendingNum > 0 ? 'text-amber-600' : 'text-gray-400'
                                  }`}>{pending}</span>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
          )}
        </>
      )}
    </div>
  );
}
