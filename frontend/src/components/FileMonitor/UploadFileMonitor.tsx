// ============================================================
// Upload File Monitor — on-demand SSH scan of IN & Rejected folders
// ============================================================

import React, { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  FolderSearch, RefreshCw, Download, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Filter, Square,
} from 'lucide-react';
import { fileMonitorApi } from '../../services/api';
import type { ClientFileMonitorResult, FileMonitorFetchResult, FileMonitorStreamEvent } from '../../types';
import { useGlobalFilter } from '../../context/GlobalFilterContext';

function formatSize(n: number): string {
  let v = n;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (Math.abs(v) < 1024) return unit === 'B' ? `${v} B` : `${v.toFixed(1)} ${unit}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

function exportCsv(rows: ClientFileMonitorResult[]) {
  const header = [
    'clientId', 'cluster', 'server', 'status', 'pendingCount', 'rejectedCount', 'error',
  ];
  const lines = rows.map(r =>
    header.map(h => `"${String((r as any)[h] ?? '').replace(/"/g, '""')}"`).join(','),
  );
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `upload-file-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function StatusBadge({ status }: { status: ClientFileMonitorResult['status'] }) {
  const styles: Record<string, string> = {
    ALERT: 'bg-red-100 text-red-700',
    CLEAN: 'bg-green-100 text-green-700',
    ERROR: 'bg-amber-100 text-amber-800',
    SKIPPED: 'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] ?? styles.SKIPPED}`}>
      {status}
    </span>
  );
}

function ClientDetailRow({ row }: { row: ClientFileMonitorResult }) {
  const [open, setOpen] = useState(row.status === 'ALERT');
  const hasDetail = row.pendingFiles.length > 0 || row.rejectedFolders.length > 0 || row.error;

  return (
    <>
      <tr className={`hover:bg-slate-50 ${row.status === 'ALERT' ? 'bg-red-50/40' : ''}`}>
        <td className="px-4 py-2 font-semibold text-sm">{row.clientId}</td>
        <td className="px-4 py-2 text-xs text-slate-500">{row.cluster ?? '—'}</td>
        <td className="px-4 py-2 text-xs text-slate-500 max-w-[180px] truncate" title={row.server}>{row.server}</td>
        <td className="px-4 py-2 text-center font-mono">{row.pendingCount}</td>
        <td className="px-4 py-2 text-center font-mono">{row.rejectedCount}</td>
        <td className="px-4 py-2"><StatusBadge status={row.status} /></td>
        <td className="px-4 py-2 text-xs text-red-600 max-w-[160px] truncate" title={row.error}>{row.error ?? ''}</td>
        <td className="px-4 py-2">
          {hasDetail && (
            <button type="button" onClick={() => setOpen(o => !o)} className="text-slate-400 hover:text-slate-600">
              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          )}
        </td>
      </tr>
      {open && hasDetail && (
        <tr>
          <td colSpan={8} className="px-6 py-3 bg-slate-50 border-b">
            {row.error && <p className="text-sm text-amber-700 mb-2">{row.error}</p>}
            {row.pendingFiles.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-semibold text-orange-700 mb-1">
                  Pending IN folder ({row.pendingFiles.length})
                </p>
                <table className="w-full text-xs">
                  <thead><tr className="text-slate-500"><th className="text-left py-1">File</th><th className="text-left">Size</th><th className="text-left">Modified</th></tr></thead>
                  <tbody>
                    {row.pendingFiles.map((f, i) => (
                      <tr key={i}><td className="py-0.5">{f.name}</td><td>{formatSize(f.size)}</td><td>{f.mtime}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {row.rejectedFolders.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-red-700 mb-1">
                  Rejected today ({row.rejectedCount})
                </p>
                {row.rejectedFolders.map((rf, i) => (
                  <div key={i} className="mb-2">
                    <p className="text-[11px] text-purple-700 font-mono truncate" title={rf.folder}>
                      {rf.folder.replace('/mount/RWS4/appuploads/upload/', '.../')}
                    </p>
                    <table className="w-full text-xs">
                      <tbody>
                        {rf.files.map((f, j) => (
                          <tr key={j}><td className="py-0.5">{f.name}</td><td className="w-20">{formatSize(f.size)}</td><td>{f.mtime}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function summarizeRows(rows: ClientFileMonitorResult[]) {
  let totalPending = 0;
  let totalRejected = 0;
  for (const row of rows) {
    totalPending += row.pendingCount;
    totalRejected += row.rejectedCount;
  }
  return {
    total: rows.length,
    alert: rows.filter(r => r.status === 'ALERT').length,
    clean: rows.filter(r => r.status === 'CLEAN').length,
    errors: rows.filter(r => r.status === 'ERROR').length,
    skipped: rows.filter(r => r.status === 'SKIPPED').length,
    totalPending,
    totalRejected,
  };
}

function upsertRow(rows: ClientFileMonitorResult[], row: ClientFileMonitorResult) {
  const idx = rows.findIndex(r => r.clientId === row.clientId);
  if (idx >= 0) {
    const next = [...rows];
    next[idx] = row;
    return next;
  }
  return [...rows, row];
}

function handleStreamEvent(
  event: FileMonitorStreamEvent,
  setResult: React.Dispatch<React.SetStateAction<FileMonitorFetchResult | null>>,
  setScanProgress: React.Dispatch<React.SetStateAction<{ completed: number; total: number; clientId?: string; phase?: string } | null>>,
) {
  if (event.type === 'start') {
    setResult({
      rows: [],
      summary: summarizeRows([]),
      scannedAt: new Date().toISOString(),
      paths: event.paths,
      usesTotpAuth: event.usesTotpAuth,
      plannedTotal: event.plannedTotal,
    });
    setScanProgress({ completed: 0, total: event.plannedTotal });
    return;
  }

  if (event.type === 'progress') {
    setScanProgress({ completed: event.completed, total: event.plannedTotal, clientId: event.clientId });
    setResult(prev => {
      if (!prev) return prev;
      const rows = upsertRow(prev.rows, event.row);
      return { ...prev, rows, summary: summarizeRows(rows) };
    });
    return;
  }

  if (event.type === 'heartbeat') {
    setScanProgress({
      completed: event.completed,
      total: event.plannedTotal,
      clientId: event.clientId,
      phase: event.phase,
    });
    return;
  }

  if (event.type === 'complete') {
    setResult(event.data);
    setScanProgress(null);
  }
}

export default function UploadFileMonitor() {
  const { clients, clusters: allClusters } = useGlobalFilter();
  const [allClustersSelected, setAllClustersSelected] = useState(true);
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
  const [allClientsSelected, setAllClientsSelected] = useState(true);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [checkPending, setCheckPending] = useState(true);
  const [checkRejected, setCheckRejected] = useState(true);
  const [showAlertsOnly, setShowAlertsOnly] = useState(false);
  const [result, setResult] = useState<FileMonitorFetchResult | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{ completed: number; total: number; clientId?: string; phase?: string } | null>(null);

  const { data: authInfo } = useQuery({
    queryKey: ['file-monitor-auth-info'],
    queryFn: () => fileMonitorApi.authInfo(),
    staleTime: 300_000,
  });
  const usesTotpAuth = authInfo?.data?.usesTotpAuth ?? result?.usesTotpAuth ?? false;
  const paths = result?.paths ?? authInfo?.data?.paths;

  const scopeClients = useMemo(() => {
    if (allClustersSelected) return clients;
    return clients.filter(c => selectedClusters.includes(c.cluster ?? ''));
  }, [clients, allClustersSelected, selectedClusters]);

  const fetchMutation = useMutation({
    mutationFn: () => fileMonitorApi.fetchStream({
      clusters: allClustersSelected ? undefined : selectedClusters,
      clientIds: allClientsSelected ? undefined : selectedClientIds,
      checkPending,
      checkRejected,
    }, (event) => handleStreamEvent(event, setResult, setScanProgress)),
    onMutate: () => {
      setCancelling(false);
      setRequestError(null);
      setScanProgress(null);
    },
    onSuccess: (data) => {
      setResult(data);
      setScanProgress(null);
      setRequestError(data.scanError ?? null);
    },
    onError: (err: Error) => {
      setRequestError(err.message ?? 'Scan failed');
    },
    onSettled: () => setCancelling(false),
  });

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await fileMonitorApi.cancel();
    } catch {
      // Scan may have finished between click and request — ignore
    }
  };

  const displayRows = useMemo(() => {
    if (!result?.rows) return [];
    if (!showAlertsOnly) return result.rows;
    return result.rows.filter(r => r.status === 'ALERT' || r.status === 'ERROR');
  }, [result, showAlertsOnly]);

  const canSubmit = (checkPending || checkRejected) && !fetchMutation.isPending
    && (allClustersSelected || selectedClusters.length > 0)
    && (allClientsSelected || selectedClientIds.length > 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-orange-100 rounded-lg">
          <FolderSearch className="w-6 h-6 text-orange-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Upload File Monitor</h1>
          <p className="text-sm text-slate-500 mt-1">
            On-demand SSH scan of Prod app servers: pending files in the IN folder and rejected DTS uploads (today, server local date).
          </p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Filter className="w-4 h-4" /> Scope
        </h2>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <input type="checkbox" checked={allClustersSelected} onChange={e => { setAllClustersSelected(e.target.checked); if (e.target.checked) setSelectedClusters([]); }} className="rounded" />
            All clusters
          </label>
          {!allClustersSelected && (
            <div className="flex flex-wrap gap-2">
              {allClusters.map(cl => (
                <button key={cl} type="button" onClick={() => setSelectedClusters(p => p.includes(cl) ? p.filter(c => c !== cl) : [...p, cl])}
                  className={`px-3 py-1 rounded-full text-xs font-medium border ${selectedClusters.includes(cl) ? 'bg-zebra-100 border-zebra-400 text-zebra-800' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  {cl}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <input type="checkbox" checked={allClientsSelected} onChange={e => { setAllClientsSelected(e.target.checked); if (e.target.checked) setSelectedClientIds([]); }} className="rounded" />
            All clients
          </label>
          {!allClientsSelected && (
            <div className="max-h-32 overflow-y-auto border rounded-lg p-2 flex flex-wrap gap-1">
              {scopeClients.map(c => (
                <button key={c.id} type="button" onClick={() => setSelectedClientIds(p => p.includes(c.clientId) ? p.filter(x => x !== c.clientId) : [...p, c.clientId])}
                  className={`px-2 py-0.5 rounded text-xs border ${selectedClientIds.includes(c.clientId) ? 'bg-zebra-100 border-zebra-400' : 'border-slate-200'}`}>
                  {c.clientId}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={checkPending} onChange={e => setCheckPending(e.target.checked)} className="rounded" />
            Pending IN folder
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={checkRejected} onChange={e => setCheckRejected(e.target.checked)} className="rounded" />
            Rejected DTS (today)
          </label>
        </div>

        {paths && (
          <div className="text-xs text-slate-600 font-mono bg-slate-50 rounded px-3 py-2 space-y-1">
            <div><span className="text-slate-500">IN folder:</span> {paths.pending}</div>
            <div><span className="text-slate-500">Rejected folder:</span> {paths.rejected}</div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={!canSubmit} onClick={() => fetchMutation.mutate()}
            className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 disabled:opacity-50">
            {fetchMutation.isPending && scanProgress
              ? <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Scanning {scanProgress.completed}/{scanProgress.total}
                  {scanProgress.clientId ? ` (${scanProgress.clientId})` : ''}…
                </>
              : fetchMutation.isPending
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Scanning servers…</>
              : <><FolderSearch className="w-4 h-4" /> Scan Now</>}
          </button>
          {fetchMutation.isPending && (
            <button type="button" disabled={cancelling} onClick={handleCancel}
              className="flex items-center gap-2 px-4 py-2 border border-red-300 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50">
              {cancelling
                ? <><RefreshCw className="w-4 h-4 animate-spin" /> Cancelling…</>
                : <><Square className="w-4 h-4" /> Cancel Scan</>}
            </button>
          )}
          {result && !fetchMutation.isPending && (
            <button type="button" onClick={() => exportCsv(result.rows)}
              className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">
              <Download className="w-4 h-4" /> Export CSV
            </button>
          )}
        </div>

        {fetchMutation.isPending && scanProgress && (
          <p className="text-xs text-slate-600 bg-slate-50 rounded px-3 py-2">
            {scanProgress.phase === 'totp-cooldown'
              ? `TOTP cooldown before next client (${scanProgress.completed}/${scanProgress.total} done)…`
              : `Progress: ${scanProgress.completed} of ${scanProgress.total} clients scanned.`}
          </p>
        )}
        {fetchMutation.isPending && usesTotpAuth && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded px-3 py-2">
            Scanning clients sequentially via SSH (password + TOTP). Expect ~30s pause between each client for TOTP cooldown.
          </p>
        )}
        {result?.cancelled && !fetchMutation.isPending && (
          <p className="text-sm text-slate-600 bg-slate-50 rounded px-3 py-2">
            Scan cancelled — showing partial results ({result.summary.total} of {result.plannedTotal} clients scanned).
          </p>
        )}
        {(requestError || result?.scanError) && !fetchMutation.isPending && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2 space-y-1">
            <p className="flex items-center gap-2 font-medium">
              <XCircle className="w-4 h-4 shrink-0" />
              {requestError || result?.scanError}
            </p>
            {result && result.rows.length > 0 && (
              <p className="text-red-600/90">
                Partial results below ({result.summary.total} of {result.plannedTotal} clients scanned).
              </p>
            )}
          </div>
        )}
      </div>

      {result && result.rows.length > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <StatCard label="Clients scanned" value={result.summary.total} />
            <StatCard label="With files" value={result.summary.alert} accent="red" />
            <StatCard label="Pending files" value={result.summary.totalPending} accent="orange" />
            <StatCard label="Rejected (today)" value={result.summary.totalRejected} accent="red" />
            <StatCard label="Errors" value={result.summary.errors} accent="amber" />
          </div>

          <div className="text-xs text-slate-500 font-mono bg-slate-50 rounded px-3 py-2">
            Scanned: {result.scannedAt}
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={showAlertsOnly} onChange={e => setShowAlertsOnly(e.target.checked)} className="rounded" />
              Show alerts &amp; errors only
            </label>
            {result.summary.alert === 0 && result.summary.errors === 0 && !result.scanError && !result.cancelled && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> All clean
              </span>
            )}
          </div>

          <div className="bg-white border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b text-xs text-slate-500 uppercase">
                  <th className="text-left px-4 py-2">Client</th>
                  <th className="text-left px-4 py-2">Cluster</th>
                  <th className="text-left px-4 py-2">Server</th>
                  <th className="text-center px-4 py-2">Pending</th>
                  <th className="text-center px-4 py-2">Rejected</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Error</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayRows.map(row => (
                  <ClientDetailRow key={row.clientId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const bg = accent === 'red' ? 'bg-red-50 text-red-700 border-red-100'
    : accent === 'orange' ? 'bg-orange-50 text-orange-700 border-orange-100'
    : accent === 'amber' ? 'bg-amber-50 text-amber-700 border-amber-100'
    : 'bg-slate-50 text-slate-700 border-slate-100';
  return (
    <div className={`rounded-lg border px-4 py-3 ${bg}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}
