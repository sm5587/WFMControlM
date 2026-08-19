import {
  SESSION_COOKIE_NAME,
  extractSessionTokenFromCookie,
  parseJwtDurationMs,
} from '../../src/utils/session-cookie';

jest.mock('../../src/config', () => ({
  config: { jwtExpiresIn: '24h', nodeEnv: 'test' },
}));

jest.mock('../../src/services/config-service', () => ({
  configService: {
    getBool: jest.fn(() => false),
  },
}));

describe('session-cookie', () => {
  it('parses jwt duration strings', () => {
    expect(parseJwtDurationMs('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseJwtDurationMs('30m')).toBe(30 * 60 * 1000);
  });

  it('extracts session token from cookie header', () => {
    const header = `other=1; ${SESSION_COOKIE_NAME}=abc.def.ghi; foo=bar`;
    expect(extractSessionTokenFromCookie(header)).toBe('abc.def.ghi');
  });

  it('returns null when cookie missing', () => {
    expect(extractSessionTokenFromCookie('foo=bar')).toBeNull();
  });
});
