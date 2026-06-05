-- ============================================================
-- SQLite queries (local app DB via Prisma) by menu
-- Table names match Prisma models. {param} = runtime value.
-- DB2 client-database queries are in client-db2-queries.sql
-- ============================================================

-- ---------- Global (sidebar filter, config, background polling) ----------

-- Layout cluster/client filter (all authenticated pages)
SELECT * FROM Client
WHERE isActive = 1
ORDER BY clientId ASC;
-- optional: search filters clientId/name with LIKE

-- App startup / ConfigContext (non-secret config; served from memory after load)
SELECT * FROM AppConfig;

-- Background polling: unprocessed punch cache trigger uses same API as Unprocessed Punch menu
-- Background polling: DB Jobs cache
SELECT * FROM CachedQueueJob;
SELECT * FROM CriticalDbJob;

-- Login (not a menu; on sign-in)
SELECT * FROM User WHERE username = {username} LIMIT 1;
SELECT up.*, p.*, perm.*
FROM UserProfile up
JOIN Profile p ON p.id = up.profileId
JOIN Permission perm ON perm.profileId = p.id
WHERE up.userId = {userId};

-- ---------- Dashboard (/dashboard) ----------

SELECT * FROM Job
WHERE deleteStatus IS NULL
ORDER BY name ASC
LIMIT {pageSize} OFFSET {offset};

SELECT j.*, c.id, c.clientId, c.name, c.cluster
FROM Job j
LEFT JOIN Client c ON c.id = j.clientId
WHERE j.isActive = 1 AND j.deleteStatus IS NULL AND j.cronExpression IS NOT NULL;

-- Unprocessed punch widget (also hits client DB2; see client-db2-queries.sql)
SELECT clientId, name, cluster FROM Client
WHERE payrollEnabled = 1 AND isActive = 1
ORDER BY cluster ASC, clientId ASC;

-- Escalated alerts widget
SELECT * FROM EscalatedAlert
WHERE resolvedAt IS NULL AND firstSeenAt <= {oneHourAgo}
ORDER BY stalePendingCount DESC;

SELECT clientId, name, cluster FROM Client;

-- ---------- Clients (/clients) ----------

SELECT c.*,
  (SELECT COUNT(*) FROM AppServer WHERE clientId = c.id) AS appServers,
  (SELECT COUNT(*) FROM Job WHERE clientId = c.id) AS jobs,
  (SELECT COUNT(*) FROM SyncHistory WHERE clientId = c.id) AS syncHistory
FROM Client c
WHERE {search/isActive filters}
ORDER BY clientId ASC;

SELECT * FROM Client WHERE id = {id};
SELECT * FROM AppServer WHERE clientId = {id} ORDER BY environment, serverNum;

SELECT * FROM SyncHistory
WHERE clientId = {id}
ORDER BY createdAt DESC
LIMIT {limit};

-- Client detail / edit dialogs
UPDATE Client SET ... WHERE id = {id};
SELECT * FROM AppServer WHERE clientId = {id};
INSERT INTO AppServer (...) VALUES (...);
UPDATE AppServer SET ... WHERE id = {serverId};
DELETE FROM AppServer WHERE id = {serverId};

-- Sync actions (writes SyncHistory, Job, AppServer, Client, CachedCronJob — large sync path)
INSERT INTO SyncHistory (...) VALUES (...);
UPDATE SyncHistory SET status = ..., completedAt = ... WHERE id = {id};
SELECT * FROM Job WHERE clientId = {id} AND deleteStatus IS NULL;
UPDATE Job SET ... WHERE id = {id};
INSERT INTO Job (...) VALUES (...);
DELETE FROM Job WHERE clientId = {id} AND ...;
UPDATE Client SET lastCronSyncAt = ..., lastCronAttemptAt = ... WHERE id = {id};
UPDATE AppServer SET timezone = ..., lastCronFetchAt = ... WHERE id = {id};

-- ---------- Cron Jobs (/jobs) ----------

SELECT j.*,
  (SELECT COUNT(*) FROM JobExecution WHERE jobId = j.id) AS executions,
  c.id, c.clientId, c.name, c.cluster
FROM Job j
LEFT JOIN Client c ON c.id = j.clientId
WHERE j.deleteStatus IS NULL AND {filters}
ORDER BY j.name ASC
LIMIT {pageSize} OFFSET {offset};

SELECT COUNT(*) FROM Job WHERE deleteStatus IS NULL AND {filters};

SELECT clients for filter dropdown (same as global Client list, isActive = 1);

-- Job detail panel
SELECT * FROM Job WHERE id = {id};
SELECT * FROM JobExecution WHERE jobId = {id} ORDER BY scheduledAt DESC LIMIT 10;
SELECT * FROM AlertRule WHERE jobId = {id};

-- Mutations: trigger/toggle/delete/create/update Job + AuditLog
INSERT INTO JobExecution (...) VALUES (...);
UPDATE Job SET isActive = ..., deleteStatus = 'D', ... WHERE id = {id};
INSERT INTO AuditLog (...) VALUES (...);

-- ---------- DB Jobs (/db-jobs) ----------

SELECT * FROM CachedQueueJob;
SELECT * FROM CriticalDbJob;

SELECT * FROM CachedQueueJob WHERE clientId = {clientId};
-- on cache miss: upsert CachedQueueJob after DB2 fetch (see client-db2-queries.sql)

INSERT INTO CachedQueueJob (clientId, jobData, jobCount, error, fetchedAt)
VALUES (...)
ON CONFLICT(clientId) DO UPDATE SET ...;

SELECT * FROM CriticalDbJob WHERE clientId = {clientId};
INSERT INTO CriticalDbJob (clientId, jobName) VALUES (...);
DELETE FROM CriticalDbJob WHERE clientId = {clientId} AND jobName = {jobName};

-- ---------- Monitor (/monitor) ----------

SELECT * FROM Client WHERE isActive = 1 ORDER BY clientId ASC;

SELECT je.*, j.name, j.jobType, j.category, j.priority
FROM JobExecution je
JOIN Job j ON j.id = je.jobId
WHERE je.status IN ('RUNNING','PENDING','QUEUED','RETRY_PENDING')
ORDER BY j.priority DESC, je.scheduledAt ASC
LIMIT {limit};

SELECT je.*, j.name, j.jobType, j.category, j.tags
FROM JobExecution je
JOIN Job j ON j.id = je.jobId
WHERE {status, jobId, clientId, cluster, category, search, date range}
ORDER BY je.scheduledAt DESC
LIMIT {pageSize} OFFSET {offset};

SELECT COUNT(*) FROM JobExecution je JOIN Job j ON j.id = je.jobId WHERE {same filters};

UPDATE JobExecution SET status = 'CANCELLED', ... WHERE id = {executionId};

-- ---------- DB Jobs Monitor (/db-monitor) ----------

SELECT clientId, name, cluster FROM Client;

SELECT clientId, jobName FROM CriticalDbJob;

-- Batch views use client DB2 (client-db2-queries.sql); SQLite only for names/critical flags above

-- Optional SSH monitor paths (same menu, legacy endpoints):
SELECT * FROM Client WHERE id = {id} INCLUDE AppServer;
SELECT * FROM Client WHERE isActive = 1 ORDER BY clientId ASC;

-- ---------- Payroll Jobs (/payroll) ----------

SELECT clientId, name, payrollCycle, payrollSyncedAt FROM Client
WHERE payrollEnabled = 1
ORDER BY clientId ASC;

-- sync-clients background (updates local flags after DB2 PRODUCT_FEATURE query)
SELECT clientId FROM Client;
UPDATE Client SET payrollEnabled = {bool}, payrollSyncedAt = {now} WHERE clientId = {id};
INSERT INTO Client (...) ON CONFLICT(clientId) DO UPDATE SET payrollEnabled = ...;

-- Payroll detail uses client DB2 only (TA_UNIT_PAY_STATUS)

-- ---------- Unprocessed Punch (/unprocessed-punch) ----------

SELECT clientId, name, cluster FROM Client
WHERE payrollEnabled = 1 AND isActive = 1
ORDER BY cluster ASC, clientId ASC;

-- Counts from client DB2 (TA_UNPROC_PUNCH); /all uses in-memory cache, no extra SQLite reads

-- ---------- Alerts (/alerts) ----------

SELECT * FROM EscalatedAlert
WHERE resolvedAt IS NULL AND firstSeenAt <= {oneHourAgo}
ORDER BY stalePendingCount DESC;

SELECT clientId, name, cluster FROM Client;

SELECT * FROM NotificationRecipient ORDER BY name ASC;

SELECT * FROM UnprocPunchAlert;
UPDATE UnprocPunchAlert SET status = 'OPEN', ... WHERE id = {id} AND suppressUntil < {now};
INSERT INTO UnprocPunchAlert (...) ON CONFLICT(clientId) DO UPDATE SET status = 'ACKNOWLEDGED' | 'SUPPRESSED', ...;

UPDATE EscalatedAlert SET status = 'ACKNOWLEDGED', ... WHERE id = {id};
UPDATE EscalatedAlert SET status = 'SUPPRESSED', suppressUntil = ..., ... WHERE id = {id};

SELECT * FROM NotificationRecipient WHERE isActive = 1 ORDER BY name ASC;
INSERT INTO NotificationRecipient (name, email) VALUES (...);
DELETE FROM NotificationRecipient WHERE id = {id};
UPDATE NotificationRecipient SET isActive = ... WHERE id = {id};

-- Unprocessed punch tab (live data = DB2; statuses = UnprocPunchAlert above)

-- ---------- Admin > Users (/admin/users) ----------

SELECT id, username, email, displayName, timezone, isActive, createdAt FROM User ORDER BY username ASC;
SELECT * FROM Profile ORDER BY name ASC;

UPDATE User SET displayName = ..., email = ..., timezone = ..., isActive = ..., passwordHash = ... WHERE id = {id};
UPDATE User SET isActive = 0 WHERE id = {id};

INSERT INTO User (username, email, displayName, passwordHash, isActive) VALUES (...);

INSERT INTO UserProfile (userId, profileId, assignedBy) VALUES (...)
ON CONFLICT(userId, profileId) DO UPDATE SET assignedBy = ...;
DELETE FROM UserProfile WHERE userId = {userId} AND profileId = {profileId};

-- ---------- Admin > Profiles (/admin/profiles) ----------

SELECT p.*, perm.*, f.*, (SELECT COUNT(*) FROM UserProfile WHERE profileId = p.id) AS users
FROM Profile p
LEFT JOIN Permission perm ON perm.profileId = p.id
LEFT JOIN AppFunction f ON f.id = perm.functionId
ORDER BY p.name ASC;

INSERT INTO Profile (name, description) VALUES (...);
DELETE FROM Profile WHERE id = {id} AND isSystem = 0;

DELETE FROM Permission WHERE profileId = {id};
INSERT INTO Permission (profileId, functionId, canRead, canWrite) VALUES (...);

INSERT INTO Permission (...) ON CONFLICT(profileId, functionId) DO UPDATE SET canRead = ..., canWrite = ...;

-- ---------- Admin > Purge (/admin/purge) ----------

SELECT * FROM PurgeConfig ORDER BY id ASC;

SELECT COUNT(*) FROM SyncHistory;
SELECT COUNT(*) FROM JobExecution;
SELECT COUNT(*) FROM AlertEvent;
SELECT COUNT(*) FROM EscalatedAlert;
SELECT COUNT(*) FROM AuditLog;
SELECT COUNT(*) FROM CachedCronJob;

UPDATE PurgeConfig SET retainDays = ..., enabled = ... WHERE id = {id};

DELETE FROM SyncHistory WHERE createdAt < {cutoff};
DELETE FROM JobExecution WHERE createdAt < {cutoff};
DELETE FROM AlertEvent WHERE createdAt < {cutoff} AND acknowledged = 1;
DELETE FROM EscalatedAlert WHERE resolvedAt < {cutoff} AND status IN ('ACKNOWLEDGED','SUPPRESSED');
DELETE FROM AuditLog WHERE createdAt < {cutoff};
DELETE FROM CachedCronJob WHERE fetchedAt < {cutoff};

UPDATE PurgeConfig SET lastPurgeAt = ..., lastPurgeCount = ... WHERE id = {id};

-- ---------- Admin > Config (/admin/config) ----------

SELECT * FROM AppConfig ORDER BY category, key;

UPDATE AppConfig SET value = ..., updatedBy = ... WHERE key = {key};
