// ============================================================
// WFM Control-M - Core Type Definitions
// ============================================================

// Job Types
export type JobType =
  | 'COMMAND'
  | 'SCRIPT'
  | 'HTTP'
  | 'SQL'
  | 'DATA_PIPELINE'
  | 'FORECAST'
  | 'SCHEDULE_GEN'
  | 'FILE_TRANSFER'
  | 'CUSTOM';

export type ExecutionStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'RETRY_PENDING'
  | 'SKIPPED';

export type AlertTriggerType =
  | 'JOB_FAILED'
  | 'JOB_TIMEOUT'
  | 'JOB_LONG_RUNNING'
  | 'CONSECUTIVE_FAILURES'
  | 'QUEUE_BUILDUP'
  | 'CUSTOM';

export type AlertChannel = 'EMAIL' | 'SLACK' | 'WEBHOOK' | 'SMS' | 'IN_APP';
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';

// HTTP Job Configuration
export interface HttpJobConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: any;
  expectedStatusCodes?: number[];
  timeout?: number;
}

// Retry Policy
export interface RetryPolicy {
  maxRetries: number;
  retryDelay: number; // seconds
  backoffMultiplier: number;
  retryableExitCodes?: number[];
}

// Job Execution Result
export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  output: string;
  errorMessage?: string;
  duration: number;
  memoryUsageMb?: number;
  cpuPercent?: number;
}

// Dashboard Stats
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

// WebSocket Events
export interface WSEvent {
  type: WSEventType;
  payload: any;
  timestamp: string;
}

export type WSEventType =
  | 'execution:started'
  | 'execution:progress'
  | 'execution:completed'
  | 'execution:failed'
  | 'alert:triggered'
  | 'dashboard:update';

// API Response
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

// Job Creation DTO
export interface CreateJobDTO {
  name: string;
  description?: string;
  jobType: JobType;
  category?: string;
  cronExpression?: string;
  timezone?: string;
  command?: string;
  scriptPath?: string;
  httpConfig?: HttpJobConfig;
  retryPolicy?: RetryPolicy;
  timeout?: number;
  priority?: number;
  maxConcurrency?: number;
  resourcePool?: string;
  tags?: string[];
  parameters?: Record<string, any>;
  environment?: Record<string, string>;
  owner?: string;
  team?: string;
}
