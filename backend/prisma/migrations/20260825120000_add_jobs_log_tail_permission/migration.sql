-- Remote log tail (SSH) — Administrator-only read permission for Cron Jobs
INSERT OR IGNORE INTO "AppFunction" ("id","module","name","description","sortOrder") VALUES
  ('JOBS_LOG_TAIL', 'JOBS', 'Remote Log Tail', 'View remote batch log content via SSH (Cron Jobs)', 16);

-- Grant read+write to System Admin only (Monitor / Read Only excluded by design)
INSERT OR IGNORE INTO "Permission" ("profileId","functionId","canRead","canWrite")
SELECT p.id, 'JOBS_LOG_TAIL', 1, 1
FROM "Profile" p WHERE p.isSystem = 1 AND p.name = 'System Admin';
