# Heat Map — Design Reference

Compares **Manager schedule** (`ITERATION_TYPE = 6`) vs **WIP copy** (`ITERATION_TYPE = 7`) distinct store counts in `RWS_GEN_SHIFT` for shifts active as-of a date (`EFF_DATE <= as-of AND END_DATE >= as-of`). No `RWS_CALENDAR` join (avoids multi-calendar-id noise).

WIP is created at the start of every fiscal week. For a healthy week, distinct `UNIT_SKEY` counts for types 6 and 7 must match.

Implementation: `backend/src/services/wip-heatmap-service.ts`, `backend/src/routes/wip.ts`, `frontend/src/components/Wip/WipHeatMap.tsx`. Canonical SQL: `database/client-db2-queries.sql` (section *heat map*).

---

## Gating

- Config: `display.heatMapEnabled` (default `true`; migrates legacy `display.wipHeatMapEnabled` on startup)
- Permission: `HEATMAP_VIEW` (auto-granted on startup to System Admin / Monitor / Advanced Monitor / Read Only, and to any profile that already has `PAYROLL_MONITOR_VIEW` read; migrates legacy `WIP_HEATMAP_VIEW`)
- Menu route: `/heatmap` (`/wip-heatmap` redirects)

Fresh code deploys do **not** require a manual Profiles/Config click — restart is enough for system profiles.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/wip/clients` | Active clients with DB2 |
| GET | `/api/wip/client/:clientId` | Weekly 6 vs 7 counts for one client |
| GET | `/api/wip` | Full snapshot (concurrency pool) |

---

## SQL shape

From `RWS_GEN_SHIFT` only: count distinct `UNIT_SKEY` for iteration types 6 and 7 where the shift covers the as-of date (`EFF_DATE <= as-of AND END_DATE >= as-of`). Returns two rows — current (`CURRENT DATE`) and previous (`CURRENT DATE - 7 DAYS`). Display dates are `MIN(EFF_DATE)` / `MAX(END_DATE)` of the matching rows.

Mismatch when `ITER6_STORES != ITER7_STORES`.

---

## Caching / refresh

- Frontend React Query cache key: `heatmap-progressive` (survives navigation)
- Config: `polling.heatMapRefreshMins` (default **60**) — show cache if younger than this; auto-rescan when stale
- Config: `polling.heatMapRefreshOffsetMins` (default **15**, range 0–59) — phase window so hourly auto-refresh does not align with batch/punch 30‑minute polls
- Auto-refresh waits for DB Monitor batch fetch and Unprocessed Punch `/all` to finish before scanning (manual **Refresh** skips the wait)
- Manual full refresh and per-client refresh always hit DB2

## UI

- Same page chrome as Payroll Monitor: padded header, summary cards, filter bar, content panel
- Summary cards: Matched / Mismatched / Errors, plus a **Legend** card (6 — Manager copy / 7 — WIP copy)
- Navigation: **Current week** or **Previous week** only (← →); each client uses its own calendar
- Each card shows that client's week-start date and a per-client refresh control
- Dense clickable grid (up to 12 cells per row); red border = mismatch, amber = error
- Click a client for a detail popup (counts, dates, delta, full error, refresh)
- Grid stays clean — no error dumps or delta text on cells
