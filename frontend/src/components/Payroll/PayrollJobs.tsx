import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DollarSign, Search, Loader2, RefreshCw, Building2,
  CheckCircle, XCircle, ChevronDown, ChevronRight, ChevronLeft,
  RotateCcw, AlertCircle, ArrowUpDown, ArrowUp, ArrowDown,
  PanelLeftClose, PanelLeftOpen, Calendar, Files, Clock, Eye, EyeOff,
} from 'lucide-react';
import { payrollApi } from '../../services/api';
import { usePermission } from '../../context/AuthContext';
import { useTimezone } from '../../hooks/useTimezone';
import { ClearableSearchInput } from '../ui/ClearableFilter';
import {
  FREQUENCY_LABELS,
  FREQUENCY_ORDER,
  PAY_DEADLINE_DAY_OF_MONTH_OPTIONS,
  PAY_DEADLINE_DAYS_AFTER_OPTIONS,
  PAY_DEADLINE_WEEKDAYS,
  daysAfterWeekEndForWeekday,
  fileGenLabel,
  formatDeadlineBadge,
  formatYyyymmdd,
  isAllStoreFileGen,
  ordinalDay,
  parseFrequencies,
  payrollDeadlinePickerKind,
  weekdayFromDaysAfter,
} from '../../constants/payroll';

const DETAIL_PAGE_SIZE = 20;
interface PayrollClient {
  clientId: string;
  name: string;
  payrollCycle: string;
  payrollFrequencies?: string[];
  payrollFileGen: string;
  priorPeriodEdit: boolean;
  priorPeriodEditLimit: number;
  payrollSyncedAt: string | null;
  payrollMonitorEnabled?: boolean;
  payrollDeadlineDaysAfterWeekEnd?: number | null;
  payrollDeadlineDayOfMonth?: number | null;
  payrollDeadlineLocalTime?: string | null;
  timezone?: string;
}

interface PayPeriod {
  weekStartDate: string;
  weekEndDate: string;
  weekNo: string;
  year: string;
  isCurrent: boolean;
  isPrevious?: boolean;
}

interface PayrollRecord {
  unitId: string;
  weekStartDate: string;
  weekEndDate: string;
  fileStatus: string;
  fileId: string;
  generated: boolean;
  generatedAt?: string;
  fileName?: string;
}

interface PayFileProcess {
  frequency: string;
  unitGrpId: string;
  fileType: string;
  splitPayfile: string;
  priorPeriodAdjLimit: number;
  reopenForEdits: string;
  payConfigName: string;
}

interface PayrollResult {
  clientId: string;
  weekEndDate: string;
  frequency: string | null;
  frequencies: string[];
  processes: PayFileProcess[];
  periods: PayPeriod[];
  generators: {
    regular: { running: boolean; jobType: string | null };
    adjustment: { running: boolean; jobType: string | null };
  };
  records: PayrollRecord[];
  summary: {
    totalStores: number;
    generatedCount: number;
    pendingCount: number;
    distinctFileIds: number;
    fileIds: string[];
    generatedAt?: string | null;
    priorWeek?: {
      weekEndDate: string;
      total: number;
      generated: number;
    } | null;
  };
  adj: {
    costSegCount: number;
    diffPayCount: number;
    outstanding: number;
    error?: string;
  } | null;
  timezone?: string;
  payrollMonitorEnabled?: boolean;
  payrollDeadlineDaysAfterWeekEnd?: number | null;
  payrollDeadlineDayOfMonth?: number | null;
  payrollDeadlineLocalTime?: string | null;
  deadlineAt?: string | null;
  deadlineResolved?: boolean;
  late?: boolean;
  lateMinutes?: number | null;
  executionTimeMs: number;
}

type FileTab = 'regular' | 'adjustment';

function clientFrequencies(c: PayrollClient, live?: string[]): string[] {
  if (live && live.length) return parseFrequencies(c.payrollCycle, live);
  return parseFrequencies(c.payrollCycle, c.payrollFrequencies);
}

function frequencyMeta(code: string): { label: string; color: string } {
  return FREQUENCY_LABELS[code] || { label: code, color: 'bg-gray-400' };
}

function displayProcessValue(value: string | null | undefined): string {
  const s = (value ?? '').trim();
  if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return '—';
  return s;
}

function isAdjEligibleWeek(weekEnd: string, periods: PayPeriod[], limit: number): boolean {
  if (!limit) return false;
  const current = periods.find(p => p.isCurrent);
  if (!current) return false;
  const sorted = [...periods].sort((a, b) => b.weekEndDate.localeCompare(a.weekEndDate));
  const currentIdx = sorted.findIndex(p => p.weekEndDate === current.weekEndDate);
  const idx = sorted.findIndex(p => p.weekEndDate === weekEnd);
  return currentIdx >= 0 && idx > currentIdx && idx <= currentIdx + limit;
}

export default function PayrollJobs() {
  const { fmt, fmtDb2 } = useTimezone();
  const canSync = usePermission('PAYROLL_SYNC', 'write');
  const canViewDetails = usePermission('PAYROLL_DETAILS_VIEW', 'read');
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedFrequency, setSelectedFrequency] = useState('');
  const [selectedWeekEnd, setSelectedWeekEnd] = useState('');
  const [fileTab, setFileTab] = useState<FileTab>('regular');
  const [searchTerm, setSearchTerm] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [expandedCycles, setExpandedCycles] = useState<Set<string>>(new Set(['WK']));
  const [fetchEnabled, setFetchEnabled] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'generated' | 'pending'>('all');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [showDetailedData, setShowDetailedData] = useState(false);
  /** Once true for a client/week, keep requesting unit rows so hide/show is UI-only. */
  const [detailsRequested, setDetailsRequested] = useState(false);
  const [detailPage, setDetailPage] = useState(1);
  const [deadlineDow, setDeadlineDow] = useState('1');
  const [deadlineDaysAfter, setDeadlineDaysAfter] = useState('1');
  const [deadlineDayOfMonth, setDeadlineDayOfMonth] = useState('5');
  const [deadlineTime, setDeadlineTime] = useState('10:00');
  const [deadlineMsg, setDeadlineMsg] = useState('');

  const qc = useQueryClient();

  const { data: clientsRes, isLoading: clientsLoading } = useQuery({
    queryKey: ['payroll-clients'],
    queryFn: () => payrollApi.getClients(),
    staleTime: 30 * 60 * 1000,
  });
  const clients: PayrollClient[] = (clientsRes as any)?.data || [];

  const selectedClient = clients.find(c => c.clientId === selectedClientId) || null;
  const lastSyncedAt: string | null = clients.find(c => c.payrollSyncedAt)?.payrollSyncedAt ?? null;

  const syncMutation = useMutation({
    mutationFn: () => payrollApi.syncClients(),
    onSuccess: () => {
      setSyncMessage('Sync running in background. Refreshing client list in 30s...');
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['payroll-clients'] });
        setSyncMessage('');
      }, 30000);
    },
    onError: (err: any) => {
      setSyncMessage(`Sync failed: ${err.message}`);
    },
  });

  const deadlineMutation = useMutation({
    mutationFn: (payload: {
      frequency?: string | null;
      daysAfterWeekEnd?: number | null;
      dayOfMonth?: number | null;
      localTime: string | null;
      clear?: boolean;
    }) => payrollApi.updateDeadline(selectedClientId, payload),
    onSuccess: () => {
      setDeadlineMsg('Deadline saved');
      qc.invalidateQueries({ queryKey: ['payroll-clients'] });
      qc.invalidateQueries({ queryKey: ['payroll-status', selectedClientId] });
      setTimeout(() => setDeadlineMsg(''), 2500);
    },
    onError: (err: any) => {
      setDeadlineMsg(err?.message || 'Failed to save deadline');
    },
  });

  const [monitorMsg, setMonitorMsg] = useState('');
  const monitorMutation = useMutation({
    mutationFn: (enabled: boolean) => payrollApi.updateMonitorEnabled(selectedClientId, enabled),
    onSuccess: (_res, enabled) => {
      setMonitorMsg(enabled ? 'Monitor enabled' : 'Monitor disabled');
      qc.invalidateQueries({ queryKey: ['payroll-clients'] });
      qc.invalidateQueries({ queryKey: ['payroll-status', selectedClientId] });
      qc.invalidateQueries({ queryKey: ['payroll-monitor-progressive'] });
      qc.invalidateQueries({ queryKey: ['payroll-deadline-alerts'] });
      setTimeout(() => setMonitorMsg(''), 2500);
    },
    onError: (err: any) => {
      setMonitorMsg(err?.message || 'Failed to update monitor');
    },
  });

  const {
    data: payrollRes,
    isLoading: payrollLoading,
    isFetching: payrollFetching,
    refetch,
    error: payrollError,
  } = useQuery({
    queryKey: ['payroll-status', selectedClientId, selectedWeekEnd, selectedFrequency, detailsRequested && canViewDetails],
    queryFn: () => payrollApi.getPayrollStatus(
      selectedClientId,
      selectedWeekEnd || undefined,
      selectedFrequency || undefined,
      detailsRequested && canViewDetails,
    ),
    enabled: fetchEnabled && !!selectedClientId,
    staleTime: 5 * 60 * 1000,
    retry: false,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!canViewDetails) {
      setShowDetailedData(false);
      setDetailsRequested(false);
    }
  }, [canViewDetails]);
  const payrollData: PayrollResult | null = (payrollRes as any)?.data || null;

  useEffect(() => {
    const weekEnd = selectedWeekEnd || payrollData?.weekEndDate || '';
    const days = payrollData?.payrollDeadlineDaysAfterWeekEnd
      ?? selectedClient?.payrollDeadlineDaysAfterWeekEnd;
    const dayOfMonth = payrollData?.payrollDeadlineDayOfMonth
      ?? selectedClient?.payrollDeadlineDayOfMonth;
    const time = payrollData?.payrollDeadlineLocalTime
      ?? selectedClient?.payrollDeadlineLocalTime;
    const dow = days != null ? weekdayFromDaysAfter(weekEnd, days) : 1;
    setDeadlineDow(dow != null ? String(dow) : '1');
    setDeadlineDaysAfter(days != null ? String(days) : '1');
    setDeadlineDayOfMonth(dayOfMonth != null ? String(dayOfMonth) : '5');
    setDeadlineTime(time || '10:00');
    setDeadlineMsg('');
  }, [
    selectedClientId,
    selectedWeekEnd,
    selectedFrequency,
    payrollData?.weekEndDate,
    selectedClient?.payrollDeadlineDaysAfterWeekEnd,
    selectedClient?.payrollDeadlineDayOfMonth,
    selectedClient?.payrollDeadlineLocalTime,
    payrollData?.payrollDeadlineDaysAfterWeekEnd,
    payrollData?.payrollDeadlineDayOfMonth,
    payrollData?.payrollDeadlineLocalTime,
  ]);

  const liveFrequencies =
    payrollData?.clientId === selectedClientId ? payrollData.frequencies : undefined;

  const frequencyKeys = useMemo(() => {
    const present = new Set(
      clients.flatMap(c =>
        clientFrequencies(c, c.clientId === selectedClientId ? liveFrequencies : undefined),
      ),
    );
    const ordered = FREQUENCY_ORDER.filter(k => present.has(k));
    const extra = [...present].filter(k => !FREQUENCY_ORDER.includes(k as typeof FREQUENCY_ORDER[number]));
    return [...ordered, ...extra];
  }, [clients, selectedClientId, liveFrequencies]);

  const clientQuery = clientSearch.trim().toLowerCase();
  const clientMatches = (c: PayrollClient) =>
    !clientQuery
    || c.clientId.toLowerCase().includes(clientQuery)
    || (c.name || '').toLowerCase().includes(clientQuery);

  const clientsByCycle: Record<string, PayrollClient[]> = {};
  for (const key of frequencyKeys) {
    clientsByCycle[key] = clients.filter(c =>
      clientMatches(c)
      && clientFrequencies(c, c.clientId === selectedClientId ? liveFrequencies : undefined).includes(key),
    );
  }
  const clientMatchCount = clientQuery
    ? clients.filter(clientMatches).length
    : clients.length;

  const prevFreqKeys = useRef<string[]>([]);
  useEffect(() => {
    setExpandedCycles(prev => {
      const next = new Set(prev);
      for (const k of frequencyKeys) {
        if (!prevFreqKeys.current.includes(k)) next.add(k);
      }
      return next;
    });
    prevFreqKeys.current = frequencyKeys;
  }, [frequencyKeys]);

  const selectedClientFreqs = selectedClient
    ? clientFrequencies(selectedClient, liveFrequencies)
    : [];
  const processes = payrollData?.processes || [];
  const records = payrollData?.records || [];
  const summary = payrollData?.summary || null;
  const periods = payrollData?.periods || [];
  const generators = payrollData?.generators;
  const adj = payrollData?.adj;

  const adjConfigured = !!(selectedClient?.priorPeriodEdit && (selectedClient.priorPeriodEditLimit || 0) > 0);
  const adjJobRunning = !!generators?.adjustment.running;
  const regularJobRunning = !!generators?.regular.running;

  const filtered = useMemo(() => {
    let result = records;
    if (statusFilter === 'generated') result = result.filter(r => r.generated);
    if (statusFilter === 'pending') result = result.filter(r => !r.generated);
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      result = result.filter(r =>
        r.unitId.toLowerCase().includes(q) ||
        r.fileId.toLowerCase().includes(q) ||
        r.fileStatus.toLowerCase().includes(q) ||
        (r.fileName || '').toLowerCase().includes(q),
      );
    }
    if (sortColumn) {
      result = [...result].sort((a, b) => {
        const aVal = String((a as any)[sortColumn] ?? '');
        const bVal = String((b as any)[sortColumn] ?? '');
        const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }
    return result;
  }, [records, searchTerm, statusFilter, sortColumn, sortDirection]);

  const detailPageCount = Math.max(1, Math.ceil(filtered.length / DETAIL_PAGE_SIZE));
  const safeDetailPage = Math.min(detailPage, detailPageCount);
  const pagedRecords = useMemo(() => {
    const start = (safeDetailPage - 1) * DETAIL_PAGE_SIZE;
    return filtered.slice(start, start + DETAIL_PAGE_SIZE);
  }, [filtered, safeDetailPage]);

  useEffect(() => {
    setDetailPage(1);
  }, [searchTerm, statusFilter, sortColumn, sortDirection, selectedClientId, selectedWeekEnd, selectedFrequency]);

  useEffect(() => {
    if (detailPage > detailPageCount) setDetailPage(detailPageCount);
  }, [detailPage, detailPageCount]);

  const handleClientClick = (clientId: string, frequency: string) => {
    setSelectedClientId(clientId);
    setSelectedFrequency(frequency);
    setSelectedWeekEnd('');
    setFetchEnabled(true);
    setSearchTerm('');
    setStatusFilter('all');
    setSortColumn(null);
    setFileTab('regular');
    setLeftPanelOpen(false);
    setShowDetailedData(false);
    setDetailsRequested(false);
    setDetailPage(1);
  };

  const toggleDetailedData = () => {
    if (!canViewDetails) return;
    if (showDetailedData) {
      setShowDetailedData(false);
      return;
    }
    setDetailsRequested(true);
    setShowDetailedData(true);
  };
  const handleSort = (col: string) => {
    if (sortColumn === col) {
      if (sortDirection === 'asc') setSortDirection('desc');
      else { setSortColumn(null); setSortDirection('asc'); }
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

  const activeWeekEnd = selectedWeekEnd || payrollData?.weekEndDate || '';
  const adjWeek = isAdjEligibleWeek(activeWeekEnd, periods, selectedClient?.priorPeriodEditLimit || 0);
  const clientTz = payrollData?.timezone || selectedClient?.timezone || 'America/Chicago';
  const formatGeneratedAt = (raw?: string) => raw ? (fmtDb2(raw, clientTz, 'full') || raw) : '';
  const activeFrequency = selectedFrequency || payrollData?.frequency || 'WK';
  const deadlinePickerKind = payrollDeadlinePickerKind(activeFrequency);
  const deadlineDaysStored = payrollData?.payrollDeadlineDaysAfterWeekEnd
    ?? selectedClient?.payrollDeadlineDaysAfterWeekEnd
    ?? null;
  const deadlineDomStored = payrollData?.payrollDeadlineDayOfMonth
    ?? selectedClient?.payrollDeadlineDayOfMonth
    ?? null;
  const deadlineTimeStored = payrollData?.payrollDeadlineLocalTime
    ?? selectedClient?.payrollDeadlineLocalTime
    ?? null;
  const deadlineConfigured = !!(
    deadlineTimeStored
    && (deadlineDomStored != null || deadlineDaysStored != null)
  );
  const deadlineSummaryLabel = formatDeadlineBadge({
    frequency: activeFrequency,
    daysAfterWeekEnd: deadlineDaysStored,
    dayOfMonth: deadlineDomStored,
    localTime: deadlineTimeStored,
    weekEndYmd: activeWeekEnd,
  });
  const isLate = !!payrollData?.late && fileTab === 'regular';
  const monitorEnabled = payrollData?.payrollMonitorEnabled
    ?? selectedClient?.payrollMonitorEnabled
    ?? true;

  const saveDeadline = () => {
    if (!/^\d{1,2}:\d{2}$/.test(deadlineTime.trim())) {
      setDeadlineMsg('Time must be HH:mm');
      return;
    }
    const localTime = deadlineTime.trim();
    if (deadlinePickerKind === 'dayOfMonth') {
      const dayOfMonth = parseInt(deadlineDayOfMonth, 10);
      if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
        setDeadlineMsg('Day of month must be 1–28');
        return;
      }
      deadlineMutation.mutate({ frequency: activeFrequency, dayOfMonth, localTime });
      return;
    }
    if (deadlinePickerKind === 'daysAfter') {
      const daysAfterWeekEnd = parseInt(deadlineDaysAfter, 10);
      if (!Number.isFinite(daysAfterWeekEnd) || daysAfterWeekEnd < 0 || daysAfterWeekEnd > 14) {
        setDeadlineMsg('Days after period end must be 0–14');
        return;
      }
      deadlineMutation.mutate({ frequency: activeFrequency, daysAfterWeekEnd, localTime });
      return;
    }
    const dow = parseInt(deadlineDow, 10);
    const daysAfterWeekEnd = daysAfterWeekEndForWeekday(activeWeekEnd, dow);
    if (daysAfterWeekEnd == null) {
      setDeadlineMsg('Select a pay week before setting the deadline day');
      return;
    }
    deadlineMutation.mutate({ frequency: activeFrequency, daysAfterWeekEnd, localTime });
  };

  const clearDeadline = () => {
    deadlineMutation.mutate({ clear: true, localTime: null });
  };

  const columns: Array<{ key: keyof PayrollRecord | 'generated'; label: string }> = [
    { key: 'unitId', label: 'Unit' },
    { key: 'fileStatus', label: 'File status' },
    { key: 'fileId', label: 'File ID' },
    { key: 'generatedAt', label: 'Generated at' },
    { key: 'weekStartDate', label: 'Week start' },
    { key: 'weekEndDate', label: 'Week end' },
  ];

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DollarSign className="w-8 h-8 text-zebra-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Payroll Jobs</h1>
            <p className="text-sm text-gray-500">Regular and adjustment pay files, grouped by pay frequency from TA_PAY_FILE_GEN_PROCESS</p>
          </div>
        </div>

        {canSync && (
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
              <span className="text-xs text-gray-400">Last synced: {fmt(lastSyncedAt)}</span>
            )}
            {syncMessage && (
              <span className="text-xs text-amber-600 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {syncMessage}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-6 flex-1 min-h-0 mt-6">
        {leftPanelOpen && (
        <div className="w-80 flex-shrink-0 flex flex-col min-h-0">
          {!clientsLoading && clients.length > 0 && (
            <div className="relative mb-2 flex-shrink-0">
              <ClearableSearchInput
                value={clientSearch}
                onChange={setClientSearch}
                placeholder="Search client..."
                inputClassName="w-full py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-zebra-500"
              />
            </div>
          )}
          <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
          {clientsLoading ? (
            <div className="bg-white rounded-xl shadow-sm border p-8 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-zebra-600" />
              <span className="ml-2 text-sm text-gray-500">Loading clients...</span>
            </div>
          ) : clients.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border p-6 text-center text-gray-400">
              <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No payroll-enabled clients found.</p>
              <p className="text-xs mt-1">Click <strong>Sync Clients</strong> to check RTA and pay-file PFs.</p>
            </div>
          ) : clientMatchCount === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border p-6 text-center text-gray-400">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No clients match “{clientSearch.trim()}”.</p>
            </div>
          ) : (
            frequencyKeys.map(cycle => {
              const meta = frequencyMeta(cycle);
              const cycleClients = clientsByCycle[cycle] || [];
              if (cycleClients.length === 0) return null;
              const isExpanded = !!clientQuery || expandedCycles.has(cycle);

              return (
                <div key={cycle} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                  <button
                    onClick={() => toggleCycle(cycle)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                      <span className={`w-2 h-2 rounded-full ${meta.color}`} />
                      <span className="font-medium text-sm text-gray-900">{meta.label}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{cycle}</span>
                    </div>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      {cycleClients.length}
                    </span>
                  </button>

                  {isExpanded && cycleClients.length > 0 && (
                    <div className="border-t divide-y divide-gray-50">
                      {cycleClients.map(c => {
                        const isSelected = selectedClientId === c.clientId && selectedFrequency === cycle;
                        return (
                        <button
                          key={`${c.clientId}-${cycle}`}
                          onClick={() => handleClientClick(c.clientId, cycle)}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-zebra-50 transition-colors ${
                            isSelected ? 'bg-zebra-50 border-l-2 border-zebra-600' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-gray-800">{c.clientId}</span>
                            {isSelected && payrollFetching && (
                              <Loader2 className="w-3 h-3 animate-spin text-zebra-600" />
                            )}
                          </div>
                          {c.name && c.name.toLowerCase() !== c.clientId.toLowerCase() && (
                            <p className="text-[11px] text-gray-500 truncate">{c.name}</p>
                          )}
                          <div className="flex flex-wrap gap-1 mt-1">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                              {fileGenLabel(c.payrollFileGen)}
                            </span>
                            {c.priorPeriodEdit && c.priorPeriodEditLimit > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">
                                Adj {c.priorPeriodEditLimit}
                              </span>
                            )}
                            {(c.payrollMonitorEnabled ?? true) ? (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 inline-flex items-center gap-0.5"
                                title="Included on Payroll Monitor"
                              >
                                <Eye className="w-2.5 h-2.5" />
                                Monitor
                              </span>
                            ) : (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 inline-flex items-center gap-0.5"
                                title="Excluded from Payroll Monitor"
                              >
                                <EyeOff className="w-2.5 h-2.5" />
                                Off
                              </span>
                            )}
                            {(c.payrollDeadlineDayOfMonth != null || c.payrollDeadlineDaysAfterWeekEnd != null)
                              && c.payrollDeadlineLocalTime && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-800 inline-flex items-center gap-0.5"
                                title={`SLA ${c.payrollDeadlineLocalTime} ${c.timezone || ''}`}
                              >
                                <Clock className="w-2.5 h-2.5" />
                                {c.clientId === selectedClientId && deadlineSummaryLabel
                                  ? deadlineSummaryLabel
                                  : formatDeadlineBadge({
                                    frequency: cycle,
                                    daysAfterWeekEnd: c.payrollDeadlineDaysAfterWeekEnd,
                                    dayOfMonth: c.payrollDeadlineDayOfMonth,
                                    localTime: c.payrollDeadlineLocalTime,
                                    weekEndYmd: activeWeekEnd,
                                  })}
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
            })
          )}
          </div>
        </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
          <div className="bg-white rounded-xl shadow-sm border p-3 flex items-center gap-3 flex-shrink-0 flex-wrap">
            <button
              onClick={() => setLeftPanelOpen(prev => !prev)}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
              title={leftPanelOpen ? 'Collapse client panel' : 'Expand client panel'}
            >
              {leftPanelOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
            </button>

            {payrollData && (
              <>
                <span className="text-sm font-semibold text-gray-900">{payrollData.clientId}</span>
                {selectedClientFreqs.length > 0 && (
                  <div className="flex items-center gap-1">
                    {selectedClientFreqs.map(freq => {
                      const meta = frequencyMeta(freq);
                      const active = selectedFrequency === freq || (!selectedFrequency && payrollData.frequency === freq);
                      return (
                        <button
                          key={freq}
                          onClick={() => {
                            setSelectedFrequency(freq);
                            if (!showDetailedData) setDetailsRequested(false);
                          }}
                          className={`text-[11px] px-2 py-1 rounded-full font-medium transition-colors ${
                            active
                              ? 'bg-zebra-600 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                          title={meta.label}
                        >
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  onClick={() => refetch()}
                  disabled={payrollFetching}
                  className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className={`w-4 h-4 ${payrollFetching ? 'animate-spin' : ''}`} />
                </button>
                <div className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4 text-gray-400" />
                  <select
                    className="border border-gray-300 rounded-lg text-sm px-2 py-1.5 focus:ring-2 focus:ring-zebra-500"
                    value={activeWeekEnd}
                    onChange={e => {
                      setSelectedWeekEnd(e.target.value);
                      if (!showDetailedData) setDetailsRequested(false);
                    }}
                  >
                    {periods.map(p => (
                      <option key={p.weekEndDate} value={p.weekEndDate}>
                        {formatYyyymmdd(p.weekStartDate)} – {formatYyyymmdd(p.weekEndDate)}
                        {p.isCurrent ? ' (current)' : p.isPrevious ? ' (previous)' : ''}
                        {p.weekNo ? `  W${p.weekNo}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {showDetailedData && (
            <ClearableSearchInput
              className="flex-1 min-w-[12rem]"
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder="Search unit or file id..."
              inputClassName="w-full py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-zebra-500"
            />
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto mt-4">
          {payrollLoading && !(payrollData && payrollData.clientId === selectedClientId) && (
            <div className="bg-white rounded-xl shadow-sm border p-12 flex flex-col items-center justify-center text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin mb-3 text-zebra-600" />
              <p className="text-sm">Loading pay periods and file status from DB2...</p>
            </div>
          )}

          {payrollError && !payrollLoading && !(payrollData && payrollData.clientId === selectedClientId) && (
            <div className="bg-white rounded-xl shadow-sm border p-8">
              <div className="flex items-center gap-3 text-red-600">
                <XCircle className="w-6 h-6" />
                <div>
                  <p className="font-medium">Query Failed</p>
                  <p className="text-sm text-red-500 mt-1">{(payrollError as any).message}</p>
                </div>
              </div>
            </div>
          )}

          {payrollData && summary && payrollData.clientId === selectedClientId && (
            <>
              <div className="flex gap-2">
                <button
                  onClick={() => setFileTab('regular')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                    fileTab === 'regular' ? 'bg-zebra-600 text-white' : 'bg-white border text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  Regular
                </button>
                <button
                  onClick={() => setFileTab('adjustment')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                    fileTab === 'adjustment' ? 'bg-zebra-600 text-white' : 'bg-white border text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  Adjustment
                </button>
              </div>

              {fileTab === 'adjustment' && !adjConfigured ? (
                <div className="bg-white rounded-xl shadow-sm border flex flex-col items-center justify-center p-12 mt-4 text-center min-h-[16rem]">
                  <AlertCircle className="w-10 h-10 text-gray-300 mb-3" />
                  <p className="text-base font-semibold text-gray-800">Adjustment is not enabled</p>
                  <p className="text-sm text-gray-500 mt-2 max-w-md">
                    This client does not generate prior-period adjustment pay files.
                    PRIOR_PERIOD_EDIT must be Y and PRIOR_PERIOD_EDIT_LIMIT &gt; 0.
                  </p>
                  <p className="text-xs text-gray-400 mt-3">
                    PRIOR_PERIOD_EDIT = {selectedClient?.priorPeriodEdit ? 'Y' : 'N'}
                    {' · '}
                    LIMIT = {selectedClient?.priorPeriodEditLimit ?? 0}
                  </p>
                </div>
              ) : (
              <>
              {isLate && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
                  <Clock className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-900">
                      Past payroll SLA deadline
                      {payrollData?.lateMinutes != null ? ` (${payrollData.lateMinutes}m)` : ''}
                    </p>
                    <p className="text-xs text-amber-800 mt-0.5">
                      {summary?.pendingCount ?? 0} unit{(summary?.pendingCount ?? 0) === 1 ? '' : 's'} still pending
                      {payrollData?.deadlineAt
                        ? ` after deadline ${fmt(payrollData.deadlineAt, 'full')}`
                        : ''}
                      .
                    </p>
                  </div>
                </div>
              )}
              <div className={`gap-3 mt-3 min-w-0 ${fileTab === 'regular' ? 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4' : 'grid grid-cols-2 md:grid-cols-4'}`}>
                {/* Status: generator + monitor */}
                <div className="bg-white rounded-xl shadow-sm border p-4 min-w-0 flex flex-col">
                  <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Status</p>
                  {fileTab === 'regular' ? (
                    <>
                      <p className={`text-base font-semibold mt-1.5 ${regularJobRunning ? 'text-green-700' : 'text-amber-700'}`}>
                        {regularJobRunning ? 'Generator running' : 'Generator idle'}
                      </p>
                      <p
                        className="text-[11px] text-gray-400 mt-0.5 font-mono truncate"
                        title={generators?.regular.jobType || 'RTANewPayFileGeneratorJob / RTAPayrollFeedGeneratorJob'}
                      >
                        {generators?.regular.jobType || 'RTANewPayFile / RTAPayrollFeed'}
                      </p>
                      <div className="mt-auto pt-3 flex items-center justify-between gap-2 border-t border-gray-100">
                        <span className="inline-flex items-center gap-1 text-[11px] text-gray-600">
                          {monitorEnabled ? <Eye className="w-3 h-3 text-emerald-600" /> : <EyeOff className="w-3 h-3 text-gray-400" />}
                          Monitor {monitorEnabled ? 'on' : 'off'}
                        </span>
                        {canSync ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={monitorEnabled}
                            disabled={monitorMutation.isPending}
                            onClick={() => monitorMutation.mutate(!monitorEnabled)}
                            className={`text-[11px] px-2 py-0.5 rounded disabled:opacity-50 ${
                              monitorEnabled
                                ? 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                                : 'bg-zebra-600 text-white hover:bg-zebra-700'
                            }`}
                          >
                            {monitorMutation.isPending ? '…' : monitorEnabled ? 'Disable' : 'Enable'}
                          </button>
                        ) : null}
                      </div>
                      {monitorMsg && (
                        <p className={`text-[11px] mt-1.5 ${monitorMsg.includes('enabled') || monitorMsg.includes('disabled') ? 'text-green-700' : 'text-amber-700'}`}>
                          {monitorMsg}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className={`text-base font-semibold mt-1.5 ${adjJobRunning ? 'text-green-700' : 'text-amber-700'}`}>
                        {adjJobRunning ? 'Generator running' : 'Generator idle'}
                      </p>
                      <p className="text-[11px] text-gray-400 mt-0.5 font-mono truncate">
                        {generators?.adjustment.jobType || 'RTAPriorAdjPayGeneratorJob'}
                      </p>
                    </>
                  )}
                </div>

                {fileTab === 'regular' && (
                <div className="bg-white rounded-xl shadow-sm border p-4 min-w-0 flex flex-col">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Units generated</p>
                    <p className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap" title={`Query ${payrollData.executionTimeMs}ms`}>
                      {formatYyyymmdd(activeWeekEnd)}
                    </p>
                  </div>
                  <p
                    className="text-2xl font-bold text-gray-900 mt-1.5 tabular-nums leading-none"
                    title={summary.generatedAt ? `Last file update ${formatGeneratedAt(summary.generatedAt)}` : undefined}
                  >
                    {summary.generatedCount}
                    <span className="text-lg font-semibold text-gray-400">/{summary.totalStores}</span>
                  </p>
                  <p
                    className="text-xs text-gray-500 mt-2"
                    title={
                      summary.priorWeek
                        ? `Baseline = FILE_STATUS=F count for week ending ${formatYyyymmdd(summary.priorWeek.weekEndDate)}`
                        : undefined
                    }
                  >
                    <span className={summary.pendingCount > 0 ? 'text-amber-700 font-medium' : undefined}>
                      {summary.pendingCount} pending
                    </span>
                    {summary.priorWeek ? (
                      <span className="text-gray-400"> · prior week {summary.priorWeek.generated} F</span>
                    ) : null}
                  </p>
                  {summary.generatedAt && (
                    <p className="text-[11px] text-gray-400 mt-auto pt-2 truncate" title={formatGeneratedAt(summary.generatedAt)}>
                      Updated {formatGeneratedAt(summary.generatedAt)}
                    </p>
                  )}
                </div>
                )}

                {fileTab === 'regular' && (
                <div className="bg-white rounded-xl shadow-sm border p-4 min-w-0 flex flex-col">
                  <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide flex items-center gap-1">
                    <Files className="w-3 h-3" /> File split
                  </p>
                  <p className="text-base font-semibold text-gray-900 mt-1.5">
                    {fileGenLabel(selectedClient?.payrollFileGen)}
                  </p>
                  <p className="text-xs text-gray-500 mt-2">
                    {summary.distinctFileIds} file id{summary.distinctFileIds === 1 ? '' : 's'}
                    {isAllStoreFileGen(selectedClient?.payrollFileGen) ? ' · shared' : ''}
                  </p>
                </div>
                )}

                {fileTab === 'regular' && (
                <div className="bg-white rounded-xl shadow-sm border p-4 min-w-0 flex flex-col">
                  <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Pay deadline
                  </p>
                  <p className={`text-base font-semibold mt-1.5 ${deadlineConfigured ? (isLate ? 'text-amber-800' : 'text-gray-900') : 'text-gray-400'}`}>
                    {deadlineConfigured ? (deadlineSummaryLabel || 'Set') : 'Not set'}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-0.5 truncate" title={clientTz}>
                    {payrollData?.deadlineAt
                      ? fmt(payrollData.deadlineAt, 'full')
                      : clientTz}
                  </p>
                  {canSync ? (
                    <div className="mt-auto pt-3 flex flex-wrap items-center gap-1.5">
                      {deadlinePickerKind === 'weekday' && (
                        <select
                          className="border border-gray-300 rounded text-xs px-1.5 py-1 bg-white"
                          value={deadlineDow}
                          onChange={e => setDeadlineDow(e.target.value)}
                          title="Deadline weekday"
                        >
                          {PAY_DEADLINE_WEEKDAYS.map(d => (
                            <option key={d.dow} value={d.dow}>{d.label}</option>
                          ))}
                        </select>
                      )}
                      {deadlinePickerKind === 'daysAfter' && (
                        <select
                          className="border border-gray-300 rounded text-xs px-1.5 py-1 bg-white"
                          value={deadlineDaysAfter}
                          onChange={e => setDeadlineDaysAfter(e.target.value)}
                          title="Days after bi-weekly period end"
                        >
                          {PAY_DEADLINE_DAYS_AFTER_OPTIONS.map(d => (
                            <option key={d} value={d}>
                              {d === 0 ? 'Period end' : `+${d} day${d === 1 ? '' : 's'}`}
                            </option>
                          ))}
                        </select>
                      )}
                      {deadlinePickerKind === 'dayOfMonth' && (
                        <select
                          className="border border-gray-300 rounded text-xs px-1.5 py-1 bg-white"
                          value={deadlineDayOfMonth}
                          onChange={e => setDeadlineDayOfMonth(e.target.value)}
                          title="Deadline day of month"
                        >
                          {PAY_DEADLINE_DAY_OF_MONTH_OPTIONS.map(d => (
                            <option key={d} value={d}>{ordinalDay(d)}</option>
                          ))}
                        </select>
                      )}
                      <input
                        type="time"
                        className="border border-gray-300 rounded text-xs px-1.5 py-1 w-[7.5rem] bg-white"
                        value={deadlineTime}
                        onChange={e => setDeadlineTime(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={saveDeadline}
                        disabled={deadlineMutation.isPending}
                        className="text-[11px] px-2 py-0.5 rounded bg-zebra-600 text-white hover:bg-zebra-700 disabled:opacity-50"
                      >
                        {deadlineMutation.isPending ? 'Saving…' : 'Save'}
                      </button>
                      {deadlineConfigured && (
                        <button
                          type="button"
                          onClick={clearDeadline}
                          disabled={deadlineMutation.isPending}
                          className="text-[11px] px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Clear
                        </button>
                      )}
                      {deadlineMsg && (
                        <span className={`text-[11px] ${deadlineMsg === 'Deadline saved' ? 'text-green-700' : 'text-amber-700'}`}>
                          {deadlineMsg}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-[11px] text-gray-400 mt-auto pt-3">PAYROLL_SYNC required to edit</p>
                  )}
                </div>
                )}

                {fileTab === 'adjustment' && (
                  <div className="bg-white rounded-xl shadow-sm border p-4">
                    <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Adj outstanding</p>
                    <p className={`text-2xl font-bold mt-1.5 tabular-nums ${adj && adj.outstanding > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                      {adj?.outstanding ?? '—'}
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      {adj
                        ? `${adj.costSegCount} cost-seg − ${adj.diffPayCount} already paid`
                        : 'No adj counts'}
                    </p>
                  </div>
                )}
              </div>

              {fileTab === 'regular' && !regularJobRunning && (
                <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Regular generator is not Running in RFX_QUEUE (RTANewPayFileGeneratorJob or RTAPayrollFeedGeneratorJob).
                </div>
              )}
              {fileTab === 'adjustment' && !adjJobRunning && (
                <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Adjustment PFs are on, but RTAPriorAdjPayGeneratorJob is not Running in RFX_QUEUE.
                </div>
              )}
              {fileTab === 'adjustment' && adjJobRunning && !adjWeek && (
                <div className="mt-3 text-xs text-gray-600 bg-gray-50 border rounded-lg px-3 py-2">
                  Selected week is outside the prior-period window (limit {selectedClient?.priorPeriodEditLimit}).
                </div>
              )}
              {fileTab === 'adjustment' && adj?.error && (
                <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  Adj count query failed: {adj.error}
                </div>
              )}

              {processes.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm border mt-3 overflow-hidden">
                  <div className="px-4 py-2 border-b bg-gray-50 flex items-center justify-between">
                    <p className="text-xs font-medium text-gray-700">
                      Pay-file processes
                      {selectedFrequency || payrollData.frequency
                        ? ` · ${frequencyMeta(selectedFrequency || payrollData.frequency || '').label}`
                        : ''}
                    </p>
                    <span className="text-[11px] text-gray-400">{processes.length} row{processes.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="px-4 py-2 font-medium">Unit group</th>
                          <th className="px-4 py-2 font-medium">File type</th>
                          <th className="px-4 py-2 font-medium">Split</th>
                          <th className="px-4 py-2 font-medium">Adj limit</th>
                          <th className="px-4 py-2 font-medium">Reopen</th>
                          <th className="px-4 py-2 font-medium">Config</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {processes.map((p, idx) => (
                          <tr key={`${p.unitGrpId}-${p.fileType}-${idx}`}>
                            <td className="px-4 py-2 font-mono text-gray-800">{displayProcessValue(p.unitGrpId)}</td>
                            <td className="px-4 py-2 text-gray-700">{displayProcessValue(p.fileType)}</td>
                            <td className="px-4 py-2 text-gray-700">{displayProcessValue(p.splitPayfile)}</td>
                            <td className="px-4 py-2 text-gray-700">{p.priorPeriodAdjLimit}</td>
                            <td className="px-4 py-2 text-gray-700">{displayProcessValue(p.reopenForEdits)}</td>
                            <td className="px-4 py-2 text-gray-700">{displayProcessValue(p.payConfigName)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {fileTab === 'regular' && (
              <div className="bg-white rounded-xl shadow-sm border mt-4">
                <div className="px-4 py-2 border-b bg-gray-50 flex items-center justify-between rounded-t-xl gap-3 flex-wrap">
                  <div className="flex items-center gap-3 text-sm min-w-0 flex-wrap">
                    <span className="text-gray-500 whitespace-nowrap">
                      {showDetailedData
                        ? `${filtered.length}${filtered.length !== records.length ? ` of ${records.length}` : ''} store${filtered.length !== 1 ? 's' : ''}`
                        : `${summary.totalStores} store${summary.totalStores !== 1 ? 's' : ''} · stats only`}
                    </span>
                    {showDetailedData && (
                      <>
                        <button
                          onClick={() => setStatusFilter('all')}
                          className={`text-xs px-2 py-0.5 rounded ${statusFilter === 'all' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}
                        >All</button>
                        <button
                          onClick={() => setStatusFilter('generated')}
                          className={`text-xs px-2 py-0.5 rounded ${statusFilter === 'generated' ? 'bg-green-100 text-green-800' : 'hover:bg-gray-100'}`}
                        >Generated</button>
                        <button
                          onClick={() => setStatusFilter('pending')}
                          className={`text-xs px-2 py-0.5 rounded ${statusFilter === 'pending' ? 'bg-amber-100 text-amber-800' : 'hover:bg-gray-100'}`}
                        >Pending</button>
                      </>
                    )}
                    {showDetailedData && filtered.length > DETAIL_PAGE_SIZE && (
                      <div className="flex items-center gap-1 text-xs text-gray-600">
                        <button
                          type="button"
                          disabled={safeDetailPage <= 1}
                          onClick={() => setDetailPage(p => Math.max(1, p - 1))}
                          className="inline-flex items-center gap-0.5 px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" /> Prev
                        </button>
                        <span className="px-2 tabular-nums">
                          {safeDetailPage} / {detailPageCount}
                        </span>
                        <button
                          type="button"
                          disabled={safeDetailPage >= detailPageCount}
                          onClick={() => setDetailPage(p => Math.min(detailPageCount, p + 1))}
                          className="inline-flex items-center gap-0.5 px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Next <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {showDetailedData && filtered.length > 0 && (
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        Showing {(safeDetailPage - 1) * DETAIL_PAGE_SIZE + 1}
                        –
                        {Math.min(safeDetailPage * DETAIL_PAGE_SIZE, filtered.length)}
                        {' '}of {filtered.length}
                      </span>
                    )}
                    {showDetailedData && (searchTerm || statusFilter !== 'all') && (
                      <button
                        onClick={() => { setSearchTerm(''); setStatusFilter('all'); }}
                        className="text-xs text-zebra-600 hover:text-zebra-800"
                      >
                        Clear filters
                      </button>
                    )}
                    {canViewDetails && (
                      <button
                        type="button"
                        onClick={toggleDetailedData}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 hover:bg-white bg-white/80"
                        title={showDetailedData ? 'Hide per-unit release status' : 'Show per-unit release status'}
                      >
                        {showDetailedData ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {showDetailedData ? 'Hide details' : 'Show details'}
                      </button>
                    )}
                  </div>
                </div>

                {!canViewDetails ? (
                  <div className="p-8 text-center text-gray-500 text-sm">
                    <p>Last payroll stats are shown above.</p>
                    <p className="mt-2 text-xs text-gray-400">
                      Unit-level details are not available for your account.
                    </p>
                  </div>
                ) : !showDetailedData ? (
                  <div className="p-8 text-center text-gray-500 text-sm">
                    <p>Last payroll stats are shown above. Unit-level release status is hidden by default.</p>
                    <button
                      type="button"
                      onClick={toggleDetailedData}
                      className="mt-3 inline-flex items-center gap-1.5 text-sm text-zebra-600 hover:text-zebra-800 font-medium"
                    >
                      <Eye className="w-4 h-4" /> Show detailed data
                    </button>
                  </div>
                ) : detailsRequested && payrollFetching && records.length === 0 ? (
                  <div className="p-10 flex flex-col items-center justify-center text-gray-500">
                    <Loader2 className="w-6 h-6 animate-spin mb-2 text-zebra-600" />
                    <p className="text-sm">Loading unit release status…</p>
                  </div>
                ) : filtered.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        {columns.map(col => (
                          <th
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap cursor-pointer select-none hover:bg-gray-100"
                          >
                            <span className="inline-flex items-center gap-1">
                              {col.label}
                              {sortColumn === col.key ? (
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
                      {pagedRecords.map((r, idx) => (
                        <tr key={`${r.unitId}-${idx}`} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 font-mono text-gray-900">{r.unitId}</td>
                          <td className="px-4 py-2.5">
                            {r.generated ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                <CheckCircle className="w-3 h-3" /> Generated
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                {r.fileStatus || 'Pending'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-gray-700">{r.fileId || '—'}</td>
                          <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap" title={r.fileName || ''}>
                            {r.generatedAt ? formatGeneratedAt(r.generatedAt) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{formatYyyymmdd(r.weekStartDate)}</td>
                          <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{formatYyyymmdd(r.weekEndDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-8 text-center text-gray-500 text-sm">
                    {searchTerm ? 'No stores match your search.' : 'No TA_UNIT_PAY_STATUS rows for this pay period.'}
                  </div>
                )}
              </div>
              )}
              </>
              )}
            </>
          )}
          {!payrollData && !payrollLoading && !payrollError && (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <Building2 className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Select a client under a frequency (Weekly, Bi-Weekly, …) to load last payroll stats</p>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
