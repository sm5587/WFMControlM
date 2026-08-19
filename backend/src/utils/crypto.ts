// ============================================================
// AES-256-GCM encryption for AppConfig secrets
// ============================================================

import crypto from 'crypto';
import { wipeBuffer } from './secure-memory';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
// Format: base64(iv + authTag + ciphertext)

export type SecretStorageState =
  | 'empty'
  | 'plaintext'
  | 'encrypted_current'
  | 'encrypted_previous'
  | 'unreadable';

function resolveKey(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function getKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY environment variable is required for secret encryption. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return resolveKey(raw);
}

function getPreviousKey(): Buffer | null {
  const raw = process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS || '';
  if (!raw) return null;
  return resolveKey(raw);
}

function looksLikeEncryptedBlob(stored: string): boolean {
  try {
    const combined = Buffer.from(stored, 'base64');
    return combined.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Decrypt a base64-encoded blob with a specific key buffer.
 */
export function decryptSecretWithKey(encoded: string, key: Buffer): string {
  const combined = Buffer.from(encoded, 'base64');
  let iv: Buffer | undefined;
  let authTag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let decrypted: Buffer | undefined;
  try {
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Invalid encrypted data: too short');
    }
    iv = combined.subarray(0, IV_LENGTH);
    authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } finally {
    wipeBuffer(combined);
    wipeBuffer(decrypted);
  }
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded blob.
 * Always uses CONFIG_ENCRYPTION_KEY (never the previous key).
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  let encrypted: Buffer | undefined;
  let authTag: Buffer | undefined;
  let combined: Buffer | undefined;
  try {
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    authTag = cipher.getAuthTag();
    combined = Buffer.concat([iv, authTag, encrypted]);
    return combined.toString('base64');
  } finally {
    wipeBuffer(encrypted);
    wipeBuffer(combined);
    wipeBuffer(iv);
    wipeBuffer(authTag);
    wipeBuffer(key);
  }
}

/**
 * Decrypt a base64-encoded blob back to plaintext.
 * Tries CONFIG_ENCRYPTION_KEY first, then CONFIG_ENCRYPTION_KEY_PREVIOUS.
 */
export function decryptSecret(encoded: string): string {
  try {
    return decryptSecretWithKey(encoded, getKey());
  } catch (currentErr) {
    const previous = getPreviousKey();
    if (previous) {
      return decryptSecretWithKey(encoded, previous);
    }
    throw currentErr;
  }
}

/**
 * Classify how a stored secret value is persisted (for pre-flight / re-encrypt).
 */
export function classifyStoredSecret(stored: string | null | undefined): SecretStorageState {
  if (!stored?.trim()) return 'empty';

  const trimmed = stored.trim();
  try {
    decryptSecretWithKey(trimmed, getKey());
    return 'encrypted_current';
  } catch {
    // fall through
  }

  const previous = getPreviousKey();
  if (previous) {
    try {
      decryptSecretWithKey(trimmed, previous);
      return 'encrypted_previous';
    } catch {
      // fall through
    }
  }

  if (looksLikeEncryptedBlob(trimmed)) return 'unreadable';
  return 'plaintext';
}

/**
 * Decrypt a stored value for re-encryption. Returns null when empty or unreadable.
 */
export function decryptStoredSecretPlaintext(stored: string | null | undefined): string | null {
  const state = classifyStoredSecret(stored);
  if (state === 'empty' || state === 'unreadable') return null;
  if (state === 'plaintext') return stored!.trim();
  return decryptSecret(stored!.trim());
}

/**
 * Check if CONFIG_ENCRYPTION_KEY is set (without throwing).
 */
export function isEncryptionConfigured(): boolean {
  return !!(process.env.CONFIG_ENCRYPTION_KEY);
}

/** Whether CONFIG_ENCRYPTION_KEY_PREVIOUS is set (rotation window active). */
export function hasPreviousEncryptionKey(): boolean {
  return !!(process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS);
}
