import { useQuery } from '@tanstack/react-query';
import { escalationsApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';

export interface EscalatedAlert {
  id: string;
  clientId: string;
  serverCode: string;
  clientName: string;
  cluster: string;
  stalePendingCount: number;
  totalPending: number;
  status: string; // OPEN | ACKNOWLEDGED | SUPPRESSED
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  suppressedBy: string | null;
  suppressUntil: string | null;
  suppressReason: string | null;
  emailSentAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Shared escalated-alerts query used by Alert Center, Dashboard, and nav badge. */
export function useEscalatedAlerts() {
  const { getInt } = useConfig();
  const refreshSecs = getInt('polling.escalatedRefreshSecs', 60);

  return useQuery<EscalatedAlert[]>({
    queryKey: ['escalated-alerts'],
    queryFn: async () => {
      const res = await escalationsApi.getAll();
      return (res.data ?? []) as EscalatedAlert[];
    },
    staleTime: refreshSecs * 1000,
    refetchInterval: refreshSecs * 1000,
    refetchOnWindowFocus: true,
  });
}
