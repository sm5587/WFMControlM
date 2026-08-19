import { clearSensitiveEnvVars, wipeBuffer, DB2_CONNECTOR_SECRET_ENV_KEYS } from '../../src/utils/secure-memory';

describe('secure-memory', () => {
  it('zero-fills a Buffer', () => {
    const buf = Buffer.from('secret-data');
    wipeBuffer(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('is a no-op for null and non-Buffers', () => {
    expect(() => wipeBuffer(null)).not.toThrow();
    expect(() => wipeBuffer(undefined)).not.toThrow();
  });

  it('removes DB2 connector secret env vars', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      DB2_PASS_OVERRIDE: 'p@ssw0rd',
      DB2_USER_OVERRIDE: 'reader',
    };
    clearSensitiveEnvVars(env);
    expect(env.DB2_PASS_OVERRIDE).toBeUndefined();
    expect(env.DB2_USER_OVERRIDE).toBe('reader');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('exports the expected secret env key list', () => {
    expect(DB2_CONNECTOR_SECRET_ENV_KEYS).toEqual(['DB2_PASS_OVERRIDE']);
  });
});
