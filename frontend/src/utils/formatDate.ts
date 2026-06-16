import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

type DateStyle = 'full' | 'short' | 'time' | 'date';

/** Short timezone abbreviation for an instant in the given IANA zone. */
function tzAbbreviation(instant: dayjs.Dayjs, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  })
    .formatToParts(instant.toDate())
    .find(p => p.type === 'timeZoneName')?.value ?? '';
}

/** Format a dayjs instance with the shared style presets. */
function formatStyled(d: dayjs.Dayjs, tz: string, style: DateStyle): string {
  const abbr = tzAbbreviation(d, tz);
  switch (style) {
    case 'time':
      return `${d.format('HH:mm')} ${abbr}`;
    case 'date':
      return d.format('DD MMM YYYY');
    case 'short':
      return `${d.format('DD MMM HH:mm')} ${abbr}`;
    case 'full':
    default:
      return `${d.format('DD MMM YYYY HH:mm')} ${abbr}`;
  }
}

/**
 * Normalize DB2 timestamp strings for parsing in client-local timezone.
 * Formats: "2026-06-06 21:30:56.312215", "2026-06-06-21.30.56.123456"
 */
export function normalizeDb2Timestamp(raw: string): string {
  const trimmed = raw.trim();
  const dashFmt = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/);
  if (dashFmt) {
    return `${dashFmt[1]}-${dashFmt[2]}-${dashFmt[3]}T${dashFmt[4]}:${dashFmt[5]}:${dashFmt[6]}`;
  }
  const spaceFmt = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (spaceFmt) {
    return `${spaceFmt[1]}T${spaceFmt[2]}`;
  }
  return trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed;
}

/**
 * Format a DB2 timestamp (client-local, no offset) in the user's timezone.
 *
 * @param db2Ts     - Raw DB2 timestamp from RFX_QUEUE etc.
 * @param clientTz  - IANA timezone of the client DB (e.g. Pacific/Auckland)
 * @param userTz    - IANA timezone for display (user preference)
 */
export function formatDb2DateTime(
  db2Ts: string | null | undefined,
  clientTz: string,
  userTz: string,
  style: DateStyle = 'full',
): string {
  if (!db2Ts) return '';
  const normalized = normalizeDb2Timestamp(db2Ts);
  const d = dayjs.tz(normalized, clientTz).tz(userTz);
  if (!d.isValid()) return db2Ts.trim();
  return formatStyled(d, userTz, style);
}

/**
 * Format an ISO date string in the user's configured timezone.
 *
 * @param isoStr  - ISO 8601 / UTC date string from the backend
 * @param tz      - IANA timezone e.g. "Asia/Kolkata", "America/New_York"
 * @param style   - 'full' | 'short' | 'time' | 'date'
 *
 * full  → "20 Apr 2026 14:30 IST"
 * short → "20 Apr 14:30 IST"
 * time  → "14:30 IST"
 * date  → "20 Apr 2026"
 */
export function formatDateTime(
  isoStr: string | null | undefined,
  tz: string,
  style: DateStyle = 'full',
): string {
  if (!isoStr) return '';
  const d = dayjs.utc(isoStr).tz(tz);
  if (!d.isValid()) return '';
  return formatStyled(d, tz, style);
}
