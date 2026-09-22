import { useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import { dbMonitorApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';
import { useBatchLookbackDays } from './useBatchLookbackDays';

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

export function allBatchStatusQueryKey(lookbackDays: number) {
  return ['all-batch-status', lookbackDays] as const;
}

export function isAllBatchStatusFetching(queryClient: QueryClient, lookbackDays: number): boolean {
  return queryClient.isFetching({ queryKey: allBatchStatusQueryKey(lookbackDays) }) > 0;
}

/** Resolves when no all-batch-status fetch is in flight (or immediately if none). */
export function waitForAllBatchStatusIdle(
  queryClient: QueryClient,
  lookbackDays: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!isAllBatchStatusFetching(queryClient, lookbackDays)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsub();
      clearInterval(interval);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const check = () => {
      if (!isAllBatchStatusFetching(queryClient, lookbackDays)) {
        cleanup();
        resolve();
      }
    };
    const unsub = queryClient.getQueryCache().subscribe(check);
    const interval = setInterval(check, 250);
    signal?.addEventListener('abort', onAbort);
    check();
  });
}

export function useAllClientsBatchData(days?: number) {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const configDays = useBatchLookbackDays();
  const lookbackDays = days ?? configDays;
  const staleMs = getInt('polling.batchRefreshMins', 30) * 60 * 1000;

  return useQuery<AllClientsBatchData>({
    queryKey: allBatchStatusQueryKey(lookbackDays),
    queryFn: async () => {
      const res = await dbMonitorApi.getAllBatchStatus(lookbackDays);
      // Backend creates/updates escalations during batch-status — refresh nav badge + Alert Center.
      await queryClient.invalidateQueries({ queryKey: ['escalated-alerts'] });
      return res.data;
    },
    staleTime: staleMs,
    gcTime: staleMs * 2,
    refetchInterval: staleMs,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });
}
