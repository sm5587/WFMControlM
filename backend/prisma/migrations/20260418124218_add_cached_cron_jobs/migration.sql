-- AlterTable
ALTER TABLE "AppServer" ADD COLUMN "cronJobCount" INTEGER;
ALTER TABLE "AppServer" ADD COLUMN "lastCronFetchAt" DATETIME;
ALTER TABLE "AppServer" ADD COLUMN "lastCronFetchStatus" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "lastCronCacheAt" DATETIME;

-- CreateTable
CREATE TABLE "CachedCronJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "appServerId" TEXT,
    "environment" TEXT NOT NULL,
    "serverDns" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "owner" TEXT,
    "rawLine" TEXT NOT NULL,
    "logPath" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CachedCronJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CachedCronJob_appServerId_fkey" FOREIGN KEY ("appServerId") REFERENCES "AppServer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CachedCronJob_clientId_idx" ON "CachedCronJob"("clientId");

-- CreateIndex
CREATE INDEX "CachedCronJob_appServerId_idx" ON "CachedCronJob"("appServerId");

-- CreateIndex
CREATE INDEX "CachedCronJob_clientId_environment_idx" ON "CachedCronJob"("clientId", "environment");

-- CreateIndex
CREATE INDEX "CachedCronJob_fetchedAt_idx" ON "CachedCronJob"("fetchedAt");
