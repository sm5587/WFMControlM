// ============================================================
// Escalation report helpers (pure functions for tests)
// ============================================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface MonthPeriod {
  year: number;
  month: number | null;
  quarter: number | null;
  type: 'monthly' | 'quarterly';
  label: string;
  startDate: string;
  endDate: string;
  start: Date;
  end: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function parseMonthPeriod(year: number, month: number): MonthPeriod {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return {
    year,
    month,
    quarter: null,
    type: 'monthly',
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    startDate: `${year}-${pad(month)}-01`,
    endDate: `${year}-${pad(month)}-${pad(end.getDate())}`,
    start,
    end,
  };
}

/** Calendar quarter: Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec. */
export function parseQuarterPeriod(year: number, quarter: number): MonthPeriod {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const start = new Date(year, startMonth - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, endMonth, 0, 23, 59, 59, 999);
  return {
    year,
    month: null,
    quarter,
    type: 'quarterly',
    label: `Q${quarter} ${year}`,
    startDate: `${year}-${pad(startMonth)}-01`,
    endDate: `${year}-${pad(endMonth)}-${pad(end.getDate())}`,
    start,
    end,
  };
}

export function isDateInRange(value: Date | null | undefined, start: Date, end: Date): boolean {
  if (!value) return false;
  const t = value.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

/** True when an escalation was active at any point during [start, end]. */
export function alertOverlapsPeriod(
  firstSeenAt: Date,
  resolvedAt: Date | null,
  start: Date,
  end: Date,
): boolean {
  if (firstSeenAt.getTime() > end.getTime()) return false;
  if (!resolvedAt) return true;
  return resolvedAt.getTime() >= start.getTime();
}

/** True when the alert was still open at `asOf` (typically period end, or now for the current period). */
export function isOpenAtPeriodEnd(resolvedAt: Date | null, asOf: Date): boolean {
  if (!resolvedAt) return true;
  return resolvedAt.getTime() > asOf.getTime();
}

export function computeDurationMins(
  firstSeenAt: Date,
  resolvedAt: Date | null,
  lastSeenAt: Date
): number {
  const end = resolvedAt ?? lastSeenAt;
  return Math.max(0, Math.round((end.getTime() - firstSeenAt.getTime()) / 60_000));
}

export function deriveQueueSeverity(stalePendingCount: number): 'CRITICAL' | 'WARNING' {
  return stalePendingCount >= 10 ? 'CRITICAL' : 'WARNING';
}

export function isCurrentMonthPeriod(period: MonthPeriod, now = new Date()): boolean {
  return periodContainsNow(period, now);
}

/** True when `now` falls inside the report window (current month or current quarter). */
export function periodContainsNow(period: Pick<MonthPeriod, 'start' | 'end'>, now = new Date()): boolean {
  return isDateInRange(now, period.start, period.end);
}

export function derivePunchActivities(
  row: {
    createdAt?: Date | null;
    acknowledgedAt?: Date | null;
    suppressedAt?: Date | null;
    emailSentAt?: Date | null;
  },
  start: Date,
  end: Date
): string[] {
  const activities: string[] = [];
  if (isDateInRange(row.createdAt, start, end)) activities.push('Tracked');
  if (isDateInRange(row.acknowledgedAt, start, end)) activities.push('Acknowledged');
  if (isDateInRange(row.suppressedAt, start, end)) activities.push('Suppressed');
  if (isDateInRange(row.emailSentAt, start, end)) activities.push('Notified');
  return activities;
}
