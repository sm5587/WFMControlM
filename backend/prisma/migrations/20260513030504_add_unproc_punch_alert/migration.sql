-- CreateTable
CREATE TABLE "UnprocPunchAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "suppressedBy" TEXT,
    "suppressedAt" DATETIME,
    "suppressUntil" DATETIME,
    "suppressReason" TEXT,
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
    "payrollEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payrollCycle" TEXT NOT NULL DEFAULT 'weekly',
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
INSERT INTO "new_Client" ("clientId", "clientType", "cluster", "createdAt", "db2Database", "db2Host", "db2Password", "db2Port", "db2Schema", "db2Username", "id", "isActive", "lastCronAttemptAt", "lastCronCacheAt", "lastCronSyncAt", "name", "payrollCycle", "payrollEnabled", "payrollSyncedAt", "tags", "timezone", "updatedAt", "whiteGlove") SELECT "clientId", coalesce("clientType", 'BAU') AS "clientType", "cluster", "createdAt", "db2Database", "db2Host", "db2Password", "db2Port", "db2Schema", "db2Username", "id", "isActive", "lastCronAttemptAt", "lastCronCacheAt", "lastCronSyncAt", "name", "payrollCycle", "payrollEnabled", "payrollSyncedAt", "tags", "timezone", "updatedAt", "whiteGlove" FROM "Client";
DROP TABLE "Client";
ALTER TABLE "new_Client" RENAME TO "Client";
CREATE UNIQUE INDEX "Client_clientId_key" ON "Client"("clientId");
CREATE INDEX "Client_clientId_idx" ON "Client"("clientId");
CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");
CREATE INDEX "Client_cluster_idx" ON "Client"("cluster");
CREATE TABLE "new_PurgeConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "retainDays" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPurgeAt" DATETIME,
    "lastPurgeCount" INTEGER,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PurgeConfig" ("enabled", "id", "label", "lastPurgeAt", "lastPurgeCount", "retainDays", "updatedAt") SELECT "enabled", "id", "label", "lastPurgeAt", "lastPurgeCount", "retainDays", "updatedAt" FROM "PurgeConfig";
DROP TABLE "PurgeConfig";
ALTER TABLE "new_PurgeConfig" RENAME TO "PurgeConfig";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "UnprocPunchAlert_clientId_key" ON "UnprocPunchAlert"("clientId");

-- CreateIndex
CREATE INDEX "UnprocPunchAlert_status_idx" ON "UnprocPunchAlert"("status");

-- CreateIndex
CREATE INDEX "UnprocPunchAlert_suppressUntil_idx" ON "UnprocPunchAlert"("suppressUntil");
