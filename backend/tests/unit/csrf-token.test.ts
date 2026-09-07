import jwt from 'jsonwebtoken';
import {
  createCsrfTokenFromSession,
  validateCsrfToken,
} from '../../src/utils/csrf-token';

jest.mock('../../src/config', () => ({
  config: { jwtSecret: 'test-csrf-secret' },
}));

function makeSessionToken(claims: Record<string, unknown> = {}): string {
  return jwt.sign(
    { userId: 'u1', username: 'test', jti: 'jti-abc', tv: 2, ...claims },
    'test-csrf-secret',
    { expiresIn: '1h' },
  );
}

describe('csrf-token', () => {
  it('creates a signed token from session JWT', () => {
    const session = makeSessionToken();
    const csrf = createCsrfTokenFromSession(session);
    expect(csrf).toBeTruthy();
    expect(csrf!.includes('.')).toBe(true);
  });

  it('returns null when session JWT lacks jti', () => {
    const session = jwt.sign({ userId: 'u1' }, 'test-csrf-secret');
    expect(createCsrfTokenFromSession(session)).toBeNull();
  });

  it('validates a token issued for the same session', () => {
    const session = makeSessionToken();
    const csrf = createCsrfTokenFromSession(session)!;
    expect(validateCsrfToken(csrf, session)).toBe(true);
  });

  it('rejects token for a different session jti', () => {
    const sessionA = makeSessionToken({ jti: 'jti-a' });
    const sessionB = makeSessionToken({ jti: 'jti-b' });
    const csrf = createCsrfTokenFromSession(sessionA)!;
    expect(validateCsrfToken(csrf, sessionB)).toBe(false);
  });

  it('rejects token after session tokenVersion changes', () => {
    const oldSession = makeSessionToken({ tv: 1 });
    const newSession = makeSessionToken({ tv: 2 });
    const csrf = createCsrfTokenFromSession(oldSession)!;
    expect(validateCsrfToken(csrf, newSession)).toBe(false);
  });

  it('rejects tampered signature', () => {
    const session = makeSessionToken();
    const csrf = createCsrfTokenFromSession(session)!;
    const tampered = csrf.slice(0, -2) + 'xx';
    expect(validateCsrfToken(tampered, session)).toBe(false);
  });

  it('rejects empty or malformed tokens', () => {
    const session = makeSessionToken();
    expect(validateCsrfToken('', session)).toBe(false);
    expect(validateCsrfToken('not-valid', session)).toBe(false);
  });
});
