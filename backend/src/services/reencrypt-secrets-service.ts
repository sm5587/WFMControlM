// ============================================================
// Re-encrypt client DB2 passwords and AppConfig secrets.db2Password
// with CONFIG_ENCRYPTION_KEY (supports dual-key rotation window).
// ============================================================

import { prisma } from '../database/prisma';
import {
  classifyStoredSecret,
  decryptStoredSecretPlaintext,
  encryptSecret,
  hasPreviousEncryptionKey,
  isEncryptionConfigured,
  SecretStorageState,
} from '../utils/crypto';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('ReencryptSecrets');

const APP_CONFIG_DB2_PASSWORD_KEY = 'secrets.db2Password';
const METADATA_ROTATED_AT_KEY = 'secrets.encryptionLastReencryptAt';
const METADATA_ROTATED_BY_KEY = 'secrets.encryptionLastReencryptBy';

export interface ReencryptClientCounts {
  total: number;
  empty: number;
  plaintext: number;
  encryptedCurrent: number;
  encryptedPrevious: number;
  unreadable: number;
}

export interface ReencryptPreflight {
  encryptionConfigured: boolean;
  previousKeyConfigured: boolean;
  rotationInProgress: boolean;
  clients: ReencryptClientCounts;
  appConfigDb2Password: { state: SecretStorageState };
  needsReencrypt: number;
}

export interface ReencryptResult {
  updated: number;
  skipped: number;
  failed: number;
  failedClients: string[];
  appConfigUpdated: boolean;
}

function countClientState(counts: ReencryptClientCounts, state: SecretStorageState): void {
  switch (state) {
    case 'empty':
      counts.empty++;
      break;
    case 'plaintext':
      counts.plaintext++;
      break;
    case 'encrypted_current':
      counts.encryptedCurrent++;
      break;
    case 'encrypted_previous':
      counts.encryptedPrevious++;
      break;
    case 'unreadable':
      counts.unreadable++;
      break;
  }
}

function needsReencryptState(state: SecretStorageState): boolean {
  return state === 'plaintext' || state === 'encrypted_previous';
}

async function getAppConfigDb2PasswordRaw(): Promise<string | null> {
  const row = await prisma.appConfig.findUnique({
    where: { key: APP_CONFIG_DB2_PASSWORD_KEY },
    select: { value: true },
  });
  return row?.value ?? null;
}

async function scanClients(): Promise<Array<{ id: string; clientId: string; db2Password: string | null }>> {
  return prisma.client.findMany({
    select: { id: true, clientId: true, db2Password: true },
  });
}

export async function getReencryptPreflight(): Promise<ReencryptPreflight> {
  const clients: ReencryptClientCounts = {
    total: 0,
    empty: 0,
    plaintext: 0,
    encryptedCurrent: 0,
    encryptedPrevious: 0,
    unreadable: 0,
  };

  const rows = await scanClients();
  clients.total = rows.length;

  for (const row of rows) {
    countClientState(clients, classifyStoredSecret(row.db2Password));
  }

  const appConfigRaw = await getAppConfigDb2PasswordRaw();
  const appConfigState = classifyStoredSecret(appConfigRaw);

  let needsReencrypt = clients.plaintext + clients.encryptedPrevious;
  if (needsReencryptState(appConfigState)) needsReencrypt++;

  return {
    encryptionConfigured: isEncryptionConfigured(),
    previousKeyConfigured: hasPreviousEncryptionKey(),
    rotationInProgress: hasPreviousEncryptionKey(),
    clients,
    appConfigDb2Password: { state: appConfigState },
    needsReencrypt,
  };
}

async function upsertRotationMetadata(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const entries = [
    {
      key: METADATA_ROTATED_AT_KEY,
      value: now,
      category: 'SECRETS',
      label: 'Last Secret Re-encryption',
      description: 'ISO timestamp of the last Admin re-encrypt secrets run',
      isSecret: false,
    },
    {
      key: METADATA_ROTATED_BY_KEY,
      value: userId,
      category: 'SECRETS',
      label: 'Last Secret Re-encryption By',
      description: 'Username who last ran re-encrypt secrets',
      isSecret: false,
    },
  ];

  for (const entry of entries) {
    await prisma.appConfig.upsert({
      where: { key: entry.key },
      create: entry,
      update: { value: entry.value, updatedBy: userId },
    });
  }
}

export async function reencryptSecrets(userId: string): Promise<ReencryptResult> {
  if (!isEncryptionConfigured()) {
    throw new Error('CONFIG_ENCRYPTION_KEY not set — cannot re-encrypt secrets');
  }

  const result: ReencryptResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
    failedClients: [],
    appConfigUpdated: false,
  };

  const rows = await scanClients();

  for (const row of rows) {
    const state = classifyStoredSecret(row.db2Password);
    if (state === 'empty' || state === 'encrypted_current') {
      result.skipped++;
      continue;
    }

    if (state === 'unreadable') {
      result.failed++;
      result.failedClients.push(row.clientId);
      logger.warn(`Cannot re-encrypt ${row.clientId}: unreadable ciphertext`);
      continue;
    }

    const plaintext = decryptStoredSecretPlaintext(row.db2Password);
    if (!plaintext) {
      result.failed++;
      result.failedClients.push(row.clientId);
      continue;
    }

    await prisma.client.update({
      where: { id: row.id },
      data: { db2Password: encryptSecret(plaintext) },
    });
    result.updated++;
    logger.info(`Re-encrypted DB2 password for client ${row.clientId}`);
  }

  const appConfigRaw = await getAppConfigDb2PasswordRaw();
  const appConfigState = classifyStoredSecret(appConfigRaw);

  if (needsReencryptState(appConfigState)) {
    if (appConfigState === 'unreadable') {
      result.failed++;
      logger.warn('Cannot re-encrypt secrets.db2Password: unreadable ciphertext');
    } else {
      const plaintext = decryptStoredSecretPlaintext(appConfigRaw);
      if (!plaintext) {
        result.failed++;
      } else {
        await prisma.appConfig.update({
          where: { key: APP_CONFIG_DB2_PASSWORD_KEY },
          data: {
            value: encryptSecret(plaintext),
            updatedBy: userId,
          },
        });
        result.appConfigUpdated = true;
        logger.info('Re-encrypted AppConfig secrets.db2Password');
      }
    }
  }

  if (result.updated > 0 || result.appConfigUpdated) {
    await upsertRotationMetadata(userId);
  }

  logger.info(
    `Re-encrypt complete by ${userId}: updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`
  );

  return result;
}
