-- AlterTable
ALTER TABLE "Client" ADD COLUMN "wfmAppUrl" TEXT;
ALTER TABLE "Client" ADD COLUMN "wfmAppVersion" TEXT;
ALTER TABLE "Client" ADD COLUMN "wfmAppVersionSyncedAt" DATETIME;
