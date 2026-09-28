// ============================================================
// useProgressivePayrollMonitor
// Show cached rows immediately on return, keep client list visible,
// then refresh each payroll client one-by-one (bounded concurrency).
// Auto/background scans wait until all-batch-status is idle so DB2
// is not hit by batch + payroll at the same time. Manual Refresh
// uses start({ force: true }) to skip that wait.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { payrollApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';
import { useBatchLookbackDays } from './useBatchLookbackDays';
import { waitForAllBatchStatusIdle } from './useAllClientsBatchData';

export type PayrollMonitorPhase = 'live' | 'late' | 'upcoming' | 'complete' | 'unknown';

export interface PayMonitorGenerator {
  queueId: string;
  jobType: string;
  distListId: string;
  distListName: string | null;
  execCron: string | null;
  schedule: string;
  scheduleKind: 'cron' | 'interval' | 'unknown';
  releaseDueAt: string | null;
  nextRunAt: string | null;
  lastJobTime: string | null;
  jobsPending: number;
  running: boolean;
}

export interface PriorWeekGeneratedCompare {
  weekEndDate: string;
  total: number;
  generated: number;
}

export interface PayrollFileStatusCounts {
  F: number;
  D: number;
  Q: number;
  blank: number;
}

export interface PayrollUnitCounts {
  total: number;
  generated: number;
  pending: number;
  byStatus?: PayrollFileStatusCounts;
}

const EMPTY_BY_STATUS: PayrollFileStatusCounts = { F: 0, D: 0, Q: 0, blank: 0 };

export interface PayrollMonitorRow {
  rowKey: string;
  clientId: string;
  name: string;
  timezone: string;
  frequencies: string[];
  weekStartDate: string;
  weekEndDate: string;
  distListId: string;
  distListName: string | null;
  generator: PayMonitorGenerator;
  units: PayrollUnitCounts;
  priorWeek?: PriorWeekGeneratedCompare | null;
  phase: PayrollMonitorPhase;
  stalled: boolean;
  stalledMinutes: number | null;
  deadlineAt: string | null;
  /** Escalated alert resolved for this pay week — no Late attention. */
  deadlineResolved?: boolean;
  late: boolean;
  lateMinutes: number | null;
  error?: string;
  loading?: boolean;
}

export interface PayrollMonitorClient {
  clientId: string;
  name: string;
  timezone: string;
  payrollFileGen: string;
  frequencies: string[];
  payrollDeadlineDaysAfterWeekEnd?: number | null;
  payrollDeadlineDayOfMonth?: number | null;
  payrollDeadlineLocalTime?: string | null;
}

export interface PayrollMonitorCache {
  rows: PayrollMonitorRow[];
  clients: PayrollMonitorClient[];
  stalledGraceMins: number;
  fetchedAt: string;
  liveCount: number;
  upcomingCount: number;
  completeCount: number;
  stalledCount: number;
  lateCount: number;
}

export interface ProgressivePayrollMonitorState {
  rows: PayrollMonitorRow[];
  clients: PayrollMonitorClient[];
  liveCount: number;
  upcomingCount: number;
  completeCount: number;
  stalledCount: number;
  lateCount: number;
  stalledGraceMins: number;
  total: number;
  loaded: number;
  status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
  fetchedAt: string | null;
  errorMessage: string | null;
  isRefreshing: boolean;
  /** Auto/background: waits for batch. Pass `{ force: true }` for manual Refresh. */
  start: (opts?: { force?: boolean }) => void;
}

export const PAYROLL_MONITOR_CACHE_KEY = ['payroll-monitor-progressive'] as const;

const EMPTY_GENERATOR: PayMonitorGenerator = {
  queueId: '',
  jobType: '',
  distListId: '',
  distListName: null,
  execCron: null,
  schedule: '',
  scheduleKind: 'unknown',
  releaseDueAt: null,
  nextRunAt: null,
  lastJobTime: null,
  jobsPending: 0,
  running: false,
};

function summarize(rows: PayrollMonitorRow[]) {
  const ready = rows.filter(r => !r.loading);
  return {
    liveCount: ready.filter(r => r.phase === 'live').length,
    upcomingCount: ready.filter(r => r.phase === 'upcoming').length,
    completeCount: ready.filter(r => r.phase === 'complete').length,
    stalledCount: ready.filter(r => r.stalled).length,
    lateCount: ready.filter(r => r.late).length,
  };
}

function skeletonRow(c: PayrollMonitorClient): PayrollMonitorRow {
  return {
    rowKey: `${c.clientId}:loading`,
    clientId: c.clientId,
    name: c.name,
    timezone: c.timezone,
    frequencies: c.frequencies || [],
    weekStartDate: '',
    weekEndDate: '',
    distListId: '',
    distListName: null,
    generator: EMPTY_GENERATOR,
    units: { total: 0, generated: 0, pending: 0, byStatus: { ...EMPTY_BY_STATUS } },
    priorWeek: null,
    phase: 'unknown',
    stalled: false,
    stalledMinutes: null,
    deadlineAt: null,
    deadlineResolved: false,
    late: false,
    lateMinutes: null,
    loading: true,
  };
}

function replaceClientRows(
  prev: PayrollMonitorRow[],
  clientId: string,
  nextRows: PayrollMonitorRow[],
): PayrollMonitorRow[] {
  const without = prev.filter(r => r.clientId !== clientId);
  return [...without, ...nextRows];
}

function markClientsLoading(
  prev: PayrollMonitorRow[],
  clients: PayrollMonitorClient[],
): PayrollMonitorRow[] {
  // Keep prior values visible while refreshing; only invent skeletons for brand-new clients.
  const known = new Set(prev.map(r => r.clientId));
  const next = [...prev];
  for (const c of clients) {
    if (!known.has(c.clientId)) next.push(skeletonRow(c));
  }
  const active = new Set(clients.map(c => c.clientId));
  return next.filter(r => active.has(r.clientId));
}

export function useProgressivePayrollMonitor(): ProgressivePayrollMonitorState {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const lookbackDays = useBatchLookbackDays();
  const CONCURRENCY = Math.max(1, getInt('engine.db2QueryConcurrency', 5));
  const STALE_MS = 60_000;
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [rows, setRows] = useState<PayrollMonitorRow[]>([]);
  const [clients, setClients] = useState<PayrollMonitorClient[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [upcomingCount, setUpcomingCount] = useState(0);
  const [completeCount, setCompleteCount] = useState(0);
  const [stalledCount, setStalledCount] = useState(0);
  const [lateCount, setLateCount] = useState(0);
  const [stalledGraceMins, setStalledGraceMins] = useState(30);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [status, setStatus] = useState<ProgressivePayrollMonitorState['status']>('idle');
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const rowsRef = useRef<PayrollMonitorRow[]>([]);
  rowsRef.current = rows;

  const applySummary = useCallback((nextRows: PayrollMonitorRow[]) => {
    const s = summarize(nextRows);
    setLiveCount(s.liveCount);
    setUpcomingCount(s.upcomingCount);
    setCompleteCount(s.completeCount);
    setStalledCount(s.stalledCount);
    setLateCount(s.lateCount);
  }, []);

  const persistCache = useCallback((payload: PayrollMonitorCache) => {
    queryClient.setQueryDefaults(PAYROLL_MONITOR_CACHE_KEY, {
      gcTime: 30 * 60 * 1000,
      staleTime: STALE_MS,
    });
    queryClient.setQueryData(PAYROLL_MONITOR_CACHE_KEY, payload);
  }, [queryClient, STALE_MS]);

  const start = useCallback((opts?: { force?: boolean }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setErrorMessage(null);

    (async () => {
      try {
        if (!opts?.force) {
          await waitForAllBatchStatusIdle(queryClient, lookbackDays, controller.signal);
          if (controller.signal.aborted) return;
        }

        setStatus(prev => (prev === 'idle' ? 'connecting' : 'streaming'));

        const listRes = await payrollApi.getMonitorClients();
        if (controller.signal.aborted) return;

        const listData = listRes?.data || {};
        const clientList: PayrollMonitorClient[] = listData.clients || [];
        const grace = Number(listData.stalledGraceMins) || 30;

        setClients(clientList);
        setStalledGraceMins(grace);
        setTotal(clientList.length);
        setLoaded(0);
        setStatus('streaming');

        if (clientList.length === 0) {
          const at = new Date().toISOString();
          setRows([]);
          applySummary([]);
          setFetchedAt(at);
          setStatus('done');
          persistCache({
            rows: [],
            clients: [],
            stalledGraceMins: grace,
            fetchedAt: at,
            liveCount: 0,
            upcomingCount: 0,
            completeCount: 0,
            stalledCount: 0,
            lateCount: 0,
          });
          return;
        }

        let idx = 0;
        let loadedCount = 0;
        let workingRows = rowsRef.current.length
          ? markClientsLoading(rowsRef.current, clientList)
          : clientList.map(skeletonRow);
        rowsRef.current = workingRows;
        setRows(workingRows);
        applySummary(workingRows);

        const processNext = async (): Promise<void> => {
          while (idx < clientList.length) {
            if (controller.signal.aborted) return;
            const i = idx++;
            const c = clientList[i];
            let nextClientRows: PayrollMonitorRow[];
            try {
              const resp = await payrollApi.getMonitorClientScan(c.clientId);
              nextClientRows = ((resp?.data?.rows || []) as PayrollMonitorRow[]).map(r => ({
                ...r,
                loading: false,
              }));
              if (!nextClientRows.length) {
                nextClientRows = [{
                  ...skeletonRow(c),
                  rowKey: `${c.clientId}:none`,
                  loading: false,
                  phase: 'unknown',
                  error: 'No running regular pay generator',
                }];
              }
            } catch (err: any) {
              nextClientRows = [{
                ...skeletonRow(c),
                rowKey: `${c.clientId}:error`,
                loading: false,
                phase: 'unknown',
                error: err?.message || 'Monitor scan failed',
              }];
            }

            if (controller.signal.aborted) return;

            workingRows = replaceClientRows(workingRows, c.clientId, nextClientRows);
            rowsRef.current = workingRows;
            loadedCount++;
            setLoaded(loadedCount);
            setRows(workingRows);
            applySummary(workingRows);
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, clientList.length) }, () => processNext()),
        );

        if (controller.signal.aborted) return;

        const at = new Date().toISOString();
        const summary = summarize(workingRows);
        setFetchedAt(at);
        setStatus('done');
        persistCache({
          rows: workingRows.map(r => ({ ...r, loading: false })),
          clients: clientList,
          stalledGraceMins: grace,
          fetchedAt: at,
          ...summary,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.message?.includes('canceled') || err?.message === 'Aborted') return;
        setErrorMessage(err?.message || 'Failed to load payroll monitor');
        setStatus('error');
      }
    })();
  }, [CONCURRENCY, applySummary, persistCache, queryClient, lookbackDays]);

  // Hydrate from cache on mount; refresh only when stale (after batch is idle).
  useEffect(() => {
    const cached = queryClient.getQueryData<PayrollMonitorCache>(PAYROLL_MONITOR_CACHE_KEY);
    const cacheAge = queryClient.getQueryState(PAYROLL_MONITOR_CACHE_KEY)?.dataUpdatedAt;
    const fresh = !!(cached?.rows && cacheAge && Date.now() - cacheAge < STALE_MS);

    if (cached?.rows?.length) {
      queryClient.setQueryDefaults(PAYROLL_MONITOR_CACHE_KEY, {
        gcTime: 30 * 60 * 1000,
        staleTime: STALE_MS,
      });
      setRows(cached.rows.map(r => ({ ...r, loading: false })));
      setClients(cached.clients || []);
      setLiveCount(cached.liveCount || 0);
      setUpcomingCount(cached.upcomingCount || 0);
      setCompleteCount(cached.completeCount || 0);
      setStalledCount(cached.stalledCount || 0);
      setLateCount(cached.lateCount || 0);
      setStalledGraceMins(cached.stalledGraceMins || 30);
      setTotal((cached.clients || []).length || new Set(cached.rows.map(r => r.clientId)).size);
      setLoaded((cached.clients || []).length || new Set(cached.rows.map(r => r.clientId)).size);
      setFetchedAt(cached.fetchedAt || null);
      setStatus('done');
      if (fresh) return;
    }

    start();
    return () => {
      abortRef.current?.abort();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Background poll while live/stalled (or slower otherwise); waits for batch.
  useEffect(() => {
    if (status !== 'done' && status !== 'error') return;

    const delay = (liveCount > 0 || stalledCount > 0 || lateCount > 0) ? 20_000 : STALE_MS;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      start();
    }, delay);

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [status, liveCount, stalledCount, lateCount, STALE_MS, start, fetchedAt]);

  return {
    rows,
    clients,
    liveCount,
    upcomingCount,
    completeCount,
    stalledCount,
    lateCount,
    stalledGraceMins,
    total,
    loaded,
    status,
    fetchedAt,
    errorMessage,
    isRefreshing: status === 'connecting' || status === 'streaming',
    start,
  };
}
