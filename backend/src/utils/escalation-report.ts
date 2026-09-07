// ============================================================
// Escalation monthly report helpers (pure functions for tests)
// ============================================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface MonthPeriod {
  year: number;
  month: number;
  label: string;
  startDate: string;
  endDate: string;
  start: Date;
  end: Date;
}

export function parseMonthPeriod(year: number, month: number): MonthPeriod {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year,
    month,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    startDate: `${year}-${pad(month)}-01`,
    endDate: `${year}-${pad(month)}-${pad(end.getDate())}`,
    start,
    end,
  };
}

export function isDateInRange(value: Date | null | undefined, start: Date, end: Date): boolean {
  if (!value) return false;
  const t = value.getTime();
  return t >= start.getTime() && t <= end.getTime();
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
  return period.year === now.getFullYear() && period.month === now.getMonth() + 1;
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
