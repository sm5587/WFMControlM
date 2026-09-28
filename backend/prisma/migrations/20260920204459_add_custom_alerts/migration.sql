-- CreateTable
CREATE TABLE "CustomAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL DEFAULT '',
    "sqlQuery" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'GT',
    "thresholdValue" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT,
    "lastValue" TEXT,
    "lastError" TEXT,
    "lastCheckedAt" DATETIME,
    "lastTriggeredAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "db2Host" TEXT,
    "db2Port" INTEGER NOT NULL DEFAULT 50000,
    "db2Database" TEXT,
    "db2Schema" TEXT,
    "db2Username" TEXT,
    "db2Password" TEXT,
    "db2SslEnabled" BOOLEAN NOT NULL DEFAULT false,
    "remoteLogTailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "payrollEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payrollCycle" TEXT NOT NULL DEFAULT 'WK',
    "payrollFileGen" TEXT NOT NULL DEFAULT '',
    "priorPeriodEdit" BOOLEAN NOT NULL DEFAULT false,
    "priorPeriodEditLimit" INTEGER NOT NULL DEFAULT 0,
    "payrollSyncedAt" DATETIME,
    "lastCronSyncAt" DATETIME,
    "lastCronAttemptAt" DATETIME,
    "lastCronCacheAt" DATETIME,
    "cluster" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "whiteGlove" BOOLEAN NOT NULL DEFAULT false,
    "clientType" TEXT NOT NULL DEFAULT 'BAU',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Client" ("clientId", "clientType", "cluster", "createdAt", "db2Database", "db2Host", "db2Password", "db2Port", "db2Schema", "db2SslEnabled", "db2Username", "id", "isActive", "lastCronAttemptAt", "lastCronCacheAt", "lastCronSyncAt", "name", "payrollCycle", "payrollEnabled", "payrollFileGen", "payrollSyncedAt", "priorPeriodEdit", "priorPeriodEditLimit", "remoteLogTailEnabled", "tags", "timezone", "updatedAt", "whiteGlove") SELECT "clientId", "clientType", "cluster", "createdAt", "db2Database", "db2Host", "db2Password", "db2Port", "db2Schema", "db2SslEnabled", "db2Username", "id", "isActive", "lastCronAttemptAt", "lastCronCacheAt", "lastCronSyncAt", "name", "payrollCycle", "payrollEnabled", "payrollFileGen", "payrollSyncedAt", "priorPeriodEdit", "priorPeriodEditLimit", "remoteLogTailEnabled", "tags", "timezone", "updatedAt", "whiteGlove" FROM "Client";
DROP TABLE "Client";
ALTER TABLE "new_Client" RENAME TO "Client";
CREATE UNIQUE INDEX "Client_clientId_key" ON "Client"("clientId");
CREATE INDEX "Client_clientId_idx" ON "Client"("clientId");
CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");
CREATE INDEX "Client_cluster_idx" ON "Client"("cluster");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CustomAlert_isActive_idx" ON "CustomAlert"("isActive");

-- CreateIndex
CREATE INDEX "CustomAlert_clientId_idx" ON "CustomAlert"("clientId");

-- CreateIndex
CREATE INDEX "CustomAlert_lastStatus_idx" ON "CustomAlert"("lastStatus");
