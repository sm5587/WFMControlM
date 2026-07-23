-- Pre-computed window times on calendar entries (computed once at Excel import)
ALTER TABLE "MaintenanceCalendarEntry" ADD COLUMN "title" TEXT;
ALTER TABLE "MaintenanceCalendarEntry" ADD COLUMN "startTimeUtc" DATETIME;
ALTER TABLE "MaintenanceCalendarEntry" ADD COLUMN "endTimeUtc" DATETIME;
ALTER TABLE "MaintenanceCalendarEntry" ADD COLUMN "startLocal" TEXT;
ALTER TABLE "MaintenanceCalendarEntry" ADD COLUMN "endLocal" TEXT;
