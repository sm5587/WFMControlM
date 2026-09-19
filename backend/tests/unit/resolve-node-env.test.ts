import { resolveNodeEnv } from '../../src/config';

describe('resolveNodeEnv', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns production when NODE_ENV=production regardless of DB value', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveNodeEnv({ getString: () => 'development' })).toBe('production');
  });

  it('returns DB value when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveNodeEnv({ getString: () => 'development' })).toBe('development');
  });

  it('falls back to development when DB value is empty', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveNodeEnv({ getString: () => '' })).toBe('development');
  });
});
