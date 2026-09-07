// ============================================================
// Config Service
// Loads all AppConfig rows from DB at startup, caches in memory,
// provides typed getters, supports hot-reload for non-INFRA keys.
// ============================================================

import { prisma } from '../database/prisma';
import { APP_NAME_CONFIG_KEY, DEFAULT_APP_NAME } from '../constants/app-display';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../utils/crypto';
import { createServiceLogger } from '../utils/logger';
import {
  clampConfigInt,
  ConfigValidationError,
  validateConfigValue,
} from '../utils/config-limits';
import { applyLdapDevMockPublicConfig } from '../utils/ldap-dev-mock';

export { ConfigValidationError };

const logger = createServiceLogger('ConfigService');

interface ConfigEntry {
  key: string;
  value: string;       // decrypted
  category: string;
  label: string;
  description: string | null;
  isSecret: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

class ConfigService {
  private cache = new Map<string, ConfigEntry>();
  private loaded = false;

  /**
   * Load all config from DB into memory. Called once at startup.
   */
  async load(): Promise<void> {
    const rows = await prisma.appConfig.findMany();
    this.cache.clear();

    for (const row of rows) {
      let value = row.value;
      if (row.isSecret && value) {
        try {
          value = decryptSecret(value);
        } catch {
          // If decryption fails, value may be stored in plain (initial seed)
          // Keep as-is — will be re-encrypted on next write
          logger.warn(`Could not decrypt secret "${row.key}" — using raw value`);
        }
      }
      this.cache.set(row.key, {
        key: row.key,
        value,
        category: row.category,
        label: row.label,
        description: row.description,
        isSecret: row.isSecret,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      });
    }

    await this.ensureAppNameConfig();
    await this.ensureNotifyCooldownConfig();
    await this.ensureMaintenanceAdHocWindowsConfig();
    await this.ensurePayrollEnabledConfig();
    await this.ensureShowUnprocPunchTabConfig();
    await this.ensureMasterAccountConfig();
    await this.ensureFileMonitorConfig();
    await this.ensureTlsConfig();
    await this.ensureDb2SslConfig();
    await this.ensureSsoConfig();
    await this.ensureLdapConfig();
    await this.ensureAuthTokenRevocationConfig();
    await this.ensureSyncConfig();
    await this.cleanupLegacyConfig();

    this.loaded = true;
    logger.info(`Loaded ${rows.length} config entries from DB`);
  }

  /** Insert display.appName when upgrading an older database. */
  private async ensureAppNameConfig(): Promise<void> {
    if (this.cache.has(APP_NAME_CONFIG_KEY)) return;
    await prisma.appConfig.create({
      data: {
        key: APP_NAME_CONFIG_KEY,
        value: DEFAULT_APP_NAME,
        category: 'DISPLAY',
        label: 'Application Name',
        description: 'Product name shown in UI, emails, and API health',
        isSecret: false,
        updatedBy: 'system',
      },
    });
    this.cache.set(APP_NAME_CONFIG_KEY, {
      key: APP_NAME_CONFIG_KEY,
      value: DEFAULT_APP_NAME,
      category: 'DISPLAY',
      label: 'Application Name',
      description: 'Product name shown in UI, emails, and API health',
      isSecret: false,
      updatedBy: 'system',
      updatedAt: new Date(),
    });
    logger.info(`Added missing config key "${APP_NAME_CONFIG_KEY}"`);
  }

  /** Insert threshold.notifyCooldownMins when upgrading an older database. */
  private async ensureNotifyCooldownConfig(): Promise<void> {
    const key = 'threshold.notifyCooldownMins';
    if (this.cache.has(key)) return;
    await prisma.appConfig.create({
      data: {
        key,
        value: '60',
        category: 'THRESHOLDS',
        label: 'Notify Cooldown (min)',
        description: 'Minutes before notify icon reappears after email sent',
        isSecret: false,
        updatedBy: 'system',
      },
    });
    this.cache.set(key, {
      key,
      value: '60',
      category: 'THRESHOLDS',
      label: 'Notify Cooldown (min)',
      description: 'Minutes before notify icon reappears after email sent',
      isSecret: false,
      updatedBy: 'system',
      updatedAt: new Date(),
    });
    logger.info(`Added missing config key "${key}"`);
  }

  /** Insert display.maintenanceAdHocWindows when upgrading an older database. */
  private async ensureMaintenanceAdHocWindowsConfig(): Promise<void> {
    const key = 'display.maintenanceAdHocWindows';
    if (this.cache.has(key)) return;
    await prisma.appConfig.create({
      data: {
        key,
        value: 'false',
        category: 'DISPLAY',
        label: 'Maintenance Ad-hoc Windows Tab',
        description: 'Show Ad-hoc Windows tab on Maintenance page (true/false)',
        isSecret: false,
        updatedBy: 'system',
      },
    });
    this.cache.set(key, {
      key,
      value: 'false',
      category: 'DISPLAY',
      label: 'Maintenance Ad-hoc Windows Tab',
      description: 'Show Ad-hoc Windows tab on Maintenance page (true/false)',
      isSecret: false,
      updatedBy: 'system',
      updatedAt: new Date(),
    });
    logger.info(`Added missing config key "${key}"`);
  }

  /** Insert display.payrollEnabled when upgrading an older database. */
  private async ensurePayrollEnabledConfig(): Promise<void> {
    const key = 'display.payrollEnabled';
    if (this.cache.has(key)) return;
    await prisma.appConfig.create({
      data: {
        key,
        value: 'false',
        category: 'DISPLAY',
        label: 'Payroll Jobs Menu',
        description: 'Show Payroll Jobs screen and API (true/false)',
        isSecret: false,
        updatedBy: 'system',
      },
    });
    this.cache.set(key, {
      key,
      value: 'false',
      category: 'DISPLAY',
      label: 'Payroll Jobs Menu',
      description: 'Show Payroll Jobs screen and API (true/false)',
      isSecret: false,
      updatedBy: 'system',
      updatedAt: new Date(),
    });
    logger.info(`Added missing config key "${key}"`);
  }

  /** Insert display.showUnprocPunchTab when upgrading an older database. */
  private async ensureShowUnprocPunchTabConfig(): Promise<void> {
    const key = 'display.showUnprocPunchTab';
    if (this.cache.has(key)) return;
    await prisma.appConfig.create({
      data: {
        key,
        value: 'false',
        category: 'DISPLAY',
        label: 'Unprocessed Punch Alerts Tab',
        description: 'Show Unprocessed Punch tab on Alerts page (true/false)',
        isSecret: false,
        updatedBy: 'system',
      },
    });
    this.cache.set(key, {
      key,
      value: 'false',
      category: 'DISPLAY',
      label: 'Unprocessed Punch Alerts Tab',
      description: 'Show Unprocessed Punch tab on Alerts page (true/false)',
      isSecret: false,
      updatedBy: 'system',
      updatedAt: new Date(),
    });
    logger.info(`Added missing config key "${key}"`);
  }

  /** Bootstrap break-glass master when upgrading a DB with empty master username. */
  private async ensureMasterAccountConfig(): Promise<void> {
    const usernameKey = 'secrets.masterUsername';
    const hashKey = 'secrets.masterPasswordHash';
    const current = this.cache.get(usernameKey)?.value?.trim();
    if (current) return;

    const username = 'WFMADMIN';
    const passwordHash = '$2b$10$yPnFQ7.oImZUCmBOLMnRIuW2o5IPI2vxoRFsdomOzvBNNlbAPnQOC';

    for (const [key, value, isSecret, label, description] of [
      [usernameKey, username, false, 'Master Username', 'Break-glass admin username'] as const,
      [hashKey, passwordHash, true, 'Master Password Hash', 'Break-glass admin bcrypt hash (default password: WFMADMIN)'] as const,
    ]) {
      await prisma.appConfig.upsert({
        where: { key },
        create: {
          key,
          value,
          category: 'SECRETS',
          label,
          description,
          isSecret,
          updatedBy: 'system',
        },
        update: { value, updatedBy: 'system' },
      });
      this.cache.set(key, {
        key,
        value,
        category: 'SECRETS',
        label,
        description,
        isSecret,
        updatedBy: 'system',
        updatedAt: new Date(),
      });
    }
    logger.info(`Configured default master account "${username}" (change password in Admin → Config before production)`);
  }

  /** Upload File Monitor paths/timeouts — added when upgrading older databases. */
  private async ensureFileMonitorConfig(): Promise<void> {
    const defaults = [
      ['infra.sshPendingFolderPath', '/mount/RWS4/batch_jobs/in', 'Pending IN Folder', 'Remote path for pending upload files'] as const,
      ['infra.sshRejectedUploadRoot', '/mount/RWS4/appuploads/upload', 'Rejected Upload Root', 'Root path for rejected DTS file scan'] as const,
      ['infra.sshCommandTimeoutSec', '30', 'SSH Command Timeout (sec)', 'Timeout for pending IN folder find (maxdepth 1)'] as const,
      ['infra.sshRejectedFindTimeoutSec', '120', 'Rejected Find Timeout (sec)', 'Timeout for recursive rejected DTS find under upload root'] as const,
    ];

    for (const [key, value, label, description] of defaults) {
      if (this.cache.has(key)) continue;
      await prisma.appConfig.create({
        data: {
          key,
          value,
          category: 'INFRA',
          label,
          description,
          isSecret: false,
          updatedBy: 'system',
        },
      });
      this.cache.set(key, {
        key,
        value,
        category: 'INFRA',
        label,
        description,
        isSecret: false,
        updatedBy: 'system',
        updatedAt: new Date(),
      });
      logger.info(`Added missing config key "${key}"`);
    }
  }

  /** TLS/SMTP and app HTTPS flags — added when upgrading older databases. */
  private async ensureTlsConfig(): Promise<void> {
    const defaults = [
      ['secrets.smtpTlsEnabled', 'false', 'SECRETS', 'SMTP TLS Enabled', 'Require TLS/STARTTLS for SMTP (ignored for local Mailpit on 127.0.0.1:1025)', false] as const,
      ['secrets.smtpTlsRejectUnauthorized', 'true', 'SECRETS', 'SMTP TLS Verify Certs', 'Validate SMTP server certificate when SMTP TLS Enabled is true', false] as const,
      ['infra.trustProxy', 'false', 'INFRA', 'Trust Proxy', 'Trust X-Forwarded-* headers from nginx/load balancer (enable in production behind TLS terminator)', false] as const,
      ['infra.requireHttps', 'false', 'INFRA', 'Require HTTPS', 'Redirect HTTP to HTTPS when behind a TLS-terminating reverse proxy', false] as const,
    ];

    for (const [key, value, category, label, description, isSecret] of defaults) {
      if (this.cache.has(key)) continue;
      await prisma.appConfig.create({
        data: {
          key,
          value,
          category,
          label,
          description,
          isSecret,
          updatedBy: 'system',
        },
      });
      this.cache.set(key, {
        key,
        value,
        category,
        label,
        description,
        isSecret,
        updatedBy: 'system',
        updatedAt: new Date(),
      });
      logger.info(`Added missing config key "${key}"`);
    }
  }

  /** DB2 JDBC TLS truststore — required when a client has db2SslEnabled=true. */
  private async ensureDb2SslConfig(): Promise<void> {
    const defaults = [
      ['infra.db2SslEnabled', 'false', 'INFRA', 'DB2 SSL Enabled', 'Global master switch for JDBC sslConnection. Requires true here AND per-client JDBC SSL enabled, plus infra.db2TrustStorePath.', false] as const,
      ['infra.db2TrustStorePath', '', 'INFRA', 'DB2 Truststore Path', 'JKS truststore path for JDBC sslConnection (e.g. /app/certs/db2-truststore.jks)', false] as const,
      ['infra.db2TrustStorePassword', '', 'INFRA', 'DB2 Truststore Password', 'Password for the DB2 JDBC truststore JKS file', true] as const,
    ];

    for (const [key, value, category, label, description, isSecret] of defaults) {
      if (this.cache.has(key)) continue;
      await prisma.appConfig.create({
        data: {
          key,
          value,
          category,
          label,
          description,
          isSecret,
          updatedBy: 'system',
        },
      });
      this.cache.set(key, {
        key,
        value,
        category,
        label,
        description,
        isSecret,
        updatedBy: 'system',
        updatedAt: new Date(),
      });
      logger.info(`Added missing config key "${key}"`);
    }
  }

  /** SSO / MFA via load balancer — email header capture for access requests. */
  private async ensureSsoConfig(): Promise<void> {
    const defaults = [
      ['infra.ssoEnabled', 'false', 'INFRA', 'SSO Header Login Enabled', 'Enable SSO via load-balancer email header (X-Forwarded-Email). Separate from direct LDAP — use LDAP Enabled for in-app AD bind.', false] as const,
      ['infra.ssoEmailHeader', 'X-Forwarded-Email', 'INFRA', 'SSO Email Header', 'HTTP header name the load balancer sets with the authenticated user email', false] as const,
      ['infra.ssoAllowedDomain', 'zebra.com', 'INFRA', 'SSO Allowed Email Domain', 'Only @zebra.com (or configured domain) emails may register or sign in via SSO', false] as const,
    ];

    for (const [key, value, category, label, description, isSecret] of defaults) {
      if (this.cache.has(key)) continue;
      await prisma.appConfig.create({
        data: { key, value, category, label, description, isSecret, updatedBy: 'system' },
      });
      this.cache.set(key, {
        key, value, category, label, description, isSecret,
        updatedBy: 'system', updatedAt: new Date(),
      });
      logger.info(`Added missing config key "${key}"`);
    }
  }

  /** Direct LDAP / Active Directory bind for username/password login. */
  private async ensureLdapConfig(): Promise<void> {
    const defaults = [
      ['infra.ldapEnabled', 'false', 'INFRA', 'LDAP Enabled', 'Authenticate login against corporate LDAP/AD (in-app bind). Requires user record + profile in WFM Watch.', false] as const,
      ['infra.ldapUrl', 'ldap://usc1.rfx.zebra.com:389', 'INFRA', 'LDAP URL', 'LDAP server URL (e.g. ldap://usc1.rfx.zebra.com:389 or ldaps://host:636)', false] as const,
      ['infra.ldapBaseDn', 'dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP Base DN', 'Base DN (e.g. dc=rfx,dc=zebra,dc=com)', false] as const,
      ['infra.ldapBindDn', 'uid=svc_wfmwatch,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP Bind DN', 'Service account DN for user search (ldap.manager.dn)', false] as const,
      ['infra.ldapBindPassword', '', 'INFRA', 'LDAP Bind Password', 'Password for LDAP service account (ldap.manager.password)', true] as const,
      ['infra.ldapUserSearchBase', 'dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP User Search Base', 'Base DN for user search (ldap.userSearch.base)', false] as const,
      ['infra.ldapUserFilter', '(uid={{username}})', 'INFRA', 'LDAP User Filter', 'Search filter; use {{username}} or {0} placeholder (e.g. (uid={{username}}))', false] as const,
      ['infra.ldapUserDnPattern', 'uid={{username}},cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP User DN Pattern', 'Direct bind DN pattern when search is not used (ldap.userDn.pattern)', false] as const,
      ['infra.ldapGroupSearchBase', 'dc=rfx,dc=zebra,dc=com', 'INFRA', 'LDAP Group Search Base', 'Base DN for group search (ldap.groupSearch.base)', false] as const,
      ['infra.ldapDomain', '', 'INFRA', 'LDAP Domain', 'UPN suffix for direct bind (user@domain) when Bind DN is empty', false] as const,
      ['infra.ldapEmailAttribute', 'mail', 'INFRA', 'LDAP Email Attribute', 'LDAP attribute for user email (default: mail)', false] as const,
      ['infra.ldapDisplayNameAttribute', 'cn', 'INFRA', 'LDAP Display Name Attribute', 'LDAP attribute for display name (default: cn)', false] as const,
      ['infra.ldapUseStartTls', 'false', 'INFRA', 'LDAP StartTLS', 'Use STARTTLS on ldap:// connections (not needed for ldaps://)', false] as const,
      ['infra.ldapTlsRejectUnauthorized', 'true', 'INFRA', 'LDAP TLS Verify Certs', 'Validate LDAP server certificate when using TLS/StartTLS', false] as const,
      ['infra.ldapAllowLocalFallback', 'true', 'INFRA', 'LDAP Allow Local Fallback', 'If LDAP bind fails, fall back to local password in User table (non-master accounts)', false] as const,
      ['infra.ldapDevMock', 'false', 'INFRA', 'LDAP Dev Mock (non-production)', 'Simulate successful LDAP login without contacting a server. Blocked in production; prefer LDAP_DEV_MOCK env var locally.', false] as const,
      ['infra.ldapTimeoutMs', '10000', 'INFRA', 'LDAP Timeout (ms)', 'LDAP connection and bind timeout in milliseconds', false] as const,
    ] as const;

    for (const [key, value, category, label, description, isSecret] of defaults) {
      if (this.cache.has(key)) continue;
      await prisma.appConfig.create({
        data: { key, value, category, label, description, isSecret, updatedBy: 'system' },
      });
      this.cache.set(key, {
        key, value, category, label, description, isSecret,
        updatedBy: 'system', updatedAt: new Date(),
      });
      logger.info(`Added missing config key "${key}"`);
    }
  }

  /** Master break-glass session invalidation counter — added when upgrading older databases. */
  private async ensureAuthTokenRevocationConfig(): Promise<void> {
    const key = 'auth.masterTokenVersion';
    if (this.cache.has(key)) return;
    await prisma.appConfig.create({
      data: {
        key,
        value: '0',
        category: 'AUTH',
        label: 'Master Token Version',
        description: 'Incremented to invalidate all master-account JWT sessions',
        isSecret: false,
        updatedBy: 'system',
      },
    });
    this.cache.set(key, {
      key,
      value: '0',
      category: 'AUTH',
      label: 'Master Token Version',
      description: 'Incremented to invalidate all master-account JWT sessions',
      isSecret: false,
      updatedBy: 'system',
      updatedAt: new Date(),
    });
    logger.info(`Added missing config key "${key}"`);
  }

  /** SSH/cron sync master toggle and daily auto-sync schedule. */
  private async ensureSyncConfig(): Promise<void> {
    const defaults = [
      ['engine.syncEnabled', 'true', 'ENGINE', 'SSH Sync Enabled', 'Master switch for cron discovery, log checks, and timezone detection via SSH. Set false during production incidents.', false] as const,
      ['engine.dbJobsSyncEnabled', 'true', 'ENGINE', 'DB Jobs Sync Enabled', 'Master switch for DB2 RFX_QUEUE fetches (Fetch All, per-client refresh, background polling). Set false during production incidents.', false] as const,
      ['engine.punchSyncEnabled', 'true', 'ENGINE', 'Punch Sync Enabled', 'Master switch for unprocessed punch DB2 queries (Refresh, progressive load, background polling). Set false during production incidents.', false] as const,
      ['engine.cronSyncSchedule', '0 3 * * *', 'ENGINE', 'Daily Cron Sync Schedule', 'Cron expression for automatic nightly cron discovery from all appservers (server local time). Requires restart to change.', false] as const,
      ['engine.autoEscalationNotifyEnabled', 'true', 'ENGINE', 'Auto Escalation Email', 'When true, automatically email notification recipients and system-acknowledge escalated alerts for Default Suppress (min) after they cross the escalation threshold.', false] as const,
    ];

    for (const [key, value, category, label, description, isSecret] of defaults) {
      if (this.cache.has(key)) continue;
      await prisma.appConfig.create({
        data: { key, value, category, label, description, isSecret, updatedBy: 'system' },
      });
      this.cache.set(key, {
        key, value, category, label, description, isSecret,
        updatedBy: 'system', updatedAt: new Date(),
      });
      logger.info(`Added missing config key "${key}"`);
    }
  }

  /**
   * Get a string config value. Returns defaultVal if not found.
   */
  getString(key: string, defaultVal: string = ''): string {
    return this.cache.get(key)?.value ?? defaultVal;
  }

  /**
   * Get an integer config value.
   */
  getInt(key: string, defaultVal: number = 0): number {
    const v = this.cache.get(key)?.value;
    if (v === undefined || v === '') return clampConfigInt(key, defaultVal);
    const parsed = parseInt(v, 10);
    if (!Number.isFinite(parsed)) return clampConfigInt(key, defaultVal);
    return clampConfigInt(key, parsed);
  }

  /**
   * Get a float config value.
   */
  getFloat(key: string, defaultVal: number = 0): number {
    const v = this.cache.get(key)?.value;
    if (v === undefined || v === '') return defaultVal;
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : defaultVal;
  }

  /**
   * Get a boolean config value.
   */
  getBool(key: string, defaultVal: boolean = false): boolean {
    const v = this.cache.get(key)?.value;
    if (v === undefined || v === '') return defaultVal;
    return v === 'true' || v === '1';
  }

  /** Whether SSH-based sync (cron discovery, log checks, TZ detect) is allowed. */
  isSyncEnabled(): boolean {
    return this.getBool('engine.syncEnabled', true);
  }

  /** Whether DB2 RFX_QUEUE fetches for DB Jobs are allowed. */
  isDbJobsSyncEnabled(): boolean {
    return this.getBool('engine.dbJobsSyncEnabled', true);
  }

  /** Whether unprocessed punch DB2 queries are allowed. */
  isPunchSyncEnabled(): boolean {
    return this.getBool('engine.punchSyncEnabled', true);
  }

  /** Whether JDBC sslConnection is allowed globally (also requires per-client db2SslEnabled). */
  isDb2SslEnabled(): boolean {
    return this.getBool('infra.db2SslEnabled', false);
  }

  /** Remove superseded or unused AppConfig keys from older databases. */
  private async cleanupLegacyConfig(): Promise<void> {
    const obsoleteKeys = [
      'infra.db2JjsPath',
      'engine.jjsTimeoutMs',
      'engine.jjsMaxBuffer',
      'ui.showUnprocPunchTab',
      'display.defaultBatchDays',
      'engine.maxConcurrentJobs',
      'engine.heartbeatIntervalMs',
      'engine.executionHistoryDays',
      'engine.logRetentionDays',
    ];

    for (const key of obsoleteKeys) {
      if (!this.cache.has(key)) continue;
      await prisma.appConfig.delete({ where: { key } });
      this.cache.delete(key);
      logger.info(`Removed obsolete config key "${key}"`);
    }
  }

  /** Product display name from AppConfig (display.appName). */
  getAppName(): string {
    const name = this.getString(APP_NAME_CONFIG_KEY, DEFAULT_APP_NAME).trim();
    return name || DEFAULT_APP_NAME;
  }

  /** Minutes before notify icon reappears after an email was sent. */
  getNotifyCooldownMins(): number {
    const mins = this.getInt('threshold.notifyCooldownMins', 60);
    return mins > 0 ? mins : 60;
  }

  /**
   * Get all config entries (for admin UI). Masks secret values.
   */
  getAll(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, entry] of this.cache) {
      result[key] = {
        key: entry.key,
        value: entry.isSecret ? '••••••••' : entry.value,
        category: entry.category,
        label: entry.label,
        description: entry.description,
        isSecret: entry.isSecret,
        updatedBy: entry.updatedBy,
        updatedAt: entry.updatedAt.toISOString(),
      };
    }
    return result;
  }

  /**
   * Get all non-secret config entries (for frontend consumption).
   * Excludes SECRETS category entirely.
   */
  getPublicConfig(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, entry] of this.cache) {
      if (entry.isSecret || entry.category === 'SECRETS') continue;
      result[key] = entry.value;
    }
    applyLdapDevMockPublicConfig(result);
    return result;
  }

  /**
   * Update a config value. Encrypts secrets before storage.
   * Returns the categories that changed (for hot-reload decisions).
   */
  async update(key: string, value: string, userId?: string): Promise<{ category: string; requiresRestart: boolean }> {
    const existing = this.cache.get(key);
    if (!existing) {
      throw new Error(`Config key "${key}" not found`);
    }

    validateConfigValue(key, value);

    let storedValue = value;
    // Only require encryption for secrets.db2Password
    if (
      key === 'secrets.db2Password' &&
      value &&
      value !== '••••••••'
    ) {
      if (!isEncryptionConfigured()) {
        throw new Error('CONFIG_ENCRYPTION_KEY not set — cannot encrypt DB2 password');
      }
      storedValue = encryptSecret(value);
    } else if (existing.isSecret && value === '••••••••') {
      // No change to secret value
      return { category: existing.category, requiresRestart: false };
    }
    // For all other secrets, store as plaintext (no encryption)

    await prisma.appConfig.update({
      where: { key },
      data: {
        value: storedValue,
        updatedBy: userId || null,
      },
    });

    // Update cache with decrypted value
    existing.value = value;
    existing.updatedBy = userId || null;
    existing.updatedAt = new Date();

    const requiresRestart = existing.category === 'SECRETS' || existing.category === 'INFRA';
    logger.info(`Config "${key}" updated by ${userId || 'system'} (category: ${existing.category}, restart: ${requiresRestart})`);

    return { category: existing.category, requiresRestart };
  }

  /**
   * Update the help description for a config key (admin UI).
   */
  async updateDescription(key: string, description: string, userId?: string): Promise<void> {
    const existing = this.cache.get(key);
    if (!existing) {
      throw new Error(`Config key "${key}" not found`);
    }

    const trimmed = description.trim();
    await prisma.appConfig.update({
      where: { key },
      data: {
        description: trimmed || null,
        updatedBy: userId || null,
      },
    });

    existing.description = trimmed || null;
    existing.updatedBy = userId || null;
    existing.updatedAt = new Date();
    logger.info(`Config description for "${key}" updated by ${userId || 'system'}`);
  }

  /**
   * Bulk update config values and/or descriptions.
   */
  async bulkUpdate(updates: Array<{ key: string; value?: string; description?: string }>, userId?: string): Promise<{
    updated: number;
    requiresRestart: boolean;
    categories: string[];
  }> {
    for (const { key, value, description } of updates) {
      if (value === undefined && description === undefined) {
        throw new Error(`Config update for "${key}" must include value and/or description`);
      }
      if (value !== undefined) {
        validateConfigValue(key, value);
      }
    }

    const categories = new Set<string>();
    let requiresRestart = false;
    let updated = 0;

    for (const { key, value, description } of updates) {
      if (value !== undefined) {
        const result = await this.update(key, value, userId);
        categories.add(result.category);
        if (result.requiresRestart) requiresRestart = true;
        updated++;
      }
      if (description !== undefined) {
        await this.updateDescription(key, description, userId);
        const cat = this.cache.get(key)?.category;
        if (cat) categories.add(cat);
        if (value === undefined) updated++;
      }
    }

    return {
      updated,
      requiresRestart,
      categories: Array.from(categories),
    };
  }

  /**
   * Reveal a secret value (for admin with proper permission).
   */
  revealSecret(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry || !entry.isSecret) return null;
    return entry.value;
  }

  /**
   * Check if service is loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

export const configService = new ConfigService();
