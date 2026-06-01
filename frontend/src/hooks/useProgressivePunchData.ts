// ============================================================
// useProgressivePunchData
// Progressive loading: fetch client list first (fast), render skeleton rows,
// then fire individual per-client DB2 queries with concurrency control.
// Each row updates as its query completes — no SSE/streaming needed.
// ============================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { unprocessedPunchApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';

export interface PunchRow {
  clientId: string;
  name: string;
  cluster: string;
  punchCount: number | null;
  lastUpdateTime: string | null;
  dbCurrentTime: string | null;
  executionTimeMs: number | null;
  error: string | null;
  loading?: boolean; // true while DB2 query is in-flight
}

export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error';

export interface ProgressivePunchState {
  rows: PunchRow[];
  total: number;
  loaded: number;
  status: StreamStatus;
  fetchedAt: string | null;
  errorMessage: string | null;
  /** Call to start (or restart) the loading */
  start: () => void;
}

const CACHE_KEY = ['unprocessed-punch-all'];

// Module-level — survives navigation (component unmount/remount).
// Tracks when start() was last called so the 30-min window is not
// reset every time the user leaves and returns to this page.
let punchLastStartedMs = 0;

export function useProgressivePunchData(): ProgressivePunchState {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const THIRTY_MINUTES = getInt('polling.punchRefreshMins', 30) * 60 * 1000;
  const CONCURRENCY = getInt('engine.db2QueryConcurrency', 5);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the cache alive when component unmounts (prevent GC)
  useQuery({
    queryKey: CACHE_KEY,
    queryFn: () => null,
    enabled: false,
    staleTime: THIRTY_MINUTES,
    gcTime: THIRTY_MINUTES * 2,
  });

  const [rows, setRows]                 = useState<PunchRow[]>([]);
  const [total, setTotal]               = useState(0);
  const [loaded, setLoaded]             = useState(0);
  const [status, setStatus]             = useState<StreamStatus>('idle');
  const [fetchedAt, setFetchedAt]       = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const start = useCallback(() => {
    // Stamp trigger time so the module-level timer is not reset by navigation
    punchLastStartedMs = Date.now();
    // Cancel any in-flight work
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRows([]);
    setTotal(0);
    setLoaded(0);
    setFetchedAt(null);
    setErrorMessage(null);
    setStatus('connecting');

    (async () => {
      try {
        // Step 1: Fetch client list (fast Prisma query — no DB2)
        const clientRes = await unprocessedPunchApi.getClients();
        const clients: { clientId: string; name: string; cluster: string }[] =
          (clientRes as any)?.data ?? [];

        if (controller.signal.aborted) return;

        if (clients.length === 0) {
          setStatus('done');
          setFetchedAt(new Date().toISOString());
          return;
        }

        // Step 2: Render all clients immediately as skeleton (loading) rows
        const skeletons: PunchRow[] = clients.map(c => ({
          clientId: c.clientId,
          name: c.name,
          cluster: c.cluster,
          punchCount: null,
          lastUpdateTime: null,
          dbCurrentTime: null,
          executionTimeMs: null,
          error: null,
          loading: true,
        }));
        setTotal(clients.length);
        setRows(skeletons);
        setStatus('streaming');

        // Step 3: Query each client's DB2 with bounded concurrency
        let idx = 0;
        let loadedCount = 0;

        const processNext = async (): Promise<void> => {
          while (idx < clients.length) {
            if (controller.signal.aborted) return;
            const i = idx++;
            const c = clients[i];
            let row: PunchRow;
            try {
              const resp = await unprocessedPunchApi.getPunchCount(c.clientId);
              const d = (resp as any)?.data;
              row = {
                clientId: c.clientId,
                name: c.name,
                cluster: c.cluster,
                punchCount: d?.punchCount ?? null,
                lastUpdateTime: d?.lastUpdateTime ?? null,
                dbCurrentTime: d?.dbCurrentTime ?? null,
                executionTimeMs: d?.executionTimeMs ?? null,
                error: null,
                loading: false,
              };
            } catch (err: any) {
              row = {
                clientId: c.clientId,
                name: c.name,
                cluster: c.cluster,
                punchCount: null,
                lastUpdateTime: null,
                dbCurrentTime: null,
                executionTimeMs: null,
                error: err.message ?? 'Unknown error',
                loading: false,
              };
            }

            if (controller.signal.aborted) return;

            // Update this specific row in-place
            setRows(prev => {
              const next = [...prev];
              const ri = next.findIndex(r => r.clientId === row.clientId);
              if (ri !== -1) next[ri] = row;
              return next;
            });
            loadedCount++;
            setLoaded(loadedCount);
          }
        };

        // Fire workers in parallel
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, clients.length) }, () => processNext())
        );

        if (controller.signal.aborted) return;

        // Step 4: Done — update cache and status
        const at = new Date().toISOString();
        setFetchedAt(at);
        setStatus('done');

        // Populate shared React Query cache so Dashboard & Alerts get data
        setRows(finalRows => {
          queryClient.setQueryData(CACHE_KEY, {
            data: finalRows.map(r => ({ ...r, loading: undefined })),
            fetchedAt: at,
          });
          return finalRows;
        });

      } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('canceled')) return;
        setErrorMessage(err.message ?? 'Failed to load');
        setStatus('error');
      }
    })();
  }, [queryClient]);

  // Auto-start on mount; use cache if fresh
  useEffect(() => {
    const cached = queryClient.getQueryData<{ data: PunchRow[]; fetchedAt: string }>(CACHE_KEY);
    const cacheAge = queryClient.getQueryState(CACHE_KEY)?.dataUpdatedAt;
    if (cached?.data?.length && cacheAge && Date.now() - cacheAge < THIRTY_MINUTES) {
      setRows(cached.data);
      setTotal(cached.data.length);
      setLoaded(cached.data.length);
      setFetchedAt(cached.fetchedAt ?? null);
      setStatus('done');
    } else {
      start();
    }

    // Subscribe to cache changes (e.g. from updateCachedRow in component)
    const unsub = queryClient.getQueryCache().subscribe(event => {
      if (
        event.type === 'updated' &&
        event.action?.type === 'success' &&
        event.query.queryKey[0] === CACHE_KEY[0]
      ) {
        const d = event.query.state.data as { data: PunchRow[]; fetchedAt: string } | undefined;
        if (d?.data) {
          setRows(d.data);
          setTotal(d.data.length);
          setLoaded(d.data.length);
          if (d.fetchedAt) setFetchedAt(d.fetchedAt);
        }
      }
    });

    // Auto-refresh: check every 60s but only fire start() when 30 min have
    // elapsed since the last start. The module-level punchLastStartedMs
    // survives navigation so the timer is not reset when the user leaves
    // and returns to this page.
    const interval = setInterval(() => {
      if (Date.now() - punchLastStartedMs >= THIRTY_MINUTES) start();
    }, 60_000);

    return () => {
      unsub();
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { rows, total, loaded, status, fetchedAt, errorMessage, start };
}
