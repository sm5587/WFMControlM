import { useAuth } from '../context/AuthContext';
import { useConfig } from '../contexts/ConfigContext';
import { formatDateTime } from '../utils/formatDate';
import { useCallback } from 'react';

/**
 * Returns the current user's timezone and a bound `fmt` function
 * that formats ISO strings in that timezone.
 */
export function useTimezone() {
  const { user } = useAuth();
  const { getString } = useConfig();
  const tz = user?.timezone || getString('display.defaultTimezone', 'Asia/Kolkata');

  const fmt = useCallback(
    (iso: string | null | undefined, style: 'full' | 'short' | 'time' | 'date' = 'full') =>
      formatDateTime(iso, tz, style),
    [tz],
  );

  return { tz, fmt };
}
