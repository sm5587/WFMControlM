-- Payroll Monitor + Sync permissions
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('PAYROLL_MONITOR_VIEW', 'Payroll Monitor', 'Payroll Monitor', NULL, 71),
  ('PAYROLL_SYNC', 'Payroll Jobs', 'Payroll Jobs — Sync Clients', 'Sync payroll product features from DB2', 72);

-- Grant to System Admin (read + write)
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 1
FROM "Profile" p
CROSS JOIN (
  SELECT 'PAYROLL_MONITOR_VIEW' AS id UNION ALL
  SELECT 'PAYROLL_SYNC'
) fn
WHERE p."isSystem" = 1 AND p.name = 'System Admin';

-- Grant read to Monitor + Read Only profiles
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 0
FROM "Profile" p
CROSS JOIN (
  SELECT 'PAYROLL_MONITOR_VIEW' AS id UNION ALL
  SELECT 'PAYROLL_SYNC'
) fn
WHERE p."isSystem" = 1 AND p.name IN ('Monitor', 'Read Only');

-- Backfill: profiles that already had PAYROLL_VIEW read also get monitor read
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT profileId, 'PAYROLL_MONITOR_VIEW', canRead, canWrite
FROM "Permission"
WHERE "functionId" = 'PAYROLL_VIEW' AND canRead = 1;

-- Ensure System Admin has Payroll Jobs read (fixes legacy rows with 0,0)
UPDATE "Permission"
SET canRead = 1, canWrite = 1
WHERE "functionId" = 'PAYROLL_VIEW'
  AND profileId IN (SELECT id FROM "Profile" WHERE "isSystem" = 1 AND name = 'System Admin');
