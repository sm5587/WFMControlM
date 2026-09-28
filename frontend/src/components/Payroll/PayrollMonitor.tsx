import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Radio, Loader2, RefreshCw, Building2, CheckCircle, Clock,
  Play, AlertCircle, AlertTriangle,
} from 'lucide-react';
import { payrollApi } from '../../services/api';
import { useTimezone } from '../../hooks/useTimezone';
import {
  useProgressivePayrollMonitor,
  type PayMonitorGenerator,
  type PayrollFileStatusCounts,
  type PayrollMonitorPhase,
  type PayrollMonitorRow,
  type PayrollUnitCounts,
} from '../../hooks/useProgressivePayrollMonitor';
import { formatYyyymmdd } from '../../constants/payroll';
import { SortableHeader, useSortState } from '../ui/SortableHeader';
import { ClearableSearchInput } from '../ui/ClearableFilter';

type Phase = PayrollMonitorPhase;

interface MonitorDetail {
  rowKey: string;
  clientId: string;
  timezone: string;
  weekStartDate: string;
  weekEndDate: string;
  distListId: string;
  distListName: string | null;
  generator: PayMonitorGenerator;
  units: PayrollUnitCounts;
  priorWeek?: {
    weekEndDate: string;
    total: number;
    generated: number;
  } | null;
  phase: Phase;
  stalled: boolean;
  stalledMinutes: number | null;
  deadlineAt: string | null;
  deadlineResolved?: boolean;
  late: boolean;
  lateMinutes: number | null;
  records: Array<{
    unitId: string;
    fileStatus: string;
    fileId: string;
    generated: boolean;
  }>;
}

const PHASE_LABEL: Record<Phase, { label: string; className: string }> = {
  live: { label: 'Live', className: 'bg-green-100 text-green-800' },
  late: { label: 'Late', className: 'bg-amber-100 text-amber-900' },
  upcoming: { label: 'Upcoming', className: 'bg-amber-100 text-amber-800' },
  complete: { label: 'Complete', className: 'bg-gray-100 text-gray-700' },
  unknown: { label: 'Unknown', className: 'bg-gray-100 text-gray-500' },
};

/** FILE_STATUS pipeline: Q pay released → D data generated → F file generated (complete). */
const STATUS_SEGMENTS: Array<{
  key: keyof PayrollFileStatusCounts;
  label: string;
  meaning: string;
  barClass: string;
  textClass: string;
}> = [
  { key: 'F', label: 'F', meaning: 'File generated', barClass: 'bg-emerald-500', textClass: 'text-emerald-700' },
  { key: 'D', label: 'D', meaning: 'Data generated', barClass: 'bg-violet-500', textClass: 'text-violet-700' },
  { key: 'Q', label: 'Q', meaning: 'Pay released', barClass: 'bg-sky-500', textClass: 'text-sky-700' },
  { key: 'blank', label: '—', meaning: 'Not started', barClass: 'bg-slate-300', textClass: 'text-slate-500' },
];

function emptyByStatus(): PayrollFileStatusCounts {
  return { F: 0, D: 0, Q: 0, blank: 0 };
}

function byStatusFromUnits(units: PayrollUnitCounts | undefined): PayrollFileStatusCounts {
  return units?.byStatus ? { ...units.byStatus } : emptyByStatus();
}

function byStatusFromRecords(
  records: Array<{ fileStatus: string }> | undefined,
): PayrollFileStatusCounts {
  const counts = emptyByStatus();
  if (!records) return counts;
  for (const r of records) {
    const s = (r.fileStatus || '').trim().toUpperCase();
    if (s === 'F' || s === 'D' || s === 'Q') counts[s] += 1;
    else counts.blank += 1;
  }
  return counts;
}

function storeGroupLabel(distListId: string, distListName?: string | null): string {
  if (distListId === 'ALL') return 'All units';
  if (distListName) return distListName;
  return `Group ${distListId || '—'}`;
}

function storeGroupTitle(distListId: string, distListName?: string | null): string {
  if (distListId === 'ALL') return 'All units';
  if (distListName) return `${distListName} (${distListId})`;
  return `Group ${distListId || '—'}`;
}

function progressPct(units: { total: number; generated: number }): number {
  if (!units.total) return 0;
  return Math.round((units.generated / units.total) * 100);
}

function UnitsStatusView({
  units,
  byStatus,
  priorWeek,
}: {
  units: { total: number; generated: number };
  byStatus: PayrollFileStatusCounts;
  priorWeek?: { weekEndDate: string; generated: number } | null;
}) {
  const pct = progressPct(units);
  const segmentSum = byStatus.F + byStatus.D + byStatus.Q + byStatus.blank;
  const denom = Math.max(units.total, segmentSum, 1);
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between text-xs text-gray-600 mb-1 gap-2">
        <span className="truncate">{units.generated}/{units.total}</span>
        <span className="shrink-0">{pct}%</span>
      </div>
      <div
        className="h-1.5 bg-gray-100 rounded-full overflow-hidden flex"
        role="img"
        aria-label={`File generated ${byStatus.F}, data generated ${byStatus.D}, pay released ${byStatus.Q}, not started ${byStatus.blank}`}
      >
        {STATUS_SEGMENTS.map(seg => {
          const count = byStatus[seg.key];
          if (count <= 0) return null;
          return (
            <div
              key={seg.key}
              className={`h-full ${seg.barClass}`}
              style={{ width: `${(count / denom) * 100}%` }}
              title={`${seg.meaning}: ${count}`}
            />
          );
        })}
      </div>
      <div className="text-[11px] mt-0.5 truncate">
        {STATUS_SEGMENTS.map((seg, i) => (
          <span key={seg.key}>
            {i > 0 ? <span className="text-gray-300"> · </span> : null}
            <span className={seg.textClass} title={seg.meaning}>
              {seg.label} {byStatus[seg.key]}
            </span>
          </span>
        ))}
      </div>
      {priorWeek && priorWeek.generated > 0 && (
        <div
          className="text-[11px] text-gray-400 mt-0.5 truncate"
          title={`Expected = prior week ${formatYyyymmdd(priorWeek.weekEndDate)} FILE_STATUS=F count (${priorWeek.generated})`}
        >
          vs prior F {priorWeek.generated}
        </div>
      )}
    </div>
  );
}

function scheduleLabel(gen: PayMonitorGenerator): string {
  if (gen.scheduleKind === 'cron') return gen.execCron || gen.schedule || '—';
  if (gen.scheduleKind === 'interval') return `every ${gen.schedule}s`;
  return gen.schedule || '—';
}

function parseReleaseSortMs(raw: string | null | undefined): number | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const isoSpace = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (isoSpace) {
    const t = Date.parse(
      `${isoSpace[1]}-${isoSpace[2]}-${isoSpace[3]}T${isoSpace[4]}:${isoSpace[5]}:${isoSpace[6]}Z`,
    );
    return Number.isFinite(t) ? t : null;
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 14) {
    const t = Date.parse(
      `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T` +
      `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`,
    );
    return Number.isFinite(t) ? t : null;
  }
  if (digits.length >= 8) {
    const t = Date.parse(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00Z`);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function releaseSortMs(gen: PayMonitorGenerator): number {
  return parseReleaseSortMs(gen.releaseDueAt)
    ?? parseReleaseSortMs(gen.lastJobTime)
    ?? Number.MAX_SAFE_INTEGER;
}

function compareReleaseOrder(a: PayrollMonitorRow, b: PayrollMonitorRow): number {
  return releaseSortMs(a.generator) - releaseSortMs(b.generator)
    || a.clientId.localeCompare(b.clientId)
    || a.distListId.localeCompare(b.distListId);
}

const PHASE_SORT_RANK: Record<Phase, number> = {
  late: 0,
  live: 1,
  upcoming: 2,
  complete: 3,
  unknown: 4,
};

function lastJobSortMs(gen: PayMonitorGenerator): number {
  return parseReleaseSortMs(gen.lastJobTime) ?? Number.MAX_SAFE_INTEGER;
}

/** Earliest deadline first; missing deadline sorts last. */
function deadlineSortMs(row: PayrollMonitorRow): number {
  if (!row.deadlineAt) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(row.deadlineAt);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function compareMonitorRows(
  a: PayrollMonitorRow,
  b: PayrollMonitorRow,
  column: string,
  direction: 'asc' | 'desc',
): number {
  const dir = direction === 'asc' ? 1 : -1;
  let cmp = 0;
  switch (column) {
    case 'client':
      cmp = a.clientId.localeCompare(b.clientId)
        || a.distListId.localeCompare(b.distListId)
        || a.name.localeCompare(b.name);
      break;
    case 'status':
      cmp = (PHASE_SORT_RANK[a.phase] - PHASE_SORT_RANK[b.phase])
        || (Number(b.stalled) - Number(a.stalled))
        || (Number(b.late) - Number(a.late))
        || ((a.stalledMinutes ?? 0) - (b.stalledMinutes ?? 0))
        || ((a.lateMinutes ?? 0) - (b.lateMinutes ?? 0));
      break;
    case 'release':
      cmp = compareReleaseOrder(a, b);
      break;
    case 'lastRun':
      cmp = lastJobSortMs(a.generator) - lastJobSortMs(b.generator)
        || a.clientId.localeCompare(b.clientId);
      break;
    case 'pending': {
      const ap = a.generator.running ? a.generator.jobsPending : -1;
      const bp = b.generator.running ? b.generator.jobsPending : -1;
      cmp = ap - bp;
      break;
    }
    case 'units':
      cmp = (progressPct(a.units) - progressPct(b.units))
        || (a.units.pending - b.units.pending)
        || (a.units.total - b.units.total);
      break;
    default:
      cmp = a.clientId.localeCompare(b.clientId);
  }
  return cmp * dir
    || a.clientId.localeCompare(b.clientId)
    || a.distListId.localeCompare(b.distListId);
}

export default function PayrollMonitor() {
  const { fmt, fmtDb2 } = useTimezone();
  const [selectedKey, setSelectedKey] = useState('');
  const [search, setSearch] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<'all' | Phase>('all');
  const { sortColumn, sortDirection, handleSort } = useSortState('status', 'asc');

  const {
    rows,
    liveCount,
    upcomingCount,
    completeCount,
    stalledCount,
    lateCount,
    stalledGraceMins,
    total,
    loaded,
    status,
    fetchedAt,
    errorMessage,
    isRefreshing,
    start,
  } = useProgressivePayrollMonitor();

  const selected = rows.find(r => r.rowKey === selectedKey) || null;
  const activeSelected = selected?.phase === 'live' || selected?.phase === 'late'
    || selected?.stalled || selected?.late;
  const canLoadDetail = !!selected?.clientId && !!selected?.distListId && !selected.loading;

  const {
    data: detailRes,
    isFetching: detailFetching,
  } = useQuery({
    queryKey: ['payroll-monitor-detail', selected?.clientId, selected?.distListId],
    queryFn: () => payrollApi.getMonitorDetail(selected!.clientId, selected!.distListId),
    enabled: canLoadDetail,
    refetchInterval: activeSelected ? 10000 : false,
    staleTime: 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const detail: MonitorDetail | null = (detailRes as any)?.data || null;

  const filtered = useMemo(() => {
    let list = rows;
    if (phaseFilter !== 'all') {
      list = list.filter(r => r.loading || r.phase === phaseFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.clientId.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.distListId.includes(q) ||
        (r.distListName || '').toLowerCase().includes(q) ||
        (r.generator.jobType || '').toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      if (a.loading !== b.loading) return a.loading ? -1 : 1;
      if ((phaseFilter === 'live' || phaseFilter === 'late') && sortColumn === 'status' && sortDirection === 'asc') {
        return (Number(b.stalled) - Number(a.stalled))
          || (Number(b.late) - Number(a.late))
          || deadlineSortMs(a) - deadlineSortMs(b)
          || ((a.lateMinutes ?? 0) - (b.lateMinutes ?? 0))
          || compareReleaseOrder(a, b)
          || a.clientId.localeCompare(b.clientId);
      }
      return compareMonitorRows(a, b, sortColumn, sortDirection);
    });
  }, [rows, phaseFilter, search, sortColumn, sortDirection]);

  const formatJobTime = (raw: string | null | undefined, tz: string) => {
    if (!raw) return '—';
    if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return fmt(raw, 'full');
    return fmtDb2(raw, tz, 'full') || raw;
  };

  const showEmpty = rows.length === 0 && status === 'done';
  const showInitialConnecting = rows.length === 0 && (status === 'connecting' || status === 'idle');

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Radio className="w-8 h-8 text-zebra-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Payroll Monitor</h1>
            <p className="text-sm text-gray-500">
              Pay release by store group (EXEC_CRON) — previous week units from RWS_DIST_STORE_MAP
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isRefreshing && total > 0 && (
            <span className="text-xs text-gray-500">
              Loading {Math.min(loaded, total)}/{total} clients
            </span>
          )}
          {fetchedAt && (
            <span className="text-xs text-gray-400">Updated {fmt(fetchedAt)}</span>
          )}
          <button
            onClick={() => start({ force: true })}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {stalledCount > 0 && (
        <div className="mt-6 flex-shrink-0 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">
              {stalledCount} store group{stalledCount === 1 ? '' : 's'} stalled
            </p>
            <p className="text-xs text-red-700 mt-0.5">
              Pay release has started but the generator is idle and units are still not generated
              (after {stalledGraceMins} min grace). Check WFM queue and pay-file generator jobs.
            </p>
          </div>
        </div>
      )}

      {lateCount > 0 && (
        <div className={`${stalledCount > 0 ? 'mt-3' : 'mt-6'} flex-shrink-0 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3`}>
          <Clock className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900">
              {lateCount} store group{lateCount === 1 ? '' : 's'} past payroll SLA deadline
            </p>
            <p className="text-xs text-amber-800 mt-0.5">
              Units are still pending after the client deadline set on Payroll Jobs.
              Release schedule (EXEC_CRON) is unchanged.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mt-6 flex-shrink-0">
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Live now</p>
          <p className="text-2xl font-bold text-green-700 mt-1">{rows.length ? liveCount : '—'}</p>
          <p className="text-xs text-gray-400 mt-1">
            Within ±12h of SLA deadline — units still pending
            {stalledCount > 0 && (
              <span className="text-red-600 font-medium"> · {stalledCount} stalled</span>
            )}
            {lateCount > 0 && (
              <span className="text-amber-700 font-medium"> · {lateCount} late</span>
            )}
          </p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Upcoming</p>
          <p className="text-2xl font-bold text-amber-700 mt-1">{rows.length ? upcomingCount : '—'}</p>
          <p className="text-xs text-gray-400 mt-1">Pending outside the SLA Live window</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Complete</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{rows.length ? completeCount : '—'}</p>
          <p className="text-xs text-gray-400 mt-1">All mapped units FILE_STATUS = F</p>
        </div>
      </div>

      <div className="flex gap-6 flex-1 min-h-0 mt-6">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="bg-white rounded-xl shadow-sm border p-3 flex items-center gap-3 flex-shrink-0 flex-wrap">
            <ClearableSearchInput
              className="flex-1 min-w-[12rem]"
              value={search}
              onChange={setSearch}
              placeholder="Search client, store group, job..."
              inputClassName="w-full py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-zebra-500"
            />
            {(['all', 'late', 'live', 'upcoming', 'complete'] as const).map(f => (
              <button
                key={f}
                onClick={() => setPhaseFilter(f)}
                className={`text-xs px-2 py-1 rounded ${
                  phaseFilter === f ? 'bg-zebra-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {f === 'all' ? 'All' : PHASE_LABEL[f].label}
              </button>
            ))}
          </div>

          {showInitialConnecting && (
            <div className="bg-white rounded-xl shadow-sm border p-12 flex flex-col items-center justify-center text-gray-500 mt-4">
              <Loader2 className="w-8 h-8 animate-spin mb-3 text-zebra-600" />
              <p className="text-sm">Loading payroll client list...</p>
            </div>
          )}

          {errorMessage && status === 'error' && rows.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm border p-6 mt-4 text-red-600 text-sm">
              {errorMessage}
            </div>
          )}

          {rows.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border flex-1 min-h-0 flex flex-col mt-4">
              {filtered.length === 0 ? (
                <div className="p-10 text-center text-gray-400">
                  <Building2 className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No payroll store groups match.</p>
                </div>
              ) : (
                <div className="overflow-auto flex-1 min-h-0">
                  <table className="w-full text-sm resizable-cols" style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '8%' }} />
                      <col style={{ width: '32%' }} />
                    </colgroup>
                    <thead className="bg-gray-50 border-b sticky top-0 z-10">
                      <tr>
                        <SortableHeader column="client" label="Client / group" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                        <SortableHeader column="status" label="Status" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                        <SortableHeader column="release" label="Release" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                        <SortableHeader column="lastRun" label="Last run" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                        <SortableHeader column="pending" label="Pending" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                        <SortableHeader column="units" label="Units" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map(r => {
                        const active = selectedKey === r.rowKey;
                        const meta = PHASE_LABEL[r.phase];
                        const gen = r.generator;
                        return (
                          <tr
                            key={r.rowKey}
                            onClick={() => !r.loading && setSelectedKey(r.rowKey)}
                            className={`${r.loading ? 'opacity-70' : 'cursor-pointer hover:bg-gray-50'} ${active ? 'bg-zebra-50' : ''} ${r.stalled ? 'bg-red-50/60' : ''}`}
                          >
                            <td className="px-4 py-2.5 overflow-hidden">
                              <div className="font-semibold text-gray-900 truncate" title={r.clientId}>{r.clientId}</div>
                              <div
                                className="text-[11px] text-gray-500 truncate"
                                title={r.loading ? 'Loading store groups…' : storeGroupTitle(r.distListId, r.distListName)}
                              >
                                {r.loading
                                  ? 'Loading…'
                                  : (
                                    <>
                                      {storeGroupLabel(r.distListId, r.distListName)}
                                      {r.weekEndDate ? ` · week ${formatYyyymmdd(r.weekEndDate)}` : ''}
                                    </>
                                  )}
                              </div>
                              <div className="text-[11px] text-gray-400 font-mono truncate" title={gen.jobType || undefined}>
                                {r.loading ? '—' : (gen.jobType || '—')}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 overflow-hidden">
                              {r.loading ? (
                                <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  Scanning
                                </span>
                              ) : (
                                <>
                                  <div className="flex flex-wrap items-center gap-1">
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.className}`}>
                                      {r.phase === 'live' && <Play className="w-3 h-3" />}
                                      {r.phase === 'late' && <Clock className="w-3 h-3" />}
                                      {r.phase === 'upcoming' && <Clock className="w-3 h-3" />}
                                      {r.phase === 'complete' && <CheckCircle className="w-3 h-3" />}
                                      {r.phase === 'late' && r.lateMinutes != null
                                        ? `Late ${r.lateMinutes}m`
                                        : meta.label}
                                    </span>
                                    {r.stalled && (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                        <AlertTriangle className="w-3 h-3" />
                                        Stalled{r.stalledMinutes != null ? ` ${r.stalledMinutes}m` : ''}
                                      </span>
                                    )}
                                    {r.deadlineResolved && (r.units?.pending || 0) > 0 && (
                                      <span
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600"
                                        title="Deadline alert resolved for this pay week — not shown as Late"
                                      >
                                        Resolved
                                      </span>
                                    )}
                                  </div>
                                  {r.error && (
                                    <p className="text-[11px] text-red-600 mt-1 truncate" title={r.error}>{r.error}</p>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-700 overflow-hidden">
                              {r.loading ? '—' : (
                                <>
                                  <div className="font-mono truncate" title={scheduleLabel(gen)}>
                                    {scheduleLabel(gen)}
                                  </div>
                                  {gen.releaseDueAt && (
                                    <div className="text-[11px] text-gray-400 mt-0.5 truncate" title={formatJobTime(gen.releaseDueAt, r.timezone)}>
                                      due {formatJobTime(gen.releaseDueAt, r.timezone)}
                                    </div>
                                  )}
                                  {r.deadlineAt && (
                                    <div className={`text-[11px] mt-0.5 truncate ${r.late ? 'text-amber-700 font-medium' : 'text-gray-400'}`} title={formatJobTime(r.deadlineAt, r.timezone)}>
                                      deadline {formatJobTime(r.deadlineAt, r.timezone)}
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-gray-700 text-xs overflow-hidden truncate" title={r.loading ? undefined : formatJobTime(gen.lastJobTime, r.timezone)}>
                              {r.loading ? '—' : formatJobTime(gen.lastJobTime, r.timezone)}
                            </td>
                            <td className="px-4 py-2.5 font-semibold text-gray-900 text-xs overflow-hidden">
                              {r.loading ? '—' : (gen.running ? gen.jobsPending : '—')}
                            </td>
                            <td className="px-4 py-2.5 overflow-hidden">
                              {r.loading ? (
                                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                  <div className="h-full w-1/3 bg-gray-300 animate-pulse" />
                                </div>
                              ) : (
                                <UnitsStatusView
                                  units={r.units}
                                  byStatus={byStatusFromUnits(r.units)}
                                  priorWeek={r.priorWeek}
                                />
                              )}
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

          {showEmpty && (
            <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400 mt-4">
              <Building2 className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No payroll-enabled clients to monitor.</p>
            </div>
          )}
        </div>

        <div className="w-[22rem] flex-shrink-0 flex flex-col min-h-0">
          {!selectedKey || !selected || selected.loading ? (
            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400 flex-1">
              <Radio className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Select a store group to watch mapped units as pay is released.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-900">{selected.clientId}</p>
                  <p
                    className="text-[11px] text-gray-400"
                    title={
                      selected.distListId === 'ALL'
                        ? undefined
                        : storeGroupTitle(
                          selected.distListId || '',
                          detail?.distListName ?? selected.distListName,
                        )
                    }
                  >
                    {selected.distListId === 'ALL'
                      ? 'Client-wide pay generator (no PARAM_3 store group)'
                      : `${storeGroupLabel(
                        selected.distListId || '',
                        detail?.distListName ?? selected.distListName,
                      )} · ID ${selected.distListId}`}
                  </p>
                </div>
                {detailFetching && <Loader2 className="w-4 h-4 animate-spin text-zebra-600" />}
              </div>
              <div className="px-4 py-3 border-b space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500 shrink-0">Job</span>
                  <span className="font-mono text-xs text-gray-800 text-right">
                    {(detail?.generator.jobType || selected.generator.jobType) || '—'}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500 shrink-0">EXEC_CRON</span>
                  <span className="font-mono text-xs text-gray-800 text-right">
                    {scheduleLabel(detail?.generator || selected.generator)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Release due</span>
                  <span className="text-gray-800 text-xs">
                    {formatJobTime(
                      detail?.generator.releaseDueAt || selected.generator.releaseDueAt,
                      detail?.timezone || selected.timezone || 'America/Chicago',
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">SLA deadline</span>
                  <span className={`text-xs ${(detail?.late ?? selected.late) ? 'text-amber-700 font-medium' : 'text-gray-800'}`}>
                    {formatJobTime(
                      detail?.deadlineAt ?? selected.deadlineAt,
                      detail?.timezone || selected.timezone || 'America/Chicago',
                    )}
                    {(detail?.late ?? selected.late) && ' (late)'}
                    {(detail?.deadlineResolved ?? selected.deadlineResolved)
                      && (detail?.units.pending ?? selected.units.pending) > 0
                      && ' (resolved)'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Last run</span>
                  <span className="text-gray-800 text-xs">
                    {formatJobTime(
                      detail?.generator.lastJobTime || selected.generator.lastJobTime,
                      detail?.timezone || selected.timezone || 'America/Chicago',
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Queue pending</span>
                  <span className="font-semibold">
                    {(detail?.generator.jobsPending ?? selected.generator.jobsPending) ?? '—'}
                  </span>
                </div>
                <div className="space-y-1">
                  <span className="text-gray-500 text-xs">Units</span>
                  <UnitsStatusView
                    units={detail?.units ?? selected.units}
                    byStatus={
                      detail?.units?.byStatus
                        ? byStatusFromUnits(detail.units)
                        : detail?.records?.length
                          ? byStatusFromRecords(detail.records)
                          : byStatusFromUnits(selected.units)
                    }
                    priorWeek={detail?.priorWeek ?? selected.priorWeek}
                  />
                </div>
              </div>
              <div className="flex-1 min-h-0" />
              {(detail?.stalled ?? selected.stalled) && (
                <div className="px-3 py-2 border-t bg-red-50 text-[11px] text-red-800 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Generator idle for {(detail?.stalledMinutes ?? selected.stalledMinutes) ?? '?'} min
                    with {(detail?.units.pending ?? selected.units.pending) ?? 0} units still not generated.
                    Investigate pay-file generator queue and WFM logs.
                  </span>
                </div>
              )}
              {selected.phase === 'late' && !(detail?.stalled ?? selected.stalled) && (
                <div className="px-3 py-2 border-t bg-amber-50 text-[11px] text-amber-900 flex items-start gap-1.5">
                  <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Past payroll SLA deadline with units still pending — shown on Alerts → Escalated.
                  </span>
                </div>
              )}
              {(detail?.deadlineResolved ?? selected.deadlineResolved)
                && (detail?.units.pending ?? selected.units.pending) > 0
                && selected.phase !== 'late'
                && !(detail?.stalled ?? selected.stalled) && (
                <div className="px-3 py-2 border-t bg-gray-50 text-[11px] text-gray-600 flex items-start gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Deadline alert resolved for this pay week — pending units no longer flagged as Late
                    on the dashboard or Monitor.
                  </span>
                </div>
              )}
              {selected.phase === 'live' && !(detail?.stalled ?? selected.stalled) && (
                <div className="px-3 py-2 border-t bg-green-50 text-[11px] text-green-800 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Refreshing every 10s while within ±12h of SLA deadline
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
