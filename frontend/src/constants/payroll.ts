export const FREQUENCY_ORDER = ['WK', 'BW', 'SM', 'GM'] as const;

export const FREQUENCY_LABELS: Record<string, { label: string; color: string }> = {
  WK: { label: 'Weekly', color: 'bg-blue-500' },
  BW: { label: 'Bi-Weekly', color: 'bg-indigo-500' },
  SM: { label: 'Semi-Monthly', color: 'bg-purple-500' },
  GM: { label: 'Gregorian Month', color: 'bg-teal-500' },
};

export function normalizeFrequency(raw: string | null | undefined): string {
  const u = (raw || '').trim().toUpperCase();
  if (!u) return '';
  if (u === 'WK' || u === 'WEEKLY') return 'WK';
  if (u === 'BW' || u === 'BI-WEEKLY' || u === 'BIWEEKLY') return 'BW';
  if (u === 'SM' || u === 'SEMI-MONTHLY' || u === 'SEMIMONTHLY') return 'SM';
  if (u === 'GM' || u === 'MONTHLY' || u === 'QUARTERLY' || u === 'GREGORIAN MONTH') return 'GM';
  return u;
}

export function parseFrequencies(raw: string | null | undefined, list?: string[]): string[] {
  const source = list && list.length ? list.join(',') : raw;
  const parts = (source || '')
    .split(/[,|;/\s]+/)
    .map(p => normalizeFrequency(p))
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const ordered = FREQUENCY_ORDER.filter(k => unique.includes(k));
  const extra = unique.filter(k => !(FREQUENCY_ORDER as readonly string[]).includes(k));
  return ordered.length || extra.length ? [...ordered, ...extra] : ['WK'];
}

/** JS weekday: 0 = Sunday … 6 = Saturday. Display order is Monday-first. */
export const PAY_DEADLINE_WEEKDAYS: Array<{ dow: number; label: string }> = [
  { dow: 1, label: 'Mon' },
  { dow: 2, label: 'Tue' },
  { dow: 3, label: 'Wed' },
  { dow: 4, label: 'Thu' },
  { dow: 5, label: 'Fri' },
  { dow: 6, label: 'Sat' },
  { dow: 0, label: 'Sun' },
];

/** Bi-weekly: days after period (week) end. */
export const PAY_DEADLINE_DAYS_AFTER_OPTIONS = Array.from({ length: 15 }, (_, i) => i);

/** Semi-monthly / monthly: calendar day of month (1–28). */
export const PAY_DEADLINE_DAY_OF_MONTH_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1);

export function payrollDeadlinePickerKind(
  frequency: string | null | undefined,
): 'weekday' | 'daysAfter' | 'dayOfMonth' {
  const code = normalizeFrequency(frequency);
  if (code === 'SM' || code === 'GM') return 'dayOfMonth';
  if (code === 'BW') return 'daysAfter';
  return 'weekday';
}

export function ordinalDay(n: number): string {
  const v = Math.floor(n);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  switch (v % 10) {
    case 1: return `${v}st`;
    case 2: return `${v}nd`;
    case 3: return `${v}rd`;
    default: return `${v}th`;
  }
}

/** Short badge / summary label for a stored SLA deadline. */
export function formatDeadlineBadge(input: {
  frequency?: string | null;
  daysAfterWeekEnd?: number | null;
  dayOfMonth?: number | null;
  localTime?: string | null;
  weekEndYmd?: string;
}): string {
  const time = (input.localTime || '').trim();
  if (!time) return '';
  if (input.dayOfMonth != null) {
    return `${ordinalDay(input.dayOfMonth)} @ ${time}`;
  }
  if (input.daysAfterWeekEnd == null) return time;
  const kind = payrollDeadlinePickerKind(input.frequency);
  if (kind === 'daysAfter') {
    const d = input.daysAfterWeekEnd;
    return d === 0 ? `Period end @ ${time}` : `+${d}d @ ${time}`;
  }
  const dow = input.weekEndYmd
    ? weekdayFromDaysAfter(input.weekEndYmd, input.daysAfterWeekEnd)
    : null;
  const label = weekdayShortLabel(dow);
  return label ? `${label} ${time}` : time;
}

export function ymdWeekday(ymd: string): number | null {
  const s = toYyyymmdd(ymd);
  if (!/^\d{8}$/.test(s)) return null;
  const d = new Date(Date.UTC(
    parseInt(s.slice(0, 4), 10),
    parseInt(s.slice(4, 6), 10) - 1,
    parseInt(s.slice(6, 8), 10),
    12,
  ));
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

/** Days after week end (0–6) so the deadline lands on targetDow. */
export function daysAfterWeekEndForWeekday(weekEndYmd: string, targetDow: number): number | null {
  const endDow = ymdWeekday(weekEndYmd);
  if (endDow == null || targetDow < 0 || targetDow > 6) return null;
  return (targetDow - endDow + 7) % 7;
}

export function weekdayFromDaysAfter(weekEndYmd: string, days: number): number | null {
  const endDow = ymdWeekday(weekEndYmd);
  if (endDow == null || !Number.isFinite(days)) return null;
  return (endDow + (((days % 7) + 7) % 7)) % 7;
}

export function weekdayShortLabel(dow: number | null | undefined): string {
  return PAY_DEADLINE_WEEKDAYS.find(d => d.dow === dow)?.label || '';
}

export function formatYyyymmdd(ymd: string): string {
  const s = toYyyymmdd(ymd);
  if (!/^\d{8}$/.test(s)) return ymd || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[parseInt(s.slice(4, 6), 10) - 1] || s.slice(4, 6);
  return `${s.slice(6, 8)} ${month} ${s.slice(0, 4)}`;
}

function toYyyymmdd(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

export function fileGenLabel(value: string | null | undefined): string {
  const u = (value || '').trim().toUpperCase();
  if (u === 'SINGLE_STORE' || u === 'SINGLE' || u === 'S') return 'Single store';
  if (u === 'ALL_STORE' || u === 'ALL' || u === 'A') return 'All stores';
  return u || '—';
}

export function isAllStoreFileGen(value: string | null | undefined): boolean {
  const u = (value || '').trim().toUpperCase();
  return u === 'ALL_STORE' || u === 'ALL' || u === 'A';
}
