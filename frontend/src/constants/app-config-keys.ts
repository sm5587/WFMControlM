// AppConfig key names — single source of truth for frontend + backend alignment.

export const APP_CONFIG_KEYS = {
  syncEnabled: 'engine.syncEnabled',
  dbJobsSyncEnabled: 'engine.dbJobsSyncEnabled',
  punchSyncEnabled: 'engine.punchSyncEnabled',
  cronSyncSchedule: 'engine.cronSyncSchedule',
} as const;

/** Keys stored as "true" / "false" in AppConfig (mirrors backend BOOL_CONFIG_KEYS). */
export const BOOLEAN_APP_CONFIG_KEYS = new Set<string>([
  APP_CONFIG_KEYS.syncEnabled,
  APP_CONFIG_KEYS.dbJobsSyncEnabled,
  APP_CONFIG_KEYS.punchSyncEnabled,
  'engine.autoEscalationNotifyEnabled',
  'display.maintenanceAdHocWindows',
  'display.payrollEnabled',
  'display.showUnprocPunchTab',
  'infra.trustProxy',
  'infra.requireHttps',
  'infra.ssoEnabled',
  'infra.ldapEnabled',
  'infra.ldapDevMock',
  'infra.ldapUseStartTls',
  'infra.ldapTlsRejectUnauthorized',
  'infra.ldapAllowLocalFallback',
  'secrets.keeperEnabled',
  'secrets.smtpTlsEnabled',
  'secrets.smtpTlsRejectUnauthorized',
  'infra.db2SslEnabled',
]);

export function isBooleanAppConfigKey(key: string): boolean {
  return BOOLEAN_APP_CONFIG_KEYS.has(key);
}

export type SyncConfigParam = keyof typeof APP_CONFIG_KEYS;
