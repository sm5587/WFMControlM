import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { escalationsApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';
import { useEscalatedAlerts } from './useEscalatedAlerts';
import { useStalePunchRows } from './useStalePunchRows';

/**
 * Whether the Alerts nav item should show its attention indicator.
 * Matches the Escalated tab badge: open job escalations + open/acked punch alerts.
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
    const openEscalated = escalated.filter(a => a.status === 'OPEN').length;

    let punchOpen = 0;
    let punchAcked = 0;
    for (const r of stalePunchRows) {
      const st = punchAlertStatuses[r.clientId];
      if (st?.status === 'ACKNOWLEDGED') punchAcked++;
      else if (st?.status !== 'SUPPRESSED') punchOpen++;
    }

    return openEscalated + punchOpen + punchAcked;
  }, [escalated, stalePunchRows, punchAlertStatuses]);

  return { showBadge: count > 0, count };
}
