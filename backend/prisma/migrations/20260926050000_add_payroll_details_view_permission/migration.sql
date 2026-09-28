-- Payroll Jobs unit-detail view permission
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('PAYROLL_DETAILS_VIEW', 'Payroll Jobs', 'Payroll Jobs — Unit Details', 'View per-unit pay file release status on Payroll Jobs', 73);

-- Grant read+write to System Admin
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, 'PAYROLL_DETAILS_VIEW', 1, 1
FROM "Profile" p
WHERE p."isSystem" = 1 AND p.name = 'System Admin';

-- Grant read to Monitor, Advanced Monitor, Read Only
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, 'PAYROLL_DETAILS_VIEW', 1, 0
FROM "Profile" p
WHERE p."isSystem" = 1 AND p.name IN ('Monitor', 'Advanced Monitor', 'Read Only');

-- Backfill: custom profiles that already had Payroll Jobs read also get unit details read
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT "profileId", 'PAYROLL_DETAILS_VIEW', "canRead", 0
FROM "Permission"
WHERE "functionId" = 'PAYROLL_VIEW' AND "canRead" = 1;
