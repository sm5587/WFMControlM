-- Align AppFunction display names and modules with sidebar menu labels
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs' WHERE "id" = 'JOBS_VIEW';
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs — Create' WHERE "id" = 'JOBS_CREATE';
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs — Edit' WHERE "id" = 'JOBS_EDIT';
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs — Delete' WHERE "id" = 'JOBS_DELETE';
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs — Run Now' WHERE "id" = 'JOBS_TRIGGER';
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs — Enable / Disable' WHERE "id" = 'JOBS_TOGGLE';
UPDATE "AppFunction" SET "module" = 'Cron Jobs', "name" = 'Cron Jobs — Remote Log Tail' WHERE "id" = 'JOBS_LOG_TAIL';

UPDATE "AppFunction" SET "module" = 'Clients', "name" = 'Clients' WHERE "id" = 'CLIENTS_VIEW';
UPDATE "AppFunction" SET "module" = 'Clients', "name" = 'Clients — Add' WHERE "id" = 'CLIENTS_CREATE';
UPDATE "AppFunction" SET "module" = 'Clients', "name" = 'Clients — Edit' WHERE "id" = 'CLIENTS_EDIT';
UPDATE "AppFunction" SET "module" = 'Clients', "name" = 'Clients — Sync Jobs' WHERE "id" = 'CLIENTS_SYNC';
UPDATE "AppFunction" SET "module" = 'Clients', "name" = 'Clients — Detect Timezones' WHERE "id" = 'CLIENTS_DETECT_TZ';

UPDATE "AppFunction" SET "module" = 'Alerts', "name" = 'Alerts' WHERE "id" = 'ALERTS_VIEW';
UPDATE "AppFunction" SET "module" = 'Alerts', "name" = 'Alerts — Manage Rules' WHERE "id" = 'ALERTS_RULES';
UPDATE "AppFunction" SET "module" = 'Alerts', "name" = 'Alerts — Acknowledge' WHERE "id" = 'ALERTS_ACK';
UPDATE "AppFunction" SET "module" = 'Alerts', "name" = 'Alerts — Suppress' WHERE "id" = 'ALERTS_SUPPRESS';
UPDATE "AppFunction" SET "module" = 'Alerts', "name" = 'Alerts — Send Email' WHERE "id" = 'ALERTS_NOTIFY';
UPDATE "AppFunction" SET "module" = 'Alerts', "name" = 'Alerts — Manage Recipients' WHERE "id" = 'RECIPIENTS_MANAGE';

UPDATE "AppFunction" SET "module" = 'DB Jobs Monitor', "name" = 'DB Jobs Monitor' WHERE "id" = 'DBMONITOR_VIEW';
UPDATE "AppFunction" SET "module" = 'DB Jobs', "name" = 'DB Jobs' WHERE "id" = 'DBJOBS_VIEW';
UPDATE "AppFunction" SET "module" = 'Payroll Jobs', "name" = 'Payroll Jobs' WHERE "id" = 'PAYROLL_VIEW';
UPDATE "AppFunction" SET "module" = 'Unprocessed Punch', "name" = 'Unprocessed Punch' WHERE "id" = 'UNPROC_PUNCH_VIEW';

UPDATE "AppFunction" SET "module" = 'Maintenance', "name" = 'Maintenance' WHERE "id" = 'MAINTENANCE_VIEW';
UPDATE "AppFunction" SET "module" = 'Maintenance', "name" = 'Maintenance — Manage' WHERE "id" = 'MAINTENANCE_MANAGE';
UPDATE "AppFunction" SET "module" = 'Maintenance', "name" = 'Maintenance — Outage Impact' WHERE "id" = 'OUTAGE_VIEW';

UPDATE "AppFunction" SET "module" = 'Upload Monitor', "name" = 'Upload Monitor' WHERE "id" = 'FILE_MONITOR_VIEW';

UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Users' WHERE "id" = 'USERS_VIEW';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Users — Manage' WHERE "id" = 'USERS_MANAGE';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Profiles' WHERE "id" = 'PROFILES_VIEW';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Profiles — Manage' WHERE "id" = 'PROFILES_MANAGE';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Config' WHERE "id" = 'PERMISSIONS_EDIT';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Users — Assign Profiles' WHERE "id" = 'USER_PROFILE_ASSIGN';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Purge' WHERE "id" = 'DATA_PURGE_VIEW';
UPDATE "AppFunction" SET "module" = 'Admin', "name" = 'Purge — Run / Configure' WHERE "id" = 'DATA_PURGE_RUN';
