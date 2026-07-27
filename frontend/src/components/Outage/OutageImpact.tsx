// ============================================================
// Outage Impact Calculator
// Ad-hoc outage window → impacted cron jobs (server TZ → UTC → compare)
// ============================================================

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Siren, ChevronDown, ChevronRight, RefreshCw, Download,
  AlertTriangle, CheckCircle2, Filter, XCircle, Square,
} from 'lucide-react';
import { outageApi } from '../../services/api';
import type { OutageImpactInitialValues, OutageImpactJob, OutageImpactResult, OutageImpactStreamEvent } from '../../types';
import { useGlobalFilter } from '../../context/GlobalFilterContext';

const TZ_OPTIONS = ['IST', 'EDT', 'EST', 'CST', 'CDT', 'UTC'] as const;

function toApiDateTime(dtLocal: string): string {
  if (!dtLocal) return '';
  return dtLocal.replace('T', ' ').slice(0, 16);
}

function normalizeDatetimeLocal(value: string): string {
  if (!value?.trim()) return '';
  const stripped = value.trim().replace(/\s+(IST|EDT|EST|CST|CDT|UTC|GMT|UK(?:\s+Time)?)\s*$/i, '');
  const m = stripped.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : '';
}

function stateFromInitialValues(iv: OutageImpactInitialValues | null | undefined) {
  return {
    allClustersSelected: iv?.allClusters !== undefined ? iv.allClusters : true,
    selectedClusters: iv?.clusters ?? [],
    allClientsSelected: iv?.allClients !== undefined ? iv.allClients : true,
    selectedClientIds: iv?.clientIds ?? [],
    startLocal: normalizeDatetimeLocal(iv?.startLocal ?? ''),
    endLocal: normalizeDatetimeLocal(iv?.endLocal ?? ''),
    inputTimezone: iv?.inputTimezone ?? 'IST',
  };
}

function exportCsv(rows: OutageImpactJob[], tz: string) {
  const header = [
    'clientId', 'cluster', 'jobName', 'cronExpression', 'serverTimezone',
    'fireTimesDisplay', 'fireTimesServer', 'fireTimesUtc', 'willRetryToday', 'command',
  ];
  const lines = rows.map(r =>
    header.map(h => {
      let v: string | boolean = '';
      if (h === 'fireTimesDisplay') v = r.fireTimesDisplay.join('; ');
      else if (h === 'fireTimesServer') v = r.fireTimesServer.join('; ');
      else if (h === 'fireTimesUtc') v = r.fireTimesUtc.join('; ');
      else v = String((r as any)[h] ?? '');
      return `"${v.replace(/"/g, '""')}"`;
    }).join(','),
  );
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `outage-impact-${tz}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function ImpactJobGroup({ clientId, jobs, tz }: { clientId: string; jobs: OutageImpactJob[]; tz: string }) {
  const [open, setOpen] = useState(true);
  const client = jobs[0];

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-left"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <span className="font-semibold text-sm">{clientId}</span>
        {client.clientName && <span className="text-slate-500 text-xs">— {client.clientName}</span>}
        {client.cluster && <span className="ml-auto text-[11px] text-slate-400">{client.cluster}</span>}
        <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full ml-1">{jobs.length} jobs</span>
      </button>
      {open && (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase">
              <th className="text-left px-4 py-2 font-medium">Job</th>
              <th className="text-left px-4 py-2 font-medium">Schedule</th>
              <th className="text-left px-4 py-2 font-medium">Fire times ({tz})</th>
              <th className="text-left px-4 py-2 font-medium">Server TZ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map(job => (
              <tr key={job.jobId} className="hover:bg-red-50/50">
                <td className="px-4 py-2 max-w-xs">
                  <p className="font-medium text-slate-700 truncate">{job.name}</p>
                  {job.command && <p className="text-slate-400 truncate">{job.command.slice(0, 70)}</p>}
                </td>
                <td className="px-4 py-2 font-mono text-slate-600 whitespace-nowrap">{job.cronExpression}</td>
                <td className="px-4 py-2">
                  {job.fireTimesDisplay.map((t, i) => (
                    <div key={i} className="text-slate-700">{t}</div>
                  ))}
                </td>
                <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
                  {job.fireTimesServer[0]}<br />
                  <span className="text-[10px]">{job.serverTimezone}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function summarizeImpactRows(rows: OutageImpactJob[]) {
  return {
    uniqueJobs: rows.length,
    totalFireTimes: rows.reduce((n, r) => n + r.fireCount, 0),
    uniqueClients: new Set(rows.map(r => r.clientId)).size,
    excludedRetryToday: 0,
    parseErrors: 0,
  };
}

function handleOutageStreamEvent(
  event: OutageImpactStreamEvent,
  setResult: React.Dispatch<React.SetStateAction<OutageImpactResult | null>>,
  setCalcProgress: React.Dispatch<React.SetStateAction<{ completed: number; total: number; clientId?: string } | null>>,
) {
  if (event.type === 'start') {
    setResult({
      rows: [],
      summary: summarizeImpactRows([]),
      window: event.window,
      plannedTotal: event.plannedTotal,
    });
    setCalcProgress({ completed: 0, total: event.plannedTotal });
    return;
  }

  if (event.type === 'progress') {
    setCalcProgress({ completed: event.completed, total: event.plannedTotal, clientId: event.clientId });
    if (event.rows.length > 0) {
      setResult(prev => {
        if (!prev) return prev;
        const rows = [...prev.rows, ...event.rows].sort((a, b) =>
          (a.fireTimesUtc[0] ?? '').localeCompare(b.fireTimesUtc[0] ?? ''),
        );
        return {
          ...prev,
          rows,
          summary: {
            ...prev.summary,
            uniqueJobs: rows.length,
            totalFireTimes: rows.reduce((n, r) => n + r.fireCount, 0),
            uniqueClients: new Set(rows.map(r => r.clientId)).size,
          },
        };
      });
    }
    return;
  }

  if (event.type === 'complete') {
    setResult(event.data);
    setCalcProgress(null);
  }
}

export default function OutageImpact({
  embedded = false,
  initialValues = null,
}: {
  embedded?: boolean;
  initialValues?: OutageImpactInitialValues | null;
}) {
  const { clients, clusters: allClusters } = useGlobalFilter();
  const initial = stateFromInitialValues(initialValues);

  const [allClustersSelected, setAllClustersSelected] = useState(initial.allClustersSelected);
  const [selectedClusters, setSelectedClusters] = useState<string[]>(initial.selectedClusters);
  const [allClientsSelected, setAllClientsSelected] = useState(initial.allClientsSelected);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>(initial.selectedClientIds);
  const [startLocal, setStartLocal] = useState(initial.startLocal);
  const [endLocal, setEndLocal] = useState(initial.endLocal);
  const [inputTimezone, setInputTimezone] = useState<string>(initial.inputTimezone);
  const [noRetryToday, setNoRetryToday] = useState(true);
  const [result, setResult] = useState<OutageImpactResult | null>(null);
  const [calcProgress, setCalcProgress] = useState<{ completed: number; total: number; clientId?: string } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const buildCalcParams = useCallback((override?: OutageImpactInitialValues) => {
    const src = override ?? {
      allClusters: allClustersSelected,
      clusters: selectedClusters,
      allClients: allClientsSelected,
      clientIds: selectedClientIds,
      startLocal,
      endLocal,
      inputTimezone,
    };
    const allCl = src.allClusters ?? allClustersSelected;
    const allCli = src.allClients ?? allClientsSelected;
    const clusters = src.clusters ?? selectedClusters;
    const clientIds = src.clientIds ?? selectedClientIds;
    const start = src.startLocal ?? startLocal;
    const end = src.endLocal ?? endLocal;
    const tz = src.inputTimezone ?? inputTimezone;
    return {
      clusters: allCl ? undefined : clusters,
      clientIds: allCli ? undefined : clientIds,
      startLocal: toApiDateTime(start),
      endLocal: toApiDateTime(end),
      inputTimezone: tz,
      noRetryToday,
    };
  }, [
    allClustersSelected, selectedClusters, allClientsSelected, selectedClientIds,
    startLocal, endLocal, inputTimezone, noRetryToday,
  ]);

  const calcMutation = useMutation({
    mutationFn: (override?: OutageImpactInitialValues) =>
      outageApi.calculateStream(buildCalcParams(override), (event) =>
        handleOutageStreamEvent(event, setResult, setCalcProgress),
      ),
    onMutate: () => {
      setRequestError(null);
      setCalcProgress(null);
    },
    onSuccess: (data) => {
      setResult(data);
      setCalcProgress(null);
      setCancelling(false);
    },
    onError: (err: Error) => {
      setRequestError(err.message ?? 'Calculation failed');
      setCancelling(false);
    },
  });

  useEffect(() => {
    if (!initialValues) return;
    const next = stateFromInitialValues(initialValues);
    setAllClustersSelected(next.allClustersSelected);
    setSelectedClusters(next.selectedClusters);
    setAllClientsSelected(next.allClientsSelected);
    setSelectedClientIds(next.selectedClientIds);
    setStartLocal(next.startLocal);
    setEndLocal(next.endLocal);
    setInputTimezone(next.inputTimezone);
    setResult(null);
    setRequestError(null);
    setCalcProgress(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- apply when prefill payload changes
  }, [initialValues]);

  const handleCancel = async () => {
    if (!calcMutation.isPending) return;
    setCancelling(true);
    try {
      await outageApi.cancel();
    } catch {
      /* server may already be done */
    } finally {
      setCancelling(false);
    }
  };

  const scopeClients = useMemo(() => {
    if (allClustersSelected) return clients;
    return clients.filter(c => selectedClusters.includes(c.cluster ?? ''));
  }, [clients, allClustersSelected, selectedClusters]);

  const grouped = useMemo(() => {
    if (!result?.rows) return {};
    return result.rows.reduce<Record<string, OutageImpactJob[]>>((acc, j) => {
      (acc[j.clientId] ??= []).push(j);
      return acc;
    }, {});
  }, [result]);

  function toggleCluster(cl: string) {
    setSelectedClusters(prev =>
      prev.includes(cl) ? prev.filter(c => c !== cl) : [...prev, cl],
    );
  }

  function toggleClient(id: string) {
    setSelectedClientIds(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id],
    );
  }

  const canSubmit = startLocal && endLocal && !calcMutation.isPending
    && (allClustersSelected || selectedClusters.length > 0)
    && (allClientsSelected || selectedClientIds.length > 0);

  return (
    <div className={embedded ? 'space-y-6' : 'p-6 space-y-6 max-w-6xl'}>
      {!embedded && (
        <div className="flex items-start gap-3">
          <div className="p-2 bg-red-100 rounded-lg">
            <Siren className="w-6 h-6 text-red-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Outage Impact</h1>
            <p className="text-sm text-slate-500 mt-1">
              Calculate cron jobs scheduled during an outage window. Cron expressions are evaluated in each job&apos;s
              server timezone, converted to UTC, and compared against your outage window.
            </p>
          </div>
        </div>
      )}
      {embedded && (
        <p className="text-sm text-slate-500">
          Calculate cron jobs scheduled during an outage window. Cron expressions are evaluated in each job&apos;s
          server timezone, converted to UTC, and compared against your outage window.
        </p>
      )}

      {/* Form */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Filter className="w-4 h-4" /> Scope &amp; Window
        </h2>

        {/* Clusters */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <input
              type="checkbox"
              checked={allClustersSelected}
              onChange={e => { setAllClustersSelected(e.target.checked); if (e.target.checked) setSelectedClusters([]); }}
              className="rounded"
            />
            All clusters
          </label>
          {!allClustersSelected && (
            <div className="flex flex-wrap gap-2 mt-2">
              {allClusters.map(cl => (
                <button
                  key={cl}
                  type="button"
                  onClick={() => toggleCluster(cl)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    selectedClusters.includes(cl)
                      ? 'bg-zebra-100 border-zebra-400 text-zebra-800'
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {cl}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Clients */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <input
              type="checkbox"
              checked={allClientsSelected}
              onChange={e => { setAllClientsSelected(e.target.checked); if (e.target.checked) setSelectedClientIds([]); }}
              className="rounded"
            />
            All clients{!allClustersSelected && selectedClusters.length > 0 ? ` (in selected clusters)` : ''}
          </label>
          {!allClientsSelected && (
            <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2 flex flex-wrap gap-1.5 mt-2">
              {scopeClients.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleClient(c.clientId)}
                  className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                    selectedClientIds.includes(c.clientId)
                      ? 'bg-zebra-100 border-zebra-400 text-zebra-800'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {c.clientId}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Time window */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Outage start</label>
            <input
              type="datetime-local"
              value={startLocal}
              onChange={e => setStartLocal(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Outage end</label>
            <input
              type="datetime-local"
              value={endLocal}
              onChange={e => setEndLocal(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Window timezone</label>
            <select
              value={inputTimezone}
              onChange={e => setInputTimezone(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              {TZ_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={noRetryToday}
            onChange={e => setNoRetryToday(e.target.checked)}
            className="rounded"
          />
          Exclude interval jobs that will run again later today
          <span className="text-xs text-slate-400">(hourly, */N min, etc.)</span>
        </label>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => calcMutation.mutate(undefined)}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {calcMutation.isPending && calcProgress
              ? <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Calculating {calcProgress.completed}/{calcProgress.total}
                  {calcProgress.clientId ? ` (${calcProgress.clientId})` : ''}…
                </>
              : calcMutation.isPending
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Calculating…</>
              : <><Siren className="w-4 h-4" /> Calculate Impact</>}
          </button>
          {calcMutation.isPending && calcProgress && (
            <button
              type="button"
              disabled={cancelling}
              onClick={handleCancel}
              className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {cancelling
                ? <><RefreshCw className="w-4 h-4 animate-spin" /> Cancelling…</>
                : <><Square className="w-4 h-4" /> Cancel</>}
            </button>
          )}
          {result && result.rows.length > 0 && !calcMutation.isPending && (
            <button
              type="button"
              onClick={() => exportCsv(result.rows, inputTimezone)}
              className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50"
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
          )}
        </div>

        {calcMutation.isPending && calcProgress && (
          <p className="text-xs text-slate-600 bg-slate-50 rounded px-3 py-2">
            Progress: {calcProgress.completed} of {calcProgress.total} clients evaluated
            {calcProgress.clientId ? ` — last: ${calcProgress.clientId}` : ''}.
            {result && result.rows.length > 0 && (
              <span className="text-red-600"> {result.summary.uniqueJobs} impacted job(s) found so far.</span>
            )}
          </p>
        )}

        {result?.cancelled && !calcMutation.isPending && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Calculation cancelled — showing partial results below.
          </p>
        )}

        {requestError && !calcMutation.isPending && (
          <div className="text-sm text-red-600 flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            {requestError}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (result.rows.length > 0 || !calcMutation.isPending) && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Impacted jobs" value={result.summary.uniqueJobs} accent="red" />
            <StatCard label="Scheduled fires" value={result.summary.totalFireTimes} accent="amber" />
            <StatCard label="Clients" value={result.summary.uniqueClients} accent="slate" />
            {noRetryToday && (
              <StatCard label="Excluded (retry today)" value={result.summary.excludedRetryToday} accent="green" />
            )}
          </div>

          <div className="text-xs text-slate-500 bg-slate-50 rounded-lg px-4 py-2 font-mono">
            Window: {result.window.startLocal} → {result.window.endLocal} {result.window.inputTimezone}
            {' · '}UTC: {result.window.startUtc} → {result.window.endUtc}
          </div>

          {result.rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400 bg-white border rounded-xl">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-400" />
              <p>No jobs impacted{noRetryToday ? ' (after excluding interval jobs)' : ''} for this window.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-600 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                {result.summary.uniqueJobs} job{result.summary.uniqueJobs !== 1 ? 's' : ''} across{' '}
                {result.summary.uniqueClients} client{result.summary.uniqueClients !== 1 ? 's' : ''} with no further
                scheduled run today{noRetryToday ? '' : ' (including interval jobs)'}.
                These may need manual re-trigger if missed during the outage.
              </p>
              {Object.entries(grouped).map(([cid, cJobs]) => (
                <ImpactJobGroup key={cid} clientId={cid} jobs={cJobs} tz={inputTimezone} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  const colors: Record<string, string> = {
    red: 'bg-red-50 text-red-700 border-red-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    green: 'bg-green-50 text-green-700 border-green-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-100',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${colors[accent] ?? colors.slate}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}
