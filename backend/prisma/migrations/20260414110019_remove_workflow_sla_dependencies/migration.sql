-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "db2Host" TEXT,
    "db2Port" INTEGER NOT NULL DEFAULT 50000,
    "db2Database" TEXT,
    "db2Schema" TEXT,
    "payrollEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payrollCycle" TEXT NOT NULL DEFAULT 'weekly',
    "payrollSyncedAt" DATETIME,
    "cluster" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "whiteGlove" BOOLEAN NOT NULL DEFAULT false,
    "owner" TEXT,
    "team" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppServer" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppServer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncHistory" (
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
CREATE TABLE "Job" (
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
CREATE TABLE "JobExecution" (
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
CREATE TABLE "AlertRule" (
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
CREATE TABLE "AlertEvent" (
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
CREATE TABLE "EscalatedAlert" (
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
CREATE TABLE "CriticalDbJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "markedBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CachedQueueJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "jobData" TEXT NOT NULL,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "NotificationRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
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
CREATE TABLE "ResourcePool" (
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
CREATE TABLE "Calendar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CalendarDate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calendarId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "isHoliday" BOOLEAN NOT NULL DEFAULT false,
    "isWorkday" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    CONSTRAINT "CalendarDate_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_clientId_key" ON "Client"("clientId");

-- CreateIndex
CREATE INDEX "Client_clientId_idx" ON "Client"("clientId");

-- CreateIndex
CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");

-- CreateIndex
CREATE INDEX "Client_cluster_idx" ON "Client"("cluster");

-- CreateIndex
CREATE INDEX "AppServer_clientId_idx" ON "AppServer"("clientId");

-- CreateIndex
CREATE INDEX "AppServer_environment_idx" ON "AppServer"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "AppServer_clientId_environment_serverNum_key" ON "AppServer"("clientId", "environment", "serverNum");

-- CreateIndex
CREATE INDEX "SyncHistory_clientId_idx" ON "SyncHistory"("clientId");

-- CreateIndex
CREATE INDEX "SyncHistory_status_idx" ON "SyncHistory"("status");

-- CreateIndex
CREATE INDEX "SyncHistory_createdAt_idx" ON "SyncHistory"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_name_key" ON "Job"("name");

-- CreateIndex
CREATE INDEX "Job_jobType_idx" ON "Job"("jobType");

-- CreateIndex
CREATE INDEX "Job_category_idx" ON "Job"("category");

-- CreateIndex
CREATE INDEX "Job_isActive_idx" ON "Job"("isActive");

-- CreateIndex
CREATE INDEX "Job_resourcePool_idx" ON "Job"("resourcePool");

-- CreateIndex
CREATE INDEX "Job_clientId_idx" ON "Job"("clientId");

-- CreateIndex
CREATE INDEX "Job_deleteStatus_idx" ON "Job"("deleteStatus");

-- CreateIndex
CREATE INDEX "JobExecution_jobId_status_idx" ON "JobExecution"("jobId", "status");

-- CreateIndex
CREATE INDEX "JobExecution_scheduledAt_idx" ON "JobExecution"("scheduledAt");

-- CreateIndex
CREATE INDEX "JobExecution_status_idx" ON "JobExecution"("status");

-- CreateIndex
CREATE INDEX "AlertRule_triggerType_idx" ON "AlertRule"("triggerType");

-- CreateIndex
CREATE INDEX "AlertRule_isActive_idx" ON "AlertRule"("isActive");

-- CreateIndex
CREATE INDEX "AlertEvent_alertRuleId_idx" ON "AlertEvent"("alertRuleId");

-- CreateIndex
CREATE INDEX "AlertEvent_severity_idx" ON "AlertEvent"("severity");

-- CreateIndex
CREATE INDEX "AlertEvent_acknowledged_idx" ON "AlertEvent"("acknowledged");

-- CreateIndex
CREATE INDEX "AlertEvent_createdAt_idx" ON "AlertEvent"("createdAt");

-- CreateIndex
CREATE INDEX "EscalatedAlert_clientId_idx" ON "EscalatedAlert"("clientId");

-- CreateIndex
CREATE INDEX "EscalatedAlert_status_idx" ON "EscalatedAlert"("status");

-- CreateIndex
CREATE INDEX "EscalatedAlert_suppressUntil_idx" ON "EscalatedAlert"("suppressUntil");

-- CreateIndex
CREATE INDEX "CriticalDbJob_clientId_idx" ON "CriticalDbJob"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CriticalDbJob_clientId_jobName_key" ON "CriticalDbJob"("clientId", "jobName");

-- CreateIndex
CREATE INDEX "CachedQueueJob_fetchedAt_idx" ON "CachedQueueJob"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CachedQueueJob_clientId_key" ON "CachedQueueJob"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRecipient_email_key" ON "NotificationRecipient"("email");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResourcePool_name_key" ON "ResourcePool"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Calendar_name_key" ON "Calendar"("name");

-- CreateIndex
CREATE INDEX "CalendarDate_date_idx" ON "CalendarDate"("date");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarDate_calendarId_date_key" ON "CalendarDate"("calendarId", "date");
