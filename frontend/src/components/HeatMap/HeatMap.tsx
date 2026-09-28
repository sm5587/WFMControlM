import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2, ChevronLeft, ChevronRight, Grid3X3, Loader2, RefreshCw, X, XCircle,
} from 'lucide-react';
import { ClearableSearchInput } from '../ui/ClearableFilter';
import {
  useProgressiveHeatMap,
  type HeatMapRow,
  type HeatMapWeekCounts,
} from '../../hooks/useProgressiveHeatMap';

type StatusFilter = 'all' | 'match' | 'mismatch' | 'error';
/** 0 = each client's current week, 1 = one week prior */
type WeekOffset = 0 | 1;

const HEAT_MAP_LEGEND = {
  series: [
    { id: 'iter6', label: '6 — Manager copy', swatchClass: 'bg-teal-500' },
    { id: 'iter7', label: '7 — WIP copy', swatchClass: 'bg-indigo-500' },
  ],
} as const;

function formatYmdShort(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return ymd;
  return `${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
}

function formatYmdLong(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return ymd;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function sortedWeeks(row: HeatMapRow): HeatMapWeekCounts[] {
  return [...row.weeks].sort((a, b) => {
    if (a.fiscalYear !== b.fiscalYear) return a.fiscalYear - b.fiscalYear;
    if (a.fiscalWeek !== b.fiscalWeek) return a.fiscalWeek - b.fiscalWeek;
    return a.weekStartDate.localeCompare(b.weekStartDate);
  });
}

function weekForOffset(row: HeatMapRow, offset: WeekOffset): HeatMapWeekCounts | null {
  const weeks = sortedWeeks(row);
  if (weeks.length === 0) return null;
  const idx = weeks.length - 1 - offset;
  return idx >= 0 ? weeks[idx] : null;
}

/** Compact dual bars for the grid — counts only, no chrome. */
function MiniBars({ week }: { week: HeatMapWeekCounts }) {
  const max = Math.max(week.iter6Stores, week.iter7Stores, 1);
  const h6 = Math.max(3, Math.round((week.iter6Stores / max) * 22));
  const h7 = Math.max(3, Math.round((week.iter7Stores / max) * 22));

  return (
    <div className="flex items-end justify-center gap-1.5 h-8">
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[9px] tabular-nums text-gray-600 leading-none">
          {week.iter6Stores.toLocaleString()}
        </span>
        <div className="w-2.5 rounded-t bg-teal-500" style={{ height: h6 }} />
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[9px] tabular-nums text-gray-600 leading-none">
          {week.iter7Stores.toLocaleString()}
        </span>
        <div className="w-2.5 rounded-t bg-indigo-500" style={{ height: h7 }} />
      </div>
    </div>
  );
}

function DetailBars({ week }: { week: HeatMapWeekCounts }) {
  const max = Math.max(week.iter6Stores, week.iter7Stores, 1);
  const h6 = Math.max(8, Math.round((week.iter6Stores / max) * 80));
  const h7 = Math.max(8, Math.round((week.iter7Stores / max) * 80));

  return (
    <div className="flex items-end justify-center gap-8 h-28">
      <div className="flex flex-col items-center gap-1.5 min-w-[4.5rem]">
        <span className="text-lg font-semibold tabular-nums text-gray-900">
          {week.iter6Stores.toLocaleString()}
        </span>
        <div className="w-10 rounded-t bg-teal-500" style={{ height: h6 }} />
        <span className="text-xs font-medium text-teal-700">Manager copy (6)</span>
      </div>
      <div className="flex flex-col items-center gap-1.5 min-w-[4.5rem]">
        <span className="text-lg font-semibold tabular-nums text-gray-900">
          {week.iter7Stores.toLocaleString()}
        </span>
        <div className="w-10 rounded-t bg-indigo-500" style={{ height: h7 }} />
        <span className="text-xs font-medium text-indigo-700">WIP copy (7)</span>
      </div>
    </div>
  );
}

function ClientCell({
  row,
  week,
  busy,
  onOpen,
  onRefresh,
}: {
  row: HeatMapRow;
  week: HeatMapWeekCounts | null;
  busy: boolean;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const mismatch = !!week?.mismatch;
  const shell = busy
    ? 'border border-gray-200 bg-white'
    : row.error
      ? 'border border-amber-400 bg-white'
      : mismatch
        ? 'border-2 border-red-500 bg-[#faf7f2]'
        : 'border border-gray-200 bg-white';

  return (
    <div className={`rounded-md px-1.5 py-1 shadow-sm ${shell}`}>
      <div className="flex items-center gap-0.5 min-w-0">
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="min-w-0 flex-1 text-left text-[11px] font-semibold text-gray-900 truncate leading-tight
            hover:text-zebra-700 focus:outline-none disabled:cursor-wait"
          title={row.name}
        >
          {row.clientId}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          disabled={busy}
          className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-50 disabled:opacity-40 shrink-0"
          title={`Refresh ${row.clientId}`}
          aria-label={`Refresh ${row.clientId}`}
        >
          <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {week?.weekStartDate && (
        <div
          className="text-[9px] tabular-nums text-gray-500 leading-tight truncate"
          title={`Week start ${formatYmdLong(week.weekStartDate)}`}
        >
          {formatYmdShort(week.weekStartDate)}
        </div>
      )}

      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        className="w-full mt-0.5 rounded hover:bg-zebra-50/50 focus:outline-none focus:ring-1 focus:ring-zebra-400/40 disabled:cursor-wait"
        title={row.name}
      >
        {busy ? (
          <div className="flex items-center justify-center h-8">
            <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
          </div>
        ) : row.error ? (
          <div className="flex items-center justify-center h-8 text-[10px] font-medium text-amber-700">
            Error
          </div>
        ) : !week ? (
          <div className="flex items-center justify-center h-8 text-[10px] text-gray-400">—</div>
        ) : (
          <MiniBars week={week} />
        )}
      </button>
    </div>
  );
}

function ClientDetailModal({
  row,
  week,
  weekOffset,
  refreshing,
  onClose,
  onRefresh,
}: {
  row: HeatMapRow;
  week: HeatMapWeekCounts | null;
  weekOffset: WeekOffset;
  refreshing: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = row.error
    ? { label: 'Error', className: 'bg-amber-100 text-amber-800' }
    : week?.mismatch
      ? { label: 'Mismatch', className: 'bg-red-100 text-red-800' }
      : week
        ? { label: 'Matched', className: 'bg-emerald-100 text-emerald-800' }
        : { label: 'No data', className: 'bg-gray-100 text-gray-600' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="heatmap-detail-title"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h2 id="heatmap-detail-title" className="text-lg font-bold text-gray-900 truncate">
              {row.clientId}
            </h2>
            <p className="text-sm text-gray-500 truncate">{row.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${status.className}`}>
              {status.label}
            </span>
            <span className="text-xs text-gray-500">
              {weekOffset === 0 ? 'Current week' : 'Previous week'}
            </span>
            {week && (
              <span className="text-xs text-gray-500 tabular-nums">
                {formatYmdLong(week.weekStartDate)} → {formatYmdLong(week.weekEndDate)}
                {week.fiscalYear > 0 && (
                  <> · FY{week.fiscalYear} FW{week.fiscalWeek}</>
                )}
              </span>
            )}
          </div>

          {refreshing || row.loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-gray-500 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              Scanning…
            </div>
          ) : row.error ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
              <p className="text-xs font-semibold text-amber-800 mb-1">Scan failed</p>
              <p className="text-xs text-amber-900 break-words font-mono whitespace-pre-wrap">
                {row.error}
              </p>
            </div>
          ) : !week ? (
            <p className="text-sm text-gray-500 text-center py-8">No week data for this client.</p>
          ) : (
            <>
              <DetailBars week={week} />
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-lg bg-gray-50 px-2 py-2">
                  <p className="text-gray-500">Manager copy (6)</p>
                  <p className="text-sm font-semibold tabular-nums text-gray-900 mt-0.5">
                    {week.iter6Stores.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 px-2 py-2">
                  <p className="text-gray-500">WIP copy (7)</p>
                  <p className="text-sm font-semibold tabular-nums text-gray-900 mt-0.5">
                    {week.iter7Stores.toLocaleString()}
                  </p>
                </div>
                <div className={`rounded-lg px-2 py-2 ${week.mismatch ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <p className={week.mismatch ? 'text-red-600' : 'text-gray-500'}>Delta</p>
                  <p className={`text-sm font-semibold tabular-nums mt-0.5 ${week.mismatch ? 'text-red-700' : 'text-gray-900'}`}>
                    {week.delta > 0 ? `+${week.delta.toLocaleString()}` : week.delta.toLocaleString()}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-gray-50">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || row.loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${(refreshing || row.loading) ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-zebra-600 text-white hover:bg-zebra-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HeatMap() {
  const {
    rows,
    total,
    loaded,
    status,
    fetchedAt,
    errorMessage,
    isRefreshing,
    refreshingClientId,
    start,
    refreshClient,
  } = useProgressiveHeatMap();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [weekOffset, setWeekOffset] = useState<WeekOffset>(0);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const goPrev = useCallback(() => setWeekOffset(1), []);
  const goCurrent = useCallback(() => setWeekOffset(0), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedClientId) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goCurrent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goCurrent, selectedClientId]);

  const matchCount = useMemo(
    () => rows.filter((r) => {
      const w = weekForOffset(r, weekOffset);
      return w && !w.mismatch && !r.error && !r.loading;
    }).length,
    [rows, weekOffset],
  );

  const mismatchCount = useMemo(
    () => rows.filter((r) => weekForOffset(r, weekOffset)?.mismatch).length,
    [rows, weekOffset],
  );

  const errorCount = useMemo(
    () => rows.filter((r) => !r.loading && !!r.error).length,
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const w = weekForOffset(r, weekOffset);
      if (statusFilter === 'match' && (!w || w.mismatch || r.error)) return false;
      if (statusFilter === 'mismatch' && !w?.mismatch) return false;
      if (statusFilter === 'error' && !r.error) return false;
      if (!q) return true;
      return (
        r.clientId.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.cluster || '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, statusFilter, weekOffset]);

  const selectedRow = selectedClientId
    ? rows.find((r) => r.clientId === selectedClientId) ?? null
    : null;

  const showInitialConnecting = rows.length === 0 && (status === 'connecting' || status === 'idle');

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Grid3X3 className="w-8 h-8 text-zebra-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Heat Map</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isRefreshing && total > 0 && (
            <span className="text-xs text-gray-500">
              Loading {Math.min(loaded, total)}/{total} clients
            </span>
          )}
          {fetchedAt && (
            <span className="text-xs text-gray-400">
              Updated {new Date(fetchedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => start({ force: true })}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6 flex-shrink-0">
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Matched</p>
          <p className="text-2xl font-bold text-green-700 mt-1">{rows.length ? matchCount : '—'}</p>
          <p className="text-xs text-gray-400 mt-1">Counts equal for this week</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Mismatched</p>
          <p className={`text-2xl font-bold mt-1 ${mismatchCount > 0 ? 'text-red-700' : 'text-gray-800'}`}>
            {rows.length ? mismatchCount : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">Red border on the grid</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Errors</p>
          <p className={`text-2xl font-bold mt-1 ${errorCount > 0 ? 'text-amber-700' : 'text-gray-800'}`}>
            {rows.length ? errorCount : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">Open client for error detail</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4" aria-label="Legend">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Legend</p>
          <ul className="mt-2 space-y-1.5">
            {HEAT_MAP_LEGEND.series.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-sm text-gray-800">
                <span className={`w-3 h-3 rounded-sm shrink-0 ${s.swatchClass}`} />
                <span className="font-medium leading-tight">{s.label}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-2">Bar colors on each client</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-3 flex items-center gap-3 flex-shrink-0 flex-wrap mt-6">
        <div
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-1 py-0.5"
          role="group"
          aria-label="Week navigator"
        >
          <button
            type="button"
            onClick={goPrev}
            disabled={weekOffset === 1}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            title="Previous week"
            aria-label="Previous week"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-3 text-center min-w-[7.5rem]">
            <div className="text-sm font-semibold text-gray-900 leading-tight">
              {weekOffset === 0 ? 'Current week' : 'Previous week'}
            </div>
          </div>
          <button
            type="button"
            onClick={goCurrent}
            disabled={weekOffset === 0}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            title="Current week"
            aria-label="Current week"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <ClearableSearchInput
          className="flex-1 min-w-[12rem]"
          value={search}
          onChange={setSearch}
          placeholder="Search client…"
          inputClassName="w-full py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-zebra-500"
        />

        {([
          { id: 'all', label: 'All' },
          { id: 'match', label: 'Matched' },
          { id: 'mismatch', label: 'Mismatch' },
          { id: 'error', label: 'Error' },
        ] as const).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatusFilter(f.id)}
            className={`text-xs px-2 py-1 rounded ${
              statusFilter === f.id
                ? 'bg-zebra-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {errorMessage && status === 'error' && rows.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border p-6 mt-4 text-red-600 text-sm flex-shrink-0">
          {errorMessage}
        </div>
      )}

      {showInitialConnecting && (
        <div className="bg-white rounded-xl shadow-sm border p-12 flex flex-col items-center justify-center text-gray-500 mt-4 flex-1 min-h-0">
          <Loader2 className="w-8 h-8 animate-spin mb-3 text-zebra-600" />
          <p className="text-sm">Loading clients…</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border flex-1 min-h-0 flex flex-col mt-4 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-gray-400">
              <Building2 className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No clients match.</p>
            </div>
          ) : (
            <div className="overflow-auto flex-1 min-h-0 p-2">
              <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-1.5">
                {filtered.map((row) => (
                  <ClientCell
                    key={row.clientId}
                    row={row}
                    week={weekForOffset(row, weekOffset)}
                    busy={row.loading || refreshingClientId === row.clientId}
                    onOpen={() => setSelectedClientId(row.clientId)}
                    onRefresh={() => refreshClient(row.clientId)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!showInitialConnecting && rows.length === 0 && status === 'done' && (
        <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400 mt-4">
          <XCircle className="w-10 h-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No active DB2 clients found.</p>
        </div>
      )}

      {selectedRow && (
        <ClientDetailModal
          row={selectedRow}
          week={weekForOffset(selectedRow, weekOffset)}
          weekOffset={weekOffset}
          refreshing={refreshingClientId === selectedRow.clientId}
          onClose={() => setSelectedClientId(null)}
          onRefresh={() => refreshClient(selectedRow.clientId)}
        />
      )}
    </div>
  );
}
