// ============================================================
// Keeper Secrets Manager Service
// Fetches secrets from Keeper Vault using the official SDK.
//
// Setup:
//   1. Create a Keeper Secrets Manager Application in your vault.
//   2. Share the folder containing your DB2/SMTP/etc. records to the app.
//   3. Generate a one-time access token from the Keeper desktop app.
//   4. Set KEEPER_CONFIG_FILE=/path/to/ksm-config.json and
//      KEEPER_ONE_TIME_TOKEN=<token> in .env, then start the app once.
//   5. Remove KEEPER_ONE_TIME_TOKEN from .env — ksm-config.json is now
//      the bound credential (keep it private, 0600 permissions).
//
// Keeper record convention for DB2 clients:
//   Record title : <CLIENT_ID>  (e.g. "CVS", "WAG", "BOFA")
//   Record type  : login
//   login field  : DB2 username  (e.g. "datareader")
//   password field: DB2 password
// ============================================================

import { config } from '../config';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('KeeperService');

function getCacheTtlMs(): number {
  return configService.getInt('engine.keeperCacheTtlMins') * 60 * 1000;
}

interface FieldCacheEntry {
  value: string;
  expiresAt: number;
}

export interface DB2ClientConfig {
  db2Host?: string | null;
  db2Port?: number | null;
  db2Database?: string | null;
  db2Schema?: string | null;
  db2Username?: string | null;
  db2Password?: string | null;
}

export interface DB2Credentials {
  username: string;
  password: string;
  database: string;
  schema: string;
  host?: string;
  port?: number;
}

class KeeperService {
  private initialized = false;
  private fieldCache = new Map<string, FieldCacheEntry>();

  /** True when KEEPER_ENABLED=true AND KEEPER_CONFIG_FILE is set */
  isConfigured(): boolean {
    return config.keeper.enabled && !!config.keeper.configFile;
  }

  /**
   * Connect to Keeper vault at app startup.
   * Only runs when KEEPER_ENABLED=true. Non-fatal if unreachable.
   */
  async initialize(): Promise<void> {
    if (!config.keeper.enabled) {
      logger.info('Keeper disabled (KEEPER_ENABLED != true) — using connection file passwords');
      return;
    }
    if (!config.keeper.configFile) {
      logger.warn('Keeper is enabled but KEEPER_CONFIG_FILE is not set — disabling Keeper');
      return;
    }

    try {
      const ksm = await import('@keeper-security/secrets-manager-core');
      const storage = ksm.localConfigStorage(config.keeper.configFile);

      if (config.keeper.oneTimeToken) {
        logger.info('Binding Keeper one-time token → writing ksm-config.json...');
        await ksm.initializeStorage(storage, config.keeper.oneTimeToken);
        logger.warn(
          '⚠  KEEPER_ONE_TIME_TOKEN has been consumed. ' +
          'Remove it from .env now — ksm-config.json is the credential.',
        );
      }

      // Validate connectivity (also completes token binding on first run)
      await ksm.getSecrets({ storage });
      this.initialized = true;
      logger.info('✓ Keeper Secrets Manager connected');
    } catch (err: any) {
      logger.error(`Keeper initialization failed: ${err.message}`);
      logger.warn('Keeper unavailable — falling back to plaintext credentials');
    }
  }

  /**
   * Fetch the password field of a Keeper record by its title.
   * Used to override DB2 passwords from connection files.
   * Returns null if Keeper is not initialized or record not found.
   */
  async getPassword(recordTitle: string): Promise<string | null> {
    return this.getField(recordTitle, 'password');
  }

  /**
   * Fetch the login/username field of a Keeper record by its title.
   */
  async getLogin(recordTitle: string): Promise<string | null> {
    return this.getField(recordTitle, 'login');
  }

  private async getField(recordTitle: string, fieldType: string): Promise<string | null> {
    if (!this.initialized) return null;

    const cacheKey = `${recordTitle}::${fieldType}`;
    const cached = this.fieldCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const ksm = await import('@keeper-security/secrets-manager-core');
      const options = { storage: ksm.localConfigStorage(config.keeper.configFile) };
      const record = await ksm.getSecretByTitle(options, recordTitle);

      if (!record) {
        logger.debug(`Keeper: record "${recordTitle}" not found`);
        return null;
      }

      const fields = record.data.fields as Array<{ type: string; value: string[] }>;
      const field = fields.find(x => x.type === fieldType);
      const value = field?.value?.[0];

      if (!value) {
        logger.debug(`Keeper: field "${fieldType}" not found in record "${recordTitle}"`);
        return null;
      }

      this.fieldCache.set(cacheKey, { value, expiresAt: Date.now() + getCacheTtlMs() });
      return value;
    } catch (err: any) {
      logger.error(`Keeper fetch error for "${recordTitle}.${fieldType}": ${err.message}`);
      return null;
    }
  }

  /** Evict cached secrets (all entries, or one client when clientId is given) */
  clearCache(clientId?: string): void {
    if (!clientId) {
      this.fieldCache.clear();
      logger.info('Keeper secret cache cleared');
      return;
    }

    const prefix = `${clientId}::`;
    for (const key of this.fieldCache.keys()) {
      if (key.startsWith(prefix)) {
        this.fieldCache.delete(key);
      }
    }
    logger.info(`Keeper secret cache cleared for ${clientId}`);
  }

  /**
   * Resolve DB2 credentials for a client.
   * Prisma/connection-file values are the base; Keeper login/password override when configured.
   */
  async getDB2Credentials(clientId: string, clientConfig: DB2ClientConfig): Promise<DB2Credentials> {
    const database = clientConfig.db2Database?.trim();
    if (!database) {
      throw new Error(`DB2 database not configured for ${clientId}`);
    }

    let username =
      clientConfig.db2Username?.trim() ||
      config.keeper.db2Username?.trim() ||
      '';
    let password =
      clientConfig.db2Password?.trim() ||
      config.keeper.db2Password?.trim() ||
      '';

    if (this.isConfigured()) {
      const keeperLogin = await this.getLogin(clientId);
      const keeperPass = await this.getPassword(clientId);
      if (keeperLogin) username = keeperLogin;
      if (keeperPass) password = keeperPass;
    }

    if (!username || !password) {
      throw new Error(`DB2 credentials not configured for ${clientId}`);
    }

    return {
      username,
      password,
      database,
      schema: clientConfig.db2Schema?.trim() || 'WFMADM',
      host: clientConfig.db2Host ?? undefined,
      port: clientConfig.db2Port ?? undefined,
    };
  }

  getStatus(): { configured: boolean; initialized: boolean; cachedEntries: number } {
    return {
      configured: this.isConfigured(),
      initialized: this.initialized,
      cachedEntries: this.fieldCache.size,
    };
  }
}

export const keeperService = new KeeperService();
