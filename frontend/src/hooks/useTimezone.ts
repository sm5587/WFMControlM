import { useAuth } from '../context/AuthContext';
import { useConfig } from '../contexts/ConfigContext';
import { formatDateTime, formatDb2DateTime } from '../utils/formatDate';
import { useCallback } from 'react';

type DateStyle = 'full' | 'short' | 'time' | 'date';

/**
 * Returns the current user's timezone and bound formatters:
 * - `fmt`     — ISO/UTC strings from the backend
 * - `fmtDb2`  — DB2 client-local timestamps → user timezone
 */
export function useTimezone() {
  const { user } = useAuth();
  const { getString } = useConfig();
  const tz = user?.timezone || getString('display.defaultTimezone', 'Asia/Kolkata');

  const fmt = useCallback(
    (iso: string | null | undefined, style: DateStyle = 'full') =>
      formatDateTime(iso, tz, style),
    [tz],
  );

  const fmtDb2 = useCallback(
    (db2Ts: string | null | undefined, clientTz: string, style: DateStyle = 'full') =>
      formatDb2DateTime(db2Ts, clientTz, tz, style),
    [tz],
  );

  return { tz, fmt, fmtDb2 };
}
