-- Payroll SLA missed: units still pending after the client deadline
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
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollDeadlineAlert_clientId_key" ON "PayrollDeadlineAlert"("clientId");
CREATE INDEX IF NOT EXISTS "PayrollDeadlineAlert_status_idx" ON "PayrollDeadlineAlert"("status");
CREATE INDEX IF NOT EXISTS "PayrollDeadlineAlert_suppressUntil_idx" ON "PayrollDeadlineAlert"("suppressUntil");
