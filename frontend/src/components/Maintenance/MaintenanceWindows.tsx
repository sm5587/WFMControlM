// ============================================================
// Maintenance Windows
// Create planned / unscheduled outages at cluster or client level.
// Import from Excel. View affected cron jobs falling in the window.
// ============================================================

import React, { useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock, Plus, Upload, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle2, Clock, XCircle, Zap, Trash2,
  RefreshCw, Eye, Siren,
} from 'lucide-react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { maintenanceApi, maintenanceCalendarApi } from '../../services/api';
import type { MaintenanceWindow, AffectedJob } from '../../types';
import MaintenanceCalendarTab from './MaintenanceCalendarTab';
import { useTimezone } from '../../hooks/useTimezone';

dayjs.extend(utc);

// ---- Constants ----------------------------------------------------------------

const TZ_OPTIONS = ['IST', 'EDT', 'EST', 'CST', 'CDT', 'UTC'] as const;
type TzOption = typeof TZ_OPTIONS[number];

const STATUS_STYLE: Record<string, string> = {
  SCHEDULED: 'bg-blue-100 text-blue-700',
  ACTIVE:    'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

const TYPE_STYLE: Record<string, string> = {
  PLANNED:     'bg-indigo-50 text-indigo-700',
  UNSCHEDULED: 'bg-red-50 text-red-600',
};

/** Expected Excel columns (case-insensitive) → field mapping */
const EXCEL_COL_MAP: Record<string, string> = {
  scope: 'scope',
  cluster: 'cluster',
  clusters: 'cluster',
  client: 'clientCode',
  clientcode: 'clientCode',
  title: 'title',
  description: 'reason',
  reason: 'reason',
  type: 'type',
  timezone: 'inputTimezone',
  tz: 'inputTimezone',
  starttime: 'startLocal',
  start: 'startLocal',
  endtime: 'endLocal',
  end: 'endLocal',
};

// ---- Helpers ------------------------------------------------------------------

function statusIcon(status: string) {
  switch (status) {
    case 'SCHEDULED': return <Clock className="w-3.5 h-3.5" />;
    case 'ACTIVE':    return <Zap className="w-3.5 h-3.5" />;
    case 'COMPLETED': return <CheckCircle2 className="w-3.5 h-3.5" />;
    case 'CANCELLED': return <XCircle className="w-3.5 h-3.5" />;
    default:          return null;
  }
}

function fmtDuration(start: string, end: string): string {
  const mins = dayjs.utc(end).diff(dayjs.utc(start), 'minute');
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ---- Create / Edit Dialog -----------------------------------------------------

interface WindowFormProps {
  clients: { id: string; clientId: string; name: string; cluster: string }[];
  onSave: (payload: any) => void;
  onClose: () => void;
  saving: boolean;
}

function WindowForm({ clients, onSave, onClose, saving }: WindowFormProps) {
  const [scope, setScope] = useState<'CLUSTER' | 'CLIENT'>('CLUSTER');
  const [cluster, setCluster] = useState('');
  const [clientDbId, setClientDbId] = useState('');
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [type, setType] = useState<'PLANNED' | 'UNSCHEDULED'>('PLANNED');
  const [tz, setTz] = useState<TzOption>('IST');
  const [startLocal, setStartLocal] = useState('');
  const [endLocal, setEndLocal] = useState('');

  const clusters = [...new Set(clients.map(c => c.cluster).filter(Boolean))].sort();
  const selectedClient = clients.find(c => c.id === clientDbId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: any = { scope, title, reason, type, inputTimezone: tz, startLocal, endLocal };
    if (scope === 'CLUSTER') {
      payload.cluster = cluster;
    } else {
      payload.clientDbId = clientDbId;
      payload.clientCode = selectedClient?.clientId;
    }
    onSave(payload);
  };

  const inputCls = 'w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400';
  const labelCls = 'block text-xs font-medium text-slate-600 mb-0.5';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center gap-2 px-5 py-4 border-b">
          <CalendarClock className="w-5 h-5 text-blue-600" />
          <h2 className="text-base font-semibold">New Maintenance Window</h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-600"><XCircle className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">

          {/* Scope */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Scope</label>
              <select className={inputCls} value={scope} onChange={e => setScope(e.target.value as any)}>
                <option value="CLUSTER">Cluster</option>
                <option value="CLIENT">Client</option>
              </select>
            </div>
            {scope === 'CLUSTER' ? (
              <div>
                <label className={labelCls}>Cluster</label>
                <select className={inputCls} value={cluster} onChange={e => setCluster(e.target.value)} required>
                  <option value="">— select —</option>
                  {clusters.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <label className={labelCls}>Client</label>
                <select className={inputCls} value={clientDbId} onChange={e => setClientDbId(e.target.value)} required>
                  <option value="">— select —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.clientId} — {c.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Title & Reason */}
          <div>
            <label className={labelCls}>Title</label>
            <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. Monthly patching window" />
          </div>
          <div>
            <label className={labelCls}>Reason / Notes</label>
            <input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional" />
          </div>

          {/* Type */}
          <div>
            <label className={labelCls}>Type</label>
            <div className="flex gap-3">
              {(['PLANNED', 'UNSCHEDULED'] as const).map(t => (
                <label key={t} className="flex items-center gap-1.5 cursor-pointer text-sm">
                  <input type="radio" value={t} checked={type === t} onChange={() => setType(t)} />
                  {t === 'PLANNED' ? 'Planned' : 'Unscheduled'}
                </label>
              ))}
            </div>
          </div>

          {/* Timezone + Times */}
          <div>
            <label className={labelCls}>Timezone</label>
            <select className={inputCls + ' w-32'} value={tz} onChange={e => setTz(e.target.value as TzOption)}>
              {TZ_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <p className="text-[11px] text-slate-400 mt-0.5">Times you enter will be converted to UTC for storage</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Start ({tz})</label>
              <input type="datetime-local" className={inputCls} value={startLocal}
                onChange={e => setStartLocal(e.target.value)} required />
            </div>
            <div>
              <label className={labelCls}>End ({tz})</label>
              <input type="datetime-local" className={inputCls} value={endLocal}
                onChange={e => setEndLocal(e.target.value)} required />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Create Window'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Affected Jobs Panel -------------------------------------------------------

function AffectedJobsPanel({ window: win, onClose }: { window: MaintenanceWindow; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['maintenance-affected', win.id],
    queryFn: () => maintenanceApi.getAffectedJobs(win.id),
  });

  const jobs: AffectedJob[] = data?.data ?? [];
  const grouped = jobs.reduce<Record<string, AffectedJob[]>>((acc, j) => {
    const key = j.clientId ?? 'unknown';
    (acc[key] ??= []).push(j);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50">
      <div className="bg-white rounded-t-2xl sm:rounded-xl shadow-xl w-full max-w-4xl mx-0 sm:mx-4 h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b flex-shrink-0">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          <div>
            <h2 className="text-base font-semibold">Affected Jobs</h2>
            <p className="text-xs text-slate-500">{win.title} · {win.startLocal} → {win.endLocal}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-600"><XCircle className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Computing affected jobs…
            </div>
          )}
          {!isLoading && jobs.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-400" />
              <p>No cron jobs scheduled to run during this window.</p>
            </div>
          )}
          {!isLoading && jobs.length > 0 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 font-medium">
                {jobs.length} job{jobs.length !== 1 ? 's' : ''} affected across {Object.keys(grouped).length} client{Object.keys(grouped).length !== 1 ? 's' : ''}.
                <span className="text-amber-600 ml-2">These will need manual trigger if the server is unavailable.</span>
              </p>
              {Object.entries(grouped).map(([cid, cJobs]) => (
                <ClientJobGroup key={cid} clientId={cid} jobs={cJobs} tz={win.inputTimezone} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ClientJobGroup({ clientId, jobs, tz }: { clientId: string; jobs: AffectedJob[]; tz: string }) {
  const [open, setOpen] = useState(true);
  const client = jobs[0];

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-left"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <span className="font-semibold text-sm">{clientId}</span>
        {client.clientName && <span className="text-slate-500 text-xs">— {client.clientName}</span>}
        {client.cluster && <span className="ml-auto text-[11px] text-slate-400">{client.cluster}</span>}
        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full ml-1">{jobs.length} jobs</span>
      </button>
      {open && (
        <table className="w-full text-xs resizable-cols">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase">
              <th className="text-left px-4 py-2 font-medium">Job / Command</th>
              <th className="text-left px-4 py-2 font-medium">Schedule</th>
              <th className="text-left px-4 py-2 font-medium">Fire times ({tz})</th>
              <th className="text-right px-4 py-2 font-medium">Count</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map(job => (
              <tr key={job.jobId} className="hover:bg-amber-50">
                <td className="px-4 py-2 max-w-xs">
                  <p className="font-medium truncate text-slate-700">{job.name}</p>
                  {job.command && <p className="text-slate-400 truncate">{job.command.slice(0, 60)}</p>}
                </td>
                <td className="px-4 py-2 font-mono text-slate-600 whitespace-nowrap">{job.cronExpression}</td>
                <td className="px-4 py-2">
                  <div className="space-y-0.5">
                    {job.fireTimesLocal.slice(0, 5).map((t, i) => (
                      <div key={i} className="text-slate-600">{t}</div>
                    ))}
                    {job.fireTimesLocal.length > 5 && (
                      <div className="text-slate-400">+{job.fireTimesLocal.length - 5} more</div>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-semibold text-amber-600">{job.fireCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Outage Form -------------------------------------------------------------

function OutageForm({ clients, onSave, onClose, saving }: {
  clients: { id: string; clientId: string; name: string; cluster: string }[];
  onSave: (payload: any) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [cluster, setCluster] = useState('');
  const [tz, setTz] = useState<TzOption>('IST');
  const [startLocal, setStartLocal] = useState('');
  const [endLocal, setEndLocal] = useState('');
  const [notes, setNotes] = useState('');

  const clusters = [...new Set(clients.map(c => c.cluster).filter(Boolean))].sort();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date();
    const title = `Outage — CL${cluster} — ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    onSave({
      scope: 'CLUSTER',
      cluster,
      title,
      reason: notes || undefined,
      type: 'UNSCHEDULED',
      inputTimezone: tz,
      startLocal,
      endLocal,
    });
  };

  const inputCls = 'w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400';
  const labelCls = 'block text-xs font-medium text-slate-600 mb-0.5';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center gap-2 px-5 py-4 border-b bg-red-50">
          <Siren className="w-5 h-5 text-red-600" />
          <h2 className="text-base font-semibold text-red-800">Report Outage</h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-600"><XCircle className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className={labelCls}>Affected Cluster</label>
            <select className={inputCls} value={cluster} onChange={e => setCluster(e.target.value)} required>
              <option value="">— select cluster —</option>
              {clusters.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Timezone</label>
            <select className={inputCls + ' w-32'} value={tz} onChange={e => setTz(e.target.value as TzOption)}>
              {TZ_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Outage Start ({tz})</label>
              <input type="datetime-local" className={inputCls} value={startLocal}
                onChange={e => setStartLocal(e.target.value)} required />
            </div>
            <div>
              <label className={labelCls}>Outage End ({tz})</label>
              <input type="datetime-local" className={inputCls} value={endLocal}
                onChange={e => setEndLocal(e.target.value)} required />
            </div>
          </div>
          <div>
            <label className={labelCls}>Notes / Description</label>
            <textarea className={inputCls} value={notes} onChange={e => setNotes(e.target.value)}
              rows={2} placeholder="What happened? Impact details…" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Log Outage'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Excel Import Button -------------------------------------------------------
// Auto-detects format:
//   NETOPS yearly calendar (Sheet "Maintenance Calendar" / header "Maintenance Group")
//     → imports into MaintenanceCalendar table
//   Ad-hoc windows sheet (has title + start + end columns)
//     → imports into MaintenanceWindow table

/** Convert Excel date serial to ISO date string */
function serialToIso(serial: number): string {
  return new Date((serial - 25569) * 86400000).toISOString();
}

/** Extract timezone from window text */
function detectTz(text: string): string {
  if (/UK\s*Time/i.test(text)) return 'UK';
  if (/\bEDT\b/i.test(text)) return 'EDT';
  if (/\bEST\b/i.test(text)) return 'EST';
  if (/\bCST\b/i.test(text)) return 'CST';
  if (/\bCDT\b/i.test(text)) return 'CDT';
  if (/\bUTC\b/i.test(text)) return 'UTC';
  return 'EST';
}

/** Strip timezone label from a time string like "01:15 AM EST" → "01:15 AM" */
function stripTzLabel(raw: string): string {
  return (raw || '').replace(/\s+(IST|EDT|EST|CST|CDT|UTC|AM|PM)$/i, (m) =>
    /^(AM|PM)$/i.test(m.trim()) ? m : ''
  ).trim();
}

function ExcelImportButton({ clients, onImported }: {
  clients: { id: string; clientId: string; name: string; cluster: string }[];
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setStatus(null);

    try {
      const XLSX = await import('xlsx');
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });

      // ── Detect format by sheet name or first-row header ──────────────────
      const sheet1Name = wb.SheetNames[0] ?? '';
      const ws1raw: any[][] = XLSX.utils.sheet_to_json(
        wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }
      );
      const firstHeader = String(ws1raw[0]?.[0] ?? '').trim();
      const isNetops =
        sheet1Name.toLowerCase().includes('maintenance calendar') ||
        firstHeader.toLowerCase().includes('maintenance group') ||
        firstHeader.toLowerCase().includes('maintenancegroup');

      // ════════════════════════════════════════════════════════════════════
      // PATH A: NETOPS yearly calendar file
      // ════════════════════════════════════════════════════════════════════
      if (isNetops) {
        const header = ws1raw[0] as string[];

        // Find month columns (col index → month number) and detect year
        const monthCols: { col: number; month: number }[] = [];
        let detectedYear = new Date().getFullYear();
        for (let c = 5; c < header.length; c++) {
          const m = String(header[c]).match(/(\w+)\s+(\d{4})/);
          if (m) { detectedYear = Number(m[2]); monthCols.push({ col: c, month: monthCols.length + 1 }); }
        }
        if (monthCols.length === 0) throw new Error('Could not find month columns in the calendar sheet.');

        // Build start/end time lookup from Sheet 2 ("Maintenance by Customer")
        const timeLookup: Record<string, { start: string; end: string; tz: string }> = {};
        if (wb.SheetNames.length > 1) {
          const ws2: any[][] = XLSX.utils.sheet_to_json(
            wb.Sheets[wb.SheetNames[1]], { header: 1, defval: '' }
          );
          for (let r = 1; r < ws2.length; r++) {
            const row = ws2[r];
            const group = String(row[0]).trim();
            const startRaw = String(row[6]).trim();
            const endRaw   = String(row[7]).trim();
            if (group && startRaw && !timeLookup[group]) {
              timeLookup[group] = {
                start: stripTzLabel(startRaw),
                end:   stripTzLabel(endRaw),
                tz:    detectTz(startRaw + ' ' + endRaw + ' ' + String(row[5])),
              };
            }
          }
        }

        // Build entries from Sheet 1
        const entries: any[] = [];
        for (let r = 1; r < ws1raw.length; r++) {
          const row = ws1raw[r];
          const group   = String(row[0]).trim();
          const clusters = String(row[1]).trim();
          const winText  = String(row[4]).trim();
          if (!group || !clusters) continue;

          const times = timeLookup[group] ?? { start: '', end: '', tz: detectTz(winText) };

          for (const { col, month } of monthCols) {
            const cell = row[col];
            if (!cell && cell !== 0) continue;

            let status = 'SCHEDULED';
            let isoDate: string;

            if (typeof cell === 'number') {
              isoDate = serialToIso(cell);
            } else if (typeof cell === 'string' && cell.toLowerCase().includes('cancel')) {
              status  = 'CANCELLED';
              isoDate = new Date(Date.UTC(detectedYear, month - 1, 1)).toISOString();
            } else {
              continue;
            }

            entries.push({
              maintenanceGroup:  group,
              clusters,
              maintenanceWindow: winText,
              windowStartTime:   times.start || undefined,
              windowEndTime:     times.end   || undefined,
              timezone:          times.tz,
              maintenanceDate:   isoDate,
              month,
              year:              detectedYear,
              status,
            });
          }
        }

        if (entries.length === 0) throw new Error('No maintenance dates found in the file.');

        const user = JSON.parse(localStorage.getItem('wfm_user') ?? '{}');
        const res = await maintenanceCalendarApi.import({
          year: detectedYear,
          fileName: file.name,
          importedBy: user.displayName || user.username,
          entries,
        });
        setStatus(`✅ Calendar ${detectedYear} imported — ${entries.length} dates across ${new Set(entries.map((e: any) => e.maintenanceGroup)).size} groups.`);
        onImported();
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // PATH B: Ad-hoc maintenance windows sheet
      // ════════════════════════════════════════════════════════════════════
      const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(
        wb.Sheets[wb.SheetNames[0]], { defval: '' }
      );
      if (rows.length === 0) throw new Error('Sheet is empty');

      const windows: any[] = rows.map((row, idx) => {
        const mapped: any = {};
        for (const [k, v] of Object.entries(row)) {
          const normKey = EXCEL_COL_MAP[k.trim().toLowerCase().replace(/\s+/g, '')];
          if (normKey) mapped[normKey] = String(v ?? '').trim();
        }
        if (!mapped.title)      throw new Error(`Row ${idx + 2}: missing "title" column`);
        if (!mapped.startLocal) throw new Error(`Row ${idx + 2}: missing "start" / "startTime" column`);
        if (!mapped.endLocal)   throw new Error(`Row ${idx + 2}: missing "end" / "endTime" column`);
        if (!mapped.inputTimezone) mapped.inputTimezone = 'IST';
        if (!mapped.type)          mapped.type = 'PLANNED';
        if (!mapped.scope)         mapped.scope = 'CLUSTER';
        if (mapped.scope?.toUpperCase() === 'CLIENT' && mapped.clientCode && !mapped.clientDbId) {
          const match = clients.find(c => c.clientId.toUpperCase() === mapped.clientCode.toUpperCase());
          if (match) mapped.clientDbId = match.id;
        }
        mapped.scope         = mapped.scope.toUpperCase();
        mapped.type          = mapped.type.toUpperCase();
        mapped.inputTimezone = mapped.inputTimezone.toUpperCase();
        return mapped;
      });

      const res = await maintenanceApi.bulk(windows);
      const r   = res.data as any;
      setStatus(`✅ Imported ${r.created} window${r.created !== 1 ? 's' : ''}${r.errors?.length ? ` (${r.errors.length} errors)` : ''}.`);
      onImported();
    } catch (err: any) {
      setStatus(`❌ ${err.message}`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [clients, onImported]);

  return (
    <div className="flex items-center gap-2">
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={importing}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
      >
        <Upload className="w-4 h-4" />
        {importing ? 'Importing…' : 'Import Excel'}
      </button>
      {status && <span className="text-xs text-slate-600">{status}</span>}
    </div>
  );
}

// ---- Main Page ----------------------------------------------------------------

export default function MaintenanceWindows() {
  const qc = useQueryClient();
  const [pageTab, setPageTab] = useState<'windows' | 'calendar' | 'outages'>('calendar');
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateOutage, setShowCreateOutage] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<MaintenanceWindow | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('active');

  const { data: winData, isLoading } = useQuery({
    queryKey: ['maintenance', filterStatus],
    queryFn: () => {
      const params: any = {};
      if (filterStatus === 'active')   { params.upcoming = '1'; }
      else if (filterStatus !== 'all') { params.status = filterStatus.toUpperCase(); }
      return maintenanceApi.list(params);
    },
    refetchInterval: 60_000,
  });

  // Fetch clients for dropdowns
  const { data: clientData } = useQuery({
    queryKey: ['clients-slim'],
    queryFn: () => import('../../services/api').then(m => m.clientsApi.list({ isActive: true, limit: 200 })),
    staleTime: 300_000,
  });
  const clients = (clientData?.data ?? []).map((c: any) => ({
    id: c.id, clientId: c.clientId, name: c.name, cluster: c.cluster ?? '',
  }));

  const createMutation = useMutation({
    mutationFn: (payload: any) => maintenanceApi.create(payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maintenance'] }); setShowCreate(false); },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => maintenanceApi.update(id, { status: 'CANCELLED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }),
  });

  // Outages
  const { data: outageData, isLoading: outageLoading } = useQuery({
    queryKey: ['maintenance-outages'],
    queryFn: () => maintenanceApi.list({ type: 'UNSCHEDULED' }),
    refetchInterval: 30_000,
    enabled: pageTab === 'outages',
  });
  const outages: MaintenanceWindow[] = (outageData?.data ?? []).filter((w: any) => w.source !== 'calendar');

  const outageMutation = useMutation({
    mutationFn: (payload: any) => maintenanceApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-outages'] });
      setShowCreateOutage(false);
    },
  });

  const cancelOutageMutation = useMutation({
    mutationFn: (id: string) => maintenanceApi.update(id, { status: 'CANCELLED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance-outages'] }),
  });

  const windows: MaintenanceWindow[] = winData?.data ?? [];

  const filterTabs = [
    { key: 'active',    label: 'Active & Upcoming' },
    { key: 'all',       label: 'All' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <CalendarClock className="w-6 h-6 text-blue-600" />
            Maintenance
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Track planned &amp; unscheduled outages and the yearly maintenance calendar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pageTab === 'windows' && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
            >
              <Plus className="w-4 h-4" /> New Window
            </button>
          )}
          {pageTab === 'outages' && (
            <button
              onClick={() => setShowCreateOutage(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-red-600 text-white text-sm rounded-md hover:bg-red-700"
            >
              <Siren className="w-4 h-4" /> Report Outage
            </button>
          )}
        </div>
      </div>

      {/* Page-level tabs */}
      <div className="flex gap-1 mb-5 border-b border-slate-200">
        <button
          onClick={() => setPageTab('windows')}
          className={`px-5 py-2 text-sm font-semibold transition-colors ${
            pageTab === 'windows'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Maintenance Windows
        </button>
        <button
          onClick={() => setPageTab('calendar')}
          className={`px-5 py-2 text-sm font-semibold transition-colors ${
            pageTab === 'calendar'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Maintenance Calendar
        </button>
        <button
          onClick={() => setPageTab('outages')}
          className={`px-5 py-2 text-sm font-semibold transition-colors ${
            pageTab === 'outages'
              ? 'border-b-2 border-red-500 text-red-600'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Outages
        </button>
      </div>

      {/* Calendar tab */}
      {pageTab === 'calendar' && <MaintenanceCalendarTab />}

      {/* Outages tab */}
      {pageTab === 'outages' && (
        <div className="space-y-3">
          {outageLoading ? (
            <div className="flex items-center justify-center h-40 text-slate-400">
              <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : outages.length === 0 ? (
            <div className="text-center py-20 text-slate-400">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-3 opacity-40 text-green-500" />
              <p className="font-medium">No outages recorded.</p>
              <p className="text-sm mt-1">Click <strong>Report Outage</strong> to log an unplanned outage.</p>
            </div>
          ) : (
            outages.map(win => (
              <WindowCard
                key={win.id}
                win={win}
                onViewJobs={() => setSelectedWindow(win)}
                onCancel={() => cancelOutageMutation.mutate(win.id)}
              />
            ))
          )}
          {showCreateOutage && (
            <OutageForm
              clients={clients}
              onSave={data => outageMutation.mutate(data)}
              onClose={() => setShowCreateOutage(false)}
              saving={outageMutation.isPending}
            />
          )}
          {selectedWindow && (
            <AffectedJobsPanel window={selectedWindow} onClose={() => setSelectedWindow(null)} />
          )}
        </div>
      )}

      {/* Windows tab content below */}
      {pageTab === 'windows' && <>

      {/* Info banner */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-5 text-sm text-amber-800 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          Times entered are in your selected timezone (IST / EDT / EST / CST / UTC) and are converted to UTC for comparison with job schedules.
          Click <strong>View Affected Jobs</strong> on any window to see which cron jobs need manual triggering.
        </span>
      </div>

      {/* Excel template hint */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 mb-5 text-xs text-slate-600">
        <strong>Excel columns:</strong> cluster (or clusters), title, reason, type (PLANNED/UNSCHEDULED, default: PLANNED), timezone (IST/EDT/EST/CST/UTC, default: IST), start (YYYY-MM-DD HH:MM), end (YYYY-MM-DD HH:MM) &mdash; <em>scope</em> column is optional (defaults to CLUSTER)
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilterStatus(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              filterStatus === tab.key
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-slate-400">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : windows.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          <CalendarClock className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p>No maintenance windows found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {windows.map(win => (
            <WindowCard
              key={win.id}
              win={win}
              onViewJobs={() => setSelectedWindow(win)}
              onCancel={() => cancelMutation.mutate(win.id)}
            />
          ))}
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <WindowForm
          clients={clients}
          onSave={data => createMutation.mutate(data)}
          onClose={() => setShowCreate(false)}
          saving={createMutation.isPending}
        />
      )}

      {/* Affected jobs panel */}
      {selectedWindow && (
        <AffectedJobsPanel window={selectedWindow} onClose={() => setSelectedWindow(null)} />
      )}
      </>}
    </div>
  );
}

// ---- Window Card --------------------------------------------------------------

function WindowCard({ win, onViewJobs, onCancel }: {
  win: MaintenanceWindow;
  onViewJobs: () => void;
  onCancel: () => void;
}) {
  const { fmt } = useTimezone();
  const duration = fmtDuration(win.startTimeUtc, win.endTimeUtc);

  return (
    <div className={`bg-white border rounded-lg px-5 py-4 flex items-start gap-4 shadow-sm ${
      win.status === 'ACTIVE' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
    }`}>
      {/* Scope badge */}
      <div className="flex-shrink-0 flex flex-col gap-1 items-center min-w-[3.5rem]">
        {win.scope === 'CLUSTER' ? (
          (win.cluster ?? '').split(/[&,]/).map(s => s.trim()).filter(Boolean).map(cl => (
            <span key={cl} className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 whitespace-nowrap">
              CL {cl}
            </span>
          ))
        ) : (
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 whitespace-nowrap">
            {win.clientCode ?? 'Client'}
          </span>
        )}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-slate-800 text-sm">{win.title}</h3>
          <span className={`text-[11px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${STATUS_STYLE[win.status] ?? ''}`}>
            {statusIcon(win.status)} {win.status}
          </span>
          <span className={`text-[11px] px-1.5 py-0.5 rounded ${TYPE_STYLE[win.type] ?? ''}`}>
            {win.type}
          </span>
        </div>
        {win.reason && <p className="text-xs text-slate-500 mt-0.5">{win.reason}</p>}
        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 flex-wrap">
          <Clock className="w-3.5 h-3.5" />
          <span>{fmt(win.startTimeUtc)}</span>
          <span>→</span>
          <span>{fmt(win.endTimeUtc)}</span>
          <span className="text-slate-400">({duration})</span>
          {win.source === 'excel_import' && (
            <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">Excel</span>
          )}
          {win.source === 'calendar' && (
            <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-medium">Calendar</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {win.status !== 'CANCELLED' && win.status !== 'COMPLETED' && (
          <button
            onClick={onViewJobs}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-amber-100 text-amber-700 rounded-md hover:bg-amber-200 font-medium"
          >
            <Eye className="w-3.5 h-3.5" /> View Affected Jobs
          </button>
        )}
        {win.source !== 'calendar' && (win.status === 'SCHEDULED' || win.status === 'ACTIVE') && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-md hover:bg-red-50 hover:text-red-600 hover:border-red-200"
          >
            <Trash2 className="w-3.5 h-3.5" /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}
