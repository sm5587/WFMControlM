-- WFM Control-M consolidated production DDL
-- Generated from current Prisma schema (all tables/indexes/constraints).
-- Apply on a fresh database before running database/dml.sql.

PRAGMA foreign_keys = ON;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "db2Host" TEXT,
    "db2Port" INTEGER NOT NULL DEFAULT 50000,
    "db2Database" TEXT,
    "db2Schema" TEXT,
    "db2Username" TEXT,
    "db2Password" TEXT,
    "payrollEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payrollCycle" TEXT NOT NULL DEFAULT 'weekly',
    "payrollSyncedAt" DATETIME,
    "lastCronSyncAt" DATETIME,
    "lastCronAttemptAt" DATETIME,
    "lastCronCacheAt" DATETIME,
    "cluster" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "whiteGlove" BOOLEAN NOT NULL DEFAULT false,
    "clientType" TEXT NOT NULL DEFAULT 'BAU',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AppServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "serverNum" TEXT NOT NULL,
    "dns" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "timezone" TEXT,
    "tzLastAttemptAt" DATETIME,
    "lastPingAt" DATETIME,
    "lastPingStatus" TEXT,
    "lastCronFetchAt" DATETIME,
    "lastCronFetchStatus" TEXT,
    "cronJobCount" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppServer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SyncHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "source" TEXT,
    "jobsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "jobsCreated" INTEGER NOT NULL DEFAULT 0,
    "jobsUpdated" INTEGER NOT NULL DEFAULT 0,
    "jobsRemoved" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncHistory_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "jobType" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "clientId" TEXT,
    "sourceSystem" TEXT,
    "sourceIdentifier" TEXT,
    "cronExpression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "serverTimezone" TEXT,
    "nextRunTime" DATETIME,
    "nextRunLocal" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "command" TEXT,
    "scriptPath" TEXT,
    "logPath" TEXT,
    "logCheckEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunStatus" TEXT,
    "lastRunAt" DATETIME,
    "lastLogCheckAt" DATETIME,
    "deleteStatus" TEXT,
    "httpConfig" TEXT,
    "retryPolicy" TEXT,
    "timeout" INTEGER NOT NULL DEFAULT 3600,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "resourcePool" TEXT NOT NULL DEFAULT 'default',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "parameters" TEXT,
    "environment" TEXT,
    "owner" TEXT,
    "team" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "JobExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "duration" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "exitCode" INTEGER,
    "output" TEXT,
    "errorMessage" TEXT,
    "logs" TEXT,
    "agentId" TEXT,
    "pid" INTEGER,
    "memoryUsageMb" REAL,
    "cpuPercent" REAL,
    "parameters" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'scheduler',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobExecution_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AlertRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "jobId" TEXT,
    "triggerType" TEXT NOT NULL,
    "condition" TEXT,
    "channels" TEXT NOT NULL DEFAULT '["EMAIL"]',
    "recipients" TEXT NOT NULL DEFAULT '[]',
    "slackChannel" TEXT,
    "webhookUrl" TEXT,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 30,
    "lastTriggeredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AlertRule_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AlertEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertRuleId" TEXT NOT NULL,
    "executionId" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertEvent_alertRuleId_fkey" FOREIGN KEY ("alertRuleId") REFERENCES "AlertRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AlertEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "JobExecution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EscalatedAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "serverCode" TEXT NOT NULL,
    "stalePendingCount" INTEGER NOT NULL,
    "totalPending" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "suppressedBy" TEXT,
    "suppressedAt" DATETIME,
    "suppressUntil" DATETIME,
    "suppressReason" TEXT,
    "emailSentAt" DATETIME,
    "emailRecipients" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UnprocPunchAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "suppressedBy" TEXT,
    "suppressedAt" DATETIME,
    "suppressUntil" DATETIME,
    "suppressReason" TEXT,
    "emailSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CriticalDbJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "markedBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CachedQueueJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "jobData" TEXT NOT NULL,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MaintenanceWindow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "cluster" TEXT,
    "clientDbId" TEXT,
    "clientCode" TEXT,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PLANNED',
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "startTimeUtc" DATETIME NOT NULL,
    "endTimeUtc" DATETIME NOT NULL,
    "inputTimezone" TEXT NOT NULL DEFAULT 'IST',
    "startLocal" TEXT NOT NULL,
    "endLocal" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "importBatchId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MaintenanceCalendar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "importedBy" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryCount" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MaintenanceCalendarEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calendarId" TEXT NOT NULL,
    "maintenanceGroup" TEXT NOT NULL,
    "clusters" TEXT NOT NULL,
    "maintenanceWindow" TEXT NOT NULL,
    "windowStartTime" TEXT,
    "windowEndTime" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'EST',
    "maintenanceDate" DATETIME NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    CONSTRAINT "MaintenanceCalendarEntry_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "MaintenanceCalendar" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CachedCronJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "appServerId" TEXT,
    "environment" TEXT NOT NULL,
    "serverDns" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "owner" TEXT,
    "rawLine" TEXT NOT NULL,
    "logPath" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CachedCronJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CachedCronJob_appServerId_fkey" FOREIGN KEY ("appServerId") REFERENCES "AppServer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserProfile" (
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,

    PRIMARY KEY ("userId", "profileId"),
    CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserProfile_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AppFunction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "module" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Permission" (
    "profileId" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY ("profileId", "functionId"),
    CONSTRAINT "Permission_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Permission_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "AppFunction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "NotificationRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurgeConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "retainDays" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPurgeAt" DATETIME,
    "lastPurgeCount" INTEGER,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AppConfig" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResourcePool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 10,
    "currentUsage" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Calendar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarDate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calendarId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "isHoliday" BOOLEAN NOT NULL DEFAULT false,
    "isWorkday" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    CONSTRAINT "CalendarDate_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Client_clientId_key" ON "Client"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Client_clientId_idx" ON "Client"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Client_isActive_idx" ON "Client"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Client_cluster_idx" ON "Client"("cluster");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AppServer_clientId_idx" ON "AppServer"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AppServer_environment_idx" ON "AppServer"("environment");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AppServer_clientId_environment_serverNum_key" ON "AppServer"("clientId", "environment", "serverNum");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SyncHistory_clientId_idx" ON "SyncHistory"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SyncHistory_status_idx" ON "SyncHistory"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SyncHistory_createdAt_idx" ON "SyncHistory"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Job_name_key" ON "Job"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_jobType_idx" ON "Job"("jobType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_category_idx" ON "Job"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_isActive_idx" ON "Job"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_resourcePool_idx" ON "Job"("resourcePool");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_clientId_idx" ON "Job"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_deleteStatus_idx" ON "Job"("deleteStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobExecution_jobId_status_idx" ON "JobExecution"("jobId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobExecution_scheduledAt_idx" ON "JobExecution"("scheduledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobExecution_status_idx" ON "JobExecution"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertRule_triggerType_idx" ON "AlertRule"("triggerType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertRule_isActive_idx" ON "AlertRule"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertEvent_alertRuleId_idx" ON "AlertEvent"("alertRuleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertEvent_severity_idx" ON "AlertEvent"("severity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertEvent_acknowledged_idx" ON "AlertEvent"("acknowledged");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AlertEvent_createdAt_idx" ON "AlertEvent"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EscalatedAlert_clientId_idx" ON "EscalatedAlert"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EscalatedAlert_status_idx" ON "EscalatedAlert"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EscalatedAlert_suppressUntil_idx" ON "EscalatedAlert"("suppressUntil");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UnprocPunchAlert_clientId_key" ON "UnprocPunchAlert"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UnprocPunchAlert_status_idx" ON "UnprocPunchAlert"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UnprocPunchAlert_suppressUntil_idx" ON "UnprocPunchAlert"("suppressUntil");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CriticalDbJob_clientId_idx" ON "CriticalDbJob"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CriticalDbJob_clientId_jobName_key" ON "CriticalDbJob"("clientId", "jobName");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CachedQueueJob_fetchedAt_idx" ON "CachedQueueJob"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CachedQueueJob_clientId_key" ON "CachedQueueJob"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceWindow_scope_cluster_idx" ON "MaintenanceWindow"("scope", "cluster");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceWindow_clientDbId_idx" ON "MaintenanceWindow"("clientDbId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceWindow_status_idx" ON "MaintenanceWindow"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceWindow_startTimeUtc_idx" ON "MaintenanceWindow"("startTimeUtc");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceWindow_importBatchId_idx" ON "MaintenanceWindow"("importBatchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceCalendar_year_idx" ON "MaintenanceCalendar"("year");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MaintenanceCalendar_year_key" ON "MaintenanceCalendar"("year");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceCalendarEntry_calendarId_idx" ON "MaintenanceCalendarEntry"("calendarId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceCalendarEntry_maintenanceDate_idx" ON "MaintenanceCalendarEntry"("maintenanceDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceCalendarEntry_year_month_idx" ON "MaintenanceCalendarEntry"("year", "month");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaintenanceCalendarEntry_clusters_idx" ON "MaintenanceCalendarEntry"("clusters");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CachedCronJob_clientId_idx" ON "CachedCronJob"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CachedCronJob_appServerId_idx" ON "CachedCronJob"("appServerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CachedCronJob_clientId_environment_idx" ON "CachedCronJob"("clientId", "environment");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CachedCronJob_fetchedAt_idx" ON "CachedCronJob"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Profile_name_key" ON "Profile"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AppFunction_module_idx" ON "AppFunction"("module");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationRecipient_email_key" ON "NotificationRecipient"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AppConfig_category_idx" ON "AppConfig"("category");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ResourcePool_name_key" ON "ResourcePool"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Calendar_name_key" ON "Calendar"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarDate_date_idx" ON "CalendarDate"("date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarDate_calendarId_date_key" ON "CalendarDate"("calendarId", "date");


