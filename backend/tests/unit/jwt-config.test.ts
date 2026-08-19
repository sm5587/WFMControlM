import jwt from 'jsonwebtoken';
import {
  JWT_ALGORITHM,
  signSessionToken,
  verifySessionToken,
} from '../../src/utils/jwt-config';

describe('jwt-config', () => {
  const secret = 'test-jwt-secret-algorithm-hs256-only';

  it('signs and verifies with HS256', () => {
    const token = signSessionToken({ userId: 'u1', tv: 0 }, secret, { jwtid: 'jti-1' });
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe(JWT_ALGORITHM);
    const payload = verifySessionToken(token, secret);
    expect(payload.userId).toBe('u1');
  });

  it('rejects none-algorithm tokens (algorithm switching)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ userId: 'attacker', tv: 0 })).toString('base64url');
    const forged = `${header}.${body}.`;
    expect(() => verifySessionToken(forged, secret)).toThrow();
  });

  it('rejects tokens signed with a different algorithm', () => {
    // HS384 token must not verify when allowlist is HS256-only
    const token = jwt.sign({ userId: 'u1' }, secret, { algorithm: 'HS384' });
    expect(() => verifySessionToken(token, secret)).toThrow();
  });
});
