-- Unprocessed Punch refresh permissions — DB2 query actions (Administrator by default)
INSERT OR IGNORE INTO "AppFunction" ("id", "module", "name", "description", "sortOrder") VALUES
  ('UNPROC_PUNCH_REFRESH_ALL',  'Unprocessed Punch', 'Unprocessed Punch — Refresh All',        'Reload punch counts for all RTA clients from DB2', 76),
  ('UNPROC_PUNCH_REFRESH_HIGH', 'Unprocessed Punch', 'Unprocessed Punch — Refresh High Alert', 'Reload punch counts for high-alert clients (>500 pending)', 77),
  ('UNPROC_PUNCH_REFRESH_ROW',  'Unprocessed Punch', 'Unprocessed Punch — Refresh Client',     'Reload punch count for a single client from DB2', 78);

-- Grant read+write to System Admin only (Monitor / Read Only excluded by design)
INSERT OR IGNORE INTO "Permission" ("profileId", "functionId", "canRead", "canWrite")
SELECT p.id, fn.id, 1, 1
FROM "Profile" p
CROSS JOIN (
  SELECT 'UNPROC_PUNCH_REFRESH_ALL' AS id UNION ALL
  SELECT 'UNPROC_PUNCH_REFRESH_HIGH' UNION ALL
  SELECT 'UNPROC_PUNCH_REFRESH_ROW'
) fn
WHERE p.isSystem = 1 AND p.name = 'System Admin';
