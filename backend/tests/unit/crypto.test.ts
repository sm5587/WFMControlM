import {
  classifyStoredSecret,
  decryptSecret,
  decryptSecretWithKey,
  encryptSecret,
  hasPreviousEncryptionKey,
} from '../../src/utils/crypto';

describe('crypto', () => {
  const currentKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const previousKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = currentKey;
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS;
  });

  afterEach(() => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS;
  });

  it('round-trips encrypt and decrypt with current key', () => {
    const stored = encryptSecret('hello-secret');
    expect(decryptSecret(stored)).toBe('hello-secret');
  });

  it('decrypts with previous key during rotation window', () => {
    process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    const storedWithOld = encryptSecret('rotated-value');

    process.env.CONFIG_ENCRYPTION_KEY = currentKey;
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = previousKey;

    expect(decryptSecret(storedWithOld)).toBe('rotated-value');
  });

  it('classifies storage states', () => {
    const encrypted = encryptSecret('pw');
    expect(classifyStoredSecret(encrypted)).toBe('encrypted_current');
    expect(classifyStoredSecret('plain-text')).toBe('plaintext');
    expect(classifyStoredSecret('')).toBe('empty');
    expect(classifyStoredSecret(null)).toBe('empty');
  });

  it('classifies previous-key ciphertext during rotation', () => {
    process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    const stored = encryptSecret('old-pw');

    process.env.CONFIG_ENCRYPTION_KEY = currentKey;
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = previousKey;

    expect(classifyStoredSecret(stored)).toBe('encrypted_previous');
    expect(decryptSecret(stored)).toBe('old-pw');
  });

  it('reports previous key configured', () => {
    expect(hasPreviousEncryptionKey()).toBe(false);
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = previousKey;
    expect(hasPreviousEncryptionKey()).toBe(true);
  });

  it('decryptSecretWithKey uses explicit key buffer', () => {
    const key = Buffer.from(currentKey, 'hex');
    const stored = encryptSecret('explicit');
    expect(decryptSecretWithKey(stored, key)).toBe('explicit');
  });
});
