// ============================================================
// Payroll — job names, frequency codes, generated-file status
// ============================================================

import cronParser from 'cron-parser';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezonePlugin from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

export const REGULAR_PAY_JOBS = [
  'RTANewPayFileGeneratorJob',
  'RTAPayrollFeedGeneratorJob',
  'RTA_PAYROLL_FILE_GEN',
] as const;

/**
 * Either-or preference when a client exposes more than one regular pay generator.
 * Feed (client-wide) wins over NewPay (store-group) over legacy file-gen.
 */
export const REGULAR_PAY_JOB_PRIORITY = [
  'RTAPayrollFeedGeneratorJob',
  'RTANewPayFileGeneratorJob',
  'RTA_PAYROLL_FILE_GEN',
] as const;

/** Sentinel when the chosen generator has no STD_QUEUE_JOB.PARAM_3 store group. */
export const CLIENT_WIDE_DIST_LIST_ID = 'ALL';

export const ADJ_PAY_JOB = 'RTAPriorAdjPayGeneratorJob';

/** TA_UNIT_PAY_STATUS.FILE_STATUS = F means the pay file was generated. */
export const PAY_FILE_GENERATED_STATUS = 'F';

/** Monitor UI buckets for FILE_STATUS (other/blank → blank/grey). */
export type PayrollFileStatusBucket = 'F' | 'D' | 'Q' | 'blank';

export interface PayrollFileStatusCounts {
  F: number;
  D: number;
  Q: number;
  blank: number;
}

export const EMPTY_FILE_STATUS_COUNTS: PayrollFileStatusCounts = {
  F: 0,
  D: 0,
  Q: 0,
  blank: 0,
};

export function fileStatusBucket(raw: string | null | undefined): PayrollFileStatusBucket {
  const s = (raw || '').trim().toUpperCase();
  if (s === 'F' || s === 'D' || s === 'Q') return s;
  return 'blank';
}

export function countFileStatuses(
  statuses: Array<string | null | undefined>,
): PayrollFileStatusCounts {
  const counts: PayrollFileStatusCounts = { ...EMPTY_FILE_STATUS_COUNTS };
  for (const raw of statuses) {
    counts[fileStatusBucket(raw)] += 1;
  }
  return counts;
}

export const PAYROLL_FEATURE_IDS = [
  'RTA_INTEGRATION',
  'PRIOR_PERIOD_EDIT',
  'PRIOR_PERIOD_EDIT_LIMIT',
  'PAYROLL_FILE_GEN',
] as const;

export const FREQUENCY_ORDER = ['WK', 'BW', 'SM', 'GM'] as const;

export const FREQUENCY_LABELS: Record<string, string> = {
  WK: 'Weekly',
  BW: 'Bi-Weekly',
  SM: 'Semi-Monthly',
  GM: 'Gregorian Month',
};

export function normalizeFrequency(raw: string | null | undefined): string {
  const u = (raw || '').trim().toUpperCase();
  if (!u) return '';
  if (u === 'WK' || u === 'WEEKLY') return 'WK';
  if (u === 'BW' || u === 'BI-WEEKLY' || u === 'BIWEEKLY' || u === 'BI_WEEKLY') return 'BW';
  if (u === 'SM' || u === 'SEMI-MONTHLY' || u === 'SEMIMONTHLY' || u === 'SEMI_MONTHLY') return 'SM';
  if (u === 'GM' || u === 'MONTHLY' || u === 'GREGORIAN MONTH' || u === 'GREGORIAN_MONTH' || u === 'QUARTERLY') return 'GM';
  return u;
}

export function matchPayJob(value: string, jobName: string): boolean {
  return (value || '').toUpperCase().includes(jobName.toUpperCase());
}

export function payJobKind(jobType: string | null | undefined): 'regular' | 'adjustment' | null {
  const blob = jobType || '';
  if (!blob) return null;
  if (matchPayJob(blob, ADJ_PAY_JOB)) return 'adjustment';
  for (const name of REGULAR_PAY_JOBS) {
    if (matchPayJob(blob, name)) return 'regular';
  }
  return null;
}

/** Lower rank = preferred either-or choice among regular pay generators. */
export function regularPayJobRank(jobType: string | null | undefined): number {
  const blob = jobType || '';
  for (let i = 0; i < REGULAR_PAY_JOB_PRIORITY.length; i++) {
    if (matchPayJob(blob, REGULAR_PAY_JOB_PRIORITY[i])) return i;
  }
  return REGULAR_PAY_JOB_PRIORITY.length;
}

export function isClientWideDistList(distListId: string | null | undefined): boolean {
  return (distListId || '').trim().toUpperCase() === CLIENT_WIDE_DIST_LIST_ID;
}

export function sanitizeWeekEnd(raw: string | undefined): string | null {
  const ymd = toYyyymmdd(raw || '');
  return /^\d{8}$/.test(ymd) ? ymd : null;
}

/**
 * Normalize DB2 CHAR(yyyyMMdd), ISO date, or timestamp
 * (e.g. 2024-02-04-00.00.00.000000) to yyyyMMdd.
 */
export function toYyyymmdd(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

export function parseFrequencies(raw: string | null | undefined): string[] {
  const parts = (raw || '')
    .split(/[,|;/\s]+/)
    .map(p => normalizeFrequency(p))
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const ordered = FREQUENCY_ORDER.filter(k => unique.includes(k));
  const extra = unique.filter(k => !(FREQUENCY_ORDER as readonly string[]).includes(k));
  return ordered.length || extra.length ? [...ordered, ...extra] : ['WK'];
}

export function serializeFrequencies(codes: string[]): string {
  return parseFrequencies(codes.join(',')).join(',');
}

export function sanitizeFrequency(raw: string | undefined): string | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const code = normalizeFrequency(t);
  return (FREQUENCY_ORDER as readonly string[]).includes(code) ? code : null;
}

export function yyyymmddToIso(ymd: string): string {
  const n = toYyyymmdd(ymd);
  if (n.length !== 8) return '';
  return `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}`;
}

/** Default the pay-week dropdown to the completed week before the current one. */
export function defaultPayWeekEnd(
  periods: Array<{ weekEndDate: string; isCurrent?: boolean }>,
): string {
  const sorted = periods
    .map(p => p.weekEndDate)
    .filter(d => /^\d{8}$/.test(d))
    .sort();
  const unique = [...new Set(sorted)];
  const current = periods.find(p => p.isCurrent)?.weekEndDate;
  const currentIdx = current ? unique.indexOf(current) : -1;
  if (currentIdx > 0) return unique[currentIdx - 1];
  if (unique.length >= 2) return unique[unique.length - 2];
  return unique[unique.length - 1] || '';
}

/**
 * Week end immediately before `weekEndDate` in the calendar period list.
 * Used to compare FILE_STATUS=F store counts vs the week in question.
 */
export function priorPayWeekEnd(
  periods: Array<{ weekEndDate: string }>,
  weekEndDate: string,
): string {
  const target = toYyyymmdd(weekEndDate);
  if (!/^\d{8}$/.test(target)) return '';
  const unique = [...new Set(
    periods.map(p => toYyyymmdd(p.weekEndDate)).filter(d => /^\d{8}$/.test(d)),
  )].sort();
  const idx = unique.indexOf(target);
  if (idx > 0) return unique[idx - 1];
  return '';
}

export interface CalendarPeriodLike {
  weekStartDate: string;
  weekEndDate: string;
  weekNo?: string;
  year?: string;
  isCurrent?: boolean;
  isPrevious?: boolean;
}

function sortedCalendarWeeks<T extends CalendarPeriodLike>(periods: T[]): T[] {
  return [...periods]
    .filter(p => /^\d{8}$/.test(toYyyymmdd(p.weekEndDate)))
    .sort((a, b) => toYyyymmdd(a.weekEndDate).localeCompare(toYyyymmdd(b.weekEndDate)));
}

function lastDayOfMonthYmd(yearMonth: string): string {
  if (!/^\d{6}$/.test(yearMonth)) return '';
  const iso = `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}-01`;
  const end = dayjs(iso).endOf('month');
  return end.isValid() ? end.format('YYYYMMDD') : '';
}

function periodIsCurrent(
  start: string,
  end: string,
  todayYmd: string,
  members: Array<{ isCurrent?: boolean }>,
): boolean {
  if (todayYmd && start && end) return start <= todayYmd && todayYmd <= end;
  return members.some(m => !!m.isCurrent);
}

/** Pair consecutive RWS_CALENDAR weeks into 14-day bi-weekly periods. */
function periodsForBiWeekly<T extends CalendarPeriodLike>(
  periods: T[],
  todayYmd: string,
): T[] {
  const sorted = sortedCalendarWeeks(periods);
  const out: T[] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const first = sorted[i];
    const second = sorted[i + 1];
    if (!second) {
      out.push({ ...first, isPrevious: false });
      continue;
    }
    const weekStartDate = toYyyymmdd(first.weekStartDate);
    const weekEndDate = toYyyymmdd(second.weekEndDate);
    out.push({
      ...second,
      weekStartDate,
      weekEndDate,
      year: weekStartDate.slice(0, 4) || second.year,
      isCurrent: periodIsCurrent(weekStartDate, weekEndDate, todayYmd, [first, second]),
      isPrevious: false,
    });
  }
  return out;
}

/**
 * Group weeks into Gregorian calendar months.
 * Display span is the 1st–last day of the month; query via calendarWeekEndOnOrBefore.
 */
function periodsForGregorianMonth<T extends CalendarPeriodLike>(
  periods: T[],
  todayYmd: string,
): T[] {
  const sorted = sortedCalendarWeeks(periods);
  const byMonth = new Map<string, T[]>();
  for (const week of sorted) {
    const end = toYyyymmdd(week.weekEndDate);
    const ym = end.slice(0, 6);
    if (!/^\d{6}$/.test(ym)) continue;
    const list = byMonth.get(ym) || [];
    list.push(week);
    byMonth.set(ym, list);
  }
  return [...byMonth.keys()].sort().map(ym => {
    const members = byMonth.get(ym)!;
    const last = members[members.length - 1];
    const weekStartDate = `${ym}01`;
    const weekEndDate = lastDayOfMonthYmd(ym);
    return {
      ...last,
      weekStartDate,
      weekEndDate,
      year: ym.slice(0, 4),
      isCurrent: periodIsCurrent(weekStartDate, weekEndDate, todayYmd, members),
      isPrevious: false,
    };
  });
}

/**
 * Group weeks into semi-monthly halves: 1–15 and 16–EOM.
 * Display span uses calendar half bounds; query via calendarWeekEndOnOrBefore.
 */
function periodsForSemiMonthly<T extends CalendarPeriodLike>(
  periods: T[],
  todayYmd: string,
): T[] {
  const sorted = sortedCalendarWeeks(periods);
  type HalfKey = string;
  const byHalf = new Map<HalfKey, T[]>();
  for (const week of sorted) {
    const end = toYyyymmdd(week.weekEndDate);
    const ym = end.slice(0, 6);
    const day = parseInt(end.slice(6, 8), 10);
    if (!/^\d{6}$/.test(ym) || !Number.isFinite(day)) continue;
    const half = day <= 15 ? '1' : '2';
    const key = `${ym}-${half}`;
    const list = byHalf.get(key) || [];
    list.push(week);
    byHalf.set(key, list);
  }
  return [...byHalf.keys()].sort().map(key => {
    const members = byHalf.get(key)!;
    const last = members[members.length - 1];
    const [ym, half] = key.split('-');
    const weekStartDate = half === '1' ? `${ym}01` : `${ym}16`;
    const weekEndDate = half === '1' ? `${ym}15` : lastDayOfMonthYmd(ym);
    return {
      ...last,
      weekStartDate,
      weekEndDate,
      year: ym.slice(0, 4),
      isCurrent: periodIsCurrent(weekStartDate, weekEndDate, todayYmd, members),
      isPrevious: false,
    };
  });
}

/**
 * Shape pay-period options for the selected frequency (Payroll Jobs).
 * BW → paired 14-day weeks; SM → 1–15 / 16–EOM; GM → calendar months; WK → passthrough.
 */
export function periodsForFrequency<T extends CalendarPeriodLike>(
  periods: T[],
  frequency: string | null | undefined,
  todayYmd?: string,
): T[] {
  const code = normalizeFrequency(frequency);
  const today = todayYmd && /^\d{8}$/.test(todayYmd) ? todayYmd : '';
  if (code === 'BW') return periodsForBiWeekly(periods, today);
  if (code === 'GM') return periodsForGregorianMonth(periods, today);
  if (code === 'SM') return periodsForSemiMonthly(periods, today);
  return periods;
}

/** Map a requested week-end into a period list (exact match, or containing range). */
export function resolveWeekEndInPeriods(
  periods: Array<{ weekStartDate: string; weekEndDate: string }>,
  weekEndDate: string | null | undefined,
): string {
  const target = toYyyymmdd(weekEndDate || '');
  if (!/^\d{8}$/.test(target)) return '';
  if (periods.some(p => toYyyymmdd(p.weekEndDate) === target)) return target;
  const containing = periods.find(p => {
    const start = toYyyymmdd(p.weekStartDate);
    const end = toYyyymmdd(p.weekEndDate);
    return !!start && !!end && start <= target && target <= end;
  });
  return containing ? toYyyymmdd(containing.weekEndDate) : '';
}

/**
 * Last RWS_CALENDAR week-end on or before a period end (for SM/GM status queries).
 * Exact calendar week-ends pass through unchanged.
 */
export function calendarWeekEndOnOrBefore(
  calendarWeeks: Array<{ weekEndDate: string }>,
  periodEndYmd: string | null | undefined,
): string {
  const target = toYyyymmdd(periodEndYmd || '');
  if (!/^\d{8}$/.test(target)) return '';
  const ends = [...new Set(
    calendarWeeks.map(p => toYyyymmdd(p.weekEndDate)).filter(d => /^\d{8}$/.test(d)),
  )].sort();
  if (ends.includes(target)) return target;
  for (let i = ends.length - 1; i >= 0; i--) {
    if (ends[i] <= target) return ends[i];
  }
  return '';
}

/** Whether status/adj queries should map period ends onto RWS calendar week-ends. */
export function frequencyUsesCalendarWeekEndQuery(
  frequency: string | null | undefined,
): boolean {
  const code = normalizeFrequency(frequency);
  return code === 'SM' || code === 'GM';
}

/**
 * WFM BIGINT times like CREATION_TIME are yyyyMMddHHmmss (not epoch millis).
 * Returns a space-separated timestamp fmtDb2 can parse.
 */
export function rfxCompactDateTime(raw: string | null | undefined): string {
  const s = (raw || '').replace(/\D/g, '');
  if (s.length < 14) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

/** RWS_CALENDAR is one row per calendar day; week dates are TIMESTAMP. */
export function calendarPeriodsSql(): string {
  return (
    `SELECT DISTINCT VARCHAR_FORMAT(WEEK_START_DATE, 'yyyyMMdd') AS WEEK_START_DATE, ` +
    `VARCHAR_FORMAT(WEEK_END_DATE, 'yyyyMMdd') AS WEEK_END_DATE, ` +
    `VARCHAR_FORMAT(CURRENT DATE, 'yyyyMMdd') AS TODAY_YMD ` +
    `FROM RWSUSER.RWS_CALENDAR ` +
    `WHERE YEAR_NO = YEAR(CURRENT DATE) ` +
    `OR YEAR(WEEK_END_DATE) = YEAR(CURRENT DATE) ` +
    `ORDER BY 1`
  );
}

/** TA_* pay week columns are INTEGER yyyyMMdd (same pattern as PUNCH_DATE). */
export function weekEndEqualsSql(column: string, ymd: string): string {
  const safe = sanitizeWeekEnd(ymd);
  if (!safe) throw new Error(`Invalid week-end date: ${ymd}`);
  return `INTEGER(${column}) = ${safe}`;
}

export function sanitizeDistListId(raw: string | null | undefined): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.toUpperCase() === CLIENT_WIDE_DIST_LIST_ID) return CLIENT_WIDE_DIST_LIST_ID;
  if (!/^\d+$/.test(s)) return null;
  return s;
}

export function distListEqualsSql(distListId: string, column = 'DIST_LIST_ID'): string {
  const safe = sanitizeDistListId(distListId);
  if (!safe) throw new Error(`Invalid DIST_LIST_ID: ${distListId}`);
  return `INTEGER(${column}) = ${safe}`;
}

/** Pay-week end must fall within RWS_DIST_STORE_MAP effective range (yyyyMMdd). */
export function storeMapEffectiveSql(payWeekEndYmd: string, prefix = ''): string {
  const safe = sanitizeWeekEnd(payWeekEndYmd);
  if (!safe) throw new Error(`Invalid pay week end: ${payWeekEndYmd}`);
  const eff = prefix ? `${prefix}EFF_DATESKEY` : 'EFF_DATESKEY';
  const end = prefix ? `${prefix}END_DATESKEY` : 'END_DATESKEY';
  return `INTEGER(${eff}) <= ${safe} AND INTEGER(${end}) >= ${safe}`;
}

export function storeMapUnitScopeSql(distListId: string, payWeekEndYmd: string, unitColumn: string): string {
  return (
    `EXISTS (SELECT 1 FROM RWSUSER.RWS_DIST_STORE_MAP m ` +
    `WHERE m.UNIT_ID = ${unitColumn} ` +
    `AND ${distListEqualsSql(distListId, 'm.DIST_LIST_ID')} ` +
    `AND ${storeMapEffectiveSql(payWeekEndYmd, 'm.')})`
  );
}

export type PayScheduleKind = 'cron' | 'interval' | 'unknown';

/** RFX_QUEUE schedule: EXEC_CRON when set, otherwise QUEUE_SLEEP seconds. */
export function resolveQueueSchedule(
  execCron: string | null | undefined,
  queueSleep: string | null | undefined,
): string {
  const cron = (execCron || '').trim();
  if (cron) return cron;
  return (queueSleep || '').trim();
}

export function scheduleKind(schedule: string): PayScheduleKind {
  const s = schedule.trim();
  if (!s) return 'unknown';
  if (/^\d+$/.test(s)) return 'interval';
  return 'cron';
}

/** Normalize WFM Quartz (6–7 field) expressions for cron-parser. */
export function normalizeQuartzCron(raw: string): string {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 7) parts.pop();
  if (parts.length === 6) return parts.join(' ');
  if (parts.length === 5) return `0 ${parts.join(' ')}`;
  return raw.trim();
}

export function computeNextCronRunIso(
  schedule: string,
  timezone: string,
  from: Date = new Date(),
): string | null {
  if (scheduleKind(schedule) !== 'cron') return null;
  try {
    const interval = cronParser.parseExpression(normalizeQuartzCron(schedule), {
      tz: timezone,
      currentDate: from,
    });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

/** First EXEC_CRON fire on or after the pay-week end date (client local day). */
export function computeReleaseDueAtIso(
  schedule: string,
  timezone: string,
  payWeekEndYmd: string,
): string | null {
  if (scheduleKind(schedule) !== 'cron') return null;
  const ymd = sanitizeWeekEnd(payWeekEndYmd);
  if (!ymd) return null;
  const isoDay = yyyymmddToIso(ymd);
  if (!isoDay) return null;
  try {
    const interval = cronParser.parseExpression(normalizeQuartzCron(schedule), {
      tz: timezone,
      currentDate: new Date(`${isoDay}T00:00:00`),
    });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export function jobTimeOnOrAfterPayWeekEnd(
  lastJobTime: string | null | undefined,
  payWeekEndYmd: string,
): boolean {
  const jobYmd = toYyyymmdd(lastJobTime);
  const weekEnd = sanitizeWeekEnd(payWeekEndYmd);
  return !!jobYmd && !!weekEnd && jobYmd >= weekEnd;
}

export type PayrollMonitorPhase = 'live' | 'late' | 'upcoming' | 'complete' | 'unknown';

/** Hours before/after SLA deadline that still count as Live (± window). */
export const DEFAULT_PAYROLL_LIVE_WINDOW_HOURS = 12;

/**
 * Live window is centered on the client SLA `deadlineAt` (± `liveWindowHours`).
 * Without a deadline, fall back to EXEC_CRON release due … due+window (or interval last job).
 */
export function isWithinPayrollLiveWindow(input: {
  deadlineAt?: string | null;
  scheduleKind: PayScheduleKind;
  releaseDueAt: string | null;
  lastJobTime: string | null;
  payWeekEndYmd: string;
  liveWindowHours?: number;
  now?: Date;
}): boolean {
  const now = (input.now || new Date()).getTime();
  const hours = input.liveWindowHours ?? DEFAULT_PAYROLL_LIVE_WINDOW_HOURS;
  const windowMs = Math.max(0, hours) * 3600000;

  const deadline = parseMonitorTimestampMs(input.deadlineAt ?? null);
  if (deadline != null) {
    return Math.abs(now - deadline) <= windowMs;
  }

  // No SLA deadline — keep release-schedule fallback so Monitor still works.
  const due = parseMonitorTimestampMs(input.releaseDueAt);
  if (due != null && input.scheduleKind !== 'interval') {
    const age = now - due;
    return age >= 0 && age <= windowMs;
  }

  if (input.scheduleKind === 'interval' || due == null) {
    if (!jobTimeOnOrAfterPayWeekEnd(input.lastJobTime, input.payWeekEndYmd)) {
      return false;
    }
    const last = parseMonitorTimestampMs(input.lastJobTime);
    if (last == null) return false;
    const age = now - last;
    return age >= 0 && age <= windowMs;
  }

  return false;
}

/** Parse monitor timestamps (ISO, DB2, compact) to epoch ms for sorting. */
export function parseMonitorTimestampMs(raw: string | null | undefined): number | null {
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
  const compact = s.replace(/\D/g, '');
  if (compact.length >= 14) {
    const fmt = rfxCompactDateTime(s);
    if (fmt) {
      const t = Date.parse(`${fmt.replace(' ', 'T')}Z`);
      return Number.isFinite(t) ? t : null;
    }
  }
  if (compact.length >= 8) {
    const t = Date.parse(
      `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00Z`,
    );
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function isReleaseStarted(input: {
  scheduleKind: PayScheduleKind;
  releaseDueAt: string | null;
  lastJobTime: string | null;
  payWeekEndYmd: string;
  running: boolean;
  now?: Date;
}): boolean {
  const now = input.now || new Date();
  if (input.scheduleKind === 'interval') {
    return input.running || jobTimeOnOrAfterPayWeekEnd(input.lastJobTime, input.payWeekEndYmd);
  }
  return (input.releaseDueAt ? now >= new Date(input.releaseDueAt) : false)
    || jobTimeOnOrAfterPayWeekEnd(input.lastJobTime, input.payWeekEndYmd);
}

/** When release started or the generator last ran — anchor for stalled detection. */
export function stalledAnchorMs(input: {
  releaseDueAt: string | null;
  lastJobTime: string | null;
  payWeekEndYmd: string;
  now?: Date;
}): number | null {
  const now = input.now || new Date();
  const candidates: number[] = [];
  const due = parseMonitorTimestampMs(input.releaseDueAt);
  if (due != null && due <= now.getTime()) candidates.push(due);
  if (jobTimeOnOrAfterPayWeekEnd(input.lastJobTime, input.payWeekEndYmd)) {
    const last = parseMonitorTimestampMs(input.lastJobTime);
    if (last != null) candidates.push(last);
  }
  if (!candidates.length) {
    return due != null && due <= now.getTime() ? due : null;
  }
  return Math.max(...candidates);
}

export function evaluateStalledGeneration(input: {
  scheduleKind: PayScheduleKind;
  releaseDueAt: string | null;
  lastJobTime: string | null;
  payWeekEndYmd: string;
  running: boolean;
  units: { pending: number };
  graceMins: number;
  now?: Date;
}): { stalled: boolean; stalledMinutes: number | null } {
  const now = input.now || new Date();
  if (input.units.pending <= 0 || input.running) {
    return { stalled: false, stalledMinutes: null };
  }
  if (!isReleaseStarted(input)) {
    return { stalled: false, stalledMinutes: null };
  }

  const anchor = stalledAnchorMs(input);
  if (anchor == null) {
    return { stalled: false, stalledMinutes: null };
  }

  const elapsedMins = Math.floor((now.getTime() - anchor) / 60000);
  if (elapsedMins < input.graceMins) {
    return { stalled: false, stalledMinutes: null };
  }
  return { stalled: true, stalledMinutes: elapsedMins };
}

export function classifyMonitorPhase(input: {
  scheduleKind: PayScheduleKind;
  releaseDueAt: string | null;
  lastJobTime: string | null;
  payWeekEndYmd: string;
  running: boolean;
  jobsPending: number;
  units: { total: number; generated: number; pending: number };
  /** Past this SLA with pending units → late (not live); alerts cover that case. */
  deadlineAt?: string | null;
  /**
   * Escalated alert was resolved for this pay week (intentional leftover units, etc.).
   * Skip Late phase so dashboard / Monitor stop seeking attention.
   */
  deadlineResolved?: boolean;
  /** Hours before/after SLA deadline that still count as Live (default ±12). */
  liveWindowHours?: number;
  now?: Date;
}): PayrollMonitorPhase {
  const now = input.now || new Date();

  if (input.units.total > 0 && input.units.pending === 0) return 'complete';

  const releaseStarted = isReleaseStarted(input);
  const inLiveWindow = isWithinPayrollLiveWindow({
    deadlineAt: input.deadlineAt,
    scheduleKind: input.scheduleKind,
    releaseDueAt: input.releaseDueAt,
    lastJobTime: input.lastJobTime,
    payWeekEndYmd: input.payWeekEndYmd,
    liveWindowHours: input.liveWindowHours,
    now,
  });

  // Live = within ± liveWindowHours of SLA deadline (or release fallback) with pending.
  if (inLiveWindow && input.units.pending > 0) return 'live';

  const { late } = evaluatePayrollDeadlineLate({
    deadlineAt: input.deadlineAt ?? null,
    pendingUnits: input.units.pending,
    now,
  });
  // Past SLA and outside the Live window → Late (Escalated), unless resolved for this week.
  if (late && !input.deadlineResolved) return 'late';

  // Pending but outside Live window (e.g. days before SLA) → Upcoming
  if (input.units.pending > 0) return 'upcoming';
  if (!releaseStarted && input.releaseDueAt && new Date(input.releaseDueAt) > now) return 'upcoming';
  if (input.units.total === 0 && !releaseStarted && input.releaseDueAt && new Date(input.releaseDueAt) > now) {
    return 'upcoming';
  }
  return 'unknown';
}

export function monitorRowKey(clientId: string, distListId: string): string {
  return `${clientId}:${distListId}`;
}

/** Release due first, else last job time; unknowns sort last. */
export function monitorReleaseSortMs(input: {
  releaseDueAt: string | null;
  lastJobTime: string | null;
}): number {
  const due = parseMonitorTimestampMs(input.releaseDueAt);
  if (due != null) return due;
  const last = parseMonitorTimestampMs(input.lastJobTime);
  if (last != null) return last;
  return Number.MAX_SAFE_INTEGER;
}

export function compareMonitorReleaseOrder(
  a: { releaseDueAt: string | null; lastJobTime: string | null },
  b: { releaseDueAt: string | null; lastJobTime: string | null },
): number {
  return monitorReleaseSortMs(a) - monitorReleaseSortMs(b);
}

/** Normalize "H:mm" / "HH:mm" to "HH:mm", or null if invalid. */
export function parsePayrollDeadlineLocalTime(raw: string | null | undefined): string | null {
  const m = (raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Weekly weekday offset: 0–7 inclusive. */
export const PAYROLL_DEADLINE_DAYS_MAX_WEEKLY = 7;
/** Bi-weekly days after period end: 0–14 inclusive. */
export const PAYROLL_DEADLINE_DAYS_MAX_BIWEEKLY = 14;
/** Semi-monthly / monthly calendar day: 1–28 (safe for all months). */
export const PAYROLL_DEADLINE_DAY_OF_MONTH_MAX = 28;

/** Accept 0–maxDays inclusive; otherwise null. Default max is weekly (7). */
export function sanitizePayrollDeadlineDays(
  raw: unknown,
  maxDays: number = PAYROLL_DEADLINE_DAYS_MAX_WEEKLY,
): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  const max = Number.isFinite(maxDays) && maxDays >= 0 ? Math.floor(maxDays) : PAYROLL_DEADLINE_DAYS_MAX_WEEKLY;
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.floor(n);
}

/** Accept calendar day 1–28; otherwise null. */
export function sanitizePayrollDeadlineDayOfMonth(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > PAYROLL_DEADLINE_DAY_OF_MONTH_MAX) return null;
  return Math.floor(n);
}

/**
 * Which deadline picker / storage shape to use for a pay frequency.
 * WK → weekday (stored as days after week end); BW → days after period end; SM/GM → day of month.
 */
export function payrollDeadlinePickerKind(
  frequency: string | null | undefined,
): 'weekday' | 'daysAfter' | 'dayOfMonth' {
  const code = normalizeFrequency(frequency);
  if (code === 'SM' || code === 'GM') return 'dayOfMonth';
  if (code === 'BW') return 'daysAfter';
  return 'weekday';
}

/**
 * SLA deadline: pay week-end calendar day in client TZ, plus daysAfter, at localTime.
 * Returns ISO UTC string, or null when any part is unset/invalid.
 * `maxDays` defaults to bi-weekly max so stored BW values (8–14) still compute.
 */
export function computePayrollDeadlineAtIso(
  payWeekEndYmd: string,
  daysAfterWeekEnd: number | null | undefined,
  localTime: string | null | undefined,
  tz: string,
  maxDays: number = PAYROLL_DEADLINE_DAYS_MAX_BIWEEKLY,
): string | null {
  const ymd = sanitizeWeekEnd(payWeekEndYmd);
  const days = sanitizePayrollDeadlineDays(daysAfterWeekEnd, maxDays);
  const time = parsePayrollDeadlineLocalTime(localTime);
  if (!ymd || days == null || !time) return null;
  const isoDay = yyyymmddToIso(ymd);
  if (!isoDay) return null;
  try {
    const base = dayjs.tz(`${isoDay} ${time}:00`, tz || 'America/Chicago');
    if (!base.isValid()) return null;
    return base.add(days, 'day').toISOString();
  } catch {
    return null;
  }
}

/**
 * SLA deadline for SM/GM: first calendar date with day-of-month on or after pay week/period end,
 * at localTime in client TZ.
 */
export function computePayrollDeadlineAtIsoFromDayOfMonth(
  payWeekEndYmd: string,
  dayOfMonth: number | null | undefined,
  localTime: string | null | undefined,
  tz: string,
): string | null {
  const ymd = sanitizeWeekEnd(payWeekEndYmd);
  const dom = sanitizePayrollDeadlineDayOfMonth(dayOfMonth);
  const time = parsePayrollDeadlineLocalTime(localTime);
  if (!ymd || dom == null || !time) return null;
  const isoDay = yyyymmddToIso(ymd);
  if (!isoDay) return null;
  const zone = tz || 'America/Chicago';
  const [hh, mm] = time.split(':').map(p => parseInt(p, 10));
  try {
    const start = dayjs.tz(`${isoDay} 12:00:00`, zone);
    if (!start.isValid()) return null;
    for (let i = 0; i <= 62; i++) {
      const d = start.add(i, 'day');
      if (d.date() === dom) {
        const due = d.hour(hh).minute(mm).second(0).millisecond(0);
        if (!due.isValid()) return null;
        return due.toISOString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve deadline ISO from either days-after (WK/BW) or day-of-month (SM/GM).
 * Day-of-month wins when both are set (should not happen after a clean save).
 */
export function resolvePayrollDeadlineAtIso(input: {
  payWeekEndYmd: string;
  daysAfterWeekEnd?: number | null;
  dayOfMonth?: number | null;
  localTime?: string | null;
  tz: string;
}): string | null {
  if (input.dayOfMonth != null && input.dayOfMonth !== undefined) {
    const fromDom = computePayrollDeadlineAtIsoFromDayOfMonth(
      input.payWeekEndYmd,
      input.dayOfMonth,
      input.localTime,
      input.tz,
    );
    if (fromDom) return fromDom;
  }
  return computePayrollDeadlineAtIso(
    input.payWeekEndYmd,
    input.daysAfterWeekEnd,
    input.localTime,
    input.tz,
  );
}

/** True when the client has a usable local SLA deadline configured. */
export function hasPayrollDeadlineConfigured(input: {
  daysAfterWeekEnd?: number | null;
  dayOfMonth?: number | null;
  localTime?: string | null;
}): boolean {
  const time = parsePayrollDeadlineLocalTime(input.localTime);
  if (!time) return false;
  return (
    sanitizePayrollDeadlineDays(input.daysAfterWeekEnd, PAYROLL_DEADLINE_DAYS_MAX_BIWEEKLY) != null
    || sanitizePayrollDeadlineDayOfMonth(input.dayOfMonth) != null
  );
}

export function evaluatePayrollDeadlineLate(input: {
  deadlineAt: string | null;
  pendingUnits: number;
  now?: Date;
}): { late: boolean; lateMinutes: number | null } {
  if (!input.deadlineAt || input.pendingUnits <= 0) {
    return { late: false, lateMinutes: null };
  }
  const now = input.now || new Date();
  const due = Date.parse(input.deadlineAt);
  if (!Number.isFinite(due) || now.getTime() < due) {
    return { late: false, lateMinutes: null };
  }
  return {
    late: true,
    lateMinutes: Math.floor((now.getTime() - due) / 60000),
  };
}

/**
 * Attention Late: past SLA with pending, outside the Live (±) window,
 * and not resolved/accepted for this pay week.
 */
export function isPayrollDeadlineAttentionLate(
  late: boolean,
  deadlineResolved?: boolean,
  inLiveWindow?: boolean,
): boolean {
  return !!late && !deadlineResolved && !inLiveWindow;
}
