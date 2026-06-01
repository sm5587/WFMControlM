-- Add DATA_PURGE_VIEW and DATA_PURGE_RUN AppFunction rows
INSERT OR IGNORE INTO "AppFunction" ("id","module","name","description","sortOrder") VALUES
  ('DATA_PURGE_VIEW', 'ADMIN', 'View Data Purge Settings', 'View retention config and row counts', 86),
  ('DATA_PURGE_RUN',  'ADMIN', 'Run / Configure Data Purge', 'Edit retention days, enable/disable, trigger purge runs', 87);

-- Grant both permissions to System Admin profile (isSystem=true)
-- System Admin profile id is looked up dynamically so we use a subquery
INSERT OR IGNORE INTO "Permission" ("profileId","functionId","canRead","canWrite")
SELECT p.id, 'DATA_PURGE_VIEW', 1, 1
FROM "Profile" p WHERE p.isSystem = 1 AND p.name = 'System Admin';

INSERT OR IGNORE INTO "Permission" ("profileId","functionId","canRead","canWrite")
SELECT p.id, 'DATA_PURGE_RUN', 1, 1
FROM "Profile" p WHERE p.isSystem = 1 AND p.name = 'System Admin';
