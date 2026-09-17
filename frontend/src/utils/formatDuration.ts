/** Format a duration given in whole minutes as "Xm", "Xh Ym", or "Xd Xh" for long spans. */
export function formatDurationMins(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins) || mins < 0) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  if (rh && rem) return `${d}d ${rh}h ${rem}m`;
  if (rh) return `${d}d ${rh}h`;
  if (rem) return `${d}d ${rem}m`;
  return `${d}d`;
}
