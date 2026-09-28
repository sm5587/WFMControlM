-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CustomAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '',
    "clientIds" TEXT NOT NULL DEFAULT '[]',
    "clientNames" TEXT NOT NULL DEFAULT '[]',
    "sqlQuery" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'GT',
    "thresholdValue" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmails" TEXT NOT NULL DEFAULT '[]',
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
INSERT INTO "new_CustomAlert" ("clientId", "clientIds", "clientName", "clientNames", "columnName", "createdAt", "createdBy", "id", "intervalMinutes", "isActive", "lastCheckedAt", "lastError", "lastStatus", "lastTriggeredAt", "lastValue", "name", "operator", "results", "sqlQuery", "thresholdValue", "updatedAt") SELECT "clientId", "clientIds", "clientName", "clientNames", "columnName", "createdAt", "createdBy", "id", "intervalMinutes", "isActive", "lastCheckedAt", "lastError", "lastStatus", "lastTriggeredAt", "lastValue", "name", "operator", "results", "sqlQuery", "thresholdValue", "updatedAt" FROM "CustomAlert";
DROP TABLE "CustomAlert";
ALTER TABLE "new_CustomAlert" RENAME TO "CustomAlert";
CREATE INDEX "CustomAlert_isActive_idx" ON "CustomAlert"("isActive");
CREATE INDEX "CustomAlert_clientId_idx" ON "CustomAlert"("clientId");
CREATE INDEX "CustomAlert_lastStatus_idx" ON "CustomAlert"("lastStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
