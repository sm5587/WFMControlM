// ============================================================
// Heat Map — SQL helpers & types
// Compare RWS_GEN_SHIFT store counts: ITERATION_TYPE 6 (Manager)
// vs 7 (Week-in-progress / WIP copy) for shifts active as-of a date.
// ============================================================

/**
 * Distinct UNIT_SKEY counts for Manager (6) vs WIP (7).
 * Active window: EFF_DATE <= as-of AND END_DATE >= as-of (no calendar join).
 * Returns current week + previous week (as-of CURRENT DATE - 7 DAYS).
 */
export function wipWeeklyCountsSql(): string {
  return (
    `SELECT ` +
    `VARCHAR_FORMAT(COALESCE(MIN(g.EFF_DATE), CURRENT DATE), 'yyyyMMdd') AS WEEK_START_DATE, ` +
    `VARCHAR_FORMAT(COALESCE(MAX(g.END_DATE), CURRENT DATE), 'yyyyMMdd') AS WEEK_END_DATE, ` +
    `COUNT(DISTINCT CASE WHEN g.ITERATION_TYPE = 6 THEN g.UNIT_SKEY END) AS ITER6_STORES, ` +
    `COUNT(DISTINCT CASE WHEN g.ITERATION_TYPE = 7 THEN g.UNIT_SKEY END) AS ITER7_STORES ` +
    `FROM RWSUSER.RWS_GEN_SHIFT g ` +
    `WHERE g.EFF_DATE <= CURRENT DATE ` +
    `  AND g.END_DATE >= CURRENT DATE ` +
    `  AND g.ITERATION_TYPE IN (6, 7) ` +
    `UNION ALL ` +
    `SELECT ` +
    `VARCHAR_FORMAT(COALESCE(MIN(g.EFF_DATE), CURRENT DATE - 7 DAYS), 'yyyyMMdd') AS WEEK_START_DATE, ` +
    `VARCHAR_FORMAT(COALESCE(MAX(g.END_DATE), CURRENT DATE - 7 DAYS), 'yyyyMMdd') AS WEEK_END_DATE, ` +
    `COUNT(DISTINCT CASE WHEN g.ITERATION_TYPE = 6 THEN g.UNIT_SKEY END) AS ITER6_STORES, ` +
    `COUNT(DISTINCT CASE WHEN g.ITERATION_TYPE = 7 THEN g.UNIT_SKEY END) AS ITER7_STORES ` +
    `FROM RWSUSER.RWS_GEN_SHIFT g ` +
    `WHERE g.EFF_DATE <= CURRENT DATE - 7 DAYS ` +
    `  AND g.END_DATE >= CURRENT DATE - 7 DAYS ` +
    `  AND g.ITERATION_TYPE IN (6, 7)`
  );
}

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

export function parseWipWeekRow(row: Record<string, string | null> | undefined): WipWeekCounts | null {
  if (!row) return null;
  const weekStartDate = (row.WEEK_START_DATE || '').trim();
  const weekEndDate = (row.WEEK_END_DATE || '').trim();
  if (!weekStartDate || !weekEndDate) return null;
  const iter6Stores = toInt(row.ITER6_STORES);
  const iter7Stores = toInt(row.ITER7_STORES);
  return {
    fiscalYear: toInt(row.FISCAL_YEAR),
    fiscalWeek: toInt(row.FISCAL_WEEK),
    weekInd: toInt(row.WEEK_IND),
    weekStartDate,
    weekEndDate,
    iter6Stores,
    iter7Stores,
    mismatch: iter6Stores !== iter7Stores,
    delta: iter7Stores - iter6Stores,
  };
}

function toInt(raw: string | null | undefined): number {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
