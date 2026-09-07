// ============================================================
// CSRF token — signed synchronizer tokens tied to session JWT
// ============================================================

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export const CSRF_HEADER_NAME = 'X-CSRF-Token';

interface SessionClaims {
  jti?: string;
  tv?: number;
}

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Create a CSRF token bound to the session JWT (jti + tokenVersion). */
export function createCsrfTokenFromSession(sessionToken: string): string | null {
  const decoded = jwt.decode(sessionToken) as SessionClaims | null;
  if (!decoded?.jti) return null;

  const payload = `${decoded.jti}:${decoded.tv ?? 0}`;
  const sig = signPayload(payload);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}

/** Validate synchronizer token against the active session cookie JWT. */
export function validateCsrfToken(csrfToken: string, sessionToken: string): boolean {
  if (!csrfToken || !sessionToken) return false;

  const dot = csrfToken.lastIndexOf('.');
  if (dot <= 0) return false;

  const encodedPayload = csrfToken.slice(0, dot);
  const sig = csrfToken.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const expectedSig = signPayload(payload);
  if (!timingSafeEqualString(sig, expectedSig)) return false;

  const colon = payload.indexOf(':');
  if (colon <= 0) return false;

  const tokenJti = payload.slice(0, colon);
  const tokenTv = payload.slice(colon + 1);

  const decoded = jwt.decode(sessionToken) as SessionClaims | null;
  if (!decoded?.jti || decoded.jti !== tokenJti) return false;

  return String(decoded.tv ?? 0) === tokenTv;
}
