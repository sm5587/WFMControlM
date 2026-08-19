// ============================================================
// MaintenanceCalendarTab.tsx
// Import & browse yearly maintenance calendars from the NETOPS Excel file.
// Sheet 1 ("Maintenance Calendar") — one row per maintenance group.
// Sheet 2 ("Maintenance by Customer") — one row per customer (used for
//   clean start/end times and cluster codes).
// ============================================================

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Upload, Calendar, Trash2, ChevronDown, ChevronRight, ChevronLeft,
  Clock, AlertTriangle, RefreshCw, CheckCircle2, Download, Siren, Square,
} from 'lucide-react';
import { maintenanceCalendarApi, outageApi } from '../../services/api';
import type {
  MaintenanceCalendar, MaintenanceCalendarEntry, CalendarImportEntry,
  OutageImpactJob, OutageImpactResult, OutageImpactStreamEvent,
} from '../../types';
import { usePermission } from '../../context/AuthContext';

// ---------------------------------------------------------------- helpers

/** Timezone label → UTC offset in minutes (for converting calendar entries to IST) */
const CAL_TZ_OFFSETS: Record<string, number> = {
  IST: 330, EDT: -240, EST: -300, CST: -360, CDT: -300, UTC: 0, UK: 0, GMT: 0,
};

function parseTime12(t: string): { h: number; m: number } | null {
  // Strip TZ suffixes ("UK Time", "EST" etc.) and leading words ("next day")
  let cleaned = t.trim().replace(/\s+(UK\s*Time|EST|EDT|CST|CDT|UTC|GMT)\s*$/i, '').trim();
  cleaned = cleaned.replace(/^.*?(\d)/i, '$1');
  cleaned = cleaned.replace(/(\d)\.(\d)/, '$1:$2');
  const match = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  if (match[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (match[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return { h, m };
}

/** Format window time for display — uses pre-computed fields when available. */
function formatEntryWindow(e: MaintenanceCalendarEntry): string {
  if (e.startLocal && e.endLocal) return `${e.startLocal} – ${e.endLocal}`;
  if (e.windowStartTime) {
    return calTimeToIST(e.maintenanceDate, e.windowStartTime, e.windowEndTime, e.timezone);
  }
  return e.maintenanceWindow.slice(0, 80);
}

/**
 * Convert a calendar window time ("12:15 AM" in e.g. EST) to an IST display string.
 * maintenanceDate is the midnight-UTC ISO string for that date.
 */
function calTimeToIST(
  maintenanceDate: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  tz: string,
): string {
  if (!startTime) return '';
  const tzKey = tz.toUpperCase().replace(' TIME', '');
  const offsetMin = CAL_TZ_OFFSETS[tzKey] ?? 0;
  const st = parseTime12(startTime);
  if (!st) return `${startTime}${endTime ? ` – ${endTime}` : ''} ${tz}`;

  const baseDateMs  = new Date(maintenanceDate).getTime(); // midnight UTC = the calendar date
  // local time on that date → subtract offset to get UTC → add IST offset
  const startUTCMs  = baseDateMs + (st.h * 60 + st.m) * 60_000 - offsetMin * 60_000;
  const startISTMs  = startUTCMs + 330 * 60_000;

  const fmtHHMM = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  };

  if (endTime) {
    const et = parseTime12(endTime);
    if (et) {
      let endUTCMs = baseDateMs + (et.h * 60 + et.m) * 60_000 - offsetMin * 60_000;
      if (endUTCMs <= startUTCMs) endUTCMs += 86_400_000; // window crosses midnight
      const endISTMs = endUTCMs + 330 * 60_000;
      return `${fmtHHMM(startISTMs)} – ${fmtHHMM(endISTMs)} IST`;
    }
  }
  return `${fmtHHMM(startISTMs)} IST`;
}

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Excel date serial → JS Date (local midnight) */
function excelSerialToDate(serial: number): Date {
  // Excel epoch: 1-Jan-1900 = serial 1 (with the infamous leap-year bug)
  const msPerDay = 86400000;
  // serial 1 = 1900-01-01 → offset from Unix epoch
  return new Date((serial - 25569) * msPerDay);
}

/** Extract timezone label from a window string, e.g. "US EST" → "EST", "UK Time" → "UK" */
function extractTimezone(text: string): string {
  if (/UK\s*Time/i.test(text)) return 'UK';
  if (/\bEDT\b/i.test(text)) return 'EDT';
  if (/\bEST\b/i.test(text)) return 'EST';
  if (/\bCST\b/i.test(text)) return 'CST';
  if (/\bCDT\b/i.test(text)) return 'CDT';
  if (/\bUTC\b/i.test(text)) return 'UTC';
  return 'EST';
}

/** Parse "01:15 AM EST" → "01:15 AM" (strip TZ label) */
function parseTimeStr(raw: string): string {
  return (raw || '').replace(/\s*(AM|PM)\s+\S+$/i, (m, ampm) => ` ${ampm}`).trim();
}

// ---------------------------------------------------------------- parse

interface ParseResult {
  year: number;
  fileName: string;
  entries: CalendarImportEntry[];
  preview: PreviewGroup[];
  errors: string[];
}

interface PreviewGroup {
  maintenanceGroup: string;
  clusters: string;
  maintenanceWindow: string;
  windowStartTime: string;
  windowEndTime: string;
  timezone: string;
  dates: { month: number; date: string; status: string }[];
}

async function parseCalendarXlsx(file: File): Promise<ParseResult> {
  const xlsx = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const wb = xlsx.read(buffer, { type: 'array' });

  const errors: string[] = [];

  // ---- Sheet 1: Maintenance Calendar (group-level) ----
  const ws1 = wb.Sheets[wb.SheetNames[0]];
  const raw1: any[][] = xlsx.utils.sheet_to_json(ws1, { header: 1, defval: '' });

  if (raw1.length < 2) {
    errors.push('Sheet "Maintenance Calendar" appears empty');
    return { year: 0, fileName: file.name, entries: [], preview: [], errors };
  }

  const header = raw1[0] as string[];
  // Columns: 0=Group, 1=Clusters, 2=Customer Count, 3=Total, 4=Maint Window,
  //          5..16 = Jan..Dec
  const monthCols: number[] = [];
  let detectedYear = 2026;
  for (let c = 5; c < header.length; c++) {
    const h = String(header[c]);
    const m = h.match(/\w+\s+(\d{4})/);
    if (m) {
      detectedYear = Number(m[1]);
      monthCols.push(c);
    }
  }

  // ---- Sheet 2: Maintenance by Customer (for clean start/end times) ----
  // Build a lookup: maintenanceGroup → { windowStart, windowEnd, timezone }
  const timeLookup: Record<string, { start: string; end: string; tz: string }> = {};
  if (wb.SheetNames.length > 1) {
    const ws2 = wb.Sheets[wb.SheetNames[1]];
    const raw2: any[][] = xlsx.utils.sheet_to_json(ws2, { header: 1, defval: '' });
    for (let r = 1; r < raw2.length; r++) {
      const row = raw2[r];
      const group = String(row[0]).trim();
      const startRaw = String(row[6]).trim(); // "Maintenance Window START"
      const endRaw   = String(row[7]).trim(); // "Maintenance Window END"
      if (group && startRaw && !timeLookup[group]) {
        timeLookup[group] = {
          start: parseTimeStr(startRaw),
          end:   parseTimeStr(endRaw),
          tz:    extractTimezone(startRaw + ' ' + endRaw + ' ' + String(row[5])),
        };
      }
    }
  }

  const entries: CalendarImportEntry[] = [];
  const preview: PreviewGroup[] = [];

  for (let r = 1; r < raw1.length; r++) {
    const row = raw1[r];
    const group   = String(row[0]).trim();
    const clusters = String(row[1]).trim();
    const window  = String(row[4]).trim();

    if (!group || !clusters) continue;

    const times = timeLookup[group] ?? {
      start: '',
      end:   '',
      tz:    extractTimezone(window),
    };

    const previewGroup: PreviewGroup = {
      maintenanceGroup: group,
      clusters,
      maintenanceWindow: window,
      windowStartTime: times.start,
      windowEndTime:   times.end,
      timezone:        times.tz,
      dates: [],
    };

    for (let ci = 0; ci < monthCols.length; ci++) {
      const col = monthCols[ci];
      const month = ci + 1;
      const cell = row[col];

      if (!cell && cell !== 0) continue;

      let status = 'SCHEDULED';
      let date: Date;

      if (typeof cell === 'number') {
        date = excelSerialToDate(cell);
      } else if (typeof cell === 'string' && cell.toLowerCase().includes('cancel')) {
        // "Maintenance has been cancelled for December 2026"
        status = 'CANCELLED';
        // Use the first of that month as placeholder date
        date = new Date(Date.UTC(detectedYear, month - 1, 1));
      } else {
        continue;
      }

      const isoDate = date.toISOString();
      previewGroup.dates.push({ month, date: isoDate, status });

      entries.push({
        maintenanceGroup: group,
        clusters,
        maintenanceWindow: window,
        windowStartTime: times.start || undefined,
        windowEndTime:   times.end   || undefined,
        timezone:        times.tz,
        maintenanceDate: isoDate,
        month,
        year: detectedYear,
        status,
      });
    }

    if (previewGroup.dates.length > 0) {
      preview.push(previewGroup);
    }
  }

  return { year: detectedYear, fileName: file.name, entries, preview, errors };
}

// ---------------------------------------------------------------- calendar grid helpers

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CLUSTER_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-orange-500', 'bg-teal-500',
  'bg-pink-500', 'bg-indigo-500',
];

function getClusterColor(cl: string): string {
  const n = parseInt(cl.replace(/\D/g, '')) || 0;
  return CLUSTER_COLORS[n % CLUSTER_COLORS.length];
}

function parseClustersGrid(raw: string): string[] {
  return raw.split(/[&,\/]/).map(s => s.trim().replace(/^CL\s*/i, '')).filter(Boolean);
}

function CalendarGridView({
  entries,
  year,
}: {
  entries: MaintenanceCalendarEntry[];
  year: number;
}) {
  const [gridMonth, setGridMonth] = useState(() => {
    const now = new Date();
    return now.getFullYear() === year ? now.getMonth() + 1 : 1;
  });
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const monthEntries = entries.filter(e => e.month === gridMonth);

  // Group by calendar day
  const byDay: Record<number, MaintenanceCalendarEntry[]> = {};
  for (const e of monthEntries) {
    const d = new Date(e.maintenanceDate).getUTCDate();
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(e);
  }

  const firstWeekday = new Date(Date.UTC(year, gridMonth - 1, 1)).getUTCDay();
  const daysInMonth  = new Date(Date.UTC(year, gridMonth, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const selectedEntries = selectedDay ? (byDay[selectedDay] ?? []) : [];

  const prevMonth = () => { setGridMonth(m => m === 1 ? 12 : m - 1); setSelectedDay(null); };
  const nextMonth = () => { setGridMonth(m => m === 12 ? 1 : m + 1); setSelectedDay(null); };

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={prevMonth} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="font-semibold text-slate-800">{MONTHS[gridMonth]} {year}</span>
        <button onClick={nextMonth} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Selected day detail — compact strip above grid */}
      {selectedDay && selectedEntries.length > 0 && (
        <div className="mb-2 px-3 py-1.5 bg-blue-50 rounded-lg border border-blue-100 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold text-slate-700 shrink-0">
            {MONTHS[gridMonth]} {selectedDay}, {year}
          </span>
          {selectedEntries.map(e => (
            <span key={e.id} className="text-slate-600">
              CL {parseClustersGrid(e.clusters).join(', ')} — {formatEntryWindow(e)}
              {e.status === 'CANCELLED' && <span className="ml-1 text-red-500">Cancelled</span>}
            </span>
          ))}
          <button
            type="button"
            onClick={() => setSelectedDay(null)}
            className="ml-auto text-slate-400 hover:text-slate-600 shrink-0"
            aria-label="Clear selection"
          >
            ×
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-7 border-l border-t border-slate-200">
        {DAY_NAMES.map(d => (
          <div key={d} className="text-center text-[11px] font-semibold text-slate-400 py-1.5 border-r border-b border-slate-200 bg-slate-50">{d}</div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={`p${idx}`} className="border-r border-b border-slate-200 min-h-[2.25rem]" />;
          const dayEntries = byDay[day] ?? [];
          const isToday = today.getFullYear() === year && today.getMonth() + 1 === gridMonth && today.getDate() === day;
          const isSelected = selectedDay === day;
          const hasMaint = dayEntries.length > 0;
          const isCancelled = hasMaint && dayEntries.every(e => e.status === 'CANCELLED');

          return (
            <button
              key={day}
              onClick={() => hasMaint ? setSelectedDay(isSelected ? null : day) : undefined}
              className={`p-1 flex flex-col items-center min-h-[2.25rem] transition-colors border-r border-b border-slate-200 ${
                isSelected ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' :
                hasMaint && !isCancelled ? 'hover:bg-slate-50 cursor-pointer' :
                hasMaint ? 'opacity-40 cursor-default' : 'cursor-default'
              }`}
            >
              <span className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full ${
                isToday ? 'bg-blue-600 text-white' :
                hasMaint && !isCancelled ? 'text-slate-800' : 'text-slate-300'
              }`}>
                {day}
              </span>
              {hasMaint && !isCancelled && (
                <div className="flex flex-wrap gap-0.5 justify-center mt-0.5">
                  {[...new Set(dayEntries.flatMap(e => parseClustersGrid(e.clusters)))].slice(0, 6).map(cl => (
                    <span key={cl} className="text-[9px] font-bold px-1 py-0 rounded bg-blue-100 text-blue-700 leading-4">
                      {cl}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sub-components

function StatusBadge({ status }: { status: string }) {
  const c = status === 'SCHEDULED'
    ? 'bg-green-100 text-green-700'
    : status === 'CANCELLED'
    ? 'bg-red-100 text-red-600'
    : 'bg-gray-100 text-gray-600';
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${c}`}>
      {status}
    </span>
  );
}

function PreviewTable({ preview }: { preview: PreviewGroup[] }) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setCollapsed(Object.fromEntries(preview.map((_, i) => [i, true])));
  }, [preview]);

  return (
    <div className="space-y-1 text-xs">
      {preview.map((g, i) => (
        <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setCollapsed(c => ({ ...c, [i]: !c[i] }))}
            className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 text-left"
          >
            {collapsed[i] ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <span className="font-semibold text-gray-800">{g.maintenanceGroup}</span>
            <span className="text-gray-400 ml-1">CL: {g.clusters}</span>
            {g.windowStartTime && (
              <span className="ml-auto text-gray-500 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {g.windowStartTime} – {g.windowEndTime} {g.timezone}
              </span>
            )}
            <span className="ml-2 bg-zebra-100 text-zebra-700 px-1.5 py-0.5 rounded text-xs font-bold">
              {g.dates.length}
            </span>
          </button>
          {!collapsed[i] && (
            <div className="px-3 py-2 flex flex-wrap gap-2">
              {g.dates.map((d, di) => (
                <div key={di} className="flex flex-col items-center text-center">
                  <span className="text-gray-500 font-medium">{MONTHS[d.month].slice(0, 3)}</span>
                  <span className="font-semibold text-gray-800">
                    {new Date(d.date).toLocaleDateString('en-US', { day: '2-digit', timeZone: 'UTC' })}
                  </span>
                  {d.status === 'CANCELLED' && (
                    <span className="text-red-500 text-[10px]">Cancelled</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Parse "19 & 26" or "CL19 & CL26" → ["19", "26"] */
function parseClusters(raw: string): string[] {
  return raw.split(/[&,/]/).map(s => s.trim().replace(/^CL\s*/i, '')).filter(Boolean);
}

function entryToApiDateTime(raw: string): string {
  if (!raw?.trim()) return '';
  const stripped = raw.trim().replace(/\s+(IST|EDT|EST|CST|CDT|UTC|GMT|UK(?:\s+Time)?)\s*$/i, '');
  const m = stripped.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : stripped.slice(0, 16).replace('T', ' ');
}

function entryInputTimezone(entry: MaintenanceCalendarEntry): string {
  const fromLocal = entry.startLocal?.match(/\s+(IST|EDT|EST|CST|CDT|UTC|GMT|UK)\s*$/i)?.[1];
  return (fromLocal ?? entry.timezone ?? 'IST').toUpperCase().replace(' TIME', '');
}

/** Calendar Excel uses "19 & 26"; client.cluster in DB is "CL19", "CL26". */
function clustersForImpactApi(raw: string): string[] {
  return parseClusters(raw).map(cl => (/^CL/i.test(cl) ? cl.toUpperCase() : `CL${cl}`));
}

function buildEntryImpactParams(entry: MaintenanceCalendarEntry) {
  if (!entry.startLocal || !entry.endLocal) return null;
  const entryClusters = clustersForImpactApi(entry.clusters);
  if (entryClusters.length === 0) return null;
  const tz = entryInputTimezone(entry);
  return {
    clusters: entryClusters,
    startLocal: entryToApiDateTime(entry.startLocal),
    endLocal: entryToApiDateTime(entry.endLocal),
    inputTimezone: tz,
    noRetryToday: true,
  };
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

function applyImpactStreamEvent(
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

function exportImpactCsv(
  rows: OutageImpactJob[],
  tz: string,
  filenameSuffix: string,
  extraColumns?: Record<string, string>,
) {
  const extraKeys = extraColumns ? Object.keys(extraColumns) : [];
  const header = [
    ...extraKeys,
    'clientId', 'cluster', 'jobName', 'cronExpression', 'serverTimezone',
    'fireTimesDisplay', 'fireTimesServer', 'fireTimesUtc', 'willRetryToday', 'command',
  ];
  const lines = rows.map(r =>
    header.map(h => {
      let v: string | boolean = extraColumns?.[h] ?? '';
      if (!extraColumns || !(h in extraColumns)) {
        if (h === 'jobName') v = r.name;
        else if (h === 'fireTimesDisplay') v = r.fireTimesDisplay.join('; ');
        else if (h === 'fireTimesServer') v = r.fireTimesServer.join('; ');
        else if (h === 'fireTimesUtc') v = r.fireTimesUtc.join('; ');
        else if (h === 'clientId') v = r.clientId;
        else if (h === 'cluster') v = r.cluster;
        else if (h === 'cronExpression') v = r.cronExpression;
        else if (h === 'serverTimezone') v = r.serverTimezone;
        else if (h === 'willRetryToday') v = r.willRetryToday;
        else if (h === 'command') v = r.command ?? '';
        else v = '';
      }
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(','),
  );
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maintenance-impact-${filenameSuffix}-${new Date().toISOString().slice(0, 10)}.csv`;
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
        className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-left"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
        <span className="font-semibold text-xs">{clientId}</span>
        {client.clientName && <span className="text-slate-500 text-[11px]">— {client.clientName}</span>}
        {client.cluster && <span className="ml-auto text-[10px] text-slate-400">{client.cluster}</span>}
        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full ml-1">{jobs.length} jobs</span>
      </button>
      {open && (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase">
              <th className="text-left px-3 py-1.5 font-medium">Job</th>
              <th className="text-left px-3 py-1.5 font-medium">Schedule</th>
              <th className="text-left px-3 py-1.5 font-medium">Fire times ({tz})</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map(job => (
              <tr key={job.jobId} className="hover:bg-red-50/40">
                <td className="px-3 py-1.5 max-w-xs">
                  <p className="font-medium text-slate-700 truncate">{job.name}</p>
                  {job.command && <p className="text-slate-400 truncate">{job.command.slice(0, 60)}</p>}
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-600 whitespace-nowrap">{job.cronExpression}</td>
                <td className="px-3 py-1.5">
                  {job.fireTimesDisplay.map((t, i) => (
                    <div key={i} className="text-slate-700">{t}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EntryTable({
  entries,
  selectedMonth,
}: {
  entries: MaintenanceCalendarEntry[];
  selectedMonth: number;
}) {
  const canOutageImpact = usePermission('OUTAGE_VIEW', 'read');
  const impactAllowed = selectedMonth > 0 && canOutageImpact;

  const clusters = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      for (const cl of parseClusters(e.clusters)) set.add(cl);
    }
    return [...set].sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [entries]);

  const [allClustersSelected, setAllClustersSelected] = useState(true);
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
  const [analyzingEntryId, setAnalyzingEntryId] = useState<string | null>(null);
  const [impactByEntry, setImpactByEntry] = useState<Record<string, OutageImpactResult>>({});
  const [liveResult, setLiveResult] = useState<OutageImpactResult | null>(null);
  const [calcProgress, setCalcProgress] = useState<{ completed: number; total: number; clientId?: string } | null>(null);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const sorted = useMemo(() => {
    let list = selectedMonth
      ? entries.filter(e => e.month === selectedMonth)
      : entries;
    if (!allClustersSelected && selectedClusters.length > 0) {
      list = list.filter(e =>
        parseClusters(e.clusters).some(cl => selectedClusters.includes(cl)),
      );
    }
    return [...list].sort(
      (a, b) => new Date(a.maintenanceDate).getTime() - new Date(b.maintenanceDate).getTime(),
    );
  }, [entries, selectedMonth, allClustersSelected, selectedClusters]);

  const analyzedCount = Object.keys(impactByEntry).length;

  function toggleCluster(cl: string) {
    setSelectedClusters(prev =>
      prev.includes(cl) ? prev.filter(c => c !== cl) : [...prev, cl],
    );
  }

  async function runImpact(entry: MaintenanceCalendarEntry) {
    if (!impactAllowed || analyzingEntryId || entry.status === 'CANCELLED') return;
    const params = buildEntryImpactParams(entry);
    if (!params) {
      setImpactError('Missing window times or cluster scope for this entry.');
      return;
    }

    setAnalyzingEntryId(entry.id);
    setImpactError(null);
    setCalcProgress(null);
    setLiveResult(null);
    setExpandedEntryId(entry.id);

    try {
      const result = await outageApi.calculateStream(params, (event) =>
        applyImpactStreamEvent(event, setLiveResult, setCalcProgress),
      );
      setImpactByEntry(prev => ({ ...prev, [entry.id]: result }));
      setLiveResult(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Impact analysis failed';
      setImpactError(msg);
    } finally {
      setAnalyzingEntryId(null);
      setCalcProgress(null);
      setLiveResult(null);
      setCancelling(false);
    }
  }

  async function handleCancel() {
    if (!analyzingEntryId) return;
    setCancelling(true);
    try {
      await outageApi.cancel();
    } catch {
      /* server may already be done */
    }
  }

  function exportEntryResult(entry: MaintenanceCalendarEntry) {
    const result = impactByEntry[entry.id];
    if (!result?.rows.length) return;
    const dateLabel = new Date(entry.maintenanceDate).toISOString().slice(0, 10);
    exportImpactCsv(result.rows, result.window.inputTimezone, dateLabel, {
      maintenanceDate: dateLabel,
      maintenanceGroup: entry.maintenanceGroup,
      clusters: entry.clusters,
    });
  }

  function exportAllResults() {
    const extraKeys = ['maintenanceDate', 'maintenanceGroup', 'clusters'];
    const header = [
      ...extraKeys,
      'clientId', 'cluster', 'jobName', 'cronExpression', 'serverTimezone',
      'fireTimesDisplay', 'fireTimesServer', 'fireTimesUtc', 'willRetryToday', 'command',
    ];
    const lines: string[] = [];
    for (const entry of sorted) {
      const result = impactByEntry[entry.id];
      if (!result?.rows.length) continue;
      const dateLabel = new Date(entry.maintenanceDate).toISOString().slice(0, 10);
      for (const r of result.rows) {
        const rowVals: Record<string, string | boolean> = {
          maintenanceDate: dateLabel,
          maintenanceGroup: entry.maintenanceGroup,
          clusters: entry.clusters,
          clientId: r.clientId,
          cluster: r.cluster,
          jobName: r.name,
          cronExpression: r.cronExpression,
          serverTimezone: r.serverTimezone,
          fireTimesDisplay: r.fireTimesDisplay.join('; '),
          fireTimesServer: r.fireTimesServer.join('; '),
          fireTimesUtc: r.fireTimesUtc.join('; '),
          willRetryToday: r.willRetryToday,
          command: r.command ?? '',
        };
        lines.push(header.map(h => `"${String(rowVals[h] ?? '').replace(/"/g, '""')}"`).join(','));
      }
    }
    if (lines.length === 0) return;
    const monthLabel = selectedMonth ? MONTHS[selectedMonth].toLowerCase() : 'all';
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maintenance-impact-${monthLabel}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (clusters.length === 0) {
    return (
      <div className="py-12 text-center text-gray-400 text-sm">
        No maintenance dates for this selection.
      </div>
    );
  }

  return (
    <div>
      {/* Cluster selector — filters the list; impact uses each row's own clusters */}
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={allClustersSelected}
              onChange={e => {
                setAllClustersSelected(e.target.checked);
                if (e.target.checked) setSelectedClusters([]);
              }}
              className="rounded"
            />
            All clusters
          </label>
          {!allClustersSelected && (
            <div className="flex flex-wrap gap-1.5">
              {clusters.map(cl => (
                <button
                  key={cl}
                  type="button"
                  onClick={() => toggleCluster(cl)}
                  className={`px-3 py-1 rounded-full text-sm font-semibold border transition-colors ${
                    selectedClusters.includes(cl)
                      ? 'bg-zebra-600 text-white border-zebra-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:border-zebra-400 hover:text-zebra-600'
                  }`}
                >
                  CL{cl}
                </button>
              ))}
            </div>
          )}
        </div>

        {canOutageImpact && selectedMonth === 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Select a specific month to run impacted jobs analysis. &quot;All Months&quot; is disabled to avoid performance issues.
          </p>
        )}

        {impactAllowed && (
          <p className="text-xs text-slate-500">
            Impact analysis uses each row&apos;s clusters (see Clusters column) and maintenance window times.
          </p>
        )}

        {analyzedCount > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportAllResults}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50"
            >
              <Download className="w-3.5 h-3.5" /> Export all analyzed ({analyzedCount})
            </button>
          </div>
        )}

        {impactError && !analyzingEntryId && (
          <p className="text-xs text-red-600 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> {impactError}
          </p>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">
          No maintenance dates for this cluster selection{selectedMonth ? ` in ${MONTHS[selectedMonth]}` : ''}.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm resizable-cols">
            <thead>
              <tr className="bg-slate-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Month</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Maintenance Date</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Clusters</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Window</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Status</th>
                {canOutageImpact && (
                  <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Impact</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(e => {
                const isAnalyzing = analyzingEntryId === e.id;
                const result = isAnalyzing && liveResult ? liveResult : impactByEntry[e.id];
                const isExpanded = expandedEntryId === e.id;
                const entryClusters = parseClusters(e.clusters);
                const canRun = impactAllowed
                  && !analyzingEntryId
                  && e.status !== 'CANCELLED'
                  && !!e.startLocal
                  && !!e.endLocal
                  && entryClusters.length > 0;
                const showResults = isExpanded && result && (result.rows.length > 0 || !isAnalyzing);
                const grouped = result?.rows.reduce<Record<string, OutageImpactJob[]>>((acc, j) => {
                  (acc[j.clientId] ??= []).push(j);
                  return acc;
                }, {}) ?? {};

                return (
                  <React.Fragment key={e.id}>
                    <tr className={`hover:bg-slate-50 ${e.status === 'CANCELLED' ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-2.5 text-slate-500">{MONTHS[e.month]}</td>
                      <td className="px-4 py-2.5 font-semibold text-slate-800">
                        {new Date(e.maintenanceDate).toLocaleDateString('en-US', {
                          weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
                        })}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 text-xs">
                        {parseClusters(e.clusters).map(cl => `CL${cl}`).join(', ')}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">
                        {formatEntryWindow(e)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={e.derivedStatus ?? e.status} />
                      </td>
                      {canOutageImpact && (
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={!canRun && !isAnalyzing}
                              onClick={() => runImpact(e)}
                              title={
                                selectedMonth === 0
                                  ? 'Select a specific month first'
                                  : analyzingEntryId && !isAnalyzing
                                  ? 'Another date is being analyzed'
                                  : entryClusters.length > 0
                                  ? `Analyze impact for CL${entryClusters.join(', CL')}`
                                  : undefined
                              }
                              className="flex items-center gap-1 px-2 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                            >
                              {isAnalyzing ? (
                                <>
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                  {calcProgress
                                    ? `${calcProgress.completed}/${calcProgress.total}`
                                    : '…'}
                                </>
                              ) : (
                                <>
                                  <Siren className="w-3 h-3" /> Analyze
                                </>
                              )}
                            </button>
                            {isAnalyzing && calcProgress && (
                              <button
                                type="button"
                                disabled={cancelling}
                                onClick={handleCancel}
                                className="flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
                              >
                                {cancelling ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                                Cancel
                              </button>
                            )}
                            {impactByEntry[e.id]?.rows.length ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setExpandedEntryId(isExpanded ? null : e.id)}
                                  className="px-2 py-1 text-xs text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50"
                                >
                                  {isExpanded ? 'Hide' : `${impactByEntry[e.id].summary.uniqueJobs} jobs`}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => exportEntryResult(e)}
                                  className="flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded-md hover:bg-slate-50"
                                >
                                  <Download className="w-3 h-3" />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      )}
                    </tr>
                    {showResults && (
                      <tr className="bg-slate-50/80">
                        <td colSpan={canOutageImpact ? 6 : 5} className="px-4 py-3">
                          {result!.rows.length === 0 ? (
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <CheckCircle2 className="w-4 h-4 text-green-500" />
                              No jobs impacted during this maintenance window.
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-xs text-slate-600">
                                <span className="font-semibold text-red-700">{result!.summary.uniqueJobs}</span> job
                                {result!.summary.uniqueJobs !== 1 ? 's' : ''} across{' '}
                                <span className="font-semibold">{result!.summary.uniqueClients}</span> client
                                {result!.summary.uniqueClients !== 1 ? 's' : ''}
                                {' · '}
                                {result!.window.startLocal} → {result!.window.endLocal}
                              </p>
                              {Object.entries(grouped).map(([cid, cJobs]) => (
                                <ImpactJobGroup
                                  key={cid}
                                  clientId={cid}
                                  jobs={cJobs}
                                  tz={result!.window.inputTimezone}
                                />
                              ))}
                            </div>
                          )}
                          {result!.cancelled && (
                            <p className="text-xs text-amber-700 mt-2">Analysis was cancelled — partial results shown.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- main component

export default function MaintenanceCalendarTab() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState<number>(0);
  const [displayMode, setDisplayMode] = useState<'grid' | 'list'>('grid');
  const [importOpen, setImportOpen] = useState(false);

  // Auto-expand import when a file is parsed or when there is nothing to view yet
  useEffect(() => {
    if (parseResult) setImportOpen(true);
  }, [parseResult]);

  // List calendars
  const { data: calData, isLoading } = useQuery({
    queryKey: ['maintenance-calendars'],
    queryFn: () => maintenanceCalendarApi.list(),
    staleTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const calendars: MaintenanceCalendar[] = calData?.data ?? [];

  // Auto-open current year's calendar (or first available) on load
  useEffect(() => {
    if (calendars.length > 0 && viewingId === null) {
      const currentYear = new Date().getFullYear();
      const match = calendars.find(c => c.year === currentYear) ?? calendars[0];
      setViewingId(match.id);
    }
  }, [calendars, viewingId]);

  // Entries for currently viewed calendar — always fetch all months
  const { data: entryData, isLoading: entriesLoading } = useQuery({
    queryKey: ['maintenance-calendar-entries', viewingId],
    queryFn: () => maintenanceCalendarApi.getEntries(viewingId!, {}),
    enabled: !!viewingId,
    staleTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const entries: MaintenanceCalendarEntry[] = entryData?.data ?? [];

  // Import mutation
  const importMut = useMutation({
    mutationFn: (payload: Parameters<typeof maintenanceCalendarApi.import>[0]) =>
      maintenanceCalendarApi.import(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-calendars'] });
      setParseResult(null);
      setImportOpen(false);
      if (fileRef.current) fileRef.current.value = '';
    },
  });

  // Delete mutation
  const deleteMut = useMutation({
    mutationFn: (id: string) => maintenanceCalendarApi.remove(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['maintenance-calendars'] });
      if (viewingId === id) setViewingId(null);
    },
  });

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseResult(null);
    try {
      const result = await parseCalendarXlsx(file);
      setParseResult(result);
    } catch (err: any) {
      setParseResult({
        year: 0, fileName: file.name, entries: [], preview: [],
        errors: [err.message],
      });
    } finally {
      setParsing(false);
    }
  }, []);

  const handleConfirmImport = () => {
    if (!parseResult || parseResult.entries.length === 0) return;
    const user = JSON.parse(sessionStorage.getItem('wfm_user') ?? '{}');
    importMut.mutate({
      year: parseResult.year,
      fileName: parseResult.fileName,
      importedBy: user.displayName || user.username,
      entries: parseResult.entries,
    });
  };

  const viewingCal = calendars.find(c => c.id === viewingId);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2 overflow-hidden">
      {/* Collapsible import — collapsed by default */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm shrink-0">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => setImportOpen(o => !o)}
            className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 hover:text-zebra-700 min-w-0"
          >
            {importOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
            <span className="truncate">Import yearly calendar</span>
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={parsing || importMut.isPending}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-zebra-600 hover:bg-zebra-700 text-white text-xs font-medium rounded-lg disabled:opacity-50 shrink-0"
          >
            <Upload className="w-3.5 h-3.5" />
            {parsing ? 'Parsing…' : 'Import'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {importOpen && (
          <div className="px-3 pb-3 border-t border-gray-100">
            <p className="text-xs text-gray-500 mt-2 mb-2">
              Import the annual NETOPS Excel file. Re-importing a year replaces existing data.
            </p>
            <div className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
              Sheet 1 "Maintenance Calendar":
              <span className="font-mono ml-1 text-gray-600">
                Maintenance Group · Clusters · Maint Window · Jan…Dec
              </span>
              &nbsp;· Sheet 2 "Maintenance by Customer":
              <span className="font-mono ml-1 text-gray-600">
                Window START · Window END
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Parse preview — only while confirming an import */}
      {parseResult && (
        <div className="bg-white rounded-xl border border-gray-200 p-3 shadow-sm shrink-0">
          <div className="flex items-center justify-between mb-2 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {parseResult.errors.length > 0 ? (
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
              )}
              <span className="font-semibold text-gray-900 text-sm truncate">
                {parseResult.year} — {parseResult.preview.length} groups, {parseResult.entries.length} dates
              </span>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => { setParseResult(null); if (fileRef.current) fileRef.current.value = ''; }}
                className="px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmImport}
                disabled={importMut.isPending || parseResult.entries.length === 0}
                className="flex items-center gap-1.5 px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-lg disabled:opacity-50"
              >
                {importMut.isPending ? (
                  <><RefreshCw className="w-3 h-3 animate-spin" /> Importing…</>
                ) : (
                  <><Upload className="w-3 h-3" /> Confirm</>
                )}
              </button>
            </div>
          </div>

          {parseResult.errors.length > 0 && (
            <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {parseResult.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {importMut.isError && (
            <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              Import failed: {(importMut.error as Error).message}
            </div>
          )}

          <PreviewTable preview={parseResult.preview} />
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-6 text-gray-400 text-sm">Loading…</div>
      ) : calendars.length === 0 && !parseResult ? (
        <div className="text-center py-6 text-gray-400 text-sm">
          No calendars yet. Use <strong>Import</strong> above to upload the yearly Excel file.
        </div>
      ) : viewingId && viewingCal ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 flex-wrap shrink-0">
            <Calendar className="w-4 h-4 text-zebra-600 shrink-0" />

            {calendars.length > 1 ? (
              <select
                value={viewingId}
                onChange={e => { setViewingId(e.target.value); setViewMonth(0); }}
                className="text-sm font-semibold text-gray-900 border border-gray-200 rounded px-2 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-zebra-300"
              >
                {calendars.map(c => (
                  <option key={c.id} value={c.id}>{c.year} Schedule</option>
                ))}
              </select>
            ) : (
              <span className="font-semibold text-gray-900 text-sm">{viewingCal.year} Schedule</span>
            )}

            <span className="text-xs text-gray-400 hidden sm:inline">
              {viewingCal.entryCount} entries · {viewingCal.fileName}
            </span>

            <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-auto">
              <button
                onClick={() => setDisplayMode('grid')}
                className={`px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  displayMode === 'grid' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                Calendar
              </button>
              <button
                onClick={() => setDisplayMode('list')}
                className={`px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  displayMode === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                List
              </button>
            </div>

            {displayMode === 'list' && (
              <select
                value={viewMonth}
                onChange={e => setViewMonth(Number(e.target.value))}
                className="text-xs border border-gray-200 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-zebra-300"
              >
                <option value={0}>All Months</option>
                {MONTHS.slice(1).map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
              </select>
            )}

            <button
              onClick={() => {
                if (confirm(`Delete ${viewingCal.year} maintenance calendar? This cannot be undone.`)) {
                  deleteMut.mutate(viewingCal.id);
                }
              }}
              className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg shrink-0"
              title="Delete calendar"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="p-3 flex-1 min-h-0 overflow-hidden">
            {entriesLoading ? (
              <div className="py-6 text-center text-gray-400 text-sm">Loading entries…</div>
            ) : displayMode === 'grid' ? (
              <CalendarGridView
                entries={entries}
                year={viewingCal.year}
              />
            ) : (
              <div className="overflow-auto max-h-full">
                <EntryTable entries={entries} selectedMonth={viewMonth} />
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
