import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unprocessedPunchApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';

export function parseDb2Ts(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return new Date(s);
}

/** Stale unprocessed-punch rows shown in Alert Center escalated tab. */
export function useStalePunchRows() {
  const { getInt } = useConfig();
  const punchRefreshMins = getInt('polling.punchRefreshMins', 30);

  const { data: punchRes, isSuccess: punchLoaded } = useQuery({
    queryKey: ['unprocessed-punch-all'],
    queryFn: () => unprocessedPunchApi.getAll(),
    staleTime: punchRefreshMins * 60 * 1000,
    refetchInterval: punchRefreshMins * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const allPunchRows: any[] = (punchRes as any)?.data ?? [];
  const prevPunchSnapshot = useRef<Map<string, { punchCount: number; lastUpdateTime: string | null }>>(new Map());

  const stalePunchRows = useMemo(() => {
    const prev = prevPunchSnapshot.current;
    const punchCountMin = getInt('threshold.punchCountMin', 100);
    const staleHoursMins = getInt('threshold.staleHoursMins', 60);

    return allPunchRows
      .filter(r => {
        if (!r.punchCount || r.punchCount <= punchCountMin || r.error) return false;
        const dbNow = parseDb2Ts(r.dbCurrentTime);
        const last = parseDb2Ts(r.lastUpdateTime);
        if (!dbNow || !last) return false;
        if ((dbNow.getTime() - last.getTime()) <= staleHoursMins * 60 * 1000) return false;

        const prevData = prev.get(r.clientId);
        if (prevData) {
          if (r.punchCount < prevData.punchCount) return false;
          if (r.lastUpdateTime !== prevData.lastUpdateTime) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const ageA = parseDb2Ts(a.dbCurrentTime)!.getTime() - parseDb2Ts(a.lastUpdateTime)!.getTime();
        const ageB = parseDb2Ts(b.dbCurrentTime)!.getTime() - parseDb2Ts(b.lastUpdateTime)!.getTime();
        return ageB - ageA;
      });
  }, [allPunchRows]);

  useEffect(() => {
    if (allPunchRows.length > 0) {
      const snapshot = new Map<string, { punchCount: number; lastUpdateTime: string | null }>();
      for (const r of allPunchRows) {
        if (r.clientId && r.punchCount != null) {
          snapshot.set(r.clientId, { punchCount: r.punchCount, lastUpdateTime: r.lastUpdateTime ?? null });
        }
      }
      prevPunchSnapshot.current = snapshot;
    }
  }, [allPunchRows]);

  return { stalePunchRows, punchLoaded };
}
