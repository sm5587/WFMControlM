# Payroll Monitor — Design Reference

Live status board for **pay-file generation in progress**. It answers: *is this client’s pay-file generator running right now, and how far has previous-week unit generation gone?*

It is **not** a historical payroll report. Payroll Jobs (`/payroll`) is the per-client drill-down with week/frequency pickers and adj outstanding. Monitor (`/payroll-monitor`) is a cross-client snapshot of the current generation run.

Canonical SQL copies also live in `database/client-db2-queries.sql` (section *payroll monitor*). Implementation: `backend/src/services/payroll-service.ts`, `backend/src/routes/payroll.ts`, `frontend/src/components/Payroll/PayrollMonitor.tsx`.

---

## 1. Purpose and scope

| Concern | Monitor | Payroll Jobs |
|---|---|---|
| Question | Is generation live, and how far along? | What is the status of a chosen week / frequency? |
| Clients | Payroll-enabled with **Monitor** on, scanned together | One client at a time |
| Week | Always **previous completed WFM week** | User-selected (defaults to previous week) |
| Frequency / `TA_PAY_FILE_GEN_PROCESS` | Not queried at scan time | Queried and filterable |
| Adj outstanding (`TA_COST_SEG_DIFF` vs `TA_DIFF_PAY_DETAIL`) | Not used | Used when adj is enabled |
| Product features | Not re-read (uses last sync) | Sync writes `payrollEnabled`, cycle, file-gen |

Gating:

- Config key: `display.payrollMonitorEnabled` (default `false`) — global feature flag
- Per-client: `Client.payrollMonitorEnabled` (default `true`) — toggled on **Payroll Jobs** (`PATCH /api/payroll/:clientId/monitor`, requires `PAYROLL_SYNC` write). Disabled clients are omitted from Monitor scans and payroll deadline alerts (open alerts are cleared on disable).
- Permission: `PAYROLL_MONITOR_VIEW` (Monitor) / `PAYROLL_VIEW` (Jobs) / `PAYROLL_DETAILS_VIEW` (per-unit release status on Jobs)
- Menu + APIs are hidden/404 until the global flag is true

### Local SLA deadline (not EXEC_CRON)

Per-client completion SLA is stored in local SQLite on `Client`. The **picker shape follows the selected pay frequency** on Payroll Jobs:

| Frequency | Picker | Stored fields |
|---|---|---|
| Weekly (`WK`) | Weekday (Mon–Sun) + time | `payrollDeadlineDaysAfterWeekEnd` (0–7) + `payrollDeadlineLocalTime` |
| Bi-Weekly (`BW`) | Days after period end (0–14) + time | `payrollDeadlineDaysAfterWeekEnd` (0–14) + `payrollDeadlineLocalTime` |
| Semi-Monthly (`SM`) / Gregorian Month (`GM`) | Day of month (1–28) + time | `payrollDeadlineDayOfMonth` + `payrollDeadlineLocalTime` |

Saving one shape clears the other offset field so only one rule is active. `deadlineAt` is still anchored to the Monitor / status **pay week-end** in the client timezone:

- WK / BW: `weekEndDate + days @ localTime`
- SM / GM: first calendar date with that day-of-month **on or after** `weekEndDate`, at `localTime`

A row is **late** when the deadline is set, `now >= deadlineAt`, and mapped units are still pending. This is separate from WFM `EXEC_CRON` release / stalled detection.

Edit on **Payroll Jobs** (`PATCH /api/payroll/:clientId/deadline`, requires `PAYROLL_SYNC` write). Body: `{ frequency, localTime, daysAfterWeekEnd? | dayOfMonth?, clear? }`. Monitor shows a late banner, row badges, and `deadline` under the release schedule column.

When units are still pending after `deadlineAt` **and** outside the Live (±) window, an alert is stored on `PayrollDeadlineAlert` and shown in **Alerts → Escalated** (acknowledge / suppress / **resolve with reason**, same idea as Unproc Punch for ack/suppress). Resolve requires a reason (`ALERTS_ACK`); the alert leaves Escalated immediately and stays closed for that pay week even if units are still pending. **Resolve also clears Late attention** on the home Payroll widget and Payroll Monitor for that pay week (phase is no longer Late; a muted **Resolved** badge may still show while units remain pending). Use this when leftover units are intentional (e.g. not releasing that store this week). Those incidents also appear in **Alerts → Reports** (monthly/quarterly escalation report, CSV, and PDF) alongside queue-buildup and punch alerts, including `resolvedBy` / `resolveReason` when manually resolved. **Notify Team** sends one email to the active notification recipients covering open stuck jobs, payroll deadlines, and unprocessed punches (`ALERTS_NOTIFY`), with the same cooldown as other escalated alerts. Opening that tab re-scans clients that have a deadline **after** the all-batch-status fetch is idle (same sequencing as Payroll Monitor auto-refresh). The alert also clears automatically when the week is no longer late.

---

## 2. High-level flow

```
UI  GET /api/payroll/monitor
        │
        ├─ 0. SQLite: payroll-enabled active clients
        │
        └─ for each client (concurrency 5)
              ├─ 1. RFX_QUEUE   (running pay generators)     ─┐ parallel
              ├─ 2. RWS_CALENDAR (weeks + today)              ─┘
              │         ↓ pick previous week
              └─ 3. TA_UNIT_PAY_STATUS  (unit counts for that week)
                        ↓ classify phase: late | live | upcoming | complete | unknown

UI  GET /api/payroll/monitor/:clientId   (right pane)
        same 1 + 2, then unit+file rows instead of counts
```

Phase is computed in memory. There is no payroll-status table on the client DB2.

---

## 3. Who is scanned

Local SQLite (not DB2), once per snapshot:

```text
clients WHERE payrollEnabled = true
          AND payrollMonitorEnabled = true
          AND isActive = true
          AND db2Host IS NOT NULL
ORDER BY clientId
```

`payrollEnabled` comes from an earlier Payroll Jobs **feature sync**, not from Monitor:

```sql
SELECT FEATURE_ID, FEATURE_VALUE
FROM RWSUSER.PRODUCT_FEATURE
WHERE FEATURE_ID IN (
  'RTA_INTEGRATION',
  'PRIOR_PERIOD_EDIT',
  'PRIOR_PERIOD_EDIT_LIMIT',
  'PAYROLL_FILE_GEN'
)
```

`RTA_INTEGRATION = 'Y'` → `payrollEnabled`. Frequencies come from `TA_PAY_FILE_GEN_PROCESS` during that same sync and are stored on the local client row (`payrollCycle`). Monitor **displays** those stored frequencies; it does not re-query them.

`payrollMonitorEnabled` is a **local** flag (not a WFM product feature). Edit it on Payroll Jobs; default is on so existing clients stay on Monitor until explicitly disabled.

A client that just got RTA will not appear on Monitor until Payroll Jobs sync has run. A client with Monitor disabled will not appear even when payroll-enabled.

---

## 4. Query sequence (per client)

Placeholders: `{previousWeekEnd}` is `yyyyMMdd` integer, e.g. `20260906`.

### Snapshot — `GET /api/payroll/monitor`

**Query 1 and Query 2 run in parallel. Query 3 waits for the week from Query 2.**

#### Query 1 — pay generator queue (`Payroll/MonitorQueue`)

```sql
SELECT q.QUEUE_ID, q.JOB_TYPE, q.EXEC_CRON, q.QUEUE_SLEEP,
       q.LAST_JOB_TIME, q.JOBS_PENDING, q.QUEUE_STATUS,
       s.PARAM_3 AS DIST_LIST_ID,
       d.NAME AS DIST_LIST_NAME
FROM RWSUSER.RFX_QUEUE q
LEFT JOIN RWSUSER.STD_QUEUE_JOB s ON s.QUEUE_ID = q.QUEUE_ID
LEFT JOIN RWSUSER.RWS_DIST_LIST d
  ON TRIM(CAST(d.DIST_LIST_ID AS VARCHAR(32))) = TRIM(CAST(s.PARAM_3 AS VARCHAR(32)))
WHERE q.QUEUE_STATUS = 'R'
```

SQL keeps only **running** rows (`QUEUE_STATUS = 'R'`). Paused (`P`) generators are ignored. Among running regular pay generators the app picks **either-or** by priority:

| Priority | `JOB_TYPE` contains | Typical scope |
|---|---|---|
| 1 | `RTAPayrollFeedGeneratorJob` | Client-wide (`PARAM_3` often empty → `distListId = ALL`) |
| 2 | `RTANewPayFileGeneratorJob` | Store group (`PARAM_3` = `DIST_LIST_ID`; name from `RWS_DIST_LIST.NAME`) |
| 3 | `RTA_PAYROLL_FILE_GEN` | Legacy / client-wide |

If the preferred family has numeric `PARAM_3` values, one monitor row is emitted per store group (with `distListName` when the join matches). If not, a single client-wide row (`ALL`) counts all `TA_UNIT_PAY_STATUS` units for the previous week.

Example: BP clients keep a paused Feed job and running NewPay store-group jobs — Monitor picks NewPay. DJ has running Feed and paused NewPay — Monitor picks Feed.

#### Query 2 — calendar / weeks (`Payroll/Calendar`)

```sql
SELECT DISTINCT
  VARCHAR_FORMAT(WEEK_START_DATE, 'yyyyMMdd') AS WEEK_START_DATE,
  VARCHAR_FORMAT(WEEK_END_DATE,   'yyyyMMdd') AS WEEK_END_DATE,
  VARCHAR_FORMAT(CURRENT DATE,    'yyyyMMdd') AS TODAY_YMD
FROM RWSUSER.RWS_CALENDAR
WHERE YEAR_NO = YEAR(CURRENT DATE)
   OR YEAR(WEEK_END_DATE) = YEAR(CURRENT DATE)
ORDER BY 1
```

Week selection (`defaultPayWeekEnd` in `backend/src/constants/payroll.ts`):

1. **Current week** = `WEEK_START_DATE <= TODAY <= WEEK_END_DATE`
2. **Previous week** = the distinct `WEEK_END_DATE` immediately before current
3. If only one week exists, fall back to the current week
4. Dates are normalized from DB2 `TIMESTAMP` / ISO / `yyyyMMdd` to `yyyyMMdd`

Weekly, bi-weekly, semi-monthly, and GM clients all use this same calendar week. Monitor does not pick a period from `TA_PAY_FILE_GEN_PROCESS`.

#### Query 3 — unit counts (`Payroll/MonitorCounts`)

```sql
SELECT
  COUNT(*) AS TOTAL_CNT,
  SUM(CASE WHEN UPPER(TRIM(COALESCE(FILE_STATUS, ''))) = 'F' THEN 1 ELSE 0 END) AS F_CNT,
  SUM(CASE WHEN UPPER(TRIM(COALESCE(FILE_STATUS, ''))) = 'D' THEN 1 ELSE 0 END) AS D_CNT,
  SUM(CASE WHEN UPPER(TRIM(COALESCE(FILE_STATUS, ''))) = 'Q' THEN 1 ELSE 0 END) AS Q_CNT,
  SUM(CASE WHEN UPPER(TRIM(COALESCE(FILE_STATUS, ''))) NOT IN ('F', 'D', 'Q') THEN 1 ELSE 0 END) AS BLANK_CNT
FROM RWSUSER.TA_UNIT_PAY_STATUS
WHERE INTEGER(WEEK_END_DATE) = {previousWeekEnd}
```

- `FILE_STATUS = 'F'` → generated (`PAY_FILE_GENERATED_STATUS`); `generated` = `F_CNT`
- **Expected store count (denominator):** prior calendar week's `FILE_STATUS=F` count (same store-group scope). Display is `thisWeekF / priorWeekF` (e.g. DJ `40/53` means 40 generated this week vs 53 that had F last week).
- `pending = expected - generated` (`max(0, priorWeekF - thisWeekF)`); falls back to current-week row count only when prior-week F is unavailable
- Responses still include `priorWeek: { weekEndDate, total, generated }` for the baseline week label
- **Status breakdown (`units.byStatus`):** this-week counts for `F` / `D` / `Q` / `blank` (null, empty, or any other code). Monitor UI shows a stacked color bar (green / orange / yellow / grey) plus a count legend; the detail pane colors each unit's status the same way.
- No `UNIT_GRP_ID` / store-group filter

---

### Detail — `GET /api/payroll/monitor/:clientId`

Same **Query 1** and **Query 2**, same previous-week rule, then unit rows instead of counts.

#### Query 3a — unit + file (`Payroll/UnitStatus`)

```sql
SELECT
  u.UNIT_ID, u.WEEK_START_DATE, u.WEEK_END_DATE,
  u.FILE_STATUS, u.FILE_ID,
  f.CREATION_TIME, f.LAST_UPDATE_TIME, f.FILE_NAME
FROM RWSUSER.TA_UNIT_PAY_STATUS u
LEFT JOIN RWSUSER.TA_PAY_FILE f ON f.FILE_ID = u.FILE_ID
WHERE INTEGER(u.WEEK_END_DATE) = {previousWeekEnd}
ORDER BY u.UNIT_ID
```

`TA_PAY_FILE.CREATION_TIME` / `LAST_UPDATE_TIME` are WFM compact `yyyyMMddHHmmss` (BIGINT), not epoch millis. Monitor loads them but the right pane currently shows **RFX_QUEUE.LAST_JOB_TIME**, not per-file generation time.

#### Query 3b — fallback if the join fails (`Payroll/UnitStatusFallback`)

```sql
SELECT UNIT_ID, WEEK_START_DATE, WEEK_END_DATE, FILE_STATUS, FILE_ID
FROM RWSUSER.TA_UNIT_PAY_STATUS
WHERE INTEGER(WEEK_END_DATE) = {previousWeekEnd}
ORDER BY UNIT_ID
```

---

## 5. Phase classification

Computed from the **regular** queue job + unit counts + optional SLA deadline. The adjustment job is fetched but **not** used for phase, list columns, or the detail pane.

```
if units.total > 0 AND units.pending === 0                         → complete
else if within ± liveWindowHours of deadlineAt AND pending > 0     → live
         (no deadlineAt → fallback: release due … due+window)
else if past deadlineAt AND outside Live window AND pending > 0
         AND deadline alert not resolved for this weekEndDate      → late   (Escalated)
else if units.pending > 0                                          → upcoming
else if release due in the future                                  → upcoming
else                                                               → unknown
```

| Phase | Meaning on the board |
|---|---|
| **Late** | Past client SLA deadline **and** outside the Live (±) window, with units still pending — Escalated alert path |
| **Live** | Now within **± 12 hours** of the SLA `deadlineAt` (configurable `threshold.payrollLiveWindowHours`) with units still pending. Without a deadline, falls back to EXEC_CRON due … due+window |
| **Upcoming** | Units pending but outside the Live window (e.g. days before SLA) |
| **Complete** | At least one expected unit, all generated (`pending === 0`) |
| **Unknown** | No unit rows, scan error, or none of the above |

Sort: Late → Live → Upcoming → Complete → Unknown, then `clientId`.

Consequences:

- Live is anchored on the **SLA deadline**, not on EXEC_CRON alone. A running generator days before the deadline is **Upcoming**, not Live.
- Inside ±12h of deadline (including up to 12h after) with pending → **Live**. After that window with pending → **Late** (+ Escalated).
- If the deadline alert is **resolved** for that `weekEndDate`, Late attention is suppressed (dashboard + Monitor) until the next pay week.
- Job running, `JOBS_PENDING = 0`, all units already `F` → **Complete**, not Live
- Adj-only run with no regular job → looks idle (phase from units / deadline / Live window only)

---

## 6. API and UI

| Method | Path | Timeout | Role |
|---|---|---|---|
| `GET` | `/api/payroll/monitor` | 180s | Full snapshot (all clients; kept for compatibility) |
| `GET` | `/api/payroll/monitor/clients` | — | Fast SQLite list of payroll-enabled clients |
| `GET` | `/api/payroll/monitor/client/:clientId` | 120s | Progressive scan for one client (store-group rows) |
| `GET` | `/api/payroll/monitor/:clientId?distListId=` | 120s | Unit list for one store group |

UI loads **progressively**: client list first, then each client is scanned with bounded concurrency. Last snapshot is kept in React Query cache (`payroll-monitor-progressive`) so navigating away and back shows prior rows immediately; a background refresh updates clients one-by-one without clearing the table.

---

## 7. Code map

| Piece | Location |
|---|---|
| Service + query builders | `backend/src/services/payroll-service.ts` — `getMonitorSnapshot`, `getMonitorDetail`, `scanMonitorClient`, `fetchPayQueueJobs`, `fetchPeriods`, `fetchUnitCounts`, `fetchUnitPayStatus` |
| Routes / feature gate | `backend/src/routes/payroll.ts` |
| Job names, week helper, calendar SQL | `backend/src/constants/payroll.ts` |
| Feature flag | `display.payrollMonitorEnabled` in `backend/src/constants/app-display.ts` |
| SQL catalogue | `database/client-db2-queries.sql` |
| UI | `frontend/src/components/Payroll/PayrollMonitor.tsx` |
| API client | `frontend/src/services/api.ts` — `payrollApi.getMonitorSnapshot` / `getMonitorDetail` |
| Tests (week + job-name helpers) | `backend/tests/unit/payroll.test.ts` |

---

## 8. Known correctness caveats

Change these first if results look wrong.

1. **Only `QUEUE_STATUS = 'R'`.** Idle generators do not contribute `LAST_JOB_TIME` / `JOBS_PENDING`. To show last run when idle, drop the `'R'` filter or query that `JOB_TYPE` without status.

2. **Previous week is calendar-based, not pay-cycle-based.** Monitor always uses the previous `RWS_CALENDAR` week. Payroll Jobs shapes periods by frequency via `periodsForFrequency` (BW = paired 14-day weeks, SM = 1–15 / 16–EOM, GM = calendar months); SM/GM status queries map period end onto the last RWS week-end on or before that date.

3. **Year boundary.** Calendar SQL is current-year only (`YEAR_NO` / `YEAR(WEEK_END_DATE)`). In early January the true previous week can be last December and get missed.

4. **Late vs Live vs Upcoming** — Live only while due / due within the last 6h (or generator running). Older Sunday crons with pending units are Upcoming; past SLA is Late.

5. **No store-group filter.** All `TA_UNIT_PAY_STATUS` rows for that week-end are counted. `UNIT_GRP_ID` from `TA_PAY_FILE_GEN_PROCESS` is ignored, so extra units can inflate total/pending.

6. **Adjustment is unused for display/phase.** An adj-only run looks idle on the board.

7. **`FILE_STATUS = 'F'` is the only generated signal.** Any other code (blank, `P`, `G`, …) counts as pending.

8. **Feature sync is stale.** Monitor does not re-read `PRODUCT_FEATURE`.

9. **Job-name match is substring, in app code.** Unexpected `JOB_TYPE` strings that contain those names will be classified; names that differ will be ignored.

10. **Detail pane “Generated at” is queue last-job time**, not `TA_PAY_FILE.LAST_UPDATE_TIME`.

---

## 9. Queries Monitor does **not** run

These belong to Payroll Jobs (or sync), not the monitor scan:

```sql
-- frequencies / cycle (sync + Payroll Jobs)
SELECT DISTINCT FREQUENCY
FROM RWSUSER.TA_PAY_FILE_GEN_PROCESS
WHERE FREQUENCY IS NOT NULL

SELECT FREQUENCY, UNIT_GRP_ID, FILE_TYPE, SPLIT_PAYFILE,
       PRIOR_PERIOD_ADJ_LIMIT, REOPEN_FOR_EDITS, PAY_CONFIG_NAME
FROM RWSUSER.TA_PAY_FILE_GEN_PROCESS

-- running jobs, JOB_TYPE only (Payroll Jobs generators widget)
SELECT JOB_TYPE FROM RWSUSER.RFX_QUEUE
WHERE QUEUE_STATUS = 'R'

-- adj outstanding (Payroll Jobs)
SELECT
  (SELECT COUNT(*) FROM RWSUSER.TA_COST_SEG_DIFF
    WHERE INTEGER(PAY_WEEK_END_DATE) = {weekEndDate}) AS COST_SEG_CNT,
  (SELECT COUNT(*) FROM RWSUSER.TA_DIFF_PAY_DETAIL
    WHERE INTEGER(PAY_WEEK_END_DATE) = {weekEndDate}) AS DIFF_PAY_CNT
FROM SYSIBM.SYSDUMMY1
```

---

## 10. Changing results

Typical edits, mapped to the sequence:

| Symptom | Likely change |
|---|---|
| Wrong week | Query 2 filter and/or `defaultPayWeekEnd` |
| Missing Live / blank last job time | Query 1 `QUEUE_STATUS` filter |
| Wrong unit counts | Query 3 week predicate and/or `FILE_STATUS` / unit-group filter |
| Wrong client list | SQLite `payrollEnabled` sync, not Monitor SQL |
| Adj run invisible | Include adjustment in `classifyPhase` and UI |
| GM/SM period wrong (Jobs) | Jobs uses `periodsForFrequency` (calendar month / half-month); Monitor still weekly |
