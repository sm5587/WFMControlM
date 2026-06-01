import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  Search, Trash2, RefreshCw,
  Filter, ChevronRight, ChevronUp, ChevronDown, CheckCircle, XCircle, AlertTriangle, Clock, Loader, FileText, X,
  Building2, Layers, CalendarDays, Activity, Briefcase
} from 'lucide-react';
import { jobsApi, clientsApi } from '../../services/api';
import { Job, JobType, JobExecution, Client, LastRunStatus } from '../../types';
import { useDbClientConnections } from '../../hooks/useDbClientConnections';
import { usePermission } from '../../context/AuthContext';
import { useTimezone } from '../../hooks/useTimezone';
import { useGlobalFilter } from '../../context/GlobalFilterContext';

function stripClientPrefix(name: string, clientId?: string): string {
  if (!clientId) return name;
  const prefixes = [`${clientId} - `, `${clientId}_`, `${clientId}-`];
  for (const p of prefixes) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  return name;
}

const JOB_TYPE_LABELS: Record<JobType, string> = {
  COMMAND: 'Command',
  SCRIPT: 'Script',
  HTTP: 'HTTP',
  SQL: 'SQL',
  DATA_PIPELINE: 'Data Pipeline',
  FORECAST: 'Forecast',
  SCHEDULE_GEN: 'Schedule Gen',
  FILE_TRANSFER: 'File Transfer',
  CUSTOM: 'Custom',
};

const JOB_TYPE_COLORS: Record<string, string> = {
  COMMAND: 'bg-gray-100 text-gray-700',
  SCRIPT: 'bg-blue-100 text-blue-700',
  HTTP: 'bg-green-100 text-green-700',
  SQL: 'bg-purple-100 text-purple-700',
  DATA_PIPELINE: 'bg-orange-100 text-orange-700',
  FORECAST: 'bg-teal-100 text-teal-700',
  SCHEDULE_GEN: 'bg-indigo-100 text-indigo-700',
  FILE_TRANSFER: 'bg-yellow-100 text-yellow-700',
  CUSTOM: 'bg-pink-100 text-pink-700',
};

export default function JobsList() {
  const queryClient = useQueryClient();
  // Get last refresh time for jobs-all query
  const jobsQueryState = queryClient.getQueryState(['jobs-all']);
  const jobsUpdatedAt = jobsQueryState?.dataUpdatedAt;
  const { fmt } = useTimezone();
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [clusterFilter, setClusterFilter] = useState('');
  const [sortColumn, setSortColumn] = useState<string>('name');

  // Sync from master header filter
  const { selectedCluster, selectedClientId } = useGlobalFilter();
  useEffect(() => { setClusterFilter(selectedCluster); }, [selectedCluster]);
  useEffect(() => { setClientFilter(selectedClientId); }, [selectedClientId]);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const canEditJobs   = usePermission('JOBS_TOGGLE',  'write');
  const canDeleteJobs = usePermission('JOBS_DELETE',  'write');
  const [logViewerJob, setLogViewerJob] = useState<Job | null>(null);
  const [clientSearch, setClientSearch] = useState('');
  const [syncing, setSyncing] = useState(false);

  // Date / time-range filter
  const [filterDate, setFilterDate] = useState('');
  const [filterTimeFrom, setFilterTimeFrom] = useState('');
  const [filterTimeTo, setFilterTimeTo] = useState('');
  const [showTimeFilter, setShowTimeFilter] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ type: 'success' | 'error' | 'loading'; message: string } | null>(null);
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());

  const { connStatus, connTesting } = useDbClientConnections();

  const { data: clientsData } = useQuery({
    queryKey: ['clients-list-active'],
    queryFn: () => clientsApi.list({ isActive: true }),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

  // Fetch ALL jobs once and cache for 30 min — client filtering done client-side
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['jobs-all'],
    queryFn: () => jobsApi.list({ pageSize: 10000 }),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const triggerMutation = useMutation({
    mutationFn: (id: string) => jobsApi.trigger(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs-all'] }),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => jobsApi.toggle(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs-all'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => jobsApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs-all'] }),
  });

  const allJobs = (data?.data || []) as Job[];
  const clients = (clientsData?.data || []) as Client[];

  // Clients missing cleanup job (only those that have at least one synced job)
  const noCleanupClients = useMemo(() => {
    const withCleanup = new Set(
      allJobs
        .filter(j => j.client?.clientId && (
          j.name.toLowerCase().includes('cleanup') ||
          j.command?.toLowerCase().includes('cleanup.sh') ||
          j.scriptPath?.toLowerCase().includes('cleanup.sh')
        ))
        .map(j => j.client!.clientId)
    );
    const clientsWithJobs = new Set(allJobs.map(j => j.client?.clientId).filter(Boolean));
    return clients.filter(c => clientsWithJobs.has(c.clientId) && !withCleanup.has(c.clientId));
  }, [allJobs, clients]);

  // Build job counts per client from ALL jobs (not filtered)
  const jobCountsByClient = useMemo(() => {
    const counts: Record<string, number> = { __all__: allJobs.length, __none__: 0 };
    for (const j of allJobs) {
      if (j.client?.id) {
        counts[j.client.id] = (counts[j.client.id] || 0) + 1;
      } else {
        counts.__none__++;
      }
    }
    return counts;
  }, [allJobs]);

  // Set of no-cleanup client IDs for filtering
  const noCleanupClientIds = useMemo(() => new Set(noCleanupClients.map(c => c.id)), [noCleanupClients]);

  // Client-side client filter
  const rawJobs = useMemo(() => {
    if (!clientFilter) return allJobs;
    if (clientFilter === 'none') return allJobs.filter(j => !j.client);
    if (clientFilter === '__no_cleanup__') return allJobs.filter(j => j.client?.id && noCleanupClientIds.has(j.client.id));
    return allJobs.filter(j => j.client?.id === clientFilter);
  }, [allJobs, clientFilter, noCleanupClientIds]);

  // Filtered client list for sidebar
  const filteredClients = useMemo(() => {
    let list = clients;
    if (clientSearch) {
      const q = clientSearch.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.clientId.toLowerCase().includes(q));
    }
    return list;
  }, [clients, clientSearch]);

  // Group sidebar clients by cluster
  const sidebarClusterGroups = useMemo(() => {
    let list = filteredClients;
    if (clusterFilter) {
      list = list.filter(c => (c.cluster || 'Unassigned') === clusterFilter);
    }
    const groups: Record<string, typeof list> = {};
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
  }, [filteredClients, clusterFilter]);

  const toggleSidebarCluster = (cl: string) => {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      if (next.has(cl)) next.delete(cl); else next.add(cl);
      return next;
    });
  };

  // Build unique cluster list from clients for filter dropdown
  const clusterList = [...new Set(clients.map(c => c.cluster).filter(Boolean))] as string[];
  clusterList.sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, '')) || 0;
    const numB = parseInt(b.replace(/\D/g, '')) || 0;
    return numA - numB;
  });

  // Client-side cluster filter
  const clusterFiltered = clusterFilter
    ? rawJobs.filter(j => j.client?.cluster === clusterFilter)
    : rawJobs;

  // Client-side search filter
  const searchFiltered = search
    ? clusterFiltered.filter(j => {
        const q = search.toLowerCase();
        return j.name.toLowerCase().includes(q) || j.description?.toLowerCase().includes(q);
      })
    : clusterFiltered;

  // Date / time-range filter on nextRunTime
  const timeFiltered = useMemo(() => {
    if (!filterDate) return searchFiltered;
    const dateStr = filterDate; // YYYY-MM-DD
    return searchFiltered.filter(j => {
      if (!j.nextRunTime) return false;
      const nrt = new Date(j.nextRunTime);
      // Compare date portion in local time
      const y = nrt.getFullYear(), m = nrt.getMonth() + 1, d = nrt.getDate();
      const jobDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (jobDate !== dateStr) return false;
      // Optional time range
      if (filterTimeFrom || filterTimeTo) {
        const jobMin = nrt.getHours() * 60 + nrt.getMinutes();
        if (filterTimeFrom) {
          const [fh, fm] = filterTimeFrom.split(':').map(Number);
          if (jobMin < fh * 60 + fm) return false;
        }
        if (filterTimeTo) {
          const [th, tm] = filterTimeTo.split(':').map(Number);
          if (jobMin > th * 60 + tm) return false;
        }
      }
      return true;
    });
  }, [searchFiltered, filterDate, filterTimeFrom, filterTimeTo]);

  const filteredJobs = timeFiltered;

  // Client-side sorting
  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sortedJobs = [...filteredJobs].sort((a, b) => {
    const dir = sortDirection === 'asc' ? 1 : -1;
    switch (sortColumn) {
      case 'name': return dir * a.name.localeCompare(b.name);
      case 'cluster': return dir * ((a.client?.cluster || '').localeCompare(b.client?.cluster || ''));
      case 'client': return dir * ((a.client?.clientId || '') .localeCompare(b.client?.clientId || ''));
      case 'schedule': return dir * ((a.cronExpression || '').localeCompare(b.cronExpression || ''));
      case 'command': return dir * ((a.command || a.scriptPath || '').localeCompare(b.command || b.scriptPath || ''));
      case 'nextRun': {
        const ta = a.nextRunTime ? new Date(a.nextRunTime).getTime() : 0;
        const tb = b.nextRunTime ? new Date(b.nextRunTime).getTime() : 0;
        return dir * (ta - tb);
      }
      case 'lastRun': {
        const statusOrder: Record<string, number> = { FAILED: 0, STALE: 1, NOT_RUN: 2, RUNNING: 3, UNKNOWN: 4, SUCCESS: 5 };
        const sa = statusOrder[a.lastRunStatus || 'UNKNOWN'] ?? 4;
        const sb = statusOrder[b.lastRunStatus || 'UNKNOWN'] ?? 4;
        if (sa !== sb) return dir * (sa - sb);
        const ta = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
        const tb = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
        return dir * (ta - tb);
      }
      case 'status': {
        const aa = a.isActive ? 1 : 0;
        const bb = b.isActive ? 1 : 0;
        return dir * (aa - bb);
      }
      default: return 0;
    }
  });

  const jobs = sortedJobs;

  return (
    <div className="p-6 space-y-6">
      {/* Last refresh time for bulk actions */}
      {jobsUpdatedAt && (
        <div className="flex items-center gap-2 mb-2">
          <Clock className="w-4 h-4 text-gray-400" />
          <span className="text-xs text-gray-500">Last refreshed {fmt(new Date(jobsUpdatedAt).toISOString(), 'time')}</span>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cron Jobs</h1>
          <p className="text-sm text-gray-500 mt-1">
            {jobs.length}{clientFilter ? ` of ${allJobs.length}` : ''} total jobs
            {clientFilter && clientFilter !== 'none' && (() => {
              const c = clients.find(cl => cl.id === clientFilter);
              return c ? ` . ${c.name}` : '';
            })()}
          </p>
        </div>

      </div>

      {/* Summary Cards */}
      {!isLoading && allJobs.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
              <Briefcase className="w-4 h-4" /> Total Jobs
            </div>
            <p className="text-2xl font-bold text-gray-900">{allJobs.length}</p>
          </div>
          <div className="bg-white rounded-xl border px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-green-600 mb-1">
              <Activity className="w-4 h-4" /> Active
            </div>
            <p className="text-2xl font-bold text-green-700">{allJobs.filter(j => j.isActive).length}</p>
          </div>
          <button
            onClick={() => setClientFilter(f => f === '__no_cleanup__' ? '' : '__no_cleanup__')}
            className={`text-left rounded-xl border px-4 py-3 transition-colors ${
              clientFilter === '__no_cleanup__'
                ? 'bg-orange-50 border-orange-300 ring-2 ring-orange-300'
                : 'bg-white hover:bg-orange-50'
            }`}
          >
            <div className="flex items-center gap-2 text-sm text-orange-500 mb-1">
              <AlertTriangle className="w-4 h-4" /> No Cleanup
            </div>
            <p className="text-2xl font-bold text-orange-600">
              {noCleanupClients.length}
              <span className="text-sm font-normal text-orange-400 ml-1">clients</span>
            </p>
            {clientFilter === '__no_cleanup__' && (
              <p className="text-xs text-orange-400 mt-1">Click to clear filter</p>
            )}
          </button>
        </div>
      )}

      {/* Main 2-panel layout */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left: Client List */}
        <div className="col-span-2 bg-white rounded-xl border overflow-hidden">
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search clients..."
                value={clientSearch}
                onChange={e => setClientSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-zebra-300 focus:border-zebra-300"
              />
            </div>
            <select
              value={clusterFilter}
              onChange={e => setClusterFilter(e.target.value)}
              className="w-full mt-2 px-2 py-1.5 text-xs border rounded-lg focus:ring-2 focus:ring-zebra-300"
            >
              <option value="">All Clusters</option>
              {clusterList.map(cl => (
                <option key={cl} value={cl}>{cl}</option>
              ))}
            </select>
          </div>
          <div className="overflow-auto max-h-[calc(100vh-340px)]">
            {/* All Clients option */}
            <button
              onClick={() => { setClientFilter(''); setClusterFilter(''); }}
              className={`w-full text-left px-4 py-2.5 border-b hover:bg-gray-50 transition-colors ${
                !clientFilter && !clusterFilter ? 'bg-zebra-50 border-l-4 border-l-zebra-500' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm text-gray-900">All Clients</span>
                <span className="text-xs text-gray-400">{jobCountsByClient.__all__}</span>
              </div>
            </button>
            {/* System (no client) */}
            {jobCountsByClient.__none__ > 0 && (
              <button
                onClick={() => setClientFilter('none')}
                className={`w-full text-left px-4 py-2.5 border-b hover:bg-gray-50 transition-colors ${
                  clientFilter === 'none' ? 'bg-zebra-50 border-l-4 border-l-zebra-500' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm text-gray-500 italic">System Jobs</span>
                  <span className="text-xs text-gray-400">{jobCountsByClient.__none__}</span>
                </div>
              </button>
            )}
            {/* Cluster-grouped client list */}
            {sidebarClusterGroups.keys.map(clName => {
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
                  {!isCollapsed && clClients.map(c => {
                    const count = jobCountsByClient[c.id] || 0;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setClientFilter(c.id)}
                        className={`w-full text-left px-4 py-2.5 border-b hover:bg-gray-50 transition-colors ${
                          clientFilter === c.id ? 'bg-zebra-50 border-l-4 border-l-zebra-500' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              connStatus[c.clientId] === 'connected' ? 'bg-green-500' :
                              connStatus[c.clientId] === 'failed' ? 'bg-red-500' :
                              connTesting ? 'bg-amber-400 animate-pulse' : 'bg-gray-300'
                            }`} title={connStatus[c.clientId] || (connTesting ? 'testing' : 'unknown')} />
                            <div className="min-w-0">
                              <span className="font-medium text-sm text-gray-900 truncate block">{c.name}</span>
                              <span className="text-xs text-gray-400">{c.clientId}</span>
                            </div>
                          </div>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${count > 0 ? 'bg-zebra-50 text-zebra-700 font-medium' : 'text-gray-300'}`}>
                            {count}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Jobs content */}
        <div className="col-span-10 space-y-4">

      {/* Search & Filters */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search jobs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
          />
        </div>
        <button
          onClick={async () => {
            if (syncing) return;
            setSyncing(true);
            setSyncStatus(null);
            try {
              if (clientFilter && clientFilter !== 'none') {
                const c = clients.find(cl => cl.id === clientFilter);
                setSyncStatus({ type: 'loading', message: `Syncing crons for ${c?.clientId || 'client'}...` });
                await clientsApi.sync(clientFilter, 'CRON_SYNC');
                setSyncStatus({ type: 'success', message: `Sync complete for ${c?.clientId || 'client'}` });
              } else {
                setSyncStatus({ type: 'loading', message: 'Syncing crons for all clients (30s cooldown per client)...' });
                await clientsApi.syncAllCrons();
                setSyncStatus({ type: 'success', message: 'Cron sync complete for all clients' });
              }
              queryClient.invalidateQueries({ queryKey: ['jobs-all'] });
              refetch();
              setTimeout(() => setSyncStatus(null), 5000);
            } catch (err: any) {
              setSyncStatus({ type: 'error', message: `Sync failed: ${err.message}` });
              setTimeout(() => setSyncStatus(null), 8000);
            } finally {
              setSyncing(false);
            }
          }}
          className={`p-2 text-gray-500 hover:text-gray-700 ${syncing ? 'opacity-50 cursor-not-allowed' : ''}`}
          title={clientFilter && clientFilter !== 'none' ? 'Sync crons from appserver' : 'Sync crons from all appservers'}
          disabled={syncing}
        >
          <RefreshCw className={`w-4 h-4 ${syncing || isLoading ? 'animate-spin' : ''}`} />
        </button>
        {syncStatus && (
          <span className={`text-xs ${
            syncStatus.type === 'loading' ? 'text-amber-600 animate-pulse' :
            syncStatus.type === 'success' ? 'text-green-600' :
            'text-red-600'
          }`}>
            {syncStatus.message}
          </span>
        )}

        {/* Time-range filter toggle */}
        <button
          onClick={() => setShowTimeFilter(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${
            showTimeFilter || filterDate
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'border-gray-200 text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
          title="Filter by date & time range"
        >
          <CalendarDays className="w-4 h-4" />
          {filterDate ? filterDate : 'Schedule Filter'}
        </button>
        {filterDate && (
          <button
            onClick={() => { setFilterDate(''); setFilterTimeFrom(''); setFilterTimeTo(''); }}
            className="p-1 text-gray-400 hover:text-red-500"
            title="Clear date/time filter"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Date / Time range filter row */}
      {showTimeFilter && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-50/50 border border-blue-100 rounded-lg">
          <CalendarDays className="w-4 h-4 text-blue-500 flex-shrink-0" />
          <label className="text-xs font-medium text-gray-600">Date</label>
          <input
            type="date"
            value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <label className="text-xs font-medium text-gray-600 ml-2">From</label>
          <input
            type="time"
            value={filterTimeFrom}
            onChange={e => setFilterTimeFrom(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <label className="text-xs font-medium text-gray-600">To</label>
          <input
            type="time"
            value={filterTimeTo}
            onChange={e => setFilterTimeTo(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          {filterDate && (
            <span className="text-xs text-blue-600 ml-2">
              {timeFiltered.length} job{timeFiltered.length !== 1 ? 's' : ''} match
            </span>
          )}
          <button
            onClick={() => { setFilterDate(''); setFilterTimeFrom(''); setFilterTimeTo(''); setShowTimeFilter(false); }}
            className="ml-auto text-xs text-gray-400 hover:text-red-500"
          >
            Clear
          </button>
        </div>
      )}

      {/* Jobs Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-auto max-h-[calc(100vh-280px)]">
        {isLoading ? (
          <div className="p-12 text-center text-gray-400">Loading jobs...</div>
        ) : jobs.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            <p className="text-lg mb-2">No jobs found</p>
            <p className="text-sm">Create your first job to get started</p>
          </div>
        ) : (
          <table className="w-full resizable-cols">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <SortableHeader column="name" label="Job Name" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="schedule" label="Schedule" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="w-28" />
                <SortableHeader column="command" label="Command" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader column="nextRun" label="Next Run" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="w-40" />
                <SortableHeader column="lastRun" label="Last Run (Calculated)" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="w-28" />
                <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {clientFilter === '__no_cleanup__' ? (() => {
                // Group jobs by client
                const groups = new Map<string, { client: Job['client']; jobs: typeof jobs }>();
                for (const job of jobs) {
                  const key = job.client?.id || '__none__';
                  if (!groups.has(key)) groups.set(key, { client: job.client, jobs: [] });
                  groups.get(key)!.jobs.push(job);
                }
                return Array.from(groups.entries()).map(([key, group]) => (
                  <>
                    <tr key={`group-${key}`} className="bg-orange-50 border-t border-orange-100">
                      <td colSpan={6} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                          <span className="text-xs font-semibold text-orange-700">{group.client?.name || 'Unknown Client'}</span>
                          <span className="text-xs text-orange-400">{group.client?.clientId}</span>
                          {group.client?.cluster && (
                            <span className="text-xs text-orange-300 ml-1">· {group.client.cluster}</span>
                          )}
                          <span className="ml-auto text-xs text-orange-400">{group.jobs.length} job{group.jobs.length !== 1 ? 's' : ''}</span>
                        </div>
                      </td>
                    </tr>
                    {group.jobs.map((job) => (
                      <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 py-2">
                          <div className="text-xs font-medium text-gray-800 truncate max-w-[200px]" title={job.name}>{stripClientPrefix(job.name, job.client?.clientId)}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600 font-mono">
                          {job.cronExpression || <span className="text-gray-300">Manual</span>}
                        </td>
                        <td className="px-3 py-2">
                          {job.command ? (
                            <div className="text-xs text-gray-600 font-mono max-w-[220px] truncate" title={job.command}>
                              {job.command.replace(/>>?\s+\S+/g, '').trim()}
                            </div>
                          ) : job.scriptPath ? (
                            <div className="text-xs text-gray-600 font-mono max-w-[220px] truncate" title={job.scriptPath}>
                              {job.scriptPath}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {job.nextRunLocal ? (
                            <div>
                              <div className="text-xs text-gray-700">{job.nextRunLocal}</div>
                            </div>
                          ) : job.nextRunTime ? (
                            <div className="text-xs text-gray-500">{fmt(job.nextRunTime)}</div>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <LastRunBadge status={job.lastRunStatus} lastRunAt={job.lastRunAt} computed={job.lastRunComputed} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              onClick={() => setLogViewerJob(job)}
                              className="p-1 text-purple-500 hover:bg-purple-50 rounded transition-colors"
                              title="View Logs"
                            >
                              <FileText className="w-3.5 h-3.5" />
                            </button>
                            {canDeleteJobs && (
                              <button
                                onClick={() => {
                                  if (confirm(`Delete job "${job.name}"?`)) {
                                    deleteMutation.mutate(job.id);
                                  }
                                }}
                                className="p-1 text-red-400 hover:bg-red-50 rounded transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </>
                ));
              })() : jobs.map((job) => (
                <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2">
                    <div className="text-xs font-medium text-gray-800 truncate max-w-[200px]" title={job.name}>{clientFilter ? stripClientPrefix(job.name, job.client?.clientId) : job.name}</div>
                  </td>

                  <td className="px-3 py-2 text-xs text-gray-600 font-mono">
                    {job.cronExpression || <span className="text-gray-300">Manual</span>}
                  </td>
                  <td className="px-3 py-2">
                    {job.command ? (
                      <div className="text-xs text-gray-600 font-mono max-w-[220px] truncate" title={job.command}>
                        {job.command.replace(/>>?\s+\S+/g, '').trim()}
                      </div>
                    ) : job.scriptPath ? (
                      <div className="text-xs text-gray-600 font-mono max-w-[220px] truncate" title={job.scriptPath}>
                        {job.scriptPath}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {job.nextRunLocal ? (
                      <div>
                        <div className="text-xs text-gray-700">{job.nextRunLocal}</div>
                      </div>
                    ) : job.nextRunTime ? (
                      <div className="text-xs text-gray-500">{fmt(job.nextRunTime)}</div>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <LastRunBadge status={job.lastRunStatus} lastRunAt={job.lastRunAt} computed={job.lastRunComputed} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        onClick={() => setLogViewerJob(job)}
                        className="p-1 text-purple-500 hover:bg-purple-50 rounded transition-colors"
                        title="View Logs"
                      >
                        <FileText className="w-3.5 h-3.5" />
                      </button>
                      {canDeleteJobs && (
                        <button
                          onClick={() => {
                            if (confirm(`Delete job "${job.name}"?`)) {
                              deleteMutation.mutate(job.id);
                            }
                          }}
                          className="p-1 text-red-400 hover:bg-red-50 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>



      {/* Log Viewer Modal */}
      {logViewerJob && <LogViewerModal job={logViewerJob} onClose={() => setLogViewerJob(null)} />}
        </div>{/* end col-span-10 */}
      </div>{/* end grid */}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: number }) {
  const color = priority >= 8 ? 'text-red-600 bg-red-50' :
                priority >= 5 ? 'text-yellow-600 bg-yellow-50' :
                'text-gray-500 bg-gray-50';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${color}`}>
      P{priority}
    </span>
  );
}

function SortableHeader({ column, label, sortColumn, sortDirection, onSort, className = '' }: {
  column: string; label: string; sortColumn: string; sortDirection: 'asc' | 'desc'; onSort: (col: string) => void; className?: string;
}) {
  const isActive = sortColumn === column;
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700 transition-colors ${className}`}
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {isActive ? (
          sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3 opacity-0 group-hover:opacity-30" />
        )}
      </span>
    </th>
  );
}

const LAST_RUN_CONFIG: Record<string, { icon: React.ReactNode; color: string; bg: string; label: string }> = {
  SUCCESS:  { icon: <CheckCircle className="w-3 h-3" />, color: 'text-green-700', bg: 'bg-green-50', label: 'Success' },
  FAILED:   { icon: <XCircle className="w-3 h-3" />,     color: 'text-red-700',   bg: 'bg-red-50',   label: 'Failed' },
  NOT_RUN:  { icon: <Clock className="w-3 h-3" />,       color: 'text-gray-500',  bg: 'bg-gray-50',  label: 'Not Run' },
  STALE:    { icon: <AlertTriangle className="w-3 h-3" />, color: 'text-yellow-700', bg: 'bg-yellow-50', label: 'Stale' },
  UNKNOWN:  { icon: <AlertTriangle className="w-3 h-3" />, color: 'text-gray-500', bg: 'bg-gray-50', label: 'Unknown' },
};

function LastRunBadge({ status, lastRunAt, computed }: { status?: LastRunStatus; lastRunAt?: string; computed?: boolean }) {
  const { fmt } = useTimezone();
  if (!lastRunAt) {
    return <span className="text-xs text-gray-300">—</span>;
  }
  return (
    <div className={`text-xs ${computed ? 'text-gray-300 italic' : 'text-gray-600'}`}
      title={computed ? 'Estimated from cron schedule — not confirmed from logs' : undefined}
    >
      {computed ? '~' : ''}{fmt(lastRunAt, 'short')}
    </div>
  );
}

const EXEC_STATUS_STYLE: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
  SUCCESS:  { color: 'text-green-700', bg: 'bg-green-50', icon: <CheckCircle className="w-3.5 h-3.5" /> },
  FAILED:   { color: 'text-red-700',   bg: 'bg-red-50',   icon: <XCircle className="w-3.5 h-3.5" /> },
  RUNNING:  { color: 'text-blue-700',  bg: 'bg-blue-50',  icon: <Loader className="w-3.5 h-3.5 animate-spin" /> },
  PENDING:  { color: 'text-gray-500',  bg: 'bg-gray-50',  icon: <Clock className="w-3.5 h-3.5" /> },
};

function LogViewerModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const { fmt } = useTimezone();
  const [lines, setLines] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ logPath: string; hostname: string; fetchedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tailCount, setTailCount] = useState(30);

  const fetchLog = async (n: number) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await jobsApi.getLogTail(job.id, n);
      const d = (resp as any)?.data;
      setLines(d?.lines ?? []);
      setMeta({ logPath: d?.logPath, hostname: d?.hostname, fetchedAt: d?.fetchedAt });
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err.message ?? 'Failed to fetch log');
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { fetchLog(tailCount); }, [job.id, tailCount]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-gray-800">Live Log Tail</h2>
            <p className="text-xs text-gray-500 mt-0.5 font-mono truncate max-w-[500px]" title={job.name}>{stripClientPrefix(job.name, job.client?.clientId)}</p>
            {meta && (
              <p className="text-[10px] text-gray-400 mt-0.5 truncate" title={meta.logPath}>
                {meta.hostname} — {meta.logPath}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <select
              value={tailCount}
              onChange={e => setTailCount(parseInt(e.target.value, 10))}
              className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-zebra-300"
            >
              <option value={10}>Last 10 lines</option>
              <option value={30}>Last 30 lines</option>
              <option value={50}>Last 50 lines</option>
              <option value={100}>Last 100 lines</option>
            </select>
            <button
              onClick={() => fetchLog(tailCount)}
              disabled={loading}
              className="p-1.5 text-gray-400 hover:text-zebra-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading && lines.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader className="w-5 h-5 animate-spin mr-2" />
              Connecting via SSH and tailing log...
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-amber-400" />
              <p className="text-sm text-red-600">{error}</p>
              <p className="text-xs text-gray-400 mt-1">Ensure the job has a log path and the client has an active Prod server</p>
            </div>
          ) : lines.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Log file is empty</p>
            </div>
          ) : (
            <pre className="text-xs text-gray-700 bg-gray-900 text-green-400 rounded-lg p-4 font-mono whitespace-pre-wrap break-words overflow-x-auto leading-relaxed">
              {lines.join('\n')}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-gray-100 flex items-center justify-between">
          <span className="text-[10px] text-gray-400">
            {meta?.fetchedAt ? `Fetched ${fmt(meta.fetchedAt, 'time')}` : ''}
          </span>
          <span className="text-[10px] text-gray-400">
            {lines.length} line{lines.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
