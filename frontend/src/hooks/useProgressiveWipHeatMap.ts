// ============================================================
// useProgressiveWipHeatMap
// List clients, then scan each one (bounded concurrency).
// Snapshot kept in React Query; auto-refresh hourly with a
// phase offset so it does not pile onto batch/punch DB2 polls.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wipApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';
import { waitForAllBatchStatusIdle } from './useAllClientsBatchData';
import { useBatchLookbackDays } from './useBatchLookbackDays';
import { waitForPunchRefreshIdle } from './useBackgroundPolling';

export interface WipWeekCounts {
  fiscalYear: number;
  fiscalWeek: number;
  weekInd: number;
  weekStartDate: string;
  weekEndDate: string;
  iter6Stores: number;
  iter7Stores: number;
  mismatch: boolean;
  delta: number;
}

export interface WipHeatMapClient {
  clientId: string;
  name: string;
  timezone: string;
  cluster: string | null;
}

export interface WipHeatMapRow {
  clientId: string;
  name: string;
  timezone: string;
  cluster: string | null;
  weeks: WipWeekCounts[];
  mismatchCount: number;
  hasMismatch: boolean;
  error?: string;
  loading?: boolean;
}

export interface ProgressiveWipHeatMapState {
  rows: WipHeatMapRow[];
  clients: WipHeatMapClient[];
  mismatchClients: number;
  total: number;
  loaded: number;
  status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
  fetchedAt: string | null;
  errorMessage: string | null;
  isRefreshing: boolean;
  refreshingClientId: string | null;
  start: (opts?: { force?: boolean }) => void;
  refreshClient: (clientId: string) => Promise<void>;
}

export const HEATMAP_CACHE_KEY = ['heatmap-progressive'] as const;

interface WipHeatMapCache {
  rows: WipHeatMapRow[];
  clients: WipHeatMapClient[];
  fetchedAt: string;
}

/** Survives navigation — 60s tick uses this so remount does not reset the hour window. */
let heatMapLastStartedMs = 0;

function skeletonRow(c: WipHeatMapClient): WipHeatMapRow {
  return {
    clientId: c.clientId,
    name: c.name,
    timezone: c.timezone,
    cluster: c.cluster,
    weeks: [],
    mismatchCount: 0,
    hasMismatch: false,
    loading: true,
  };
}

function summarize(rows: WipHeatMapRow[]) {
  return {
    mismatchClients: rows.filter((r) => !r.loading && r.hasMismatch).length,
  };
}

/** True during the first minute of each offset-aligned refresh window. */
function isInHeatMapPhaseWindow(refreshMs: number, offsetMs: number, now = Date.now()): boolean {
  if (refreshMs <= 0) return true;
  const phase = ((now - offsetMs) % refreshMs + refreshMs) % refreshMs;
  return phase < 60_000;
}

export function useProgressiveWipHeatMap(): ProgressiveWipHeatMapState {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const lookbackDays = useBatchLookbackDays();
  const concurrency = Math.max(1, Math.min(10, getInt('engine.db2QueryConcurrency', 5)));
  const refreshMs = Math.max(5, getInt('polling.heatMapRefreshMins', 60)) * 60 * 1000;
  const offsetMs = Math.min(59, Math.max(0, getInt('polling.heatMapRefreshOffsetMins', 15))) * 60 * 1000;

  // Keep cache alive across navigations
  useQuery({
    queryKey: HEATMAP_CACHE_KEY,
    queryFn: () => null,
    enabled: false,
    staleTime: refreshMs,
    gcTime: refreshMs * 2,
  });

  const cached = queryClient.getQueryData<WipHeatMapCache>(HEATMAP_CACHE_KEY);
  const [rows, setRows] = useState<WipHeatMapRow[]>(cached?.rows || []);
  const [clients, setClients] = useState<WipHeatMapClient[]>(cached?.clients || []);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'streaming' | 'done' | 'error'>(
    cached?.rows?.length ? 'done' : 'idle',
  );
  const [fetchedAt, setFetchedAt] = useState<string | null>(cached?.fetchedAt || null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(cached?.rows?.filter((r) => !r.loading).length || 0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingClientId, setRefreshingClientId] = useState<string | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const startRef = useRef<(opts?: { force?: boolean }) => void>(() => undefined);

  const start = useCallback(async (opts?: { force?: boolean }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = ++runIdRef.current;

    setIsRefreshing(true);
    setErrorMessage(null);

    try {
      if (!opts?.force) {
        await waitForAllBatchStatusIdle(queryClient, lookbackDays, controller.signal);
        if (controller.signal.aborted || runId !== runIdRef.current) return;
        await waitForPunchRefreshIdle(controller.signal);
        if (controller.signal.aborted || runId !== runIdRef.current) return;
      }

      heatMapLastStartedMs = Date.now();
      setStatus((prev) => (prev === 'idle' || rowsRef.current.length === 0 ? 'connecting' : 'streaming'));

      const listRes = await wipApi.getClients();
      if (controller.signal.aborted || runId !== runIdRef.current) return;

      const nextClients: WipHeatMapClient[] = listRes?.data?.clients || [];
      setClients(nextClients);

      const keepExisting = rowsRef.current.length > 0;
      if (!keepExisting) {
        setRows(nextClients.map(skeletonRow));
      }
      setLoaded(0);
      setStatus('streaming');

      let completed = 0;
      const results = new Map<string, WipHeatMapRow>();
      let idx = 0;

      const worker = async () => {
        while (idx < nextClients.length) {
          if (controller.signal.aborted || runId !== runIdRef.current) return;
          const c = nextClients[idx++];
          try {
            const scanRes = await wipApi.getClientScan(c.clientId);
            if (controller.signal.aborted || runId !== runIdRef.current) return;
            const data = scanRes?.data;
            const row: WipHeatMapRow = data
              ? { ...data, loading: false }
              : {
                  ...skeletonRow(c),
                  loading: false,
                  error: scanRes?.error || 'Scan failed',
                };
            results.set(c.clientId, row);
          } catch (err) {
            if (controller.signal.aborted || runId !== runIdRef.current) return;
            results.set(c.clientId, {
              ...skeletonRow(c),
              loading: false,
              error: err instanceof Error ? err.message : 'Scan failed',
            });
          }
          completed += 1;
          if (controller.signal.aborted || runId !== runIdRef.current) return;
          setLoaded(completed);
          setRows((prev) => {
            const byId = new Map(prev.map((r) => [r.clientId, r]));
            return nextClients.map((client) => {
              if (results.has(client.clientId)) return results.get(client.clientId)!;
              return byId.get(client.clientId) || skeletonRow(client);
            });
          });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, nextClients.length || 1) }, () => worker()),
      );

      if (controller.signal.aborted || runId !== runIdRef.current) return;

      const finalRows = nextClients.map((client) => results.get(client.clientId) || {
        ...skeletonRow(client),
        loading: false,
        error: 'Missing scan result',
      });
      const at = new Date().toISOString();
      setRows(finalRows);
      setFetchedAt(at);
      setStatus('done');
      queryClient.setQueryDefaults(HEATMAP_CACHE_KEY, {
        staleTime: refreshMs,
        gcTime: refreshMs * 2,
      });
      queryClient.setQueryData<WipHeatMapCache>(HEATMAP_CACHE_KEY, {
        rows: finalRows,
        clients: nextClients,
        fetchedAt: at,
      });
    } catch (err) {
      if (controller.signal.aborted || runId !== runIdRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Heat Map failed');
    } finally {
      if (runId === runIdRef.current) setIsRefreshing(false);
    }
  }, [concurrency, lookbackDays, queryClient, refreshMs]);

  startRef.current = start;

  const refreshClient = useCallback(async (clientId: string) => {
    setRefreshingClientId(clientId);
    setRows((prev) =>
      prev.map((r) => (r.clientId === clientId ? { ...r, loading: true, error: undefined } : r)),
    );
    try {
      const scanRes = await wipApi.getClientScan(clientId);
      const data = scanRes?.data;
      const nextRow: WipHeatMapRow = data
        ? { ...data, loading: false }
        : {
            clientId,
            name: clientId,
            timezone: 'UTC',
            cluster: null,
            weeks: [],
            mismatchCount: 0,
            hasMismatch: false,
            loading: false,
            error: scanRes?.error || 'Scan failed',
          };
      setRows((prev) => {
        const updated = prev.map((r) => (r.clientId === clientId ? { ...r, ...nextRow, name: nextRow.name || r.name } : r));
        const cache = queryClient.getQueryData<WipHeatMapCache>(HEATMAP_CACHE_KEY);
        if (cache) {
          queryClient.setQueryData<WipHeatMapCache>(HEATMAP_CACHE_KEY, {
            ...cache,
            rows: updated,
            fetchedAt: new Date().toISOString(),
          });
        }
        return updated;
      });
      setFetchedAt(new Date().toISOString());
    } catch (err) {
      setRows((prev) =>
        prev.map((r) =>
          r.clientId === clientId
            ? {
                ...r,
                loading: false,
                error: err instanceof Error ? err.message : 'Scan failed',
              }
            : r,
        ),
      );
    } finally {
      setRefreshingClientId((cur) => (cur === clientId ? null : cur));
    }
  }, [queryClient]);

  // Mount: hydrate from cache if fresh; otherwise scan. Auto-refresh hourly in phase window.
  useEffect(() => {
    const cache = queryClient.getQueryData<WipHeatMapCache>(HEATMAP_CACHE_KEY);
    const cacheAge = queryClient.getQueryState(HEATMAP_CACHE_KEY)?.dataUpdatedAt
      || (cache?.fetchedAt ? Date.parse(cache.fetchedAt) : 0);

    if (cache?.rows?.length && cacheAge && Date.now() - cacheAge < refreshMs) {
      setRows(cache.rows);
      setClients(cache.clients || []);
      setLoaded(cache.rows.filter((r) => !r.loading).length);
      setFetchedAt(cache.fetchedAt ?? null);
      setStatus('done');
      if (!heatMapLastStartedMs) heatMapLastStartedMs = cacheAge;
    } else {
      startRef.current();
    }

    const interval = setInterval(() => {
      if (Date.now() - heatMapLastStartedMs < refreshMs) return;
      if (!isInHeatMapPhaseWindow(refreshMs, offsetMs)) return;
      startRef.current();
    }, 60_000);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [queryClient, refreshMs, offsetMs]);

  const { mismatchClients } = summarize(rows);

  return {
    rows,
    clients,
    mismatchClients,
    total: clients.length || rows.length,
    loaded,
    status,
    fetchedAt,
    errorMessage,
    isRefreshing,
    refreshingClientId,
    start,
    refreshClient,
  };
}
