import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Radio, Loader2, RefreshCw, Building2, CheckCircle, Clock,
  Play, AlertCircle, AlertTriangle, Search,
} from 'lucide-react';
import { payrollApi } from '../../services/api';
import { useTimezone } from '../../hooks/useTimezone';
import { formatYyyymmdd } from '../../constants/payroll';

type Phase = 'live' | 'upcoming' | 'complete' | 'unknown';

interface PayMonitorGenerator {
  queueId: string;
  jobType: string;
  distListId: string;
  execCron: string | null;
  schedule: string;
  scheduleKind: 'cron' | 'interval' | 'unknown';
  releaseDueAt: string | null;
  nextRunAt: string | null;
  lastJobTime: string | null;
  jobsPending: number;
  running: boolean;
}

interface MonitorRow {
  rowKey: string;
  clientId: string;
  name: string;
  timezone: string;
  frequencies: string[];
  weekStartDate: string;
  weekEndDate: string;
  distListId: string;
  generator: PayMonitorGenerator;
  units: { total: number; generated: number; pending: number };
  phase: Phase;
  stalled: boolean;
  stalledMinutes: number | null;
  error?: string;
}

interface MonitorSnapshot {
  fetchedAt: string;
  liveCount: number;
  upcomingCount: number;
  completeCount: number;
  stalledCount: number;
  stalledGraceMins: number;
  rows: MonitorRow[];
  executionTimeMs: number;
}

interface MonitorDetail {
  rowKey: string;
  clientId: string;
  timezone: string;
  weekStartDate: string;
  weekEndDate: string;
  distListId: string;
  generator: PayMonitorGenerator;
  units: { total: number; generated: number; pending: number };
  phase: Phase;
  stalled: boolean;
  stalledMinutes: number | null;
  records: Array<{
    unitId: string;
    fileStatus: string;
    fileId: string;
    generated: boolean;
  }>;
}

const PHASE_LABEL: Record<Phase, { label: string; className: string }> = {
  live: { label: 'Live', className: 'bg-green-100 text-green-800' },
  upcoming: { label: 'Upcoming', className: 'bg-amber-100 text-amber-800' },
  complete: { label: 'Complete', className: 'bg-gray-100 text-gray-700' },
  unknown: { label: 'Unknown', className: 'bg-gray-100 text-gray-500' },
};

function progressPct(units: { total: number; generated: number }): number {
  if (!units.total) return 0;
  return Math.round((units.generated / units.total) * 100);
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

function compareReleaseOrder(a: MonitorRow, b: MonitorRow): number {
  return releaseSortMs(a.generator) - releaseSortMs(b.generator)
    || a.clientId.localeCompare(b.clientId)
    || a.distListId.localeCompare(b.distListId);
}

export default function PayrollMonitor() {
  const { fmt, fmtDb2 } = useTimezone();
  const [selectedKey, setSelectedKey] = useState('');
  const [search, setSearch] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<'all' | Phase>('all');

  const {
    data: snapRes,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ['payroll-monitor'],
    queryFn: () => payrollApi.getMonitorSnapshot(),
    refetchInterval: (q) => {
      const snap = (q.state.data as any)?.data;
      const live = Number(snap?.liveCount || 0);
      const stalled = Number(snap?.stalledCount || 0);
      return live > 0 || stalled > 0 ? 20000 : 60000;
    },
    staleTime: 10 * 1000,
    retry: false,
  });

  const snapshot: MonitorSnapshot | null = (snapRes as any)?.data || null;
  const rows = snapshot?.rows || [];

  const selected = rows.find(r => r.rowKey === selectedKey) || null;
  const activeSelected = selected?.phase === 'live' || selected?.stalled;

  const {
    data: detailRes,
    isFetching: detailFetching,
  } = useQuery({
    queryKey: ['payroll-monitor-detail', selected?.clientId, selected?.distListId],
    queryFn: () => payrollApi.getMonitorDetail(selected!.clientId, selected!.distListId),
    enabled: !!selected?.clientId && !!selected?.distListId,
    refetchInterval: activeSelected ? 10000 : false,
    staleTime: 8 * 1000,
    retry: false,
  });

  const detail: MonitorDetail | null = (detailRes as any)?.data || null;

  const filtered = useMemo(() => {
    let list = rows;
    if (phaseFilter !== 'all') list = list.filter(r => r.phase === phaseFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.clientId.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.distListId.includes(q) ||
        (r.generator.jobType || '').toLowerCase().includes(q),
      );
    }
    if (phaseFilter === 'live') {
      list = [...list].sort((a, b) =>
        (b.stalled ? 1 : 0) - (a.stalled ? 1 : 0) || compareReleaseOrder(a, b),
      );
    }
    return list;
  }, [rows, phaseFilter, search]);

  const formatJobTime = (raw: string | null | undefined, tz: string) => {
    if (!raw) return '—';
    if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return fmt(raw, 'full');
    return fmtDb2(raw, tz, 'full') || raw;
  };

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
          {snapshot?.fetchedAt && (
            <span className="text-xs text-gray-400">Updated {fmt(snapshot.fetchedAt)}</span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {snapshot && snapshot.stalledCount > 0 && (
        <div className="mt-6 flex-shrink-0 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">
              {snapshot.stalledCount} store group{snapshot.stalledCount === 1 ? '' : 's'} stalled
            </p>
            <p className="text-xs text-red-700 mt-0.5">
              Pay release has started but the generator is idle and units are still not generated
              (after {snapshot.stalledGraceMins} min grace). Check WFM queue and pay-file generator jobs.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mt-6 flex-shrink-0">
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Live now</p>
          <p className="text-2xl font-bold text-green-700 mt-1">{snapshot?.liveCount ?? '—'}</p>
          <p className="text-xs text-gray-400 mt-1">
            Release started — units still generating
            {(snapshot?.stalledCount ?? 0) > 0 && (
              <span className="text-red-600 font-medium"> · {snapshot!.stalledCount} stalled</span>
            )}
          </p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Upcoming</p>
          <p className="text-2xl font-bold text-amber-700 mt-1">{snapshot?.upcomingCount ?? '—'}</p>
          <p className="text-xs text-gray-400 mt-1">Before EXEC_CRON release or pending after week end</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Complete</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{snapshot?.completeCount ?? '—'}</p>
          <p className="text-xs text-gray-400 mt-1">All mapped units FILE_STATUS = F</p>
        </div>
      </div>

      <div className="flex gap-6 flex-1 min-h-0 mt-6">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="bg-white rounded-xl shadow-sm border p-3 flex items-center gap-3 flex-shrink-0 flex-wrap">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search client, store group, job..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-zebra-500"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            {(['all', 'live', 'upcoming', 'complete'] as const).map(f => (
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

          {isLoading && (
            <div className="bg-white rounded-xl shadow-sm border p-12 flex flex-col items-center justify-center text-gray-500 mt-4">
              <Loader2 className="w-8 h-8 animate-spin mb-3 text-zebra-600" />
              <p className="text-sm">Loading pay release schedule and store-group unit status...</p>
            </div>
          )}

          {error && !isFetching && (
            <div className="bg-white rounded-xl shadow-sm border p-6 mt-4 text-red-600 text-sm">
              {(error as any).message || 'Monitor query failed'}
            </div>
          )}

          {snapshot && !isLoading && (
            <div className="bg-white rounded-xl shadow-sm border flex-1 min-h-0 flex flex-col mt-4">
              {filtered.length === 0 ? (
                <div className="p-10 text-center text-gray-400">
                  <Building2 className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No payroll store groups match.</p>
                </div>
              ) : (
                <div className="overflow-auto flex-1 min-h-0">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b sticky top-0 z-10">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium text-gray-600">Client / group</th>
                        <th className="px-4 py-2 text-left font-medium text-gray-600">Status</th>
                        <th className="px-4 py-2 text-left font-medium text-gray-600">Release</th>
                        <th className="px-4 py-2 text-left font-medium text-gray-600">Last run</th>
                        <th className="px-4 py-2 text-left font-medium text-gray-600">Pending</th>
                        <th className="px-4 py-2 text-left font-medium text-gray-600">Units</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map(r => {
                        const pct = progressPct(r.units);
                        const active = selectedKey === r.rowKey;
                        const meta = PHASE_LABEL[r.phase];
                        const gen = r.generator;
                        return (
                          <tr
                            key={r.rowKey}
                            onClick={() => setSelectedKey(r.rowKey)}
                            className={`cursor-pointer hover:bg-gray-50 ${active ? 'bg-zebra-50' : ''} ${r.stalled ? 'bg-red-50/60' : ''}`}
                          >
                            <td className="px-4 py-2.5">
                              <div className="font-semibold text-gray-900">{r.clientId}</div>
                              <div className="text-[11px] text-gray-500">
                                Group {r.distListId || '—'}
                                {r.weekEndDate ? ` · week ${formatYyyymmdd(r.weekEndDate)}` : ''}
                              </div>
                              <div className="text-[11px] text-gray-400 font-mono truncate max-w-[14rem]">
                                {gen.jobType || '—'}
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap items-center gap-1">
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.className}`}>
                                  {r.phase === 'live' && <Play className="w-3 h-3" />}
                                  {r.phase === 'upcoming' && <Clock className="w-3 h-3" />}
                                  {r.phase === 'complete' && <CheckCircle className="w-3 h-3" />}
                                  {meta.label}
                                </span>
                                {r.stalled && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                    <AlertTriangle className="w-3 h-3" />
                                    Stalled{r.stalledMinutes != null ? ` ${r.stalledMinutes}m` : ''}
                                  </span>
                                )}
                              </div>
                              {r.error && (
                                <p className="text-[11px] text-red-600 mt-1 truncate max-w-[12rem]" title={r.error}>{r.error}</p>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-700">
                              <div className="font-mono truncate max-w-[10rem]" title={scheduleLabel(gen)}>
                                {scheduleLabel(gen)}
                              </div>
                              {gen.releaseDueAt && (
                                <div className="text-[11px] text-gray-400 mt-0.5 whitespace-nowrap">
                                  due {formatJobTime(gen.releaseDueAt, r.timezone)}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap text-xs">
                              {formatJobTime(gen.lastJobTime, r.timezone)}
                            </td>
                            <td className="px-4 py-2.5 font-semibold text-gray-900 text-xs">
                              {gen.running ? gen.jobsPending : '—'}
                            </td>
                            <td className="px-4 py-2.5 min-w-[10rem]">
                              <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                                <span>{r.units.generated}/{r.units.total}</span>
                                <span>{pct}%</span>
                              </div>
                              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className={`h-full ${r.phase === 'live' ? 'bg-green-500' : r.phase === 'upcoming' ? 'bg-amber-500' : 'bg-gray-400'}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
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

        <div className="w-[22rem] flex-shrink-0 flex flex-col min-h-0">
          {!selectedKey ? (
            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400 flex-1">
              <Radio className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Select a store group to watch mapped units as pay is released.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-900">{selected?.clientId}</p>
                  <p className="text-[11px] text-gray-400">
                    Store group {selected?.distListId} · PARAM_3 = DIST_LIST_ID
                  </p>
                </div>
                {detailFetching && <Loader2 className="w-4 h-4 animate-spin text-zebra-600" />}
              </div>
              <div className="px-4 py-3 border-b space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500 shrink-0">Job</span>
                  <span className="font-mono text-xs text-gray-800 text-right">
                    {(detail?.generator.jobType || selected?.generator.jobType) || '—'}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-500 shrink-0">EXEC_CRON</span>
                  <span className="font-mono text-xs text-gray-800 text-right">
                    {scheduleLabel(detail?.generator || selected!.generator)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Release due</span>
                  <span className="text-gray-800 text-xs">
                    {formatJobTime(
                      detail?.generator.releaseDueAt || selected?.generator.releaseDueAt,
                      detail?.timezone || selected?.timezone || 'America/Chicago',
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Last run</span>
                  <span className="text-gray-800 text-xs">
                    {formatJobTime(
                      detail?.generator.lastJobTime || selected?.generator.lastJobTime,
                      detail?.timezone || selected?.timezone || 'America/Chicago',
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Queue pending</span>
                  <span className="font-semibold">
                    {(detail?.generator.jobsPending ?? selected?.generator.jobsPending) ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Units</span>
                  <span>
                    {(detail?.units.generated ?? selected?.units.generated) ?? 0}
                    {' / '}
                    {(detail?.units.total ?? selected?.units.total) ?? 0}
                  </span>
                </div>
              </div>
              <div className="overflow-auto flex-1 min-h-0">
                {!detail ? (
                  <div className="p-6 text-center text-gray-400 text-sm">Loading mapped units...</div>
                ) : detail.records.length === 0 ? (
                  <div className="p-6 text-center text-gray-400 text-sm">No mapped units in TA_UNIT_PAY_STATUS for this pay week.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-500">Unit</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-500">File</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-500">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {detail.records.map(u => (
                        <tr key={u.unitId}>
                          <td className="px-3 py-1.5 font-mono text-gray-800">{u.unitId}</td>
                          <td className="px-3 py-1.5 font-mono text-gray-600">{u.fileId || '—'}</td>
                          <td className="px-3 py-1.5">
                            {u.generated ? (
                              <span className="text-green-700">Generated</span>
                            ) : (
                              <span className="text-amber-700">{u.fileStatus || 'Pending'}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {(detail?.stalled ?? selected?.stalled) && (
                <div className="px-3 py-2 border-t bg-red-50 text-[11px] text-red-800 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Generator idle for {(detail?.stalledMinutes ?? selected?.stalledMinutes) ?? '?'} min
                    with {(detail?.units.pending ?? selected?.units.pending) ?? 0} units still not generated.
                    Investigate pay-file generator queue and WFM logs.
                  </span>
                </div>
              )}
              {selected?.phase === 'live' && !(detail?.stalled ?? selected?.stalled) && (
                <div className="px-3 py-2 border-t bg-green-50 text-[11px] text-green-800 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Refreshing every 10s while release is live
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
