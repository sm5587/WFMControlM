// ============================================================
// AppConfig safety limits — prevent aggressive DB polling / DoS
// ============================================================

import cron from 'node-cron';

export const MIN_DB_POLLING_MINS = 5;

const BOOL_CONFIG_KEYS = new Set([
  'engine.syncEnabled',
  'engine.dbJobsSyncEnabled',
  'engine.punchSyncEnabled',
  'engine.autoEscalationNotifyEnabled',
  'engine.autoEscalationNotifyQueueEnabled',
  'engine.autoEscalationNotifyPayrollEnabled',
  'engine.autoEscalationNotifyPunchEnabled',
  'display.maintenanceAdHocWindows',
  'display.payrollEnabled',
  'display.payrollMonitorEnabled',
  'display.heatMapEnabled',
  'display.wipHeatMapEnabled',
  'display.showUnprocPunchTab',
  'infra.trustProxy',
  'infra.requireHttps',
  'infra.ssoEnabled',
  'infra.ldapEnabled',
  'infra.ldapUseStartTls',
  'infra.ldapTlsRejectUnauthorized',
  'infra.ldapAllowLocalFallback',
  'secrets.keeperEnabled',
  'secrets.smtpTlsEnabled',
  'secrets.smtpTlsRejectUnauthorized',
  'infra.db2SslEnabled',
]);

const CRON_CONFIG_KEYS = new Set([
  'engine.purgeSchedule',
  'engine.cronSyncSchedule',
  'engine.wfmVersionSyncSchedule',
]);
export const MIN_DB2_QUERY_CONCURRENCY = 1;
export const MAX_DB2_QUERY_CONCURRENCY = 10;
export const MIN_DB2_POOL_MAX = 1;
export const MAX_DB2_POOL_MAX = 10;

/** DB-related polling/cache intervals — cannot be set below MIN_DB_POLLING_MINS. */
export const DB_POLLING_MINUTE_KEYS = new Set([
  'polling.batchRefreshMins',
  'polling.punchRefreshMins',
  'polling.backgroundPollingMins',
  'polling.dbMonitorSyncMins',
  'polling.batchCacheTtlMins',
  'polling.punchCacheTtlMins',
  'polling.heatMapRefreshMins',
]);

/** Phase offsets (minutes) — 0–59; used to stagger Heat Map vs other DB2 polls. */
export const POLLING_OFFSET_MINUTE_KEYS = new Set([
  'polling.heatMapRefreshOffsetMins',
]);
export const MIN_POLLING_OFFSET_MINS = 0;
export const MAX_POLLING_OFFSET_MINS = 59;

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function parsePositiveInt(value: string): number | null {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** Reject out-of-range values on Admin → Config save. */
export function validateConfigValue(key: string, value: string): void {
  if (value === '••••••••') return;

  if (DB_POLLING_MINUTE_KEYS.has(key)) {
    const mins = parsePositiveInt(value);
    if (mins === null || mins < MIN_DB_POLLING_MINS) {
      throw new ConfigValidationError(
        `${key} must be at least ${MIN_DB_POLLING_MINS} minutes`,
      );
    }
    return;
  }

  if (POLLING_OFFSET_MINUTE_KEYS.has(key)) {
    const mins = parsePositiveInt(value);
    if (mins === null || mins < MIN_POLLING_OFFSET_MINS || mins > MAX_POLLING_OFFSET_MINS) {
      throw new ConfigValidationError(
        `${key} must be between ${MIN_POLLING_OFFSET_MINS} and ${MAX_POLLING_OFFSET_MINS}`,
      );
    }
    return;
  }

  if (key === 'engine.db2QueryConcurrency') {
    const n = parsePositiveInt(value);
    if (n === null || n < MIN_DB2_QUERY_CONCURRENCY || n > MAX_DB2_QUERY_CONCURRENCY) {
      throw new ConfigValidationError(
        `engine.db2QueryConcurrency must be between ${MIN_DB2_QUERY_CONCURRENCY} and ${MAX_DB2_QUERY_CONCURRENCY}`,
      );
    }
    return;
  }

  if (key === 'infra.db2PoolMax') {
    const n = parsePositiveInt(value);
    if (n === null || n < MIN_DB2_POOL_MAX || n > MAX_DB2_POOL_MAX) {
      throw new ConfigValidationError(
        `infra.db2PoolMax must be between ${MIN_DB2_POOL_MAX} and ${MAX_DB2_POOL_MAX}`,
      );
    }
    return;
  }

  if (BOOL_CONFIG_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') {
      throw new ConfigValidationError(`${key} must be "true" or "false"`);
    }
    return;
  }

  if (key === 'display.externalTools') {
    validateExternalToolsJson(value);
    return;
  }

  if (CRON_CONFIG_KEYS.has(key)) {
    if (!cron.validate(value.trim())) {
      throw new ConfigValidationError(`${key} must be a valid cron expression (5 fields)`);
    }
  }
}

function validateExternalToolsJson(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigValidationError(
      'display.externalTools must be valid JSON (array of {label, url, icon?, enabled?})',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigValidationError('display.externalTools must be a JSON array');
  }
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigValidationError(`display.externalTools[${i}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.label !== 'string' || !row.label.trim()) {
      throw new ConfigValidationError(`display.externalTools[${i}].label is required`);
    }
    if (typeof row.url !== 'string' || !row.url.trim()) {
      throw new ConfigValidationError(`display.externalTools[${i}].url is required`);
    }
    const url = row.url.trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new ConfigValidationError(`display.externalTools[${i}].url must start with http:// or https://`);
    }
    if (row.icon !== undefined && typeof row.icon !== 'string') {
      throw new ConfigValidationError(`display.externalTools[${i}].icon must be a string`);
    }
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean') {
      throw new ConfigValidationError(`display.externalTools[${i}].enabled must be a boolean`);
    }
    if (row.profileIds !== undefined) {
      if (!Array.isArray(row.profileIds)) {
        throw new ConfigValidationError(`display.externalTools[${i}].profileIds must be an array of strings`);
      }
      for (let j = 0; j < row.profileIds.length; j++) {
        if (typeof row.profileIds[j] !== 'string' || !(row.profileIds[j] as string).trim()) {
          throw new ConfigValidationError(`display.externalTools[${i}].profileIds[${j}] must be a non-empty string`);
        }
      }
    }
  }
}

/** Clamp already-loaded values at runtime (defense in depth). */
export function clampConfigInt(key: string, value: number): number {
  if (DB_POLLING_MINUTE_KEYS.has(key)) {
    return Math.max(value, MIN_DB_POLLING_MINS);
  }
  if (POLLING_OFFSET_MINUTE_KEYS.has(key)) {
    return Math.min(Math.max(value, MIN_POLLING_OFFSET_MINS), MAX_POLLING_OFFSET_MINS);
  }
  if (key === 'engine.db2QueryConcurrency') {
    return Math.min(Math.max(value, MIN_DB2_QUERY_CONCURRENCY), MAX_DB2_QUERY_CONCURRENCY);
  }
  if (key === 'infra.db2PoolMax') {
    return Math.min(Math.max(value, MIN_DB2_POOL_MAX), MAX_DB2_POOL_MAX);
  }
  return value;
}
