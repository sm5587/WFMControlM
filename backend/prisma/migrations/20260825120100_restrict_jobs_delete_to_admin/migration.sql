-- Restrict cron job delete to System Admin only (Monitor / Read Only excluded)
DELETE FROM "Permission"
WHERE "functionId" = 'JOBS_DELETE'
  AND "profileId" IN (
    SELECT id FROM "Profile" WHERE isSystem = 1 AND name IN ('Monitor', 'Read Only')
  );

INSERT OR IGNORE INTO "Permission" ("profileId","functionId","canRead","canWrite")
SELECT p.id, 'JOBS_DELETE', 1, 1
FROM "Profile" p WHERE p.isSystem = 1 AND p.name = 'System Admin';
