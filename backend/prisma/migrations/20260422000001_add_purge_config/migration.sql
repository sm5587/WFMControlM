-- PurgeConfig table: admin-controlled retention settings per purgeable table.
CREATE TABLE "PurgeConfig" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "label"          TEXT NOT NULL,
  "retainDays"     INTEGER NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT 1,
  "lastPurgeAt"    DATETIME,
  "lastPurgeCount" INTEGER,
  "updatedAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed default retention policies
INSERT INTO "PurgeConfig" ("id","label","retainDays","enabled","updatedAt") VALUES
  ('syncHistory',     'Sync History',        30, 1, CURRENT_TIMESTAMP),
  ('jobExecution',    'Job Executions',       30, 1, CURRENT_TIMESTAMP),
  ('alertEvent',      'Alert Events',         60, 1, CURRENT_TIMESTAMP),
  ('escalatedAlert',  'Escalated Alerts',     90, 1, CURRENT_TIMESTAMP),
  ('auditLog',        'Audit Log',            90, 1, CURRENT_TIMESTAMP),
  ('cachedCronJob',   'Cached Cron Jobs',      7, 1, CURRENT_TIMESTAMP);

-- Clear all existing JobExecution rows (feature paused — data is stale)
DELETE FROM "JobExecution";
