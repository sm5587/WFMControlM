// ============================================================
// AES-256-GCM encryption for AppConfig secrets
// ============================================================

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
// Format: base64(iv + authTag + ciphertext)

function getKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY environment variable is required for secret encryption. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  // Accept hex (64 chars) or raw 32-byte string
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Hash whatever was provided to get 32 bytes
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded blob.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv (12) + authTag (16) + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypt a base64-encoded blob back to plaintext.
 */
export function decryptSecret(encoded: string): string {
  const key = getKey();
  const combined = Buffer.from(encoded, 'base64');
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Check if CONFIG_ENCRYPTION_KEY is set (without throwing).
 */
export function isEncryptionConfigured(): boolean {
  return !!(process.env.CONFIG_ENCRYPTION_KEY);
}
