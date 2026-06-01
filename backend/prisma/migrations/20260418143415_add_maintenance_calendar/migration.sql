-- CreateTable
CREATE TABLE "MaintenanceCalendar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "importedBy" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryCount" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "MaintenanceCalendarEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calendarId" TEXT NOT NULL,
    "maintenanceGroup" TEXT NOT NULL,
    "clusters" TEXT NOT NULL,
    "maintenanceWindow" TEXT NOT NULL,
    "windowStartTime" TEXT,
    "windowEndTime" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'EST',
    "maintenanceDate" DATETIME NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    CONSTRAINT "MaintenanceCalendarEntry_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "MaintenanceCalendar" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MaintenanceCalendar_year_idx" ON "MaintenanceCalendar"("year");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceCalendar_year_key" ON "MaintenanceCalendar"("year");

-- CreateIndex
CREATE INDEX "MaintenanceCalendarEntry_calendarId_idx" ON "MaintenanceCalendarEntry"("calendarId");

-- CreateIndex
CREATE INDEX "MaintenanceCalendarEntry_maintenanceDate_idx" ON "MaintenanceCalendarEntry"("maintenanceDate");

-- CreateIndex
CREATE INDEX "MaintenanceCalendarEntry_year_month_idx" ON "MaintenanceCalendarEntry"("year", "month");

-- CreateIndex
CREATE INDEX "MaintenanceCalendarEntry_clusters_idx" ON "MaintenanceCalendarEntry"("clusters");
