import {
  decryptClientDb2Password,
  encryptClientDb2Password,
  hasStoredDb2Password,
} from '../../src/utils/client-db2-password';

describe('client-db2-password', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = key;
  });

  afterEach(() => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
  });

  it('round-trips encrypt and decrypt', () => {
    const stored = encryptClientDb2Password('s3cret-db2-pass');
    expect(stored).not.toBe('s3cret-db2-pass');
    expect(decryptClientDb2Password(stored)).toBe('s3cret-db2-pass');
    expect(hasStoredDb2Password(stored)).toBe(true);
  });

  it('returns legacy plaintext when value is not encrypted', () => {
    expect(decryptClientDb2Password('legacy-plain')).toBe('legacy-plain');
  });

  it('throws when encryption key is missing', () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(() => encryptClientDb2Password('x')).toThrow(/CONFIG_ENCRYPTION_KEY/);
  });
});
