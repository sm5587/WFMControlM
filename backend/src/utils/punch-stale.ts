// ============================================================
// Stale unprocessed punch helpers (mirrors Alert Center logic)
// ============================================================

export function parseDb2Ts(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface PunchRowLike {
  clientId: string;
  name?: string;
  cluster?: string;
  punchCount: number | null;
  lastUpdateTime?: string | null;
  dbCurrentTime?: string | null;
  error?: string | null;
}

export function isStalePunchRow(
  row: PunchRowLike,
  punchCountMin: number,
  staleHoursMins: number
): boolean {
  if (!row.punchCount || row.punchCount <= punchCountMin || row.error) return false;
  const dbNow = parseDb2Ts(row.dbCurrentTime ?? null);
  const last = parseDb2Ts(row.lastUpdateTime ?? null);
  if (!dbNow || !last) return false;
  return dbNow.getTime() - last.getTime() > staleHoursMins * 60_000;
}

export function staleAgeMins(row: PunchRowLike): number | null {
  const dbNow = parseDb2Ts(row.dbCurrentTime ?? null);
  const last = parseDb2Ts(row.lastUpdateTime ?? null);
  if (!dbNow || !last) return null;
  return Math.max(0, Math.round((dbNow.getTime() - last.getTime()) / 60_000));
}

export function filterStalePunchRows(
  rows: PunchRowLike[],
  punchCountMin: number,
  staleHoursMins: number
): PunchRowLike[] {
  return rows
    .filter(r => isStalePunchRow(r, punchCountMin, staleHoursMins))
    .sort((a, b) => (staleAgeMins(b) ?? 0) - (staleAgeMins(a) ?? 0));
}
