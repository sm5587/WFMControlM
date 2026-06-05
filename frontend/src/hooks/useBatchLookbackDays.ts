import { useConfig } from '../contexts/ConfigContext';

/** Shared BATCH_STATUS lookback window — must match DB Monitor and Alerts. */
export function useBatchLookbackDays(): number {
  const { getInt } = useConfig();
  return getInt('engine.dbMonitorBatchDays', 2);
}
