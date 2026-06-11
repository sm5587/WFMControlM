// ============================================================
// API Service - Axios-based API client
// ============================================================

import axios from 'axios';
import { ApiResponse, Job, JobExecution, DashboardStats, AlertEvent, Client, AppServer, SyncHistory, CronSyncBatchStatus } from '../types';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor for auth token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('wfm_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Callback set by AuthContext so the interceptor can trigger logout
let _onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: () => void) { _onUnauthorized = cb; }

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401 && _onUnauthorized) {
      // Don't trigger on login attempts
      const url = error.config?.url || '';
      if (!url.includes('/auth/login')) {
        _onUnauthorized();
      }
    }
    const message = error.response?.data?.error || error.message || 'An error occurred';
    console.error('API Error:', message);
    throw new Error(message);
  }
);

// ---- Jobs ----
export const jobsApi = {
  list: (params?: Record<string, any>): Promise<ApiResponse<Job[]>> =>
    api.get('/jobs', { params }),

  get: (id: string): Promise<ApiResponse<Job>> =>
    api.get(`/jobs/${id}`),

  create: (data: Partial<Job>): Promise<ApiResponse<Job>> =>
    api.post('/jobs', data),

  update: (id: string, data: Partial<Job>): Promise<ApiResponse<Job>> =>
    api.put(`/jobs/${id}`, data),

  delete: (id: string): Promise<ApiResponse> =>
    api.delete(`/jobs/${id}`),

  trigger: (id: string): Promise<ApiResponse<{ executionId: string }>> =>
    api.post(`/jobs/${id}/trigger`),

  toggle: (id: string): Promise<ApiResponse<Job>> =>
    api.post(`/jobs/${id}/toggle`),

  getExecutions: (id: string, params?: Record<string, any>): Promise<ApiResponse<JobExecution[]>> =>
    api.get(`/jobs/${id}/executions`, { params }),

  getUpcoming: (hours?: number): Promise<ApiResponse<any>> =>
    api.get('/jobs/upcoming', { params: { hours } }),

  getLogTail: (id: string, lines = 10): Promise<ApiResponse<{ lines: string[]; logPath: string; hostname: string; fetchedAt: string }>> =>
    api.get(`/jobs/${id}/log-tail`, { params: { lines }, timeout: 30000 }),
};

// ---- Executions ----
export const executionsApi = {
  cancel: (id: string): Promise<ApiResponse> =>
    api.post(`/jobs/executions/${id}/cancel`),

  getLogs: (id: string): Promise<ApiResponse<{ output: string; errorMessage: string; logs: string }>> =>
    api.get(`/jobs/executions/${id}/logs`),
};

// ---- Monitoring ----
export const monitoringApi = {
  getDashboard: (): Promise<ApiResponse<DashboardStats>> =>
    api.get('/monitoring/dashboard'),

  getLive: (limit?: number): Promise<ApiResponse<JobExecution[]>> =>
    api.get('/monitoring/live', { params: { limit } }),

  getHistory: (params?: { status?: string; clientId?: string; cluster?: string; startDate?: string; endDate?: string; page?: number; pageSize?: number; jobId?: string; category?: string; search?: string }): Promise<ApiResponse<JobExecution[]>> =>
    api.get('/monitoring/history', { params }),

  getAnalytics: (jobId: string, days?: number): Promise<ApiResponse<any>> =>
    api.get(`/monitoring/analytics/${jobId}`, { params: { days } }),

  getHealth: (): Promise<ApiResponse<any>> =>
    api.get('/monitoring/health'),

  getScheduler: (): Promise<ApiResponse<any>> =>
    api.get('/monitoring/scheduler'),
};

// ---- Alerts ----
export const alertsApi = {
  getRules: (): Promise<ApiResponse<any[]>> =>
    api.get('/alerts/rules'),

  createRule: (data: any): Promise<ApiResponse<any>> =>
    api.post('/alerts/rules', data),

  updateRule: (id: string, data: any): Promise<ApiResponse<any>> =>
    api.put(`/alerts/rules/${id}`, data),

  deleteRule: (id: string): Promise<ApiResponse> =>
    api.delete(`/alerts/rules/${id}`),

  getEvents: (params?: Record<string, any>): Promise<ApiResponse<AlertEvent[]>> =>
    api.get('/alerts/events', { params }),

  acknowledge: (id: string, userId?: string): Promise<ApiResponse> =>
    api.post(`/alerts/events/${id}/acknowledge`, { userId }),

  acknowledgeAll: (userId?: string): Promise<ApiResponse> =>
    api.post('/alerts/events/acknowledge-all', { userId }),

  getSummary: (): Promise<ApiResponse<any>> =>
    api.get('/alerts/summary'),
};

// ---- Auth ----
export const authApi = {
  login: (username: string, password: string): Promise<ApiResponse<{ token: string; user: { id: string; username: string; displayName: string; email: string } }>> =>
    api.post('/auth/login', { username, password }),

  me: (): Promise<ApiResponse<{ id: string; username: string; displayName: string; email: string }>> =>
    api.get('/auth/me'),

  register: (data: { username: string; email: string; displayName: string; password: string }): Promise<ApiResponse<any>> =>
    api.post('/auth/register', data),
};

// ---- Admin types ----
export interface AdminUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  timezone?: string;
  isActive: boolean;
  createdAt: string;
  profiles: { userId: string; profileId: string; profile: { id: string; name: string } }[];
}

export interface AdminProfile {
  id: string;
  name: string;
  description?: string;
  isSystem: boolean;
  createdAt: string;
  permissions: {
    functionId: string;
    canRead: boolean;
    canWrite: boolean;
    function: { id: string; module: string; name: string; description?: string; sortOrder: number };
  }[];
  _count: { users: number };
}

export interface AdminAppFunction {
  id: string;
  module: string;
  name: string;
  description?: string;
  sortOrder: number;
}

export interface PurgeConfig {
  id: string;
  label: string;
  retainDays: number;
  enabled: boolean;
  lastPurgeAt: string | null;
  lastPurgeCount: number | null;
  updatedAt: string;
}

// ---- Admin API ----
export const adminApi = {
  getUsers: (): Promise<ApiResponse<AdminUser[]>> =>
    api.get('/admin/users'),

  updateUser: (id: string, data: { displayName?: string; email?: string; timezone?: string; isActive?: boolean; password?: string }): Promise<ApiResponse<any>> =>
    api.patch(`/admin/users/${id}`, data),

  assignProfile: (userId: string, profileId: string): Promise<ApiResponse<any>> =>
    api.post(`/admin/users/${userId}/profiles`, { profileId }),

  removeProfile: (userId: string, profileId: string): Promise<ApiResponse<any>> =>
    api.delete(`/admin/users/${userId}/profiles/${profileId}`),

  getProfiles: (): Promise<ApiResponse<AdminProfile[]>> =>
    api.get('/admin/profiles'),

  createProfile: (data: { name: string; description?: string }): Promise<ApiResponse<any>> =>
    api.post('/admin/profiles', data),

  deleteProfile: (id: string): Promise<ApiResponse<any>> =>
    api.delete(`/admin/profiles/${id}`),

  getFunctions: (): Promise<ApiResponse<AdminAppFunction[]>> =>
    api.get('/admin/functions'),

  updatePermissions: (profileId: string, perms: { functionId: string; canRead: boolean; canWrite: boolean }[]): Promise<ApiResponse<any>> =>
    api.put(`/admin/profiles/${profileId}/permissions`, perms),

  getPurgeConfig: (): Promise<ApiResponse<{ configs: PurgeConfig[]; counts: Record<string, number> }>> =>
    api.get('/admin/purge/config'),

  updatePurgeConfig: (id: string, data: { retainDays?: number; enabled?: boolean }): Promise<ApiResponse<PurgeConfig>> =>
    api.put(`/admin/purge/config/${id}`, data),

  runPurgeAll: (): Promise<ApiResponse<any>> =>
    api.post('/admin/purge/run'),

  runPurgeOne: (id: string): Promise<ApiResponse<any>> =>
    api.post(`/admin/purge/run/${id}`),
};

// ---- Clients ----
export const clientsApi = {
  list: (params?: Record<string, any>): Promise<ApiResponse<Client[]>> =>
    api.get('/clients', { params }),

  get: (id: string): Promise<ApiResponse<Client & { appServers: AppServer[] }>> =>
    api.get(`/clients/${id}`),

  create: (data: {
    clientId: string;
    name: string;
    cluster?: string;
    timezone?: string;
    isActive?: boolean;
    whiteGlove?: boolean;
    clientType?: 'BAU' | 'IMPL';
    db2Host?: string;
    db2Port?: number;
    db2Database?: string;
    db2Schema?: string;
    appServers?: { environment: 'Prod' | 'PP'; serverNum?: string; dns: string; sshPort?: number }[];
  }): Promise<ApiResponse<Client>> =>
    api.post('/clients', data),

  update: (id: string, data: {
    name?: string;
    timezone?: string;
    clientType?: 'BAU' | 'IMPL';
    cluster?: string;
    whiteGlove?: boolean;
    isActive?: boolean;
    db2Host?: string;
    db2Port?: number;
    db2Database?: string;
    db2Schema?: string;
    db2Username?: string;
    db2Password?: string;
  }): Promise<ApiResponse<Client>> =>
    api.patch(`/clients/${id}`, data),

  getJobs: (id: string, params?: Record<string, any>): Promise<ApiResponse<Job[]>> =>
    api.get(`/clients/${id}/jobs`, { params }),

  getServers: (id: string, environment?: string): Promise<ApiResponse<AppServer[]>> =>
    api.get(`/clients/${id}/servers`, { params: { environment } }),

  sync: (id: string, syncType?: string): Promise<ApiResponse<any>> =>
    api.post(`/clients/${id}/sync`, { syncType }),

  syncAll: (): Promise<ApiResponse<any>> =>
    api.post('/clients/sync-all'),

  syncAllCrons: (opts?: { force?: boolean }): Promise<ApiResponse<any>> =>
    api.post('/clients/sync-all-crons', opts ?? {}, { timeout: 0 }),

  getCronSyncStatus: (): Promise<ApiResponse<CronSyncBatchStatus | null>> =>
    api.get('/clients/cron-sync-status'),

  detectTimezones: (filter?: { cluster?: string; clientIds?: string[] }): Promise<ApiResponse<any>> =>
    api.post('/clients/detect-timezones', filter),

  bulkUpdatePasswords: (password: string): Promise<ApiResponse<any>> =>
    api.post('/clients/bulk-update-passwords', { password }),

  getSyncHistory: (id: string, limit?: number): Promise<ApiResponse<SyncHistory[]>> =>
    api.get(`/clients/${id}/sync-history`, { params: { limit } }),

  checkLogs: (id: string): Promise<ApiResponse<any>> =>
    api.post(`/clients/${id}/check-logs`),

  addServer: (clientId: string, data: { environment: string; serverNum?: string; dns: string; sshPort?: number }): Promise<ApiResponse<AppServer>> =>
    api.post(`/clients/${clientId}/servers`, data),

  updateServer: (clientId: string, serverId: string, data: { dns?: string; sshPort?: number; isActive?: boolean; serverNum?: string; environment?: string }): Promise<ApiResponse<AppServer>> =>
    api.patch(`/clients/${clientId}/servers/${serverId}`, data),

  removeServer: (clientId: string, serverId: string): Promise<ApiResponse<any>> =>
    api.delete(`/clients/${clientId}/servers/${serverId}`),
};

// ---- DB Monitor ----
export const dbMonitorApi = {
  getStatus: (): Promise<ApiResponse<any>> =>
    api.get('/db-monitor/status'),

  testConnection: (id: string): Promise<ApiResponse<any>> =>
    api.post(`/db-monitor/${id}/test`),

  getJobs: (id: string): Promise<ApiResponse<any>> =>
    api.get(`/db-monitor/${id}/jobs`),

  getTables: (id: string): Promise<ApiResponse<any>> =>
    api.get(`/db-monitor/${id}/tables`),

  executeQuery: (id: string, sql: string): Promise<ApiResponse<any>> =>
    api.post(`/db-monitor/${id}/query`, { sql }),

  getKeeperStatus: (): Promise<ApiResponse<any>> =>
    api.get('/db-monitor/keeper'),

  clearKeeperCache: (clientId?: string): Promise<ApiResponse<any>> =>
    api.post('/db-monitor/keeper/clear-cache', { clientId }),

  // Direct DB2 connection endpoints
  getDbClients: (): Promise<ApiResponse<any>> =>
    api.get('/db-monitor/db-clients'),

  testDbClient: (clientId: string): Promise<ApiResponse<any>> =>
    api.get(`/db-monitor/db-clients/${clientId}/test`),

  getAllBatchStatus: (days?: number): Promise<ApiResponse<any>> =>
    api.get('/db-monitor/db-clients/batch-status-all', { params: { days }, timeout: 300000 }),

  getBatchStatus: (clientId: string, days?: number): Promise<ApiResponse<any>> =>
    api.get(`/db-monitor/db-clients/${clientId}/batch-status`, { params: { days } }),

  getBatchDetails: (clientId: string, jobType: string, planType: string, days?: number): Promise<ApiResponse<any>> =>
    api.get(`/db-monitor/db-clients/${clientId}/batch-status/${jobType}`, { params: { days, planType } }),
};

// ---- Payroll ----
export const payrollApi = {
  getClients: (): Promise<ApiResponse<any>> =>
    api.get('/payroll/clients'),

  getPayrollStatus: (clientId: string): Promise<ApiResponse<any>> =>
    api.get(`/payroll/${clientId}`, { timeout: 120000 }),

  syncClients: (): Promise<ApiResponse<any>> =>
    api.post('/payroll/sync-clients'),
};

// ---- DB Jobs (RFX_QUEUE) ----
export const dbJobsApi = {
  getAllQueueJobs: (): Promise<ApiResponse<any>> =>
    api.get('/db-jobs/queue-all', { timeout: 300000 }),

  fetchAll: (): Promise<ApiResponse<any>> =>
    api.post('/db-jobs/fetch-all', {}, { timeout: 600000 }),

  getQueueJobs: (clientId: string): Promise<ApiResponse<any>> =>
    api.get(`/db-jobs/${clientId}/queue`),

  refreshClient: (clientId: string): Promise<ApiResponse<any>> =>
    api.post(`/db-jobs/${clientId}/refresh`, {}, { timeout: 120000 }),

  markCritical: (clientId: string, jobName: string): Promise<ApiResponse<any>> =>
    api.post('/db-jobs/critical', { clientId, jobName }),

  markCriticalBatch: (jobs: { clientId: string; jobName: string }[]): Promise<ApiResponse<any>> =>
    api.post('/db-jobs/critical/batch', { jobs }),

  unmarkCritical: (clientId: string, jobName: string): Promise<ApiResponse<any>> =>
    api.delete('/db-jobs/critical', { data: { clientId, jobName } }),

  listCritical: (): Promise<ApiResponse<any[]>> =>
    api.get('/db-jobs/critical'),
};

// ---- Escalations (Red Tab) ----
export const escalationsApi = {
  getAll: (): Promise<ApiResponse<any[]>> =>
    api.get('/escalations'),

  acknowledge: (id: string, userId?: string): Promise<ApiResponse> =>
    api.post(`/escalations/${id}/acknowledge`, { userId }),

  suppress: (id: string, durationMinutes: number, userId?: string, reason?: string): Promise<ApiResponse> =>
    api.post(`/escalations/${id}/suppress`, { userId, durationMinutes, reason }),

  notify: (alertIds?: string[]): Promise<ApiResponse<{ sent: number; skipped: number }>> =>
    api.post('/escalations/notify', { alertIds }),

  testEmail: (): Promise<ApiResponse<{ sent: boolean; recipients: string[]; error?: string; details?: string[] }>> =>
    api.post('/escalations/test-email'),

  notifyPunch: (rows: any[]): Promise<ApiResponse<any>> =>
    api.post('/escalations/notify-punch', { rows }),

  getRecipients: (): Promise<ApiResponse<any[]>> =>
    api.get('/escalations/recipients'),

  addRecipient: (name: string, email: string): Promise<ApiResponse<any>> =>
    api.post('/escalations/recipients', { name, email }),

  removeRecipient: (id: string): Promise<ApiResponse> =>
    api.delete(`/escalations/recipients/${id}`),

  toggleRecipient: (id: string): Promise<ApiResponse<any>> =>
    api.post(`/escalations/recipients/${id}/toggle`),

  // ---- Unproc Punch Alert status (Acknowledge / Suppress) ----
  getPunchAlertStatuses: (): Promise<ApiResponse<Record<string, any>>> =>
    api.get('/escalations/punch-alerts'),

  acknowledgePunch: (clientId: string, userId?: string): Promise<ApiResponse> =>
    api.post(`/escalations/punch-alerts/${clientId}/acknowledge`, { userId }),

  suppressPunch: (clientId: string, durationMinutes: number, userId?: string, reason?: string): Promise<ApiResponse> =>
    api.post(`/escalations/punch-alerts/${clientId}/suppress`, { userId, durationMinutes, reason }),
};

// ---- Maintenance Windows ----
export const maintenanceApi = {
  list: (params?: { cluster?: string; clientDbId?: string; status?: string; type?: string; upcoming?: '1' }): Promise<ApiResponse<any[]>> =>
    api.get('/maintenance', { params }),

  create: (data: {
    scope: string;
    cluster?: string;
    clientDbId?: string;
    clientCode?: string;
    title: string;
    reason?: string;
    type?: string;
    inputTimezone: string;
    startLocal: string;
    endLocal: string;
    createdBy?: string;
  }): Promise<ApiResponse<any>> =>
    api.post('/maintenance', data),

  bulk: (windows: any[], importBatchId?: string): Promise<ApiResponse<{ created: number; errors: any[]; batchId: string }>> =>
    api.post('/maintenance/bulk', { windows, importBatchId }),

  update: (id: string, data: { status?: string; title?: string; reason?: string; startLocal?: string; endLocal?: string; inputTimezone?: string }): Promise<ApiResponse<any>> =>
    api.patch(`/maintenance/${id}`, data),

  remove: (id: string): Promise<ApiResponse> =>
    api.delete(`/maintenance/${id}`),

  getAffectedJobs: (id: string): Promise<ApiResponse<any>> =>
    api.get(`/maintenance/${id}/affected-jobs`),
};

// ---- Maintenance Calendar ----
export const maintenanceCalendarApi = {
  list: (): Promise<ApiResponse<import('../types').MaintenanceCalendar[]>> =>
    api.get('/maintenance/calendar'),

  import: (payload: {
    year: number;
    fileName: string;
    importedBy?: string;
    entries: import('../types').CalendarImportEntry[];
  }): Promise<ApiResponse<import('../types').MaintenanceCalendar>> =>
    api.post('/maintenance/calendar/import', payload),

  getEntries: (
    id: string,
    params?: { month?: number; cluster?: string }
  ): Promise<ApiResponse<import('../types').MaintenanceCalendarEntry[]>> =>
    api.get(`/maintenance/calendar/${id}/entries`, { params }),

  remove: (id: string): Promise<ApiResponse> =>
    api.delete(`/maintenance/calendar/${id}`),
};

// ---- Unprocessed Punch (TA_UNPROC_PUNCH) ----
export const unprocessedPunchApi = {
  getAll: (): Promise<ApiResponse<any>> =>
    api.get('/unprocessed-punch/all', { timeout: 600000 }),

  /** Fast: just the client list from Prisma, no DB2 queries */
  getClients: (): Promise<ApiResponse<any>> =>
    api.get('/unprocessed-punch/clients', { timeout: 60000 }),

  getPunchCount: (clientId: string): Promise<ApiResponse<any>> =>
    api.get(`/unprocessed-punch/${clientId}`, { timeout: 120000 }),

  /** SSE stream — returns an EventSource connected to the /stream endpoint */
  openStream: (): EventSource =>
    new EventSource('/api/unprocessed-punch/stream'),
};

// ============================================================
// Config API
// ============================================================
export const configApi = {
  getPublic: (): Promise<ApiResponse<Record<string, any>[]>> =>
    api.get('/config/public'),

  getAll: (): Promise<ApiResponse<Record<string, any>[]>> =>
    api.get('/config'),

  update: (updates: Array<{ key: string; value: string }>): Promise<ApiResponse<any>> =>
    api.patch('/config', { updates }),

  reveal: (key: string): Promise<ApiResponse<{ value: string }>> =>
    api.post('/config/reveal', { key }),
};

export default api;
