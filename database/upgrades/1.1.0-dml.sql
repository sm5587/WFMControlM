-- ============================================================
-- WFM Watch 1.1.0 — incremental DML (upgrade from 1.0.0)
-- ============================================================
-- Apply once on an existing SQLite config DB when upgrading to 1.1.0
-- (after 1.1.0-ddl.sql if that file is used on this path):
--
--   node scripts/apply-sql.js ../database/upgrades/1.1.0-dml.sql
--
-- Fresh installs: first-time-deployment-dml.sql already includes these rows;
-- still apply this file only if your bootstrap DML is older than 1.1.0.
--
-- Mirrors Prisma migrations / seed additions:
--   20260923140000_add_advanced_monitor_profile
--   20260923153000_collapse_users_profiles_manage
--   20260928140000_add_custom_alerts_permissions
--   display.externalTools (AppConfig) — also ensured at backend startup
--   engine.wfmVersionSyncSchedule (AppConfig) — also ensured at backend startup
-- ============================================================

-- ---- AppConfig: rename product display name (only if still default) ----
UPDATE "AppConfig"
SET "value" = 'Workcloud Pulse',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'display.appName'
  AND "value" = 'WFM Watch';

-- ---- AppConfig: Daily WFM app version sync ----
INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
VALUES (
  'engine.wfmVersionSyncSchedule',
  '0 4 * * *',
  'ENGINE',
  'Daily WFM Version Sync Schedule',
  'Cron expression for daily refresh of client WFM app version (RFX_CONFIG APPURL + /reflexisversion.txt). Requires restart to change.',
  0,
  'system',
  CURRENT_TIMESTAMP
);

-- ---- AppConfig: External Tools waffle menu ----
INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
VALUES (
  'display.externalTools',
  '[]',
  'DISPLAY',
  'External Tools Menu',
  'Managed via Admin → Config → External Tools panel (label, URL, icon, profiles). Empty list hides the waffle menu.',
  0,
  'system',
  CURRENT_TIMESTAMP
);

-- ---- AppConfig: Payroll Live window (± hours around SLA deadline) ----
INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
VALUES (
  'threshold.payrollLiveWindowHours',
  '12',
  'THRESHOLDS',
  'Payroll Live Window (hours)',
  'Mark store group Live while now is within ± X hours of the SLA deadline (still pending). Past deadline and outside that window → Late. No deadline → fallback to EXEC_CRON due … due+X hours.',
  0,
  'system',
  CURRENT_TIMESTAMP
);

UPDATE "AppConfig"
SET "value" = '12',
    "description" = 'Mark store group Live while now is within ± X hours of the SLA deadline (still pending). Past deadline and outside that window → Late. No deadline → fallback to EXEC_CRON due … due+X hours.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'threshold.payrollLiveWindowHours'
  AND "value" = '6';

-- ---- AppFunction: Payroll Jobs unit details ----
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('PAYROLL_DETAILS_VIEW', 'Payroll Jobs', 'Payroll Jobs — Unit Details', 'View per-unit pay file release status on Payroll Jobs', 73);

-- ---- System profile: Advanced Monitor ----
INSERT OR IGNORE INTO "Profile" ("id", "name", "description", "isSystem", "createdAt", "updatedAt")
VALUES (
  'b7e3c914-2a5f-4d8e-9c1b-6f0a8d3e5c27',
  'Advanced Monitor',
  'Operational write access beyond Monitor (alerts, sync, maintenance, payroll) — no users/profiles/config admin',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.functionId, 1, fn.canWrite
FROM "Profile" p
CROSS JOIN (
  SELECT 'ALERTS_VIEW' AS functionId, 0 AS canWrite UNION ALL
  SELECT 'ALERTS_RULES', 0 UNION ALL
  SELECT 'ALERTS_ACK', 1 UNION ALL
  SELECT 'ALERTS_SUPPRESS', 1 UNION ALL
  SELECT 'ALERTS_NOTIFY', 1 UNION ALL
  SELECT 'RECIPIENTS_MANAGE', 0 UNION ALL
  SELECT 'CLIENTS_VIEW', 0 UNION ALL
  SELECT 'CLIENTS_CREATE', 0 UNION ALL
  SELECT 'CLIENTS_EDIT', 0 UNION ALL
  SELECT 'CLIENTS_SYNC', 1 UNION ALL
  SELECT 'CLIENTS_DETECT_TZ', 1 UNION ALL
  SELECT 'JOBS_VIEW', 0 UNION ALL
  SELECT 'JOBS_CREATE', 0 UNION ALL
  SELECT 'JOBS_EDIT', 1 UNION ALL
  SELECT 'JOBS_TOGGLE', 1 UNION ALL
  SELECT 'JOBS_TRIGGER', 1 UNION ALL
  SELECT 'JOBS_LOG_TAIL', 1 UNION ALL
  SELECT 'DBMONITOR_VIEW', 0 UNION ALL
  SELECT 'DBJOBS_VIEW', 0 UNION ALL
  SELECT 'MONITOR_VIEW', 0 UNION ALL
  SELECT 'PAYROLL_VIEW', 0 UNION ALL
  SELECT 'PAYROLL_MONITOR_VIEW', 0 UNION ALL
  SELECT 'PAYROLL_SYNC', 1 UNION ALL
  SELECT 'PAYROLL_DETAILS_VIEW', 0 UNION ALL
  SELECT 'UNPROC_PUNCH_VIEW', 0 UNION ALL
  SELECT 'UNPROC_PUNCH_REFRESH_ALL', 1 UNION ALL
  SELECT 'UNPROC_PUNCH_REFRESH_HIGH', 1 UNION ALL
  SELECT 'UNPROC_PUNCH_REFRESH_ROW', 1 UNION ALL
  SELECT 'MAINTENANCE_VIEW', 0 UNION ALL
  SELECT 'MAINTENANCE_MANAGE', 1 UNION ALL
  SELECT 'OUTAGE_VIEW', 0 UNION ALL
  SELECT 'FILE_MONITOR_VIEW', 0 UNION ALL
  SELECT 'USERS_VIEW', 0 UNION ALL
  SELECT 'PROFILES_VIEW', 0 UNION ALL
  SELECT 'DATA_PURGE_VIEW', 0 UNION ALL
  SELECT 'DATA_PURGE_RUN', 0
) fn
INNER JOIN "AppFunction" af ON af.id = fn.functionId
WHERE p."isSystem" = 1 AND p.name = 'Advanced Monitor';

-- ---- Collapse Users/Profiles Manage into View write ----
UPDATE "Permission"
SET "canWrite" = 1
WHERE "functionId" = 'USERS_VIEW'
  AND "profileId" IN (
    SELECT "profileId" FROM (
      SELECT "profileId" FROM "Permission"
      WHERE "functionId" = 'USERS_MANAGE' AND "canWrite" = 1
    )
  );

UPDATE "Permission"
SET "canWrite" = 1
WHERE "functionId" = 'PROFILES_VIEW'
  AND "profileId" IN (
    SELECT "profileId" FROM (
      SELECT "profileId" FROM "Permission"
      WHERE "functionId" = 'PROFILES_MANAGE' AND "canWrite" = 1
    )
  );

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p."profileId", 'USERS_VIEW', 1, CASE WHEN p."canWrite" = 1 THEN 1 ELSE 0 END
FROM "Permission" p
WHERE p."functionId" = 'USERS_MANAGE';

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p."profileId", 'PROFILES_VIEW', 1, CASE WHEN p."canWrite" = 1 THEN 1 ELSE 0 END
FROM "Permission" p
WHERE p."functionId" = 'PROFILES_MANAGE';

DELETE FROM "Permission" WHERE "functionId" IN ('USERS_MANAGE', 'PROFILES_MANAGE');
DELETE FROM "AppFunction" WHERE "id" IN ('USERS_MANAGE', 'PROFILES_MANAGE');

UPDATE "AppFunction"
SET "description" = 'Read: view users & access requests. Write: edit users, approve/reject requests, revoke sessions.'
WHERE "id" = 'USERS_VIEW';

UPDATE "AppFunction"
SET "description" = 'Read: view profiles. Write: create/edit/delete profiles (permission matrix still needs Config write).'
WHERE "id" = 'PROFILES_VIEW';

-- ---- Payroll Jobs — Unit Details permission grants ----
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, 'PAYROLL_DETAILS_VIEW', 1, 1
FROM "Profile" p
WHERE p."isSystem" = 1 AND p.name = 'System Admin';

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, 'PAYROLL_DETAILS_VIEW', 1, 0
FROM "Profile" p
WHERE p."isSystem" = 1 AND p.name IN ('Monitor', 'Advanced Monitor', 'Read Only');

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT "profileId", 'PAYROLL_DETAILS_VIEW', "canRead", 0
FROM "Permission"
WHERE "functionId" = 'PAYROLL_VIEW' AND "canRead" = 1;

-- ---- Heat Map permission + config (HEATMAP_VIEW) ----
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder")
VALUES ('HEATMAP_VIEW', 'Heat Map', 'Heat Map', 'Weekly ITERATION_TYPE 6 vs 7 store count comparison', 74);

-- Migrate legacy WIP_HEATMAP_VIEW → HEATMAP_VIEW
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT "profileId", 'HEATMAP_VIEW', "canRead", "canWrite"
FROM "Permission"
WHERE "functionId" = 'WIP_HEATMAP_VIEW';

DELETE FROM "Permission" WHERE "functionId" = 'WIP_HEATMAP_VIEW';
DELETE FROM "AppFunction" WHERE "id" = 'WIP_HEATMAP_VIEW';

INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
VALUES (
  'display.heatMapEnabled',
  'true',
  'DISPLAY',
  'Heat Map Menu',
  'Show Heat Map screen and API (true/false)',
  0,
  'system',
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
VALUES (
  'polling.heatMapRefreshMins',
  '60',
  'POLLING',
  'Heat Map Refresh (min)',
  'Heat Map client scan refresh interval in minutes',
  0,
  'system',
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
VALUES (
  'polling.heatMapRefreshOffsetMins',
  '15',
  'POLLING',
  'Heat Map Refresh Offset (min)',
  'Phase offset so Heat Map auto-refresh does not align with other DB2 polls (0–59)',
  0,
  'system',
  CURRENT_TIMESTAMP
);

-- Migrate legacy display.wipHeatMapEnabled → display.heatMapEnabled
INSERT OR IGNORE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt")
SELECT
  'display.heatMapEnabled',
  "value",
  'DISPLAY',
  'Heat Map Menu',
  'Show Heat Map screen and API (true/false)',
  0,
  'system',
  CURRENT_TIMESTAMP
FROM "AppConfig"
WHERE "key" = 'display.wipHeatMapEnabled';

DELETE FROM "AppConfig" WHERE "key" = 'display.wipHeatMapEnabled';

UPDATE "AppConfig"
SET "label" = 'Heat Map Menu', "description" = 'Show Heat Map screen and API (true/false)'
WHERE "key" = 'display.heatMapEnabled';

UPDATE "AppConfig"
SET "value" = 'true', "updatedBy" = 'system', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'display.heatMapEnabled' AND "value" = 'false';

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, 'HEATMAP_VIEW', 1, 1
FROM "Profile" p
WHERE p."isSystem" = 1 AND p.name = 'System Admin';

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, 'HEATMAP_VIEW', 1, 0
FROM "Profile" p
WHERE p."isSystem" = 1 AND p.name IN ('Monitor', 'Advanced Monitor', 'Read Only');

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT "profileId", 'HEATMAP_VIEW', "canRead", 0
FROM "Permission"
WHERE "functionId" = 'PAYROLL_MONITOR_VIEW' AND "canRead" = 1;

-- ---- Custom Alerts permissions (Prisma 20260928140000) ----
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('CUSTOM_ALERTS_VIEW', 'Custom Alerts', 'Custom Alerts', NULL, 73),
  ('CUSTOM_ALERTS_MANAGE', 'Custom Alerts', 'Custom Alerts — Create / Edit / Delete', 'Create, edit, delete and run custom SQL threshold alerts', 74);

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 1
FROM "Profile" p
CROSS JOIN (
  SELECT 'CUSTOM_ALERTS_VIEW' AS id UNION ALL
  SELECT 'CUSTOM_ALERTS_MANAGE'
) fn
WHERE p."isSystem" = 1 AND p.name = 'System Admin';

INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 0
FROM "Profile" p
CROSS JOIN (
  SELECT 'CUSTOM_ALERTS_VIEW' AS id UNION ALL
  SELECT 'CUSTOM_ALERTS_MANAGE'
) fn
WHERE p."isSystem" = 1 AND p.name IN ('Monitor', 'Read Only');
