// ============================================================
// useBackgroundPolling
// Runs at app level (inside Layout) to keep DB Jobs and
// Unprocessed Punch caches warm every 30 minutes.
//
// PUNCH COORDINATOR: module-level singleton so that no matter
// how many components call triggerPunchRefresh(), only one
// actual refresh runs per 30-minute window.
//
// Batch status is NOT refreshed here — the backend warm-sync
// (index.ts setInterval) already does it server-side.
// ============================================================

import { useEffect } from 'react';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { dbJobsApi, unprocessedPunchApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';

// ---- Module-level punch refresh coordinator ----
// Persists across hook re-mounts (navigation between pages).
let punchLastTriggeredMs = 0;
let punchInFlight: Promise<void> | null = null;

/**
 * Trigger a punch data refresh only if:
 *  - No refresh was triggered within the last `stallMs` milliseconds, AND
 *  - No refresh is currently in-flight.
 * Safe to call from multiple sources simultaneously.
 */
export async function triggerPunchRefresh(
  queryClient: QueryClient,
  stallMs: number
): Promise<void> {
  // Guard: already triggered recently
  if (Date.now() - punchLastTriggeredMs < stallMs) return;
  // Guard: already in-flight
  if (punchInFlight) return;

  // Stamp trigger time immediately so concurrent callers are blocked
  punchLastTriggeredMs = Date.now();

  punchInFlight = (async () => {
    try {
      const res = await unprocessedPunchApi.getAll();
      if ((res as any)?.data) {
        queryClient.setQueryData(['unprocessed-punch-all'], res);
      }
    } catch {
      // On failure, reset trigger time so it can be retried next interval
      punchLastTriggeredMs = 0;
    } finally {
      punchInFlight = null;
    }
  })();

  return punchInFlight;
}

export function useBackgroundPolling() {
  const queryClient = useQueryClient();
  const { getInt } = useConfig();
  const THIRTY_MINUTES = getInt('polling.backgroundPollingMins', 30) * 60 * 1000;

  useEffect(() => {
    // ---- DB Jobs background refresh ----
    const refreshDbJobs = async () => {
      try {
        const res = await dbJobsApi.fetchAll();
        queryClient.setQueryData(['db-jobs-queue-all'], res);
      } catch {
        // Silently fail — page will retry on its own
      }
    };

    // Fire on mount only if cache is stale/empty
    const dbJobsAge = queryClient.getQueryState(['db-jobs-queue-all'])?.dataUpdatedAt;
    if (!dbJobsAge || Date.now() - dbJobsAge >= THIRTY_MINUTES) {
      refreshDbJobs();
    }

    // Punch: use the coordinator — skips if already triggered recently
    triggerPunchRefresh(queryClient, THIRTY_MINUTES);

    // Recurring intervals
    const dbJobsInterval = setInterval(refreshDbJobs, THIRTY_MINUTES);
    // Check every minute; coordinator itself enforces the 30-min window
    const punchInterval  = setInterval(() => triggerPunchRefresh(queryClient, THIRTY_MINUTES), 60_000);

    return () => {
      clearInterval(dbJobsInterval);
      clearInterval(punchInterval);
    };
  }, [queryClient]);
}
