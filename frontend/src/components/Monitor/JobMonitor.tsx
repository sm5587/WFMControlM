import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity, RefreshCw, XCircle, Search, Filter,
  Terminal, ChevronDown, ChevronUp, ChevronRight, Building2, Layers
} from 'lucide-react';
import { monitoringApi, executionsApi, clientsApi } from '../../services/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { JobExecution, Client } from '../../types';
import { useTimezone } from '../../hooks/useTimezone';
import { useGlobalFilter } from '../../context/GlobalFilterContext';

export default function JobMonitor() {
  const queryClient = useQueryClient();
  const { fmt } = useTimezone();
  const { subscribe, followExecution } = useWebSocket();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedExecution, setSelectedExecution] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const [clientFilter, setClientFilter] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [clusterFilter, setClusterFilter] = useState('');

  // Sync from master header filter
  const { selectedCluster, selectedClientId } = useGlobalFilter();
  useEffect(() => { setClusterFilter(selectedCluster); }, [selectedCluster]);
  useEffect(() => { setClientFilter(selectedClientId); }, [selectedClientId]);
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { data: clientsData } = useQuery({
    queryKey: ['clients-list-active'],
    queryFn: () => clientsApi.list({ isActive: true }),
  });

  const clients = (clientsData?.data || []) as Client[];

  const { data: liveData, refetch: refetchLive } = useQuery({
    queryKey: ['live-executions'],
    queryFn: () => monitoringApi.getLive(50),
    refetchInterval: 3000,
  });

  const { data: historyData } = useQuery({
    queryKey: ['execution-history', statusFilter, clientFilter, clusterFilter, startDate, endDate],
    queryFn: () => {
      // Resolve cluster name for selected client if no explicit cluster
      const selectedClient = clientFilter ? clients.find(c => c.id === clientFilter) : null;
      const resolvedCluster = clusterFilter || undefined;
      return monitoringApi.getHistory({
        status:    statusFilter || undefined,
        clientId:  clientFilter || undefined,
        cluster:   resolvedCluster,
        startDate: startDate || undefined,
        endDate:   endDate   || undefined,
        pageSize:  500,
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => executionsApi.cancel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['live-executions'] });
      queryClient.invalidateQueries({ queryKey: ['execution-history'] });
    },
  });

  // Real-time execution updates
  useEffect(() => {
    const unsub1 = subscribe('execution:started', () => refetchLive());
    const unsub2 = subscribe('execution:completed', () => {
      refetchLive();
      queryClient.invalidateQueries({ queryKey: ['execution-history'] });
    });
    const unsub3 = subscribe('execution:failed', () => {
      refetchLive();
      queryClient.invalidateQueries({ queryKey: ['execution-history'] });
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [subscribe, refetchLive, queryClient]);

  // Follow logs for selected execution
  useEffect(() => {
    if (!selectedExecution) return;
    followExecution(selectedExecution);
    const unsub = subscribe('execution:progress', (data: any) => {
      if (data.payload?.executionId === selectedExecution) {
        setLogs(prev => [...prev, data.payload.output || data.payload.message || JSON.stringify(data.payload)]);
      }
    });
    return unsub;
  }, [selectedExecution, followExecution, subscribe]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const liveExecutions = (liveData?.data || []) as JobExecution[];
  const historyExecutions = (historyData?.data || []) as JobExecution[];

  // Client-side client filter
  const filterByClient = (exec: JobExecution) => {
    if (!clientFilter) return true;
    const jobClient = (exec as any).job?.client;
    if (clientFilter === 'none') return !jobClient;
    return jobClient?.id === clientFilter || jobClient?.clientId === clientFilter;
  };

  const filteredLive = liveExecutions.filter(e => {
    if (search && !e.job?.name?.toLowerCase().includes(search.toLowerCase())) return false;
    if (!filterByClient(e)) return false;
    return true;
  });

  const filteredHistory = historyExecutions.filter(e => filterByClient(e));

  const hasTimeRange = !!(startDate || endDate);
  const clearTimeRange = () => { setStartDate(''); setEndDate(''); };

  // Build execution counts per client
  const allExecutions = [...liveExecutions, ...historyExecutions];
  const execCountsByClient = useMemo(() => {
    const counts: Record<string, number> = { __all__: allExecutions.length };
    for (const e of allExecutions) {
      const jobClient = (e as any).job?.client;
      if (jobClient?.id) {
        counts[jobClient.id] = (counts[jobClient.id] || 0) + 1;
      }
    }
    return counts;
  }, [allExecutions]);

  // Filtered client sidebar list
  const filteredClients = useMemo(() => {
    let list = clients;
    if (clientSearch) {
      const q = clientSearch.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.clientId.toLowerCase().includes(q));
    }
    return list;
  }, [clients, clientSearch]);

  // Build unique cluster list
  const clusterList = useMemo(() => {
    const set = new Set(clients.map(c => c.cluster).filter(Boolean) as string[]);
    return [...set].sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB;
    });
  }, [clients]);

  // Group sidebar clients by cluster
  const sidebarClusterGroups = useMemo(() => {
    let list = filteredClients;
    if (clusterFilter) {
      list = list.filter(c => (c.cluster || 'Unassigned') === clusterFilter);
    }
    const groups: Record<string, Client[]> = {};
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

  return (
    <div className="h-full flex">
      {/* Client Sidebar */}
      <div className="w-52 bg-white border-r flex flex-col flex-shrink-0">
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
        <div className="overflow-auto flex-1">
          <button
            onClick={() => { setClientFilter(''); setClusterFilter(''); }}
            className={`w-full text-left px-4 py-2.5 border-b hover:bg-gray-50 transition-colors ${
              !clientFilter && !clusterFilter ? 'bg-zebra-50 border-l-4 border-l-zebra-500' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm text-gray-900">All Clients</span>
              <span className="text-xs text-gray-400">{execCountsByClient.__all__}</span>
            </div>
          </button>
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
                  const count = execCountsByClient[c.id] || 0;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setClientFilter(c.id)}
                      className={`w-full text-left px-4 py-2.5 border-b hover:bg-gray-50 transition-colors ${
                        clientFilter === c.id ? 'bg-zebra-50 border-l-4 border-l-zebra-500' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <span className="font-medium text-sm text-gray-900 truncate block">{c.name}</span>
                          <span className="text-xs text-gray-400">{c.clientId}</span>
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

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Job Monitor</h1>
            <p className="text-sm text-gray-500 mt-1">Real-time execution tracking</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Activity className="w-4 h-4 text-green-500 animate-pulse" />
            {filteredLive.length} active
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Filter by job name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
          >
            <option value="">All Statuses</option>
            <option value="RUNNING">Running</option>
            <option value="PENDING">Pending</option>
            <option value="QUEUED">Queued</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILED">Failed</option>
            <option value="TIMEOUT">Timeout</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <button onClick={() => refetchLive()} className="p-2 text-gray-500 hover:text-gray-700">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Execution List */}
        <div className="flex-1 overflow-auto">
          {/* Live Section */}
          <div className="px-6 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-semibold text-blue-700">Live ({filteredLive.length})</span>
          </div>
          {filteredLive.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-400 text-sm border-b">No active executions</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredLive.map((exec) => (
                <ExecutionRow
                  key={exec.id}
                  execution={exec}
                  isSelected={selectedExecution === exec.id}
                  onSelect={() => {
                    setSelectedExecution(exec.id);
                    setLogs([]);
                  }}
                  onCancel={() => cancelMutation.mutate(exec.id)}
                />
              ))}
            </div>
          )}

          {/* History Section */}
          <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-600">
              {hasTimeRange
                ? `History in range (${filteredHistory.length} results)`
                : `Recent History (${filteredHistory.length})`
              }
            </span>
            {(clientFilter || clusterFilter) && (
              <span className="text-xs text-zebra-600 font-medium">
                · {clientFilter ? clients.find(c => c.id === clientFilter)?.name ?? 'selected client' : clusterFilter}
              </span>
            )}
          </div>
          <div className="divide-y divide-gray-50">
            {filteredHistory.map((exec) => (
              <ExecutionRow
                key={exec.id}
                execution={exec}
                isSelected={selectedExecution === exec.id}
                onSelect={() => {
                  setSelectedExecution(exec.id);
                  setLogs([]);
                }}
                onCancel={exec.status === 'RUNNING' ? () => cancelMutation.mutate(exec.id) : undefined}
              />
            ))}
          </div>
        </div>

        {/* Log Viewer */}
        {selectedExecution && (
          <div className="w-96 bg-gray-900 border-l border-gray-700 flex flex-col">
            <div className="px-4 py-3 bg-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-gray-300 text-sm">
                <Terminal className="w-4 h-4" />
                Execution Logs
              </div>
              <button
                onClick={() => setSelectedExecution(null)}
                className="text-gray-500 hover:text-gray-300"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <div ref={logRef} className="flex-1 overflow-auto p-4 font-mono text-xs text-green-400 custom-scrollbar">
              {logs.length === 0 ? (
                <div className="text-gray-500">Waiting for log output...</div>
              ) : (
                logs.map((line, i) => (
                  <div key={i} className="py-0.5 whitespace-pre-wrap">{line}</div>
                ))
              )}
            </div>
          </div>
        )}
      </div>{/* end flex-1 main content */}
    </div>{/* end flex-1 flex flex-col */}
    </div>
  );
}

function ExecutionRow({
  execution: exec,
  isSelected,
  onSelect,
  onCancel,
}: {
  execution: JobExecution;
  isSelected: boolean;
  onSelect: () => void;
  onCancel?: () => void;
}) {
  const { fmt } = useTimezone();
  const statusColors: Record<string, string> = {
    RUNNING: 'status-running',
    PENDING: 'status-pending',
    QUEUED: 'status-queued',
    SUCCESS: 'status-success',
    FAILED: 'status-failed',
    CANCELLED: 'status-pending',
    TIMEOUT: 'status-warning',
    RETRY_PENDING: 'status-warning',
    SKIPPED: 'status-pending',
  };

  const statusBg: Record<string, string> = {
    RUNNING: 'bg-blue-50',
    FAILED: 'bg-red-50',
    TIMEOUT: 'bg-orange-50',
  };

  return (
    <div
      onClick={onSelect}
      className={`px-6 py-3 flex items-center justify-between cursor-pointer transition-colors ${
        isSelected ? 'bg-zebra-50 border-l-4 border-zebra-500' : 'hover:bg-gray-50'
      } ${statusBg[exec.status] || ''}`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className={`status-dot ${statusColors[exec.status]}`} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-800 truncate">{exec.job?.name || 'Unknown'}</div>
          <div className="text-xs text-gray-400 flex items-center gap-2">
            {(exec as any).job?.client && (
              <>
                <span className="text-gray-500 font-medium">{(exec as any).job.client.name || (exec as any).job.client.clientId}</span>
                <span>·</span>
              </>
            )}
            <span>{exec.status}</span>
            <span>·</span>
            <span>{exec.triggeredBy}</span>
            {(exec as any).retryCount > 0 && (
              <>
                <span>·</span>
                <span className="text-yellow-600">Retry #{(exec as any).retryCount}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="text-xs text-gray-500">
            {exec.startedAt ? fmt(exec.startedAt, 'time') : 'Pending'}
          </div>
          {exec.duration !== null && exec.duration !== undefined && (
            <div className="text-xs text-gray-400">{exec.duration}s</div>
          )}
        </div>
        {onCancel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="p-1.5 text-red-400 hover:bg-red-100 rounded transition-colors"
            title="Cancel"
          >
            <XCircle className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
