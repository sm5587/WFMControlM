-- Convert Client/AppServer DateTime columns from TEXT to integer ms (Prisma SQLite on Linux).
-- Safe to rerun: only updates rows where typeof(column) = 'text'.

PRAGMA foreign_keys = OFF;

-- Helper: julianday-based ms conversion for 'YYYY-MM-DD HH:MM:SS.sss' text values.
-- Applied per column below.

UPDATE "Client" SET "payrollSyncedAt" = CAST((julianday(substr("payrollSyncedAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("payrollSyncedAt",21,3),'0') AS INTEGER) WHERE typeof("payrollSyncedAt")='text' AND "payrollSyncedAt" IS NOT NULL;
UPDATE "Client" SET "lastCronSyncAt" = CAST((julianday(substr("lastCronSyncAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("lastCronSyncAt",21,3),'0') AS INTEGER) WHERE typeof("lastCronSyncAt")='text' AND "lastCronSyncAt" IS NOT NULL;
UPDATE "Client" SET "lastCronAttemptAt" = CAST((julianday(substr("lastCronAttemptAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("lastCronAttemptAt",21,3),'0') AS INTEGER) WHERE typeof("lastCronAttemptAt")='text' AND "lastCronAttemptAt" IS NOT NULL;
UPDATE "Client" SET "lastCronCacheAt" = CAST((julianday(substr("lastCronCacheAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("lastCronCacheAt",21,3),'0') AS INTEGER) WHERE typeof("lastCronCacheAt")='text' AND "lastCronCacheAt" IS NOT NULL;
UPDATE "Client" SET "createdAt" = CAST((julianday(substr("createdAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("createdAt",21,3),'0') AS INTEGER) WHERE typeof("createdAt")='text' AND "createdAt" IS NOT NULL;
UPDATE "Client" SET "updatedAt" = CAST((julianday(substr("updatedAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("updatedAt",21,3),'0') AS INTEGER) WHERE typeof("updatedAt")='text' AND "updatedAt" IS NOT NULL;

UPDATE "AppServer" SET "tzLastAttemptAt" = CAST((julianday(substr("tzLastAttemptAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("tzLastAttemptAt",21,3),'0') AS INTEGER) WHERE typeof("tzLastAttemptAt")='text' AND "tzLastAttemptAt" IS NOT NULL;
UPDATE "AppServer" SET "lastPingAt" = CAST((julianday(substr("lastPingAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("lastPingAt",21,3),'0') AS INTEGER) WHERE typeof("lastPingAt")='text' AND "lastPingAt" IS NOT NULL;
UPDATE "AppServer" SET "lastCronFetchAt" = CAST((julianday(substr("lastCronFetchAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("lastCronFetchAt",21,3),'0') AS INTEGER) WHERE typeof("lastCronFetchAt")='text' AND "lastCronFetchAt" IS NOT NULL;
UPDATE "AppServer" SET "createdAt" = CAST((julianday(substr("createdAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("createdAt",21,3),'0') AS INTEGER) WHERE typeof("createdAt")='text' AND "createdAt" IS NOT NULL;
UPDATE "AppServer" SET "updatedAt" = CAST((julianday(substr("updatedAt",1,19)) - 2440587.5) * 86400000 AS INTEGER) + CAST(COALESCE(substr("updatedAt",21,3),'0') AS INTEGER) WHERE typeof("updatedAt")='text' AND "updatedAt" IS NOT NULL;

PRAGMA foreign_keys = ON;
