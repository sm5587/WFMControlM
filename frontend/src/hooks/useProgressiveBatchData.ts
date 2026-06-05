// ============================================================
// useProgressiveBatchData
// Progressive loading for DB Monitor: fetch client list (fast),
// then query each client's batch status individually with
// concurrency control. Each row updates as its query completes.
// ============================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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

export interface ClientBatchEntry {
  clientId: string;
  groups: BatchJobGroup[];
  error?: string;
  loading?: boolean;
}

export interface ProgressiveBatchState {
  /** Per-client batch data map */
  clients: Record<string, ClientBatchEntry>;
  /** Client name map (clientId -> name) */
  clientNames: Record<string, string>;
  /** Stale-pending alerts */
  pendingAlerts: { clientId: string; clientName: string; stalePendingCount: number; totalPending: number }[];
  total: number;
  loaded: number;
  status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
  fetchedAt: string | null;
  errorMessage: string | null;
  start: () => void;
}

const CACHE_KEY_PREFIX = 'all-batch-status';

function computeAlerts(
  clientsMap: Record<string, ClientBatchEntry>,
  nameMap: Record<string, string>,
) {
  const alerts: ProgressiveBatchState['pendingAlerts'] = [];
  for (const [cid, data] of Object.entries(clientsMap)) {
    if (data.loading || data.error) continue;
    const groups = data.groups || [];
    const totalPending = groups.reduce((s, g) => s + (g.pending || 0), 0);
    const stalePendingCount = groups.reduce((s, g) => s + (g.stalePending || 0), 0);
    if (stalePendingCount > 0) {
      alerts.push({ clientId: cid, clientName: nameMap[cid] || cid, stalePendingCount, totalPending });
    }
  }
  return alerts.sort((a, b) => b.stalePendingCount - a.stalePendingCount);
}

export function useProgressiveBatchData(days: number = 2): ProgressiveBatchState {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const THIRTY_MINUTES = getInt('polling.batchRefreshMins', 30) * 60 * 1000;
  const CONCURRENCY = getInt('engine.db2QueryConcurrency', 5);
  const abortRef = useRef<AbortController | null>(null);

  const [clients, setClients]             = useState<Record<string, ClientBatchEntry>>({});
  const [clientNames, setClientNames]     = useState<Record<string, string>>({});
  const [pendingAlerts, setPendingAlerts]  = useState<ProgressiveBatchState['pendingAlerts']>([]);
  const [total, setTotal]                 = useState(0);
  const [loaded, setLoaded]               = useState(0);
  const [status, setStatus]               = useState<ProgressiveBatchState['status']>('idle');
  const [fetchedAt, setFetchedAt]         = useState<string | null>(null);
  const [errorMessage, setErrorMessage]   = useState<string | null>(null);

  const start = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Do NOT clear existing state — keep showing stale data while refreshing.
    // Only reset to empty if there is no data at all yet.
    setErrorMessage(null);
    setStatus('connecting');

    (async () => {
      try {
        // Step 1: Prefer backend aggregated payload (fast when server-side cache is warm).
        const allRes = await dbMonitorApi.getAllBatchStatus(days);
        const allData = allRes?.data;
        if (allData?.clients) {
          if (controller.signal.aborted) return;

          const clientEntries: Record<string, ClientBatchEntry> = {};
          for (const [cid, val] of Object.entries(allData.clients as Record<string, any>)) {
            clientEntries[cid] = {
              clientId: cid,
              groups: val?.groups || [],
              error: val?.error,
              loading: false,
            };
          }

          const names = allData.clientNames || {};
          const at = allData.fetchedAt || new Date().toISOString();

          setClients(clientEntries);
          setClientNames(names);
          setPendingAlerts(allData.pendingAlerts || computeAlerts(clientEntries, names));
          setTotal(Object.keys(clientEntries).length);
          setLoaded(Object.keys(clientEntries).length);
          setFetchedAt(at);
          setStatus('done');

          queryClient.setQueryData([CACHE_KEY_PREFIX, days], {
            clients: Object.fromEntries(
              Object.entries(clientEntries).map(([k, v]) => [k, { groups: v.groups, error: v.error }])
            ),
            pendingAlerts: allData.pendingAlerts || computeAlerts(clientEntries, names),
            clientNames: names,
            fetchedAt: at,
          });
          return;
        }

        // Fallback Step 1: Fetch client list (fast)
        const clientRes = await dbMonitorApi.getDbClients();
        const clientList: { clientId: string; name: string; cluster: string }[] =
          clientRes?.data || [];

        if (controller.signal.aborted) return;

        if (clientList.length === 0) {
          setStatus('done');
          setFetchedAt(new Date().toISOString());
          return;
        }

        // Build name map — only reset client skeletons if we have no prior data
        const nameMap: Record<string, string> = {};
        const skeletons: Record<string, ClientBatchEntry> = {};
        for (const c of clientList) {
          nameMap[c.clientId] = c.name;
          skeletons[c.clientId] = { clientId: c.clientId, groups: [], loading: true };
        }

        setTotal(clientList.length);
        setClientNames(nameMap);
        setClients(prev => Object.keys(prev).length > 0 ? prev : skeletons);
        setStatus('streaming');

        // Step 2: Query each client with bounded concurrency
        let idx = 0;
        let loadedCount = 0;
        const finalClients: Record<string, ClientBatchEntry> = { ...skeletons };

        const processNext = async (): Promise<void> => {
          while (idx < clientList.length) {
            if (controller.signal.aborted) return;
            const i = idx++;
            const c = clientList[i];
            let entry: ClientBatchEntry;
            try {
              const resp = await dbMonitorApi.getBatchStatus(c.clientId, days);
              const groups = resp?.data || [];
              entry = { clientId: c.clientId, groups, loading: false };
            } catch (err: any) {
              entry = { clientId: c.clientId, groups: [], error: err.message ?? 'Unknown error', loading: false };
            }

            if (controller.signal.aborted) return;

            finalClients[c.clientId] = entry;

            // Update this specific client in-place
            setClients(prev => ({ ...prev, [c.clientId]: entry }));
            loadedCount++;
            setLoaded(loadedCount);

            // Recompute alerts as data arrives
            setPendingAlerts(computeAlerts(finalClients, nameMap));
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, clientList.length) }, () => processNext())
        );

        if (controller.signal.aborted) return;

        // Step 3: Done
        const at = new Date().toISOString();
        setFetchedAt(at);
        setStatus('done');

        // Populate shared cache
        queryClient.setQueryData([CACHE_KEY_PREFIX, days], {
          clients: Object.fromEntries(
            Object.entries(finalClients).map(([k, v]) => [k, { groups: v.groups, error: v.error }])
          ),
          pendingAlerts: computeAlerts(finalClients, nameMap),
          clientNames: nameMap,
          fetchedAt: at,
        });

      } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('canceled')) return;
        setErrorMessage(err.message ?? 'Failed to load');
        setStatus('error');
      }
    })();
  }, [days, queryClient]);

  // Auto-start on mount; use cache if fresh
  useEffect(() => {
    const cached = queryClient.getQueryData<any>([CACHE_KEY_PREFIX, days]);
    const cacheAge = queryClient.getQueryState([CACHE_KEY_PREFIX, days])?.dataUpdatedAt;
    if (cached?.clients && cacheAge && Date.now() - cacheAge < THIRTY_MINUTES) {
      const clientEntries: Record<string, ClientBatchEntry> = {};
      for (const [cid, val] of Object.entries(cached.clients as Record<string, any>)) {
        clientEntries[cid] = { clientId: cid, groups: val.groups || [], error: val.error, loading: false };
      }
      setClients(clientEntries);
      setClientNames(cached.clientNames || {});
      setPendingAlerts(cached.pendingAlerts || []);
      setTotal(Object.keys(clientEntries).length);
      setLoaded(Object.keys(clientEntries).length);
      setFetchedAt(cached.fetchedAt ?? null);
      setStatus('done');
      return;
    }

    start();
    return () => { abortRef.current?.abort(); };
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  return { clients, clientNames, pendingAlerts, total, loaded, status, fetchedAt, errorMessage, start };
}
