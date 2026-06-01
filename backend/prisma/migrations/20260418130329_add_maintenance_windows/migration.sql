-- CreateTable
CREATE TABLE "MaintenanceWindow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "cluster" TEXT,
    "clientDbId" TEXT,
    "clientCode" TEXT,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PLANNED',
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "startTimeUtc" DATETIME NOT NULL,
    "endTimeUtc" DATETIME NOT NULL,
    "inputTimezone" TEXT NOT NULL DEFAULT 'IST',
    "startLocal" TEXT NOT NULL,
    "endLocal" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "importBatchId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "MaintenanceWindow_scope_cluster_idx" ON "MaintenanceWindow"("scope", "cluster");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_clientDbId_idx" ON "MaintenanceWindow"("clientDbId");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_status_idx" ON "MaintenanceWindow"("status");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_startTimeUtc_idx" ON "MaintenanceWindow"("startTimeUtc");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_importBatchId_idx" ON "MaintenanceWindow"("importBatchId");
