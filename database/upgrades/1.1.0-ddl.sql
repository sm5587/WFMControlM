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
-- ============================================================

-- Per-client payroll SLA deadline (days after week end + local HH:mm)
ALTER TABLE "Client" ADD COLUMN "payrollDeadlineDaysAfterWeekEnd" INTEGER;
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
