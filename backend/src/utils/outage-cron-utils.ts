// Shared cron fire-time utilities for outage impact calculation.
import cronParser from 'cron-parser';

/** Map shorthand TZ labels → IANA names and fixed UTC offset minutes */
export const TZ_OFFSETS: Record<string, { iana: string; offsetMin: number }> = {
  IST:  { iana: 'Asia/Kolkata',      offsetMin:  330 },
  EDT:  { iana: 'America/New_York',  offsetMin: -240 },
  EST:  { iana: 'America/New_York',  offsetMin: -300 },
  CST:  { iana: 'America/Chicago',   offsetMin: -360 },
  CDT:  { iana: 'America/Chicago',   offsetMin: -300 },
  MST:  { iana: 'America/Denver',    offsetMin: -420 },
  MDT:  { iana: 'America/Denver',    offsetMin: -360 },
  PST:  { iana: 'America/Los_Angeles', offsetMin: -480 },
  PDT:  { iana: 'America/Los_Angeles', offsetMin: -420 },
  UTC:  { iana: 'UTC',               offsetMin:    0 },
  UK:   { iana: 'Europe/London',     offsetMin:    0 },
  GMT:  { iana: 'Europe/London',     offsetMin:    0 },
};

const IANA_ALIASES: Record<string, string> = {
  IST: 'Asia/Kolkata',
  EDT: 'America/New_York',
  EST: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  UTC: 'UTC',
};

export function resolveServerTz(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  return IANA_ALIASES[tz.toUpperCase()] ?? tz;
}

/** Parse local datetime + TZ label → UTC Date. Accepts YYYY-MM-DD HH:MM or ISO datetime-local. */
export function localToUtc(localStr: string, tzLabel: string): Date {
  const tz = TZ_OFFSETS[tzLabel.toUpperCase()];
  if (!tz) throw new Error(`Unknown timezone label "${tzLabel}". Use IST, EDT, EST, CST, CDT or UTC.`);

  const normalised = localStr.replace('T', ' ').replace(/\//g, '-').trim();
  let parts = normalised.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!parts) {
    const ddmm = normalised.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (ddmm) parts = [ddmm[0], ddmm[3], ddmm[2], ddmm[1], ddmm[4], ddmm[5]];
  }
  if (!parts) throw new Error(`Cannot parse date "${localStr}". Use YYYY-MM-DD HH:MM`);

  const [, yr, mo, dy, hr, mn] = parts;
  const localMs = Date.UTC(Number(yr), Number(mo) - 1, Number(dy), Number(hr), Number(mn));
  return new Date(localMs - tz.offsetMin * 60_000);
}

export function utcToDisplay(utc: Date, tzLabel: string): string {
  const tz = TZ_OFFSETS[tzLabel.toUpperCase()] ?? TZ_OFFSETS.IST;
  const local = new Date(utc.getTime() + tz.offsetMin * 60_000);
  const iso = local.toISOString().replace('T', ' ').slice(0, 19);
  return iso;
}

export function fmtInIanaTz(d: Date, ianaTz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: resolveServerTz(ianaTz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function localDateFromStart(startLocal: string): string {
  const m = startLocal.replace('T', ' ').match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) throw new Error('Could not extract date from startLocal');
  return m[1];
}

/** Cron in server TZ → UTC instants within [windowStartUtc, windowEndUtc]. */
export function getFireTimesUtcInWindow(
  expr: string,
  serverTz: string,
  windowStartUtc: Date,
  windowEndUtc: Date,
): { fireTimesUtc: Date[]; error: string | null } {
  const iana = resolveServerTz(serverTz);
  const fireTimesUtc: Date[] = [];
  try {
    const interval = cronParser.parseExpression(expr, {
      tz: iana,
      currentDate: new Date(windowStartUtc.getTime() - 1000),
    });
    for (let i = 0; i < 500; i++) {
      const fireUtc = interval.next().toDate();
      if (fireUtc > windowEndUtc) break;
      if (fireUtc >= windowStartUtc) fireTimesUtc.push(fireUtc);
    }
  } catch (err: any) {
    return { fireTimesUtc: [], error: err.message };
  }
  return { fireTimesUtc, error: null };
}

/** Another fire scheduled later the same input-TZ calendar day? */
export function hasFireLaterToday(
  expr: string,
  serverTz: string,
  afterUtc: Date,
  inputTz: string,
  startLocal: string,
): boolean {
  const date = localDateFromStart(startLocal);
  const endOfDayUtc = localToUtc(`${date} 23:59:59`, inputTz);
  const { fireTimesUtc } = getFireTimesUtcInWindow(
    expr,
    serverTz,
    new Date(afterUtc.getTime() + 1),
    endOfDayUtc,
  );
  return fireTimesUtc.length > 0;
}
