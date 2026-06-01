import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DollarSign, Search, Loader2, RefreshCw, Building2,
  CheckCircle, XCircle, Lock, Unlock, ChevronDown, ChevronRight,
  RotateCcw, AlertCircle, ArrowUpDown, ArrowUp, ArrowDown,
  PanelLeftClose, PanelLeftOpen
} from 'lucide-react';
import { payrollApi } from '../../services/api';
import { useTimezone } from '../../hooks/useTimezone';

// ============================================================
// Payroll Jobs Page — TA_UNIT_PAY_STATUS per client (on-demand)
// Clients grouped by payroll cycle, click to fetch
// ============================================================

interface PayrollSummary {
  totalRecords: number;
  uniqueUnits: number;
  weekStartDates: string[];
  fileStatusCounts: Record<string, number>;
  lockStatusCounts: Record<string, number>;
}

interface PayrollResult {
  clientId: string;
  columns: string[];
  records: Record<string, string>[];
  summary: PayrollSummary;
  recordCount: number;
  executionTimeMs: number;
}

const PAYROLL_CYCLES = [
  { key: 'weekly', label: 'Weekly', color: 'bg-blue-500' },
  { key: 'bi-weekly', label: 'Bi-Weekly', color: 'bg-indigo-500' },
  { key: 'semi-monthly', label: 'Semi-Monthly', color: 'bg-purple-500' },
  { key: 'monthly', label: 'Monthly', color: 'bg-teal-500' },
  { key: 'quarterly', label: 'Quarterly', color: 'bg-amber-500' },
] as const;

// Make column headers readable: UNIT_ID -> Unit Id, WEEK_START_DATE -> Week Start Date
function formatColumnName(col: string): string {
  return col
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function getStatusBadge(value: string, column: string) {
  const s = value.toUpperCase();
  const col = column.toUpperCase();

  if (col.includes('FILE_STATUS')) {
    if (s === 'COMPLETE' || s === 'COMPLETED' || s === 'C') return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
        <CheckCircle className="w-3 h-3" /> {value}
      </span>
    );
    if (s === 'PENDING' || s === 'IN_PROGRESS' || s === 'P') return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
        <Loader2 className="w-3 h-3" /> {value}
      </span>
    );
  }

  if (col.includes('LOCK_STATUS')) {
    if (s === 'LOCKED' || s === 'Y') return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
        <Lock className="w-3 h-3" /> {value}
      </span>
    );
    if (s === 'UNLOCKED' || s === 'N') return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
        <Unlock className="w-3 h-3" /> {value}
      </span>
    );
  }

  if (col.includes('STATUS')) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
        {value}
      </span>
    );
  }

  return null;
}

export default function PayrollJobs() {
  const { fmt } = useTimezone();
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCycles, setExpandedCycles] = useState<Set<string>>(new Set(['weekly']));
  const [fetchEnabled, setFetchEnabled] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string>('');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);

  // Summary filter: clicking a status value in summary cards filters the table
  const [summaryFilter, setSummaryFilter] = useState<{ column: string; value: string } | null>(null);

  // Column sorting
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const qc = useQueryClient();

  const { data: clientsRes, isLoading: clientsLoading, refetch: refetchClients } = useQuery({
    queryKey: ['payroll-clients'],
    queryFn: () => payrollApi.getClients(),
    staleTime: 30 * 60 * 1000,
  });
  const clients = (clientsRes as any)?.data || [];

  // Derive last sync time from clients list
  const lastSyncedAt: string | null = clients.length > 0
    ? (clients.find((c: any) => c.payrollSyncedAt)?.payrollSyncedAt ?? null)
    : null;

  const syncMutation = useMutation({
    mutationFn: () => payrollApi.syncClients(),
    onSuccess: () => {
      setSyncMessage('Sync running in background. Refreshing client list in 30s...');
      // Poll for updated client list after sync runs
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['payroll-clients'] });
        setSyncMessage('');
      }, 30000);
    },
    onError: (err: any) => {
      setSyncMessage(`Sync failed: ${err.message}`);
    },
  });

  // Group clients by payroll cycle
  const clientsByCycle: Record<string, any[]> = {};
  for (const cycle of PAYROLL_CYCLES) {
    clientsByCycle[cycle.key] = clients.filter((c: any) => (c.payrollCycle || 'weekly') === cycle.key);
  }

  const {
    data: payrollRes,
    isLoading: payrollLoading,
    isFetching: payrollFetching,
    refetch,
    error: payrollError,
  } = useQuery({
    queryKey: ['payroll-status', selectedClientId],
    queryFn: () => payrollApi.getPayrollStatus(selectedClientId),
    enabled: fetchEnabled && !!selectedClientId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const payrollData: PayrollResult | null = (payrollRes as any)?.data || null;
  const columns = payrollData?.columns || [];
  const records = payrollData?.records || [];
  const summary = payrollData?.summary || null;

  // Apply search + summary filter + sorting
  const filtered = useMemo(() => {
    let result = records;

    // Summary card filter
    if (summaryFilter) {
      result = result.filter(r =>
        (r[summaryFilter.column] || '').toUpperCase() === summaryFilter.value.toUpperCase()
      );
    }

    // Text search
    if (searchTerm) {
      result = result.filter(r =>
        Object.values(r).some(v =>
          (v || '').toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }

    // Column sorting
    if (sortColumn) {
      result = [...result].sort((a, b) => {
        const aVal = (a[sortColumn] || '').trim();
        const bVal = (b[sortColumn] || '').trim();
        // Try numeric comparison first
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortDirection === 'asc' ? aNum - bNum : bNum - aNum;
        }
        const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }

    return result;
  }, [records, searchTerm, summaryFilter, sortColumn, sortDirection]);

  const handleClientClick = (clientId: string) => {
    if (clientId === selectedClientId && fetchEnabled) return; // already fetched
    setSelectedClientId(clientId);
    setFetchEnabled(true);
    setSearchTerm('');
    setSummaryFilter(null);
    setSortColumn(null);
    setLeftPanelOpen(false); // auto-collapse after selection
  };

  const handleSummaryClick = (column: string, value: string) => {
    // Toggle: click same filter again to clear
    if (summaryFilter?.column === column && summaryFilter?.value === value) {
      setSummaryFilter(null);
    } else {
      setSummaryFilter({ column, value });
    }
  };

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      if (sortDirection === 'asc') setSortDirection('desc');
      else { setSortColumn(null); setSortDirection('asc'); } // third click clears sort
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  };

  const toggleCycle = (cycleKey: string) => {
    setExpandedCycles(prev => {
      const next = new Set(prev);
      if (next.has(cycleKey)) next.delete(cycleKey);
      else next.add(cycleKey);
      return next;
    });
  };

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DollarSign className="w-8 h-8 text-zebra-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Payroll Jobs</h1>
            <p className="text-sm text-gray-500">TA_UNIT_PAY_STATUS — Last 7 Days</p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {syncMutation.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <RotateCcw className="w-4 h-4" />}
            {syncMutation.isPending ? 'Starting Sync...' : 'Sync Clients'}
          </button>
          {lastSyncedAt && !syncMessage && (
            <span className="text-xs text-gray-400">
              Last synced: {fmt(lastSyncedAt)}
            </span>
          )}
          {syncMessage && (
            <span className="text-xs text-amber-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {syncMessage}
            </span>
          )}
          {clients.length === 0 && !clientsLoading && !syncMutation.isPending && (
            <span className="text-xs text-gray-400">No enabled clients — click Sync Clients to discover</span>
          )}
        </div>
      </div>

      <div className="flex gap-6 flex-1 min-h-0 mt-6">
        {/* Left Panel — Payroll Cycle Sections (collapsible) */}
        {leftPanelOpen && (
        <div className="w-72 flex-shrink-0 space-y-2 overflow-y-auto">
          {clientsLoading ? (
            <div className="bg-white rounded-xl shadow-sm border p-8 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-zebra-600" />
              <span className="ml-2 text-sm text-gray-500">Loading clients...</span>
            </div>
          ) : clients.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border p-6 text-center text-gray-400">
              <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No payroll-enabled clients found.</p>
              <p className="text-xs mt-1">Click <strong>Sync Clients</strong> to check RTA_INTEGRATION across all client databases.</p>
            </div>
          ) : (
            PAYROLL_CYCLES.map(cycle => {
              const cycleClients = clientsByCycle[cycle.key] || [];
              const isExpanded = expandedCycles.has(cycle.key);

              return (
                <div key={cycle.key} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                  {/* Cycle Header */}
                  <button
                    onClick={() => toggleCycle(cycle.key)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                      <span className={`w-2 h-2 rounded-full ${cycle.color}`} />
                      <span className="font-medium text-sm text-gray-900">{cycle.label}</span>
                    </div>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      {cycleClients.length}
                    </span>
                  </button>

                  {/* Client List */}
                  {isExpanded && cycleClients.length > 0 && (
                    <div className="border-t divide-y divide-gray-50">
                      {cycleClients.map((c: any) => (
                        <button
                          key={c.clientId}
                          onClick={() => handleClientClick(c.clientId)}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-zebra-50 transition-colors flex items-center justify-between ${
                            selectedClientId === c.clientId ? 'bg-zebra-50 border-l-2 border-zebra-600' : ''
                          }`}
                        >
                          <div>
                            <span className="font-medium text-gray-800">{c.clientId}</span>
                            <span className="text-gray-400 ml-1.5 text-xs">{c.name !== c.clientId ? c.name : ''}</span>
                          </div>
                          {selectedClientId === c.clientId && payrollFetching && (
                            <Loader2 className="w-3 h-3 animate-spin text-zebra-600" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {isExpanded && cycleClients.length === 0 && (
                    <div className="border-t px-4 py-3 text-xs text-gray-400 text-center">No clients</div>
                  )}
                </div>
              );
            })
          )}
        </div>
        )}

        {/* Right Panel — Payroll Data */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Panel toggle + Search bar */}
          <div className="bg-white rounded-xl shadow-sm border p-3 flex items-center gap-3 flex-shrink-0">
            <button
              onClick={() => setLeftPanelOpen(prev => !prev)}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
              title={leftPanelOpen ? 'Collapse client panel' : 'Expand client panel'}
            >
              {leftPanelOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
            </button>

            {payrollData && !payrollFetching && (
              <>
                <span className="text-sm font-semibold text-gray-900">{payrollData.clientId}</span>
                <button
                  onClick={() => refetch()}
                  disabled={payrollFetching}
                  className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </>
            )}

            {summaryFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-1 bg-zebra-50 border border-zebra-200 rounded-lg text-xs text-zebra-700">
                {formatColumnName(summaryFilter.column)}: {summaryFilter.value}
                <button onClick={() => setSummaryFilter(null)} className="ml-1 hover:text-red-600">&times;</button>
              </span>
            )}

            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search across all columns..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-zebra-500"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          {/* Loading */}
          {(payrollLoading || payrollFetching) && (
            <div className="bg-white rounded-xl shadow-sm border p-12 flex flex-col items-center justify-center text-gray-500 mt-4">
              <Loader2 className="w-8 h-8 animate-spin mb-3 text-zebra-600" />
              <p className="text-sm">Querying TA_UNIT_PAY_STATUS via DB2...</p>
              <p className="text-xs text-gray-400 mt-1">This may take a moment for remote connections</p>
            </div>
          )}

          {/* Error */}
          {payrollError && !payrollFetching && (
            <div className="bg-white rounded-xl shadow-sm border p-8 mt-4">
              <div className="flex items-center gap-3 text-red-600">
                <XCircle className="w-6 h-6" />
                <div>
                  <p className="font-medium">Query Failed</p>
                  <p className="text-sm text-red-500 mt-1">{(payrollError as any).message}</p>
                </div>
              </div>
            </div>
          )}

          {/* Summary Cards */}
          {payrollData && summary && !payrollFetching && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-shrink-0 mt-4">
              <div className="bg-white rounded-xl shadow-sm border p-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Total Records</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalRecords}</p>
                <p className="text-xs text-gray-400 mt-1">{payrollData.executionTimeMs}ms</p>
              </div>

              <div className="bg-white rounded-xl shadow-sm border p-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Unique Units</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.uniqueUnits}</p>
                <p className="text-xs text-gray-400 mt-1">{summary.weekStartDates.length} week(s)</p>
              </div>

              <div className="bg-white rounded-xl shadow-sm border p-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide">File Status</p>
                <div className="mt-2 space-y-1">
                  {Object.entries(summary.fileStatusCounts).map(([status, count]) => (
                    <button
                      key={status}
                      onClick={() => handleSummaryClick('FILE_STATUS', status)}
                      className={`w-full flex items-center justify-between text-sm px-2 py-0.5 rounded transition-colors ${
                        summaryFilter?.column === 'FILE_STATUS' && summaryFilter?.value === status
                          ? 'bg-zebra-100 ring-1 ring-zebra-400'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-gray-600">{status}</span>
                      <span className="font-medium text-gray-900">{count}</span>
                    </button>
                  ))}
                  {Object.keys(summary.fileStatusCounts).length === 0 && (
                    <p className="text-xs text-gray-400">N/A</p>
                  )}
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border p-4">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Lock Status</p>
                <div className="mt-2 space-y-1">
                  {Object.entries(summary.lockStatusCounts).map(([status, count]) => (
                    <button
                      key={status}
                      onClick={() => handleSummaryClick('LOCK_STATUS', status)}
                      className={`w-full flex items-center justify-between text-sm px-2 py-0.5 rounded transition-colors ${
                        summaryFilter?.column === 'LOCK_STATUS' && summaryFilter?.value === status
                          ? 'bg-zebra-100 ring-1 ring-zebra-400'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-gray-600">{status}</span>
                      <span className="font-medium text-gray-900">{count}</span>
                    </button>
                  ))}
                  {Object.keys(summary.lockStatusCounts).length === 0 && (
                    <p className="text-xs text-gray-400">N/A</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Data Table */}
          {payrollData && !payrollFetching && (
            <div className="bg-white rounded-xl shadow-sm border flex-1 min-h-0 flex flex-col mt-4">
              <div className="px-4 py-2 border-b bg-gray-50 flex items-center justify-between rounded-t-xl flex-shrink-0">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium text-gray-900">{payrollData.clientId}</span>
                  <span className="text-gray-500">
                    {filtered.length}{filtered.length !== records.length ? ` of ${records.length}` : ''} record{filtered.length !== 1 ? 's' : ''}
                  </span>
                  <span className="text-gray-400">{columns.length} columns</span>
                </div>
                {(searchTerm || summaryFilter) && (
                  <button
                    onClick={() => { setSearchTerm(''); setSummaryFilter(null); }}
                    className="text-xs text-zebra-600 hover:text-zebra-800"
                  >
                    Clear all filters
                  </button>
                )}
              </div>

              {filtered.length > 0 ? (
                <div className="overflow-auto flex-1 min-h-0">
                  <table className="w-full text-sm resizable-cols">
                    <thead className="bg-gray-50 border-b sticky top-0 z-10">
                      <tr>
                        {columns.map(col => (
                          <th
                            key={col}
                            onClick={() => handleSort(col)}
                            className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap cursor-pointer select-none hover:bg-gray-100 transition-colors"
                          >
                            <span className="inline-flex items-center gap-1">
                              {formatColumnName(col)}
                              {sortColumn === col ? (
                                sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-zebra-600" /> : <ArrowDown className="w-3 h-3 text-zebra-600" />
                              ) : (
                                <ArrowUpDown className="w-3 h-3 text-gray-300" />
                              )}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map((r, idx) => (
                        <tr key={idx} className="hover:bg-gray-50 transition-colors">
                          {columns.map(col => {
                            const val = r[col] || '';
                            const badge = getStatusBadge(val, col);
                            return (
                              <td key={col} className="px-4 py-2.5 whitespace-nowrap">
                                {badge || (
                                  <span className={col.includes('UNIT_ID') ? 'font-mono text-gray-900' : 'text-gray-700'}>
                                    {val}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500 text-sm">
                  {searchTerm ? 'No records match your search.' : 'No payroll records found for the last 7 days.'}
                </div>
              )}
            </div>
          )}

          {/* Empty State */}
          {!payrollData && !payrollLoading && !payrollFetching && !payrollError && (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400 mt-4">
              <Building2 className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Select a client from the payroll cycle sections to fetch TA_UNIT_PAY_STATUS</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
