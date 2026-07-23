// ============================================================
// MaintenanceCalendarTab.tsx
// Import & browse yearly maintenance calendars from the NETOPS Excel file.
// Sheet 1 ("Maintenance Calendar") — one row per maintenance group.
// Sheet 2 ("Maintenance by Customer") — one row per customer (used for
//   clean start/end times and cluster codes).
// ============================================================

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Upload, Calendar, Trash2, ChevronDown, ChevronRight, ChevronLeft,
  Clock, AlertTriangle, RefreshCw, CheckCircle2,
} from 'lucide-react';
import { maintenanceCalendarApi } from '../../services/api';
import type { MaintenanceCalendar, MaintenanceCalendarEntry, CalendarImportEntry } from '../../types';
import { useTimezone } from '../../hooks/useTimezone';

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
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="font-semibold text-slate-800">{MONTHS[gridMonth]} {year}</span>
        <button onClick={nextMonth} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 border-l border-t border-slate-200">
        {DAY_NAMES.map(d => (
          <div key={d} className="text-center text-[11px] font-semibold text-slate-400 py-1.5 border-r border-b border-slate-200 bg-slate-50">{d}</div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={`p${idx}`} className="border-r border-b border-slate-200 min-h-[3.5rem]" />;
          const dayEntries = byDay[day] ?? [];
          const isToday = today.getFullYear() === year && today.getMonth() + 1 === gridMonth && today.getDate() === day;
          const isSelected = selectedDay === day;
          const hasMaint = dayEntries.length > 0;
          const isCancelled = hasMaint && dayEntries.every(e => e.status === 'CANCELLED');

          return (
            <button
              key={day}
              onClick={() => hasMaint ? setSelectedDay(isSelected ? null : day) : undefined}
              className={`p-1.5 flex flex-col items-center min-h-[3.5rem] transition-colors border-r border-b border-slate-200 ${
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

      {/* Selected day detail */}
      {selectedDay && selectedEntries.length > 0 && (
        <div className="mt-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <p className="text-sm font-semibold text-slate-700 mb-3">
            {MONTHS[gridMonth]} {selectedDay}, {year}
          </p>
          <div className="space-y-2">
            {selectedEntries.map(e => (
              <div key={e.id} className="flex items-start gap-3 text-sm">
                <div className="flex flex-wrap gap-1 flex-shrink-0 mt-0.5">
                  {parseClustersGrid(e.clusters).map(cl => (
                    <span key={cl} className="text-[11px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700">
                      CL {cl}
                    </span>
                  ))}
                </div>
                <div>
                  <span className="text-slate-700">
                    {e.windowStartTime
                      ? calTimeToIST(e.maintenanceDate, e.windowStartTime, e.windowEndTime, e.timezone)
                      : e.maintenanceWindow.slice(0, 80)}
                  </span>
                  {e.status === 'CANCELLED' && (
                    <span className="ml-2 text-xs text-red-500 font-medium">Cancelled</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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

  return (
    <div className="space-y-1 max-h-80 overflow-auto text-xs">
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

function CalendarCard({
  cal,
  onDelete,
  onView,
  isViewing,
}: {
  cal: MaintenanceCalendar;
  onDelete: (id: string) => void;
  onView: (id: string) => void;
  isViewing: boolean;
}) {
  const { fmt } = useTimezone();
  return (
    <div className={`border rounded-xl p-4 ${isViewing ? 'border-zebra-400 bg-zebra-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Calendar className="w-5 h-5 text-zebra-600 flex-shrink-0" />
          <div>
            <div className="font-semibold text-gray-900">{cal.year} Maintenance Calendar</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {cal.fileName} &middot; {cal.entryCount} entries
            </div>
            <div className="text-xs text-gray-400">
              Imported {fmt(cal.importedAt)}
              {cal.importedBy ? ` by ${cal.importedBy}` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onView(cal.id)}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium ${
              isViewing
                ? 'bg-zebra-600 text-white'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            }`}
          >
            {isViewing ? 'Viewing' : 'View'}
          </button>
          <button
            onClick={() => onDelete(cal.id)}
            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
            title="Delete calendar"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Parse "19 & 26" or "CL19 & CL26" → ["19", "26"] */
function parseClusters(raw: string): string[] {
  return raw.split(/[&,/]/).map(s => s.trim().replace(/^CL\s*/i, '')).filter(Boolean);
}

function EntryTable({
  entries,
  selectedMonth,
}: {
  entries: MaintenanceCalendarEntry[];
  selectedMonth: number;
}) {
  // Build cluster → entries map (an entry appears under each of its clusters)
  const clusterMap: Record<string, MaintenanceCalendarEntry[]> = {};
  for (const e of entries) {
    for (const cl of parseClusters(e.clusters)) {
      if (!clusterMap[cl]) clusterMap[cl] = [];
      clusterMap[cl].push(e);
    }
  }

  // Sort clusters numerically where possible
  const clusters = Object.keys(clusterMap).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  const [selectedCluster, setSelectedCluster] = useState<string>('');
  const activeCluster = selectedCluster || clusters[0] || '';

  const clusterEntries = clusterMap[activeCluster] ?? [];
  const filtered = selectedMonth
    ? clusterEntries.filter(e => e.month === selectedMonth)
    : clusterEntries;
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.maintenanceDate).getTime() - new Date(b.maintenanceDate).getTime()
  );

  if (clusters.length === 0) {
    return (
      <div className="py-12 text-center text-gray-400 text-sm">
        No maintenance dates for this selection.
      </div>
    );
  }

  return (
    <div>
      {/* Cluster selector pills */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {clusters.map(cl => (
          <button
            key={cl}
            onClick={() => setSelectedCluster(cl)}
            className={`px-3 py-1 rounded-full text-sm font-semibold border transition-colors ${
              activeCluster === cl
                ? 'bg-zebra-600 text-white border-zebra-600'
                : 'bg-white text-slate-600 border-slate-300 hover:border-zebra-400 hover:text-zebra-600'
            }`}
          >
            CL{cl}
            <span className="ml-1.5 text-xs font-normal opacity-75">
              ({clusterMap[cl].length})
            </span>
          </button>
        ))}
      </div>

      {/* Maintenance dates for selected cluster */}
      {sorted.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">
          No maintenance dates for Cluster {activeCluster} in this period.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm resizable-cols">
            <thead>
              <tr className="bg-slate-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Month</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Maintenance Date</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Window</th>
                <th className="text-left px-4 py-2.5 font-semibold text-slate-500 text-xs uppercase tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(e => (
                <tr key={e.id} className={`hover:bg-slate-50 ${e.status === 'CANCELLED' ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2.5 text-slate-500">{MONTHS[e.month]}</td>
                  <td className="px-4 py-2.5 font-semibold text-slate-800">
                    {new Date(e.maintenanceDate).toLocaleDateString('en-US', {
                      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
                    })}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs">
                    {e.windowStartTime
                      ? calTimeToIST(e.maintenanceDate, e.windowStartTime, e.windowEndTime, e.timezone)
                      : e.maintenanceWindow.slice(0, 60)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={e.status} />
                  </td>
                </tr>
              ))}
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
  const { fmt } = useTimezone();

  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState<number>(0);
  const [displayMode, setDisplayMode] = useState<'grid' | 'list'>('grid');

  // List calendars
  const { data: calData, isLoading } = useQuery({
    queryKey: ['maintenance-calendars'],
    queryFn: () => maintenanceCalendarApi.list(),
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
  });
  const entries: MaintenanceCalendarEntry[] = entryData?.data ?? [];

  // Import mutation
  const importMut = useMutation({
    mutationFn: (payload: Parameters<typeof maintenanceCalendarApi.import>[0]) =>
      maintenanceCalendarApi.import(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-calendars'] });
      setParseResult(null);
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
    const user = JSON.parse(localStorage.getItem('wfm_user') ?? '{}');
    importMut.mutate({
      year: parseResult.year,
      fileName: parseResult.fileName,
      importedBy: user.displayName || user.username,
      entries: parseResult.entries,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header + upload */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Yearly Maintenance Calendars</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Import the annual NETOPS Excel file. Re-importing a year replaces existing data.
            </p>
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={parsing || importMut.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-zebra-600 hover:bg-zebra-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {parsing ? 'Parsing…' : 'Import Calendar'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Column hints */}
        <div className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
          Expected columns — Sheet 1 "Maintenance Calendar":
          <span className="font-mono ml-1 text-gray-600">
            Maintenance Group · Clusters · Maint Window · January 2026 … December 2026
          </span>
          &nbsp;&nbsp; Sheet 2 "Maintenance by Customer":
          <span className="font-mono ml-1 text-gray-600">
            Maintenance Window START · Maintenance Window END
          </span>
        </div>
      </div>

      {/* Parse preview panel */}
      {parseResult && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {parseResult.errors.length > 0 ? (
                <AlertTriangle className="w-4 h-4 text-amber-500" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              )}
              <span className="font-semibold text-gray-900">
                {parseResult.year} — {parseResult.preview.length} groups, {parseResult.entries.length} date entries
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setParseResult(null); if (fileRef.current) fileRef.current.value = ''; }}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmImport}
                disabled={importMut.isPending || parseResult.entries.length === 0}
                className="flex items-center gap-2 px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                {importMut.isPending ? (
                  <><RefreshCw className="w-3 h-3 animate-spin" /> Importing…</>
                ) : (
                  <><Upload className="w-3 h-3" /> Confirm Import</>
                )}
              </button>
            </div>
          </div>

          {parseResult.errors.length > 0 && (
            <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {parseResult.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {importMut.isError && (
            <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              Import failed: {(importMut.error as Error).message}
            </div>
          )}

          <PreviewTable preview={parseResult.preview} />
        </div>
      )}

      {/* Existing calendars */}
      {isLoading ? (
        <div className="text-center py-8 text-gray-400 text-sm">Loading…</div>
      ) : calendars.length === 0 ? (
        <div className="text-center py-8 text-gray-400 text-sm">
          No calendars imported yet. Use the Import button above.
        </div>
      ) : (
        <div className="space-y-3">
          {calendars.map(cal => (
            <CalendarCard
              key={cal.id}
              cal={cal}
              isViewing={viewingId === cal.id}
              onView={id => { setViewingId(viewingId === id ? null : id); setViewMonth(0); }}
              onDelete={id => {
                if (confirm(`Delete ${cal.year} maintenance calendar? This cannot be undone.`)) {
                  deleteMut.mutate(id);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Entry viewer */}
      {viewingId && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-3 flex-wrap">
            <Calendar className="w-4 h-4 text-zebra-600" />
            <span className="font-semibold text-gray-900 text-sm">
              {calendars.find(c => c.id === viewingId)?.year} Schedule
            </span>

            {/* View mode toggle */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2">
              <button
                onClick={() => setDisplayMode('grid')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  displayMode === 'grid' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                Calendar
              </button>
              <button
                onClick={() => setDisplayMode('list')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  displayMode === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                List
              </button>
            </div>

            {/* Month filter — list mode only */}
            {displayMode === 'list' && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-gray-500">Filter by month:</span>
                <select
                  value={viewMonth}
                  onChange={e => setViewMonth(Number(e.target.value))}
                  className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-zebra-300"
                >
                  <option value={0}>All Months</option>
                  {MONTHS.slice(1).map((m, i) => (
                    <option key={i + 1} value={i + 1}>{m}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="p-4">
            {entriesLoading ? (
              <div className="py-8 text-center text-gray-400 text-sm">Loading entries…</div>
            ) : displayMode === 'grid' ? (
              <CalendarGridView
                entries={entries}
                year={calendars.find(c => c.id === viewingId)?.year ?? new Date().getFullYear()}
              />
            ) : (
              <EntryTable entries={entries} selectedMonth={viewMonth} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
