-- ============================================================
-- WFM Watch 1.1.0 — incremental DDL (upgrade from 1.0.0)
-- ============================================================
-- Apply once on an existing SQLite config DB when upgrading to 1.1.0:
--
--   node scripts/apply-sql.js ../database/upgrades/1.1.0-ddl.sql
--
-- Fresh installs: apply first-time-deployment-ddl.sql (1.0.0 baseline), then this file
-- (and later upgrades/ in order). Do not add 1.1.0+ objects back into first-time DDL.
--
-- Mirrors Prisma migrations:
--   20260921120000_add_payroll_deadline
--   20260921140000_add_payroll_deadline_alert
--   20260921160000_add_payroll_deadline_email_sent
--   20260924120000_add_payroll_deadline_resolve_reason
--   20260924163000_add_payroll_deadline_day_of_month
--   20260925120000_add_client_wfm_app_version
-- ============================================================

-- Per-client payroll SLA deadline (days after week/period end + local HH:mm;
-- SM/GM use day-of-month instead of days-after)
ALTER TABLE "Client" ADD COLUMN "payrollDeadlineDaysAfterWeekEnd" INTEGER;
ALTER TABLE "Client" ADD COLUMN "payrollDeadlineDayOfMonth" INTEGER;
ALTER TABLE "Client" ADD COLUMN "payrollDeadlineLocalTime" TEXT;

-- Payroll deadline missed alerts (Escalated tab + Notify Team)
CREATE TABLE IF NOT EXISTS "PayrollDeadlineAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL DEFAULT '',
    "weekEndDate" TEXT NOT NULL DEFAULT '',
    "deadlineAt" DATETIME,
    "pendingUnits" INTEGER NOT NULL DEFAULT 0,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "suppressedBy" TEXT,
    "suppressedAt" DATETIME,
    "suppressUntil" DATETIME,
    "suppressReason" TEXT,
    "emailSentAt" DATETIME,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollDeadlineAlert_clientId_key" ON "PayrollDeadlineAlert"("clientId");
CREATE INDEX IF NOT EXISTS "PayrollDeadlineAlert_status_idx" ON "PayrollDeadlineAlert"("status");
CREATE INDEX IF NOT EXISTS "PayrollDeadlineAlert_suppressUntil_idx" ON "PayrollDeadlineAlert"("suppressUntil");

-- Manual resolve-with-reason (Prisma 20260924120000)
ALTER TABLE "PayrollDeadlineAlert" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "PayrollDeadlineAlert" ADD COLUMN "resolveReason" TEXT;

-- Client WFM app version (Prisma 20260925120000) — APPURL from DB2 RFX_CONFIG + reflexisversion.txt
ALTER TABLE "Client" ADD COLUMN "wfmAppUrl" TEXT;
ALTER TABLE "Client" ADD COLUMN "wfmAppVersion" TEXT;
ALTER TABLE "Client" ADD COLUMN "wfmAppVersionSyncedAt" DATETIME;

-- ============================================================
-- Custom Alerts (user-defined SQL threshold watchers)
-- Mirrors Prisma migrations:
--   20260920204459_add_custom_alerts
--   20260922090051_custom_alerts_multi_client
--   20260923101746_custom_alerts_notify_emails
--   20260923195313_custom_alerts_schedule
--   20260925083703_custom_alerts_cron_schedule
--   20260928130000_custom_alerts_remove_column
--   (permissions → 1.1.0-dml.sql)
-- ============================================================

CREATE TABLE IF NOT EXISTS "CustomAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '',
    "clientIds" TEXT NOT NULL DEFAULT '[]',
    "clientNames" TEXT NOT NULL DEFAULT '[]',
    "sqlQuery" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'GT',
    "thresholdValue" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "scheduleType" TEXT NOT NULL DEFAULT 'INTERVAL',
    "scheduleConfig" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmails" TEXT NOT NULL DEFAULT '[]',
    "startAt" DATETIME,
    "endAt" DATETIME,
    "lastStatus" TEXT,
    "lastValue" TEXT,
    "lastError" TEXT,
    "lastCheckedAt" DATETIME,
    "lastTriggeredAt" DATETIME,
    "results" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS "CustomAlert_isActive_idx" ON "CustomAlert"("isActive");
CREATE INDEX IF NOT EXISTS "CustomAlert_clientId_idx" ON "CustomAlert"("clientId");
CREATE INDEX IF NOT EXISTS "CustomAlert_lastStatus_idx" ON "CustomAlert"("lastStatus");
