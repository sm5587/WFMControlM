// ============================================================
// Payroll — job names, frequency codes, generated-file status
// ============================================================

import cronParser from 'cron-parser';

export const REGULAR_PAY_JOBS = [
  'RTANewPayFileGeneratorJob',
  'RTAPayrollFeedGeneratorJob',
  'RTA_PAYROLL_FILE_GEN',
] as const;

export const ADJ_PAY_JOB = 'RTAPriorAdjPayGeneratorJob';

/** TA_UNIT_PAY_STATUS.FILE_STATUS = F means the pay file was generated. */
export const PAY_FILE_GENERATED_STATUS = 'F';

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

export type PayrollMonitorPhase = 'live' | 'upcoming' | 'complete' | 'unknown';

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
  now?: Date;
}): PayrollMonitorPhase {
  const now = input.now || new Date();

  if (input.units.total > 0 && input.units.pending === 0) return 'complete';

  const releaseStarted = isReleaseStarted(input);

  if (input.running && (input.jobsPending > 0 || input.units.pending > 0)) return 'live';
  if (releaseStarted && input.units.pending > 0) return 'live';
  if (input.units.pending > 0 && !releaseStarted) return 'upcoming';
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
