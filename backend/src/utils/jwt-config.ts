// ============================================================
// JWT signing / verification — explicit HS256 only (no alg switching)
// ============================================================

import jwt, { Algorithm, SignOptions } from 'jsonwebtoken';

export const JWT_ALGORITHM: Algorithm = 'HS256';

export const JWT_VERIFY_OPTIONS: jwt.VerifyOptions = {
  algorithms: [JWT_ALGORITHM],
};

export function signSessionToken(
  payload: object,
  secret: string,
  options: SignOptions = {},
): string {
  return jwt.sign(payload, secret, {
    ...options,
    algorithm: JWT_ALGORITHM,
  });
}

export function verifySessionToken(token: string, secret: string): jwt.JwtPayload {
  return jwt.verify(token, secret, JWT_VERIFY_OPTIONS) as jwt.JwtPayload;
}
