import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { dbMonitorApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';

export type ConnStatus = 'testing' | 'connected' | 'failed';

/**
 * Fetches the DB2 client list and tests all connections,
 * caching everything in React Query for configurable duration.
 * Data persists across navigation.
 */
export function useDbClientConnections() {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const THIRTY_MINUTES = getInt('polling.batchRefreshMins', 30) * 60 * 1000;

  // Fetch client list — cached
  const clientsQuery = useQuery({
    queryKey: ['db-clients'],
    queryFn: () => dbMonitorApi.getDbClients(),
    staleTime: THIRTY_MINUTES,
    gcTime: THIRTY_MINUTES * 2,
    refetchInterval: THIRTY_MINUTES,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const clients = clientsQuery.data?.data || [];

  // Connection status for all clients
  // - NOT fetched automatically on every mount (refetchOnMount: false)
  // - NOT polled on a timer (no refetchInterval)
  // - Only fires once when data is first needed, then cached until manually refreshed
  // - User can trigger a re-test via refetchConnections()
  const connQuery = useQuery<Record<string, ConnStatus>>({
    queryKey: ['db-client-connections'],
    queryFn: async () => {
      const clientList = queryClient.getQueryData<any>(['db-clients'])?.data || [];
      if (clientList.length === 0) return {};

      const results: Record<string, ConnStatus> = {};
      const concurrency = 10;
      let idx = 0;

      await new Promise<void>((resolve) => {
        let running = 0;
        const runNext = () => {
          while (running < concurrency && idx < clientList.length) {
            const client = clientList[idx++];
            running++;
            dbMonitorApi.testDbClient(client.clientId)
              .then(res => {
                results[client.clientId] = res.success ? 'connected' : 'failed';
              })
              .catch(() => {
                results[client.clientId] = 'failed';
              })
              .finally(() => {
                running--;
                if (idx >= clientList.length && running === 0) resolve();
                else runNext();
              });
          }
        };
        runNext();
      });

      return results;
    },
    enabled: clients.length > 0,
    staleTime: Infinity,        // Never auto-expire — only refresh on manual request
    gcTime: 60 * 60 * 1000,
    refetchOnMount: false,       // Do NOT re-test every time the page is visited
    refetchInterval: false,      // No background polling for connection tests
    refetchOnWindowFocus: false,
  });

  const connStatus = connQuery.data || {};
  const connTesting = connQuery.isFetching;

  const refetchConnections = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['db-client-connections'] });
  }, [queryClient]);

  return {
    clients,
    clientsLoading: clientsQuery.isLoading,
    connStatus,
    connTesting,
    refetchConnections,
  };
}
