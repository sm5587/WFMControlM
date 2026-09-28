-- Custom Alerts permissions
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('CUSTOM_ALERTS_VIEW', 'Custom Alerts', 'Custom Alerts', NULL, 73),
  ('CUSTOM_ALERTS_MANAGE', 'Custom Alerts', 'Custom Alerts — Create / Edit / Delete', 'Create, edit, delete and run custom SQL threshold alerts', 74);

-- Grant to System Admin (read + write)
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 1
FROM "Profile" p
CROSS JOIN (
  SELECT 'CUSTOM_ALERTS_VIEW' AS id UNION ALL
  SELECT 'CUSTOM_ALERTS_MANAGE'
) fn
WHERE p."isSystem" = 1 AND p.name = 'System Admin';

-- Grant read to Monitor + Read Only profiles
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 0
FROM "Profile" p
CROSS JOIN (
  SELECT 'CUSTOM_ALERTS_VIEW' AS id UNION ALL
  SELECT 'CUSTOM_ALERTS_MANAGE'
) fn
WHERE p."isSystem" = 1 AND p.name IN ('Monitor', 'Read Only');
