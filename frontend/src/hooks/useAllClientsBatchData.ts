import { useQuery } from '@tanstack/react-query';
import { dbMonitorApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';

export interface BatchJobGroup {
  jobType: string;
  planType: string;
  description: string;
  totalRuns: number;
  completed: number;
  failed: number;
  active: number;
  pending: number;
  stalePending: number;
  latestRun: string | null;
}

export interface AllClientsBatchData {
  clients: Record<string, { groups: BatchJobGroup[]; error?: string }>;
  pendingAlerts: { clientId: string; clientName: string; stalePendingCount: number; totalPending: number }[];
  clientNames: Record<string, string>;
  fetchedAt: string;
}

const THIRTY_MINUTES = 30 * 60 * 1000;

export function useAllClientsBatchData(days: number = 1) {
  const { getInt } = useConfig();
  const staleMs = getInt('polling.batchRefreshMins', 30) * 60 * 1000;

  return useQuery<AllClientsBatchData>({
    queryKey: ['all-batch-status', days],
    queryFn: async () => {
      const res = await dbMonitorApi.getAllBatchStatus(days);
      return res.data;
    },
    staleTime: staleMs,
    gcTime: staleMs * 2,
    refetchInterval: staleMs,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });
}
