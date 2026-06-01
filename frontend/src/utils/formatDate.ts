import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

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
  style: 'full' | 'short' | 'time' | 'date' = 'full',
): string {
  if (!isoStr) return '';
  const d = dayjs.utc(isoStr).tz(tz);
  if (!d.isValid()) return '';

  // Get short timezone abbreviation (IST, EDT, CDT, etc.)
  const abbr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  })
    .formatToParts(d.toDate())
    .find(p => p.type === 'timeZoneName')?.value ?? '';

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
