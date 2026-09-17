-- WFM Control-M consolidated production DML
--
-- FIRST-TIME DEPLOYMENT ONLY — seeds baseline reference/config data after
-- database/first-time-deployment-ddl.sql on a fresh database.
-- Do NOT re-run on live production (uses INSERT OR REPLACE and can overwrite AppConfig).
-- Regenerate first-time file: npm run db:extract:first-time
-- Regenerate dated snapshot: npm run db:extract
--
-- NOTE:
-- 1) Client/AppServer inventory is environment-specific and should be loaded
--    via import scripts/admin APIs, not hardcoded in this file.
-- 2) Replace placeholder secret values before production rollout.

-- ============================================================
-- APP FUNCTIONS (RBAC function registry)
-- ============================================================
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('JOBS_VIEW', 'Cron Jobs', 'Cron Jobs', NULL, 10),
  ('JOBS_CREATE', 'Cron Jobs', 'Cron Jobs — Create', NULL, 11),
  ('JOBS_EDIT', 'Cron Jobs', 'Cron Jobs — Edit', NULL, 12),
  ('JOBS_DELETE', 'Cron Jobs', 'Cron Jobs — Delete', NULL, 13),
  ('JOBS_TRIGGER', 'Cron Jobs', 'Cron Jobs — Run Now', NULL, 14),
  ('JOBS_TOGGLE', 'Cron Jobs', 'Cron Jobs — Enable / Disable', NULL, 15),
  ('JOBS_LOG_TAIL', 'Cron Jobs', 'Cron Jobs — Remote Log Tail', 'View remote batch log content via SSH', 16),
  ('CLIENTS_VIEW', 'Clients', 'Clients', NULL, 20),
  ('CLIENTS_CREATE', 'Clients', 'Clients — Add', NULL, 21),
  ('CLIENTS_EDIT', 'Clients', 'Clients — Edit', NULL, 22),
  ('CLIENTS_SYNC', 'Clients', 'Clients — Sync Jobs', NULL, 23),
  ('CLIENTS_DETECT_TZ', 'Clients', 'Clients — Detect Timezones', NULL, 24),
  ('ALERTS_VIEW', 'Alerts', 'Alerts', NULL, 30),
  ('ALERTS_RULES', 'Alerts', 'Alerts — Manage Rules', NULL, 31),
  ('ALERTS_ACK', 'Alerts', 'Alerts — Acknowledge', NULL, 32),
  ('ALERTS_SUPPRESS', 'Alerts', 'Alerts — Suppress', NULL, 33),
  ('ALERTS_NOTIFY', 'Alerts', 'Alerts — Send Email', NULL, 34),
  ('RECIPIENTS_MANAGE', 'Alerts', 'Alerts — Manage Recipients', NULL, 35),
  ('DBMONITOR_VIEW', 'DB Jobs Monitor', 'DB Jobs Monitor', NULL, 40),
  ('DBJOBS_VIEW', 'DB Jobs', 'DB Jobs', NULL, 50),
  ('MAINTENANCE_VIEW', 'Maintenance', 'Maintenance', NULL, 55),
  ('MAINTENANCE_MANAGE', 'Maintenance', 'Maintenance — Manage', NULL, 56),
  ('OUTAGE_VIEW', 'Maintenance', 'Maintenance — Outage Impact', NULL, 57),
  ('FILE_MONITOR_VIEW', 'Upload Monitor', 'Upload Monitor', NULL, 58),
  ('MONITOR_VIEW', 'Monitor', 'Monitor', NULL, 60),
  ('PAYROLL_VIEW', 'Payroll Jobs', 'Payroll Jobs', NULL, 70),
  ('PAYROLL_MONITOR_VIEW', 'Payroll Monitor', 'Payroll Monitor', NULL, 71),
  ('PAYROLL_SYNC', 'Payroll Jobs', 'Payroll Jobs — Sync Clients', 'Sync payroll product features from DB2', 72),
  ('UNPROC_PUNCH_VIEW', 'Unprocessed Punch', 'Unprocessed Punch', NULL, 75),
  ('UNPROC_PUNCH_REFRESH_ALL', 'Unprocessed Punch', 'Unprocessed Punch — Refresh All', 'Reload punch counts for all RTA clients from DB2', 76),
  ('UNPROC_PUNCH_REFRESH_HIGH', 'Unprocessed Punch', 'Unprocessed Punch — Refresh High Alert', 'Reload punch counts for high-alert clients (>500 pending)', 77),
  ('UNPROC_PUNCH_REFRESH_ROW', 'Unprocessed Punch', 'Unprocessed Punch — Refresh Client', 'Reload punch count for a single client from DB2', 78),
  ('USERS_VIEW', 'Admin', 'Users', NULL, 80),
  ('USERS_MANAGE', 'Admin', 'Users — Manage', NULL, 81),
  ('PROFILES_VIEW', 'Admin', 'Profiles', NULL, 82),
  ('PROFILES_MANAGE', 'Admin', 'Profiles — Manage', NULL, 83),
  ('PERMISSIONS_EDIT', 'Admin', 'Config', NULL, 84),
  ('USER_PROFILE_ASSIGN', 'Admin', 'Users — Assign Profiles', NULL, 85),
  ('DATA_PURGE_VIEW', 'Admin', 'Purge', NULL, 86),
  ('DATA_PURGE_RUN', 'Admin', 'Purge — Run / Configure', NULL, 87);

-- ============================================================
-- SYSTEM PROFILES
-- ============================================================
INSERT OR IGNORE INTO "Profile" ("id", "name", "description", "isSystem", "createdAt", "updatedAt") VALUES
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'Monitor', 'Read-only + send email notifications', 1, 1776517994275, 1776517994275),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'Read Only', 'View all data, no write access', 1, 1776517994284, 1776517994284),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'System Admin', 'Full access to all features', 1, 1776517994265, 1776517994265);

-- ============================================================
-- BOOTSTRAP ADMIN USER (MANDATORY: change password after first login)
-- ============================================================
-- username: admin
-- temporary password: ChangeMe123!
INSERT OR IGNORE INTO "User" ("id", "username", "email", "displayName", "passwordHash", "timezone", "isActive", "createdAt", "updatedAt", "tokenVersion") VALUES
  ('9081b93e-b4bd-4983-a7b8-38e144a88700', 'admin', 'admin@zebra.com', 'Administrator', '$2b$10$S.O00AxVmyL1PMwqBLNKsOrfpnBW3deIoe1/Bfa9tXZXSA5TvNWY2', 'Asia/Kolkata', 1, 1776517995071, 1783318905550, 0);

-- ============================================================
-- BOOTSTRAP ADMIN PROFILE ASSIGNMENT
-- ============================================================
INSERT OR IGNORE INTO "UserProfile" ("userId", "profileId", "assignedAt", "assignedBy") VALUES
  ('9081b93e-b4bd-4983-a7b8-38e144a88700', 'd0532f26-8b3a-463f-81a2-825e56a8cd32', 1776517995071, 'seed');

-- ============================================================
-- PROFILE PERMISSIONS
-- ============================================================
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite") VALUES
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'ALERTS_ACK', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'ALERTS_NOTIFY', 1, 1),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'ALERTS_RULES', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'ALERTS_SUPPRESS', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'ALERTS_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'CLIENTS_CREATE', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'CLIENTS_DETECT_TZ', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'CLIENTS_EDIT', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'CLIENTS_SYNC', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'CLIENTS_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'DATA_PURGE_RUN', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'DATA_PURGE_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'DBJOBS_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'DBMONITOR_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'FILE_MONITOR_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'JOBS_CREATE', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'JOBS_EDIT', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'JOBS_TOGGLE', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'JOBS_TRIGGER', 1, 1),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'JOBS_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'MAINTENANCE_MANAGE', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'MAINTENANCE_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'MONITOR_VIEW', 0, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'OUTAGE_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'PAYROLL_MONITOR_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'PAYROLL_SYNC', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'PAYROLL_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'PROFILES_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'RECIPIENTS_MANAGE', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'UNPROC_PUNCH_VIEW', 1, 0),
  ('889daec3-6c8e-421b-b6aa-1ae99e6d7d1e', 'USERS_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'ALERTS_ACK', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'ALERTS_NOTIFY', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'ALERTS_RULES', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'ALERTS_SUPPRESS', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'ALERTS_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'CLIENTS_CREATE', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'CLIENTS_DETECT_TZ', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'CLIENTS_EDIT', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'CLIENTS_SYNC', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'CLIENTS_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'DBJOBS_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'DBMONITOR_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'FILE_MONITOR_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'JOBS_CREATE', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'JOBS_EDIT', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'JOBS_TOGGLE', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'JOBS_TRIGGER', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'JOBS_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'MAINTENANCE_MANAGE', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'MAINTENANCE_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'MONITOR_VIEW', 0, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'OUTAGE_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'PAYROLL_MONITOR_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'PAYROLL_SYNC', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'PAYROLL_VIEW', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'RECIPIENTS_MANAGE', 1, 0),
  ('97e85fe1-6fb2-4b16-92eb-42ad62e6a756', 'UNPROC_PUNCH_VIEW', 1, 0),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'ALERTS_ACK', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'ALERTS_NOTIFY', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'ALERTS_RULES', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'ALERTS_SUPPRESS', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'ALERTS_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'CLIENTS_CREATE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'CLIENTS_DETECT_TZ', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'CLIENTS_EDIT', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'CLIENTS_SYNC', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'CLIENTS_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'DATA_PURGE_RUN', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'DATA_PURGE_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'DBJOBS_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'DBMONITOR_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'FILE_MONITOR_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_CREATE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_DELETE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_EDIT', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_LOG_TAIL', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_TOGGLE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_TRIGGER', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'JOBS_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'MAINTENANCE_MANAGE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'MAINTENANCE_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'MONITOR_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'OUTAGE_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'PAYROLL_MONITOR_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'PAYROLL_SYNC', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'PAYROLL_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'PERMISSIONS_EDIT', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'PROFILES_MANAGE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'PROFILES_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'RECIPIENTS_MANAGE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'UNPROC_PUNCH_REFRESH_ALL', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'UNPROC_PUNCH_REFRESH_HIGH', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'UNPROC_PUNCH_REFRESH_ROW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'UNPROC_PUNCH_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'USERS_MANAGE', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'USERS_VIEW', 1, 1),
  ('d0532f26-8b3a-463f-81a2-825e56a8cd32', 'USER_PROFILE_ASSIGN', 1, 1);

-- ============================================================
-- RESOURCE POOLS
-- ============================================================
INSERT OR REPLACE INTO "ResourcePool" ("id", "name", "description", "maxConcurrency", "currentUsage", "isActive", "createdAt", "updatedAt") VALUES
  ('rp-default', 'default', 'Default resource pool for general jobs', 20, 0, 1, 1781078694000, 1781078694000),
  ('rp-etl-pool', 'etl-pool', 'Data pipeline and ETL jobs', 10, 0, 1, 1781078694000, 1781078694000),
  ('rp-wfm-compute', 'wfm-compute', 'High-compute pool for WFM forecast and optimization', 5, 0, 1, 1781078694000, 1781078694000);

-- ============================================================
-- PURGE CONFIG
-- ============================================================
INSERT OR REPLACE INTO "PurgeConfig" ("id", "label", "retainDays", "enabled", "lastPurgeAt", "lastPurgeCount", "updatedAt") VALUES
  ('alertEvent', 'Alert Events', 60, 1, 1789072200269, 0, 1789072200271),
  ('auditLog', 'Audit Log', 90, 1, 1789072200301, 0, 1789072200303),
  ('cachedCronJob', 'Cached Cron Jobs', 7, 1, 1789072200344, 945, 1789072200346),
  ('escalatedAlert', 'Escalated Alerts', 90, 1, 1789072200354, 0, 1789072200356),
  ('jobExecution', 'Job Executions', 30, 1, 1789072205516, 52165, 1789072205557),
  ('syncHistory', 'Sync History', 30, 1, 1789072205713, 1037, 1789072205715);

-- ============================================================
-- NOTIFICATION RECIPIENTS (local / Mailpit testing)
-- ============================================================
INSERT OR IGNORE INTO "NotificationRecipient" ("id", "name", "email", "isActive", "createdAt", "updatedAt") VALUES
  ('78e6fbea-5eb0-4ae1-9447-1419d0cb6de2', 'Swapna', 'sm5587@zebra.com', 1, 1776245357088, 1776245357088),
  ('fa28706a-9e3d-4c9e-bf17-7c1e69a76c1c', 'Local Tester', 'test@localhost', 1, 1780574545099, 1780576018395);

-- ============================================================
-- APP CONFIG (runtime configuration defaults)
-- ============================================================
INSERT OR REPLACE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt") VALUES
  ('auth.masterTokenVersion', '0', 'AUTH', 'Master Token Version', 'Incremented to invalidate all master-account JWT sessions', 0, 'system', 1786963011462),
  ('display.appName', 'WFM Watch', 'DISPLAY', 'Application Name', 'Product name shown in UI, emails, and API health', 0, 'seed', 1781078694000),
  ('display.defaultTimezone', 'Asia/Kolkata', 'DISPLAY', 'Default Timezone', 'Default timezone when user has none set', 0, 'seed', 1781078694000),
  ('display.maintenanceAdHocWindows', 'false', 'DISPLAY', 'Maintenance Ad-hoc Windows Tab', 'Show Ad-hoc Windows tab on Maintenance page (true/false)', 0, 'admin', 1787552836785),
  ('display.panelMaxWidth', '700', 'DISPLAY', 'Panel Max Width (px)', 'Resizable panel max width in pixels', 0, 'seed', 1781078694000),
  ('display.panelMinWidth', '160', 'DISPLAY', 'Panel Min Width (px)', 'Resizable panel min width in pixels', 0, 'seed', 1781078694000),
  ('display.payrollEnabled', 'false', 'DISPLAY', 'Payroll Jobs Menu', 'Show Payroll Jobs screen and API (true/false)', 0, 'admin', 1789618950439),
  ('display.payrollMonitorEnabled', 'false', 'DISPLAY', 'Payroll Monitor Menu', 'Show Payroll Monitor screen and API (true/false)', 0, 'admin', 1789618950458),
  ('display.showUnprocPunchTab', 'false', 'DISPLAY', 'Unprocessed Punch Alerts Tab', 'Show Unprocessed Punch tab on Alerts page (true/false)', 0, 'admin', 1787552595619),
  ('display.wsReconnectAttempts', '10', 'DISPLAY', 'WS Reconnect Attempts', 'WebSocket max reconnection attempts', 0, 'seed', 1781078694000),
  ('display.wsReconnectDelayMs', '1000', 'DISPLAY', 'WS Reconnect Delay (ms)', 'WebSocket reconnect delay in ms', 0, 'seed', 1781078694000),
  ('engine.autoEscalationNotifyEnabled', 'true', 'ENGINE', 'Auto Escalation Email', 'When true, automatically email notification recipients and system-acknowledge escalated alerts for Default Suppress (min) after they cross the escalation threshold.', 0, 'system', 1787551986850),
  ('engine.batchQueryDays', '7', 'ENGINE', 'Batch Query Days', 'Default batch status query window in days', 0, 'seed', 1781078694000),
  ('engine.cronSyncSchedule', '0 3 * * *', 'ENGINE', 'Daily Cron Sync Schedule', 'Cron expression for automatic nightly cron discovery from all appservers (server local time). Requires restart to change.', 0, 'system', 1787546240932),
  ('engine.db2QueryConcurrency', '5', 'ENGINE', 'DB2 Query Concurrency', 'Concurrent per-client DB2 queries', 0, 'seed', 1781078694000),
  ('engine.dbJobsSyncEnabled', 'true', 'ENGINE', 'DB Jobs Sync Enabled', 'Master switch for DB2 RFX_QUEUE fetches (Fetch All, per-client refresh, background polling). Set false during production incidents.', 0, 'system', 1787546522205),
  ('engine.dbMonitorBatchDays', '2', 'ENGINE', 'DB Monitor Batch Days', 'Default batch summary window at startup', 0, 'seed', 1781078694000),
  ('engine.keeperCacheTtlMins', '5', 'ENGINE', 'Keeper Cache TTL (min)', 'Keeper secret cache TTL in minutes', 0, 'seed', 1781078694000),
  ('engine.maxBatchDetailRows', '500', 'ENGINE', 'Max Batch Detail Rows', 'FETCH FIRST X ROWS in batch detail DB2 query', 0, 'seed', 1781078694000),
  ('engine.maxErrorChars', '10000', 'ENGINE', 'Max Error Chars', 'Max stored error message per execution', 0, 'seed', 1781078694000),
  ('engine.maxOutputChars', '50000', 'ENGINE', 'Max Output Chars', 'Max stored output per execution', 0, 'seed', 1781078694000),
  ('engine.payrollLookbackDays', '7', 'ENGINE', 'Payroll Lookback (days)', 'Payroll DB2 lookback window', 0, 'seed', 1781078694000),
  ('engine.pollIntervalMs', '5000', 'ENGINE', 'Poll Interval (ms)', 'Pending job check interval', 0, 'seed', 1781078694000),
  ('engine.postRunCheckDelayMins', '30', 'ENGINE', 'Post-Run Check Delay (min)', 'Delay before post-run log status check', 0, 'seed', 1781078694000),
  ('engine.punchLookbackDays', '2', 'ENGINE', 'Punch Lookback (days)', 'Unprocessed punch DB2 lookback window', 0, 'seed', 1781078694000),
  ('engine.punchSyncEnabled', 'true', 'ENGINE', 'Punch Sync Enabled', 'Master switch for unprocessed punch DB2 queries (Refresh, progressive load, background polling). Set false during production incidents.', 0, 'system', 1787547667585),
  ('engine.purgeSchedule', '0 2 * * *', 'ENGINE', 'Purge Schedule', 'Nightly data purge cron expression', 0, 'seed', 1781078694000),
  ('engine.syncEnabled', 'true', 'ENGINE', 'SSH Sync Enabled', 'Master switch for cron discovery, log checks, and timezone detection via SSH. Set false during production incidents.', 0, 'admin', 1787546426181),
  ('engine.upcomingScanIntervalMins', '60', 'ENGINE', 'Upcoming Scan Interval (min)', 'Upcoming job scanner interval', 0, 'seed', 1781078694000),
  ('infra.bodySizeLimit', '10mb', 'INFRA', 'Body Size Limit', 'Express JSON body size limit', 0, 'seed', 1781078694000),
  ('infra.corsOrigins', 'http://localhost:3005,http://localhost:5173', 'INFRA', 'CORS Origins', 'Comma-separated allowed CORS origins', 0, 'seed', 1783318365318),
  ('infra.db2ConnDir', '', 'INFRA', 'DB2 Conn Dir', 'Path to DB2 connection .txt files', 0, 'seed', 1781078694000),
  ('infra.db2DefaultPort', '50000', 'INFRA', 'DB2 Default Port', 'Default DB2 port fallback', 0, 'seed', 1781078694000),
  ('infra.db2LibDir', '', 'INFRA', 'DB2 Lib Dir', 'Path to DB2Connector.js & db2jcc4.jar', 0, 'seed', 1781078694000),
  ('infra.db2PoolAcquireMs', '30000', 'INFRA', 'DB2 Pool Acquire (ms)', 'Max wait for a DB2 pool slot', 0, 'seed', 1781078694000),
  ('infra.db2PoolIdleMs', '300000', 'INFRA', 'DB2 Pool Idle (ms)', 'Evict idle pool connections after this', 0, 'seed', 1781078694000),
  ('infra.db2PoolMax', '10', 'INFRA', 'DB2 Pool Max', 'Max concurrent DB2 pool connections', 0, 'seed', 1781078694000),
  ('infra.db2SslEnabled', 'true', 'INFRA', 'DB2 SSL Enabled', 'Use JDBC SSL for DB2 connections (requires truststore when server enforces TLS)', 0, 'admin', 1786596696184),
  ('infra.db2SslTrustStorePassword', '', 'INFRA', 'DB2 SSL Truststore Password', 'Password for DB2 SSL truststore JKS file', 1, 'system', 1786592304777),
  ('infra.db2SslTrustStorePath', '', 'INFRA', 'DB2 SSL Truststore', 'Path to JKS truststore for DB2 server certificates', 0, 'system', 1786592304764),
  ('infra.db2TrustStorePassword', '', 'INFRA', 'DB2 Truststore Password', 'Password for the DB2 JDBC truststore JKS file', 1, 'system', 1787233440279),
  ('infra.db2TrustStorePath', '', 'INFRA', 'DB2 Truststore Path', 'JKS truststore path for JDBC sslConnection (e.g. /app/certs/db2-truststore.jks)', 0, 'system', 1787233440271),
  ('infra.ldapAllowLocalFallback', 'true', 'INFRA', 'LDAP Allow Local Fallback', 'If LDAP bind fails, fall back to local password in User table (non-master accounts)', 0, 'system', 1787550797702),
  ('infra.ldapBaseDn', '', 'INFRA', 'LDAP Base DN', 'Base DN (e.g. DC=rfx,DC=zebra,DC=com)', 0, 'system', 1787550797579),
  ('infra.ldapBindDn', '', 'INFRA', 'LDAP Bind DN', 'Service account DN for user search (optional if using UPN bind via LDAP Domain)', 0, 'system', 1787550797589),
  ('infra.ldapBindPassword', '', 'INFRA', 'LDAP Bind Password', 'Password for LDAP service account', 1, 'system', 1787550797604),
  ('infra.ldapDevMock', 'false', 'INFRA', 'LDAP Dev Mock (non-production)', 'Simulate successful LDAP login without contacting a server. Blocked in production; prefer LDAP_DEV_MOCK env var locally.', 0, 'system', 1787897206835),
  ('infra.ldapDisplayNameAttribute', 'displayName', 'INFRA', 'LDAP Display Name Attribute', 'LDAP attribute for display name (default: displayName)', 0, 'system', 1787550797664),
  ('infra.ldapDomain', 'zebra.com', 'INFRA', 'LDAP Domain', 'UPN suffix for direct bind (user@domain) when Bind DN is empty', 0, 'system', 1787550797640),
  ('infra.ldapEmailAttribute', 'mail', 'INFRA', 'LDAP Email Attribute', 'LDAP attribute for user email (default: mail)', 0, 'system', 1787550797653),
  ('infra.ldapEnabled', 'false', 'INFRA', 'LDAP Enabled', 'Authenticate login against corporate LDAP/AD (in-app bind). Requires user record + profile in WFM Watch.', 0, 'system', 1787550797552),
  ('infra.ldapGroupSearchBase', 'dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP Group Search Base', 'Base DN for group search (ldap.groupSearch.base)', 0, 'system', 1787923886362),
  ('infra.ldapTimeoutMs', '10000', 'INFRA', 'LDAP Timeout (ms)', 'LDAP connection and bind timeout in milliseconds', 0, 'system', 1787550797713),
  ('infra.ldapTlsRejectUnauthorized', 'true', 'INFRA', 'LDAP TLS Verify Certs', 'Validate LDAP server certificate when using TLS/StartTLS', 0, 'system', 1787550797690),
  ('infra.ldapUrl', 'usc1.rfx.zebra.com', 'INFRA', 'LDAP URL', 'LDAP server URL (e.g. ldap://usc1.rfx.zebra.com:389 or ldaps://host:636)', 0, 'admin', 1787572901394),
  ('infra.ldapUseStartTls', 'false', 'INFRA', 'LDAP StartTLS', 'Use STARTTLS on ldap:// connections (not needed for ldaps://)', 0, 'system', 1787550797679),
  ('infra.ldapUserDnPattern', 'uid={{username}},cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP User DN Pattern', 'Direct bind DN pattern when search is not used (ldap.userDn.pattern)', 0, 'system', 1787923886323),
  ('infra.ldapUserFilter', '(sAMAccountName={{username}})', 'INFRA', 'LDAP User Filter', 'Search filter; use {{username}} placeholder (Active Directory default)', 0, 'system', 1787550797628),
  ('infra.ldapUserSearchBase', '', 'INFRA', 'LDAP User Search Base', 'OU to search users (defaults to LDAP Base DN)', 0, 'system', 1787550797617),
  ('infra.logDir', 'logs', 'INFRA', 'Log Directory', 'Log file output directory', 0, 'seed', 1781078694000),
  ('infra.nodeEnv', 'development', 'INFRA', 'Node Environment', 'development or production', 0, 'seed', 1781078694000),
  ('infra.port', '4005', 'INFRA', 'HTTP Port', 'HTTP server listen port', 0, 'seed', 1783318365298),
  ('infra.requireHttps', 'false', 'INFRA', 'Require HTTPS', 'Redirect HTTP to HTTPS when behind a TLS-terminating reverse proxy', 0, 'system', 1786603126248),
  ('infra.sshCommandTimeoutSec', '30', 'INFRA', 'SSH Command Timeout (sec)', 'Timeout for pending IN folder find (maxdepth 1)', 0, 'system', 1785076837961),
  ('infra.sshCronEntryPath', '/mount/backup/cronEntry', 'INFRA', 'SSH Cron Entry Path', 'Remote path to read cron entries', 0, 'seed', 1781078694000),
  ('infra.sshPendingFolderPath', '/mount/RWS4/batch_jobs/in', 'INFRA', 'Pending IN Folder', 'Remote path for pending upload files', 0, 'system', 1785076837906),
  ('infra.sshPort', '22', 'INFRA', 'SSH Port', 'SSH connection port for app servers', 0, 'seed', 1781078694000),
  ('infra.sshRejectedFindTimeoutSec', '120', 'INFRA', 'Rejected Find Timeout (sec)', 'Timeout for recursive rejected DTS find under upload root', 0, 'system', 1785076837978),
  ('infra.sshRejectedUploadRoot', '/mount/RWS4/appuploads/upload', 'INFRA', 'Rejected Upload Root', 'Root path for rejected DTS file scan', 0, 'system', 1785076837942),
  ('infra.sshTimeout', '15000', 'INFRA', 'SSH Timeout (ms)', 'SSH connection timeout in milliseconds', 0, 'seed', 1781078694000),
  ('infra.sshWfmPathPrefix', '/mount/RWS4', 'INFRA', 'WFM Path Prefix', 'Prefix to identify WFM cron jobs', 0, 'seed', 1781078694000),
  ('infra.ssoAllowedDomain', 'zebra.com', 'INFRA', 'SSO Allowed Email Domain', 'Only @zebra.com (or configured domain) emails may register or sign in via SSO', 0, 'system', 1787044821168),
  ('infra.ssoEmailHeader', 'X-Forwarded-Email', 'INFRA', 'SSO Email Header', 'HTTP header name the load balancer sets with the authenticated user email', 0, 'system', 1787037637945),
  ('infra.ssoEnabled', 'false', 'INFRA', 'SSO Enabled', 'Enable SSO/MFA email capture from load balancer header', 0, 'system', 1787037637901),
  ('infra.trustProxy', 'false', 'INFRA', 'Trust Proxy', 'Trust X-Forwarded-* headers from nginx/load balancer (enable in production behind TLS terminator)', 0, 'system', 1786603126222),
  ('polling.backgroundPollingMins', '30', 'POLLING', 'Background Polling (min)', 'Background DB2 poll interval in minutes', 0, 'seed', 1781078694000),
  ('polling.batchCacheTtlMins', '30', 'POLLING', 'Batch Cache TTL (min)', 'Backend batch summary cache TTL in minutes', 0, 'seed', 1781078694000),
  ('polling.batchRefreshMins', '30', 'POLLING', 'Batch Refresh (min)', 'Batch data refresh interval in minutes', 0, 'seed', 1781078694000),
  ('polling.clientListStaleMins', '5', 'POLLING', 'Client List Stale (min)', 'Client list cache TTL in minutes', 0, 'seed', 1781078694000),
  ('polling.cronSyncCooldownHrs', '24', 'POLLING', 'Cron Sync Cooldown (hrs)', 'Skip cron sync if done less than X hours ago', 0, 'seed', 1781078694000),
  ('polling.dbMonitorSyncMins', '30', 'POLLING', 'DB Monitor Sync (min)', 'DB Monitor batch sync interval in minutes', 0, 'seed', 1781078694000),
  ('polling.escalatedRefreshSecs', '60', 'POLLING', 'Escalated Refresh (sec)', 'Escalated alerts refresh interval in seconds', 0, 'seed', 1781078694000),
  ('polling.punchCacheTtlMins', '30', 'POLLING', 'Punch Cache TTL (min)', 'Unprocessed punch cache TTL in minutes', 0, 'seed', 1781078694000),
  ('polling.punchRefreshMins', '30', 'POLLING', 'Punch Refresh (min)', 'Punch data refresh interval in minutes', 0, 'seed', 1781078694000),
  ('polling.punchStatusRefreshSecs', '60', 'POLLING', 'Punch Status Refresh (sec)', 'Punch alert statuses refresh in seconds', 0, 'seed', 1781078694000),
  ('polling.upcomingJobsRefreshSecs', '60', 'POLLING', 'Upcoming Jobs Refresh (sec)', 'Upcoming jobs refresh interval in seconds', 0, 'seed', 1781078694000),
  ('secrets.db2Password', '', 'SECRETS', 'DB2 Password', 'Fallback DB2 password', 1, 'seed', 1781078694000),
  ('secrets.db2Username', '', 'SECRETS', 'DB2 Username', 'Fallback DB2 username', 1, 'seed', 1781078694000),
  ('secrets.jwtExpiresIn', '24h', 'SECRETS', 'JWT Expiry', 'Token lifetime (e.g. 24h, 7d)', 0, 'seed', 1781078694000),
  ('secrets.jwtSecret', '', 'SECRETS', 'JWT Secret', 'Secret key for signing JWT tokens', 1, 'seed', 1781078694000),
  ('secrets.keeperEnabled', 'false', 'SECRETS', 'Keeper Enabled', 'Enable Keeper Secrets Manager integration', 0, 'seed', 1781078694000),
  ('secrets.masterPasswordHash', '', 'SECRETS', 'Master Password Hash', 'Break-glass admin bcrypt hash (default password: WFMADMIN)', 1, 'seed', 1781078694000),
  ('secrets.masterUsername', 'WFMADMIN', 'SECRETS', 'Master Username', 'Break-glass admin username', 0, 'seed', 1781078694000),
  ('secrets.slackWebhookUrl', '', 'SECRETS', 'Slack Webhook URL', 'Slack incoming webhook URL for notifications', 1, 'seed', 1781078694000),
  ('secrets.smtpFromEmail', 'wfm-controlm@localhost', 'SECRETS', 'Email From Address', 'From address for alert emails', 0, 'seed', 1781078694000),
  ('secrets.smtpHost', '127.0.0.1', 'SECRETS', 'SMTP Host', 'SMTP relay (127.0.0.1 for Mailpit, avoid localhost/IPv6)', 0, 'seed', 1781078694000),
  ('secrets.smtpPass', '', 'SECRETS', 'SMTP Password', 'SMTP auth password', 1, 'seed', 1781078694000),
  ('secrets.smtpPort', '1025', 'SECRETS', 'SMTP Port', 'SMTP port (1025 Mailpit local, 587 STARTTLS, 465 TLS)', 0, 'seed', 1781078694000),
  ('secrets.smtpTlsEnabled', 'false', 'SECRETS', 'SMTP TLS Enabled', 'Require TLS/STARTTLS for SMTP (ignored for local Mailpit on 127.0.0.1:1025)', 0, 'system', 1786592304789),
  ('secrets.smtpTlsRejectUnauthorized', 'true', 'SECRETS', 'SMTP TLS Verify Certs', 'Validate SMTP server certificate when SMTP TLS Enabled is true', 0, 'system', 1786592304803);
INSERT OR REPLACE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt") VALUES
  ('secrets.smtpUser', '', 'SECRETS', 'SMTP Username', 'SMTP auth username (empty = unauthenticated relay)', 0, 'seed', 1781078694000),
  ('secrets.sshPassword', '', 'SECRETS', 'SSH Password', 'SSH service account password', 1, 'import-ssh-credentials', 1781151981934),
  ('secrets.sshTotpSecret', '', 'SECRETS', 'SSH TOTP Secret', 'TOTP secret for 2FA SSH auth', 1, 'import-ssh-credentials', 1781151981941),
  ('secrets.sshUsername', 'svc_wfmspt_user', 'SECRETS', 'SSH Username', 'SSH service account username', 0, 'import-ssh-credentials', 1781151981885),
  ('threshold.defaultSuppressMins', '60', 'THRESHOLDS', 'Default Suppress (min)', 'Default suppress duration in modal', 0, 'seed', 1781078694000),
  ('threshold.escalationMins', '60', 'THRESHOLDS', 'Escalation Threshold (min)', 'Pending > X mins -> escalated to Red tab', 0, 'seed', 1781078694000),
  ('threshold.jobPriorityCritical', '8', 'THRESHOLDS', 'Job Priority Critical', 'Job priority >= X -> CRITICAL color', 0, 'seed', 1781078694000),
  ('threshold.jobPriorityWarning', '5', 'THRESHOLDS', 'Job Priority Warning', 'Job priority >= X -> WARNING color', 0, 'seed', 1781078694000),
  ('threshold.notifyCooldownMins', '60', 'THRESHOLDS', 'Notify Cooldown (min)', 'Minutes before notify icon reappears after email sent', 0, 'seed', 1781078694000),
  ('threshold.payrollStalledGraceMins', '30', 'THRESHOLDS', 'Payroll Stalled Grace (min)', 'After pay release time, flag store group as stalled when generator is idle and units still pending for X mins', 0, 'system', 1789462923999),
  ('threshold.punchCountMin', '100', 'THRESHOLDS', 'Min Punch Count', 'Minimum punchCount to flag a client', 0, 'seed', 1781078694000),
  ('threshold.purgeRowsAmber', '1000', 'THRESHOLDS', 'Purge Rows Amber', 'Admin purge count > X -> amber highlight', 0, 'seed', 1781078694000),
  ('threshold.purgeRowsRed', '10000', 'THRESHOLDS', 'Purge Rows Red', 'Admin purge count > X -> red highlight', 0, 'seed', 1781078694000),
  ('threshold.staleHoursMins', '60', 'THRESHOLDS', 'Stale Threshold (min)', 'Minutes before punch/pending is considered stale', 0, 'seed', 1781078694000),
  ('threshold.stalePendingCritical', '10', 'THRESHOLDS', 'Critical Threshold', 'stalePendingCount >= X -> CRITICAL badge', 0, 'seed', 1781078694000),
  ('threshold.stalePendingDbMins', '30', 'THRESHOLDS', 'DB Stale Pending (min)', 'DB2 SQL: pending older than X mins = stale', 0, 'seed', 1781078694000),
  ('threshold.stalePendingWarning', '5', 'THRESHOLDS', 'Warning Threshold', 'stalePendingCount >= X -> WARNING badge', 0, 'seed', 1781078694000);
