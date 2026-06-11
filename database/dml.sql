-- WFM Control-M consolidated production DML
--
-- This script seeds baseline reference/config data after database/ddl.sql.
-- It is safe to rerun because statements use INSERT OR IGNORE / OR REPLACE.
--
-- NOTE:
-- 1) Client/AppServer inventory is environment-specific and should be loaded
--    via import scripts/admin APIs, not hardcoded in this file.
-- 2) Replace placeholder secret values before production rollout.

-- ============================================================
-- APP FUNCTIONS (RBAC function registry)
-- ============================================================
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('JOBS_VIEW', 'JOBS', 'View Jobs', NULL, 10),
  ('JOBS_CREATE', 'JOBS', 'Create Jobs', NULL, 11),
  ('JOBS_EDIT', 'JOBS', 'Edit Jobs', NULL, 12),
  ('JOBS_DELETE', 'JOBS', 'Delete Jobs', NULL, 13),
  ('JOBS_TRIGGER', 'JOBS', 'Trigger (Run Now)', NULL, 14),
  ('JOBS_TOGGLE', 'JOBS', 'Enable / Disable Jobs', NULL, 15),
  ('CLIENTS_VIEW', 'CLIENTS', 'View Clients', NULL, 20),
  ('CLIENTS_CREATE', 'CLIENTS', 'Add Client', NULL, 21),
  ('CLIENTS_EDIT', 'CLIENTS', 'Edit Client', NULL, 22),
  ('CLIENTS_SYNC', 'CLIENTS', 'Sync Client Jobs', NULL, 23),
  ('CLIENTS_DETECT_TZ', 'CLIENTS', 'Detect Timezones', NULL, 24),
  ('ALERTS_VIEW', 'ALERTS', 'View Alerts', NULL, 30),
  ('ALERTS_RULES', 'ALERTS', 'Manage Alert Rules', NULL, 31),
  ('ALERTS_ACK', 'ALERTS', 'Acknowledge Alerts', NULL, 32),
  ('ALERTS_SUPPRESS', 'ALERTS', 'Suppress Alerts', NULL, 33),
  ('ALERTS_NOTIFY', 'ALERTS', 'Send Email Notification', NULL, 34),
  ('RECIPIENTS_MANAGE', 'ALERTS', 'Manage Notification Recipients', NULL, 35),
  ('DBMONITOR_VIEW', 'DBMONITOR', 'View DB Monitor', NULL, 40),
  ('DBJOBS_VIEW', 'DBJOBS', 'View DB Jobs', NULL, 50),
  ('MAINTENANCE_VIEW', 'MAINTENANCE', 'View Maintenance Windows', NULL, 55),
  ('MAINTENANCE_MANAGE', 'MAINTENANCE', 'Create / Edit / Cancel Maintenance Windows', NULL, 56),
  ('MONITOR_VIEW', 'MONITOR', 'View Monitor', NULL, 60),
  ('PAYROLL_VIEW', 'PAYROLL', 'View Payroll', NULL, 70),
  ('UNPROC_PUNCH_VIEW', 'UNPROC_PUNCH', 'View Unprocessed Punches', NULL, 75),
  ('USERS_VIEW', 'ADMIN', 'View Users', NULL, 80),
  ('USERS_MANAGE', 'ADMIN', 'Create / Edit / Deactivate Users', NULL, 81),
  ('PROFILES_VIEW', 'ADMIN', 'View Profiles', NULL, 82),
  ('PROFILES_MANAGE', 'ADMIN', 'Create / Edit Profiles', NULL, 83),
  ('PERMISSIONS_EDIT', 'ADMIN', 'Edit Profile Permissions', NULL, 84),
  ('USER_PROFILE_ASSIGN', 'ADMIN', 'Assign Users to Profiles', NULL, 85),
  ('DATA_PURGE_VIEW', 'ADMIN', 'View Data Purge Settings', NULL, 86),
  ('DATA_PURGE_RUN', 'ADMIN', 'Run / Configure Data Purge', NULL, 87);

-- ============================================================
-- SYSTEM PROFILES
-- ============================================================
INSERT OR IGNORE INTO "Profile" ("id", "name", "description", "isSystem", "createdAt", "updatedAt") VALUES
  ('SYS_ADMIN_PROFILE', 'System Admin', 'Full access to all features', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('MONITOR_PROFILE', 'Monitor', 'Read-only + send email notifications', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('READONLY_PROFILE', 'Read Only', 'View all data, no write access', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ============================================================
-- BOOTSTRAP ADMIN USER (MANDATORY: change password after first login)
-- username: admin
-- temporary password: ChangeMe123!
-- ============================================================
INSERT OR IGNORE INTO "User" ("id", "username", "email", "displayName", "passwordHash", "timezone", "isActive", "createdAt", "updatedAt") VALUES
  ('bootstrap-admin', 'admin', 'admin@zebra.com', 'Administrator', '$2b$10$uYLWzpnTFTP2Lw1rl94Naujkx5TYpigEV9wYQD2A9XbcJqXcSQ9cO', 'Asia/Kolkata', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO "UserProfile" ("userId", "profileId", "assignedAt", "assignedBy")
SELECT u.id, p.id, CURRENT_TIMESTAMP, 'sql-bootstrap'
FROM "User" u
JOIN "Profile" p ON p.name = 'System Admin'
WHERE u.username = 'admin';

-- ============================================================
-- PROFILE PERMISSIONS
-- ============================================================
-- System Admin: full access
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, f.id, 1, 1
FROM "Profile" p
JOIN "AppFunction" f ON 1 = 1
WHERE p.name = 'System Admin';

-- Monitor: read most + write ALERTS_NOTIFY and JOBS_TRIGGER
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT
  p.id,
  f.id,
  CASE WHEN f.id IN ('USERS_MANAGE', 'PROFILES_MANAGE', 'PERMISSIONS_EDIT', 'USER_PROFILE_ASSIGN') THEN 0 ELSE 1 END,
  CASE WHEN f.id IN ('ALERTS_NOTIFY', 'JOBS_TRIGGER') THEN 1 ELSE 0 END
FROM "Profile" p
JOIN "AppFunction" f ON 1 = 1
WHERE p.name = 'Monitor'
  AND f.id NOT IN ('USERS_MANAGE', 'PROFILES_MANAGE', 'PERMISSIONS_EDIT', 'USER_PROFILE_ASSIGN');

-- Read Only: read all non-ADMIN functions
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, f.id, 1, 0
FROM "Profile" p
JOIN "AppFunction" f ON 1 = 1
WHERE p.name = 'Read Only'
  AND f.module <> 'ADMIN';

-- ============================================================
-- RESOURCE POOLS
-- ============================================================
INSERT OR REPLACE INTO "ResourcePool" ("id", "name", "description", "maxConcurrency", "currentUsage", "isActive", "createdAt", "updatedAt") VALUES
  ('rp-default', 'default', 'Default resource pool for general jobs', 20, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rp-wfm-compute', 'wfm-compute', 'High-compute pool for WFM forecast and optimization', 5, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rp-etl-pool', 'etl-pool', 'Data pipeline and ETL jobs', 10, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ============================================================
-- PURGE CONFIG
-- ============================================================
INSERT OR REPLACE INTO "PurgeConfig" ("id", "label", "retainDays", "enabled", "lastPurgeAt", "lastPurgeCount", "updatedAt") VALUES
  ('syncHistory', 'Sync History', 30, 1, NULL, NULL, CURRENT_TIMESTAMP),
  ('jobExecution', 'Job Executions', 30, 1, NULL, NULL, CURRENT_TIMESTAMP),
  ('alertEvent', 'Alert Events', 60, 1, NULL, NULL, CURRENT_TIMESTAMP),
  ('escalatedAlert', 'Escalated Alerts', 90, 1, NULL, NULL, CURRENT_TIMESTAMP),
  ('auditLog', 'Audit Log', 90, 1, NULL, NULL, CURRENT_TIMESTAMP),
  ('cachedCronJob', 'Cached Cron Jobs', 7, 1, NULL, NULL, CURRENT_TIMESTAMP);

-- ============================================================
-- NOTIFICATION RECIPIENTS (local / Mailpit testing)
-- ============================================================
INSERT OR IGNORE INTO "NotificationRecipient" ("id", "name", "email", "isActive", "createdAt", "updatedAt") VALUES
  ('a1000000-0000-4000-8000-000000000001', 'Local Tester', 'test@localhost', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ============================================================
-- APP CONFIG (runtime configuration defaults)
-- ============================================================
INSERT OR REPLACE INTO "AppConfig" ("key", "value", "category", "label", "description", "isSecret", "updatedBy", "updatedAt") VALUES
  ('secrets.jwtSecret', 'dev-secret-change-in-production', 'SECRETS', 'JWT Secret', 'Secret key for signing JWT tokens', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.jwtExpiresIn', '24h', 'SECRETS', 'JWT Expiry', 'Token lifetime (e.g. 24h, 7d)', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.smtpHost', '127.0.0.1', 'SECRETS', 'SMTP Host', 'SMTP relay (127.0.0.1 for Mailpit, avoid localhost/IPv6)', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.smtpPort', '1025', 'SECRETS', 'SMTP Port', 'SMTP port (1025 Mailpit local, 587 STARTTLS, 465 TLS)', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.smtpUser', '', 'SECRETS', 'SMTP Username', 'SMTP auth username (empty = unauthenticated relay)', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.smtpPass', '', 'SECRETS', 'SMTP Password', 'SMTP auth password', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.smtpFromEmail', 'wfm-controlm@localhost', 'SECRETS', 'Email From Address', 'From address for alert emails', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.sshUsername', COALESCE(NULLIF((SELECT "value" FROM "AppConfig" WHERE "key"='secrets.sshUsername'), ''), ''), 'SECRETS', 'SSH Username', 'SSH service account username', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.sshPassword', COALESCE(NULLIF((SELECT "value" FROM "AppConfig" WHERE "key"='secrets.sshPassword'), ''), ''), 'SECRETS', 'SSH Password', 'SSH service account password', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.sshTotpSecret', COALESCE(NULLIF((SELECT "value" FROM "AppConfig" WHERE "key"='secrets.sshTotpSecret'), ''), ''), 'SECRETS', 'SSH TOTP Secret', 'TOTP secret for 2FA SSH auth', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.slackWebhookUrl', '', 'SECRETS', 'Slack Webhook URL', 'Slack incoming webhook URL for notifications', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.masterUsername', COALESCE(NULLIF((SELECT "value" FROM "AppConfig" WHERE "key"='secrets.masterUsername'), ''), 'WFMADMIN'), 'SECRETS', 'Master Username', 'Break-glass admin username', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.masterPasswordHash', COALESCE(NULLIF((SELECT "value" FROM "AppConfig" WHERE "key"='secrets.masterPasswordHash'), ''), '$2b$10$yPnFQ7.oImZUCmBOLMnRIuW2o5IPI2vxoRFsdomOzvBNNlbAPnQOC'), 'SECRETS', 'Master Password Hash', 'Break-glass admin bcrypt hash (default password: WFMADMIN)', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.keeperEnabled', 'false', 'SECRETS', 'Keeper Enabled', 'Enable Keeper Secrets Manager integration', 0, 'seed', CURRENT_TIMESTAMP),
  ('secrets.db2Username', '', 'SECRETS', 'DB2 Username', 'Fallback DB2 username', 1, 'seed', CURRENT_TIMESTAMP),
  ('secrets.db2Password', '', 'SECRETS', 'DB2 Password', 'Fallback DB2 password', 1, 'seed', CURRENT_TIMESTAMP),

  ('infra.port', '4000', 'INFRA', 'HTTP Port', 'HTTP server listen port', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.nodeEnv', 'development', 'INFRA', 'Node Environment', 'development or production', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.corsOrigins', 'http://localhost:3000,http://localhost:5173', 'INFRA', 'CORS Origins', 'Comma-separated allowed CORS origins', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.bodySizeLimit', '10mb', 'INFRA', 'Body Size Limit', 'Express JSON body size limit', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.sshPort', '22', 'INFRA', 'SSH Port', 'SSH connection port for app servers', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.sshTimeout', '15000', 'INFRA', 'SSH Timeout (ms)', 'SSH connection timeout in milliseconds', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.sshCronEntryPath', '/mount/backup/cronEntry', 'INFRA', 'SSH Cron Entry Path', 'Remote path to read cron entries', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.sshWfmPathPrefix', '/mount/RWS4', 'INFRA', 'WFM Path Prefix', 'Prefix to identify WFM cron jobs', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2ConnDir', '', 'INFRA', 'DB2 Conn Dir', 'Path to DB2 connection .txt files', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2LibDir', '', 'INFRA', 'DB2 Lib Dir', 'Path to DB2Connector.js & db2jcc4.jar', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2JjsPath', '', 'INFRA', 'JJS Path', 'Path to JDK Nashorn jjs binary', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2PoolMax', '10', 'INFRA', 'DB2 Pool Max', 'Max concurrent DB2 pool connections', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2PoolIdleMs', '300000', 'INFRA', 'DB2 Pool Idle (ms)', 'Evict idle pool connections after this', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2PoolAcquireMs', '30000', 'INFRA', 'DB2 Pool Acquire (ms)', 'Max wait for a DB2 pool slot', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.logDir', 'logs', 'INFRA', 'Log Directory', 'Log file output directory', 0, 'seed', CURRENT_TIMESTAMP),
  ('infra.db2DefaultPort', '50000', 'INFRA', 'DB2 Default Port', 'Default DB2 port fallback', 0, 'seed', CURRENT_TIMESTAMP),

  ('polling.batchRefreshMins', '30', 'POLLING', 'Batch Refresh (min)', 'Batch data refresh interval in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.punchRefreshMins', '30', 'POLLING', 'Punch Refresh (min)', 'Punch data refresh interval in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.escalatedRefreshSecs', '60', 'POLLING', 'Escalated Refresh (sec)', 'Escalated alerts refresh interval in seconds', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.punchStatusRefreshSecs', '60', 'POLLING', 'Punch Status Refresh (sec)', 'Punch alert statuses refresh in seconds', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.upcomingJobsRefreshSecs', '60', 'POLLING', 'Upcoming Jobs Refresh (sec)', 'Upcoming jobs refresh interval in seconds', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.clientListStaleMins', '5', 'POLLING', 'Client List Stale (min)', 'Client list cache TTL in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.backgroundPollingMins', '30', 'POLLING', 'Background Polling (min)', 'Background DB2 poll interval in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.dbMonitorSyncMins', '30', 'POLLING', 'DB Monitor Sync (min)', 'DB Monitor batch sync interval in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.cronSyncCooldownHrs', '24', 'POLLING', 'Cron Sync Cooldown (hrs)', 'Skip cron sync if done less than X hours ago', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.batchCacheTtlMins', '30', 'POLLING', 'Batch Cache TTL (min)', 'Backend batch summary cache TTL in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('polling.punchCacheTtlMins', '30', 'POLLING', 'Punch Cache TTL (min)', 'Unprocessed punch cache TTL in minutes', 0, 'seed', CURRENT_TIMESTAMP),

  ('threshold.stalePendingCritical', '10', 'THRESHOLDS', 'Critical Threshold', 'stalePendingCount >= X -> CRITICAL badge', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.stalePendingWarning', '5', 'THRESHOLDS', 'Warning Threshold', 'stalePendingCount >= X -> WARNING badge', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.punchCountMin', '100', 'THRESHOLDS', 'Min Punch Count', 'Minimum punchCount to flag a client', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.staleHoursMins', '60', 'THRESHOLDS', 'Stale Threshold (min)', 'Minutes before punch/pending is considered stale', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.escalationMins', '60', 'THRESHOLDS', 'Escalation Threshold (min)', 'Pending > X mins -> escalated to Red tab', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.notifyCooldownMins', '60', 'THRESHOLDS', 'Notify Cooldown (min)', 'Minutes before notify icon reappears after email sent', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.jobPriorityCritical', '8', 'THRESHOLDS', 'Job Priority Critical', 'Job priority >= X -> CRITICAL color', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.jobPriorityWarning', '5', 'THRESHOLDS', 'Job Priority Warning', 'Job priority >= X -> WARNING color', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.purgeRowsRed', '10000', 'THRESHOLDS', 'Purge Rows Red', 'Admin purge count > X -> red highlight', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.purgeRowsAmber', '1000', 'THRESHOLDS', 'Purge Rows Amber', 'Admin purge count > X -> amber highlight', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.defaultSuppressMins', '60', 'THRESHOLDS', 'Default Suppress (min)', 'Default suppress duration in modal', 0, 'seed', CURRENT_TIMESTAMP),
  ('threshold.stalePendingDbMins', '30', 'THRESHOLDS', 'DB Stale Pending (min)', 'DB2 SQL: pending older than X mins = stale', 0, 'seed', CURRENT_TIMESTAMP),

  ('engine.pollIntervalMs', '5000', 'ENGINE', 'Poll Interval (ms)', 'Pending job check interval', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.maxConcurrentJobs', '50', 'ENGINE', 'Max Concurrent Jobs', 'Global max concurrent job executions', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.heartbeatIntervalMs', '10000', 'ENGINE', 'Heartbeat Interval (ms)', 'Agent heartbeat interval', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.executionHistoryDays', '90', 'ENGINE', 'Execution History (days)', 'Retain execution history for this many days', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.logRetentionDays', '30', 'ENGINE', 'Log Retention (days)', 'Retain execution logs for this many days', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.maxBatchDetailRows', '500', 'ENGINE', 'Max Batch Detail Rows', 'FETCH FIRST X ROWS in batch detail DB2 query', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.db2QueryConcurrency', '5', 'ENGINE', 'DB2 Query Concurrency', 'Concurrent per-client DB2 queries', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.batchQueryDays', '7', 'ENGINE', 'Batch Query Days', 'Default batch status query window in days', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.punchLookbackDays', '2', 'ENGINE', 'Punch Lookback (days)', 'Unprocessed punch DB2 lookback window', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.payrollLookbackDays', '7', 'ENGINE', 'Payroll Lookback (days)', 'Payroll DB2 lookback window', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.purgeSchedule', '0 2 * * *', 'ENGINE', 'Purge Schedule', 'Nightly data purge cron expression', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.jjsTimeoutMs', '120000', 'ENGINE', 'JJS Timeout (ms)', 'DB2 jjs child process timeout', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.jjsMaxBuffer', '10485760', 'ENGINE', 'JJS Max Buffer', 'DB2 jjs stdout max buffer size in bytes', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.maxOutputChars', '50000', 'ENGINE', 'Max Output Chars', 'Max stored output per execution', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.maxErrorChars', '10000', 'ENGINE', 'Max Error Chars', 'Max stored error message per execution', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.keeperCacheTtlMins', '5', 'ENGINE', 'Keeper Cache TTL (min)', 'Keeper secret cache TTL in minutes', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.upcomingScanIntervalMins', '60', 'ENGINE', 'Upcoming Scan Interval (min)', 'Upcoming job scanner interval', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.postRunCheckDelayMins', '30', 'ENGINE', 'Post-Run Check Delay (min)', 'Delay before post-run log status check', 0, 'seed', CURRENT_TIMESTAMP),
  ('engine.dbMonitorBatchDays', '2', 'ENGINE', 'DB Monitor Batch Days', 'Default batch summary window at startup', 0, 'seed', CURRENT_TIMESTAMP),

  ('display.appName', 'WFM Watch', 'DISPLAY', 'Application Name', 'Product name shown in UI, emails, and API health', 0, 'seed', CURRENT_TIMESTAMP),
  ('display.defaultTimezone', 'Asia/Kolkata', 'DISPLAY', 'Default Timezone', 'Default timezone when user has none set', 0, 'seed', CURRENT_TIMESTAMP),
  ('display.defaultBatchDays', '2', 'DISPLAY', 'Default Batch Days', 'Default batch days shown on pages', 0, 'seed', CURRENT_TIMESTAMP),
  ('display.panelMinWidth', '160', 'DISPLAY', 'Panel Min Width (px)', 'Resizable panel min width in pixels', 0, 'seed', CURRENT_TIMESTAMP),
  ('display.panelMaxWidth', '700', 'DISPLAY', 'Panel Max Width (px)', 'Resizable panel max width in pixels', 0, 'seed', CURRENT_TIMESTAMP),
  ('display.wsReconnectAttempts', '10', 'DISPLAY', 'WS Reconnect Attempts', 'WebSocket max reconnection attempts', 0, 'seed', CURRENT_TIMESTAMP),
  ('display.wsReconnectDelayMs', '1000', 'DISPLAY', 'WS Reconnect Delay (ms)', 'WebSocket reconnect delay in ms', 0, 'seed', CURRENT_TIMESTAMP);