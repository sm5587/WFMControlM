// ============================================================
// Client DB2 password encryption (AES-256-GCM via CONFIG_ENCRYPTION_KEY)
// Stored in Client.db2Password; legacy plaintext values still decrypt-on-read.
// ============================================================

import { encryptSecret, decryptSecret, isEncryptionConfigured } from './crypto';

/**
 * Encrypt a client DB2 password for storage in Client.db2Password.
 */
export function encryptClientDb2Password(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) {
    throw new Error('DB2 password cannot be empty');
  }
  if (!isEncryptionConfigured()) {
    throw new Error('CONFIG_ENCRYPTION_KEY not set — cannot store DB2 password');
  }
  return encryptSecret(trimmed);
}

/**
 * Decrypt a stored Client.db2Password value.
 * Returns legacy plaintext unchanged when decryption fails (migration path).
 */
export function decryptClientDb2Password(stored: string | null | undefined): string | null {
  if (!stored?.trim()) return null;
  try {
    return decryptSecret(stored);
  } catch {
    return stored;
  }
}

/** Whether a non-empty password value exists in the database. */
export function hasStoredDb2Password(stored: string | null | undefined): boolean {
  return !!(stored && stored.trim());
}
