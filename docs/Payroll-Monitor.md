# Payroll Monitor — Design Reference

Live status board for **pay-file generation in progress**. It answers: *is this client’s pay-file generator running right now, and how far has previous-week unit generation gone?*

It is **not** a historical payroll report. Payroll Jobs (`/payroll`) is the per-client drill-down with week/frequency pickers and adj outstanding. Monitor (`/payroll-monitor`) is a cross-client snapshot of the current generation run.

Canonical SQL copies also live in `database/client-db2-queries.sql` (section *payroll monitor*). Implementation: `backend/src/services/payroll-service.ts`, `backend/src/routes/payroll.ts`, `frontend/src/components/Payroll/PayrollMonitor.tsx`.

---

## 1. Purpose and scope

| Concern | Monitor | Payroll Jobs |
|---|---|---|
| Question | Is generation live, and how far along? | What is the status of a chosen week / frequency? |
| Clients | All payroll-enabled, scanned together | One client at a time |
| Week | Always **previous completed WFM week** | User-selected (defaults to previous week) |
| Frequency / `TA_PAY_FILE_GEN_PROCESS` | Not queried at scan time | Queried and filterable |
| Adj outstanding (`TA_COST_SEG_DIFF` vs `TA_DIFF_PAY_DETAIL`) | Not used | Used when adj is enabled |
| Product features | Not re-read (uses last sync) | Sync writes `payrollEnabled`, cycle, file-gen |

Gating:

- Config key: `display.payrollMonitorEnabled` (default `false`)
- Permission: `PAYROLL_VIEW`
- Menu + APIs are hidden/404 until the flag is true

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
                        ↓ classify phase: live | upcoming | complete | unknown

UI  GET /api/payroll/monitor/:clientId   (right pane)
        same 1 + 2, then unit+file rows instead of counts
```

Phase is computed in memory. There is no payroll-status table on the client DB2.

---

## 3. Who is scanned

Local SQLite (not DB2), once per snapshot:

```text
clients WHERE payrollEnabled = true
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

A client that just got RTA will not appear on Monitor until Payroll Jobs sync has run.

---

## 4. Query sequence (per client)

Placeholders: `{previousWeekEnd}` is `yyyyMMdd` integer, e.g. `20260906`.

### Snapshot — `GET /api/payroll/monitor`

**Query 1 and Query 2 run in parallel. Query 3 waits for the week from Query 2.**

#### Query 1 — running queue jobs (`Payroll/MonitorQueue`)

```sql
SELECT q.JOB_TYPE, q.LAST_JOB_TIME, q.JOBS_PENDING, q.QUEUE_STATUS
FROM RWSUSER.RFX_QUEUE q
WHERE q.QUEUE_STATUS = 'R'
```

SQL does **not** filter by job name. The app keeps only pay generators by substring match on `JOB_TYPE`:

| Kind | `JOB_TYPE` contains |
|---|---|
| Regular | `RTANewPayFileGeneratorJob`, `RTAPayrollFeedGeneratorJob`, `RTA_PAYROLL_FILE_GEN` |
| Adjustment | `RTAPriorAdjPayGeneratorJob` |

If several regular (or adj) jobs are running, the row with the **highest `JOBS_PENDING`** wins.

`QUEUE_STATUS = 'R'` means running. Idle generator rows are ignored, so `LAST_JOB_TIME` / `JOBS_PENDING` are blank unless the job is running.

DB Jobs uses the same `'R'` filter, plus a `STD_QUEUE_JOB` join. Monitor does **not** join `STD_QUEUE_JOB`.

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
  SUM(CASE WHEN UPPER(FILE_STATUS) = 'F' THEN 1 ELSE 0 END) AS GENERATED_CNT
FROM RWSUSER.TA_UNIT_PAY_STATUS
WHERE INTEGER(WEEK_END_DATE) = {previousWeekEnd}
```

- `FILE_STATUS = 'F'` → generated (`PAY_FILE_GENERATED_STATUS`)
- `pending = total - generated`
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

Computed from the **regular** queue job + unit counts. The adjustment job is fetched but **not** used for phase, list columns, or the detail pane.

```
if regular.running AND (jobsPending > 0 OR units.pending > 0)  → live
else if units.total > 0 AND units.pending === 0                → complete
else if units.pending > 0                                      → upcoming
else                                                           → unknown
```

| Phase | Meaning on the board |
|---|---|
| **Live** | Regular pay job is running **and** there is still work (`JOBS_PENDING` or pending units) |
| **Upcoming** | Previous week still has units not `F` (job may or may not be running) |
| **Complete** | At least one unit row, all `FILE_STATUS = F` |
| **Unknown** | No unit rows, scan error, or none of the above |

Sort: Live → Upcoming → Complete → Unknown, then `clientId`.

Consequences:

- Job running, `JOBS_PENDING = 0`, all units already `F` → **Complete**, not Live
- Units pending, job not running → **Upcoming**, never Live
- Adj-only run with no regular job → looks idle (phase from units only)

---

## 6. API and UI

| Method | Path | Timeout | Role |
|---|---|---|---|
| `GET` | `/api/payroll/monitor` | 180s | Snapshot of all payroll-enabled clients |
| `GET` | `/api/payroll/monitor/:clientId` | 120s | Unit list for one client |

Response snapshot fields (per row): `clientId`, `name`, `timezone`, `frequencies`, `payrollFileGen`, `weekStartDate`, `weekEndDate`, `regular`, `adjustment`, `units { total, generated, pending }`, `phase`, optional `error`.

Polling (frontend only; no extra query types):

| Surface | Interval |
|---|---|
| List | 20s if any client is Live, else 60s |
| Detail | 10s only while the selected client is Live |

UI columns: Client (with frequency + week end), Status, Generator (`regular.jobType`), Last job time (`regular.lastJobTime` via `fmtDb2` / client timezone), Queue pending (`regular.jobsPending` only if running), Units (generated/total bar).

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

2. **Previous week is calendar-based, not pay-cycle-based.** GM / SM / BW may need a different period than `RWS_CALENDAR` week, or dates from `TA_PAY_FILE_GEN_PROCESS`.

3. **Year boundary.** Calendar SQL is current-year only (`YEAR_NO` / `YEAR(WEEK_END_DATE)`). In early January the true previous week can be last December and get missed.

4. **Live vs Complete vs Upcoming** — see phase table above. “Generator process exists” is not enough for Live.

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
| GM/SM period wrong | Do not reuse weekly calendar; read pay-cycle dates |
