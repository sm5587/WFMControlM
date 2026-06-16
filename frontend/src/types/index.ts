// ============================================================
// Frontend TypeScript Types
// ============================================================

export type JobType =
  | 'COMMAND' | 'SCRIPT' | 'HTTP' | 'SQL'
  | 'DATA_PIPELINE' | 'FORECAST' | 'SCHEDULE_GEN'
  | 'FILE_TRANSFER' | 'CUSTOM';

export type ExecutionStatus =
  | 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCESS'
  | 'FAILED' | 'CANCELLED' | 'TIMEOUT'
  | 'RETRY_PENDING' | 'SKIPPED';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';

export type MaintenanceScope  = 'CLUSTER' | 'CLIENT';
export type MaintenanceType   = 'PLANNED' | 'UNSCHEDULED';
export type MaintenanceStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type MaintenanceTz     = 'IST' | 'EDT' | 'EST' | 'CST' | 'CDT' | 'UTC';

export interface MaintenanceWindow {
  id: string;
  scope: MaintenanceScope;
  cluster?: string | null;
  clientDbId?: string | null;
  clientCode?: string | null;
  title: string;
  reason?: string | null;
  type: MaintenanceType;
  status: MaintenanceStatus;
  startTimeUtc: string;
  endTimeUtc: string;
  inputTimezone: string;
  startLocal: string;
  endLocal: string;
  source: string;
  importBatchId?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AffectedJob {
  source: 'job' | 'cache';
  jobId: string;
  name: string;
  clientId?: string;
  clientName?: string;
  cluster?: string;
  cronExpression: string;
  serverTimezone?: string;
  command?: string;
  logPath?: string | null;
  fireTimesUtc: string[];
  fireTimesLocal: string[];
  fireCount: number;
}

// Client & Server types
export interface Client {
  id: string;
  clientId: string;
  name: string;
  isActive: boolean;
  cluster?: string;
  db2Host?: string;
  db2Port: number;
  db2Database?: string;
  db2Schema?: string;
  db2Username?: string;
  db2PasswordSet?: boolean;
  timezone: string;
  clientType?: 'BAU' | 'IMPL';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  whiteGlove?: boolean;
  lastCronSyncAt?: string | null;
  lastCronAttemptAt?: string | null;
  lastTzAttemptAt?: string | null;
  _count?: { appServers: number; jobs: number; syncHistory: number };
  serverCounts?: { PP: number; Prod: number; total: number };
}

export interface AppServer {
  id: string;
  clientId: string;
  environment: string;
  serverNum: string;
  dns: string;
  isActive: boolean;
  sshPort: number;
  lastPingAt?: string;
  lastPingStatus?: string;
}

export interface SyncHistory {
  id: string;
  clientId: string;
  client?: { clientId: string; name: string };
  syncType: string;
  status: string;
  source?: string;
  jobsDiscovered: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsRemoved: number;
  errors?: string;
  startedAt: string;
  completedAt?: string;
  duration?: number;
}

/** Latest bulk CRON_SYNC run summary from SyncHistory. */
export interface CronSyncBatchStatus {
  startedAt: string;
  finishedAt: string | null;
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  running: number;
  sampleErrors: Array<{ clientId: string; error: string }>;
}

export type LastRunStatus = 'SUCCESS' | 'FAILED' | 'NOT_RUN' | 'STALE' | 'UNKNOWN';

export interface LogCheckResult {
  jobName: string;
  logPath: string;
  status: LastRunStatus;
  exists: boolean;
  hasFailure: boolean;
  hasSuccess: boolean;
  triggered: boolean;
  isRunning: boolean;
  lastModified: string | null;
  expectedLastRun: string | null;
  logFresh: boolean;
  failureLines: string[];
  successLines: string[];
  cronExitCode: number | null;
  sizeBytes: number;
  summary: string;
}

export interface Job {
  id: string;
  name: string;
  description?: string;
  jobType: JobType;
  category: string;
  cronExpression?: string;
  timezone: string;
  isActive: boolean;
  command?: string;
  scriptPath?: string;
  logPath?: string;
  logCheckEnabled?: boolean;
  lastRunStatus?: LastRunStatus;
  lastRunAt?: string;
  lastRunComputed?: boolean;  // true when lastRunAt is estimated via cron interval.prev(), not confirmed from logs
  lastLogCheckAt?: string;
  timeout: number;
  priority: number;
  tags: string[];
  owner?: string;
  team?: string;
  client?: { id: string; clientId: string; name: string; cluster?: string };
  sourceSystem?: string;
  serverTimezone?: string;
  nextRunTime?: string;
  nextRunLocal?: string;
  createdAt: string;
  updatedAt: string;
  _count?: { executions: number };
}

export interface JobExecution {
  id: string;
  jobId: string;
  job?: { name: string; jobType: JobType; category: string; priority: number };
  status: ExecutionStatus;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  attempt: number;
  maxAttempts: number;
  exitCode?: number;
  output?: string;
  errorMessage?: string;
  triggeredBy: string;
}

export interface DashboardStats {
  totalJobs: number;
  activeJobs: number;
  runningExecutions: number;
  failedToday: number;
  succeededToday: number;
  pendingExecutions: number;
  activeAlerts: number;
  avgDurationTrend: number[];
  successRateTrend: number[];
}

export interface AlertEvent {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  createdAt: string;
  alertRule: { name: string; triggerType: string };
  execution?: { job: { name: string } };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// ---- Maintenance Calendar ----
export interface MaintenanceCalendar {
  id: string;
  year: number;
  fileName: string;
  importedBy?: string | null;
  importedAt: string;
  entryCount: number;
}

export interface MaintenanceCalendarEntry {
  id: string;
  calendarId: string;
  maintenanceGroup: string;
  clusters: string;
  maintenanceWindow: string;
  windowStartTime?: string | null;
  windowEndTime?: string | null;
  timezone: string;
  maintenanceDate: string; // ISO string
  month: number;
  year: number;
  status: string; // SCHEDULED | CANCELLED
}

export interface CalendarImportEntry {
  maintenanceGroup: string;
  clusters: string;
  maintenanceWindow: string;
  windowStartTime?: string;
  windowEndTime?: string;
  timezone: string;
  maintenanceDate: string;
  month: number;
  year: number;
  status: string;
}

