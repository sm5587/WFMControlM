import { isAllowedSsoDomain, normalizeEmail } from '../../src/utils/sso-email';

jest.mock('../../src/config', () => ({
  config: {
    sso: { allowedDomain: 'zebra.com', enabled: true, emailHeader: 'X-Forwarded-Email' },
    https: { trustProxy: true },
    nodeEnv: 'test',
  },
}));

describe('sso-email', () => {
  describe('normalizeEmail', () => {
    it('lowercases and trims valid emails', () => {
      expect(normalizeEmail('  User@Zebra.COM  ')).toBe('user@zebra.com');
    });

    it('rejects invalid values', () => {
      expect(normalizeEmail('not-an-email')).toBeNull();
      expect(normalizeEmail('')).toBeNull();
    });
  });

  describe('isAllowedSsoDomain', () => {
    it('allows @zebra.com addresses', () => {
      expect(isAllowedSsoDomain('user@zebra.com')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isAllowedSsoDomain('user@gmail.com')).toBe(false);
      expect(isAllowedSsoDomain('user@zebra.com.evil.com')).toBe(false);
    });
  });
});
