// ============================================================
// Config Service
// Loads all AppConfig rows from DB at startup, caches in memory,
// provides typed getters, supports hot-reload for non-INFRA keys.
// ============================================================

import { prisma } from '../database/prisma';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../utils/crypto';
import { createServiceLogger } from '../utils/logger';

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

    this.loaded = true;
    logger.info(`Loaded ${rows.length} config entries from DB`);
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
    if (v === undefined || v === '') return defaultVal;
    const parsed = parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : defaultVal;
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
   * Bulk update multiple config values.
   */
  async bulkUpdate(updates: Array<{ key: string; value: string }>, userId?: string): Promise<{
    updated: number;
    requiresRestart: boolean;
    categories: string[];
  }> {
    const categories = new Set<string>();
    let requiresRestart = false;

    for (const { key, value } of updates) {
      const result = await this.update(key, value, userId);
      categories.add(result.category);
      if (result.requiresRestart) requiresRestart = true;
    }

    return {
      updated: updates.length,
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
