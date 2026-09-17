import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { escalationsApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';
import { useEscalatedAlerts } from './useEscalatedAlerts';
import { useStalePunchRows } from './useStalePunchRows';

/**
 * Whether the Alerts nav item should show its attention indicator.
 * Active = open or acknowledged (not suppressed/resolved). Matches Escalated tab badge.
 */
export function useAlertsMenuBadge() {
  const { getInt } = useConfig();
  const { data: escalated = [] } = useEscalatedAlerts();
  const { stalePunchRows } = useStalePunchRows();

  const { data: punchAlertStatuses = {} } = useQuery<Record<string, any>>({
    queryKey: ['punch-alert-statuses'],
    queryFn: async () => {
      const res = await escalationsApi.getPunchAlertStatuses();
      return (res as any)?.data ?? {};
    },
    refetchInterval: getInt('polling.punchStatusRefreshSecs', 60) * 1000,
    refetchOnWindowFocus: true,
  });

  const count = useMemo(() => {
    const activeEscalated = escalated.filter(
      a => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED',
    ).length;

    let punchOpen = 0;
    let punchAcked = 0;
    for (const r of stalePunchRows) {
      const st = punchAlertStatuses[r.clientId];
      if (st?.status === 'ACKNOWLEDGED') punchAcked++;
      else if (st?.status !== 'SUPPRESSED') punchOpen++;
    }

    return activeEscalated + punchOpen + punchAcked;
  }, [escalated, stalePunchRows, punchAlertStatuses]);

  return { showBadge: count > 0, count };
}
