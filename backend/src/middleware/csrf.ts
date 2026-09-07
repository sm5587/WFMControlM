// ============================================================
// CSRF middleware — synchronizer token for cookie-authenticated requests
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { extractSessionTokenFromCookie } from '../utils/session-cookie';
import { CSRF_HEADER_NAME, validateCsrfToken } from '../utils/csrf-token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Unauthenticated POST endpoints — no session CSRF required. */
const PUBLIC_MUTATING_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/sso-login',
]);

function readCsrfHeader(req: Request): string | null {
  const raw = req.headers[CSRF_HEADER_NAME.toLowerCase()] ?? req.headers[CSRF_HEADER_NAME];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

/**
 * Require X-CSRF-Token on state-changing requests when the session JWT
 * is sent via HttpOnly cookie. Bearer-only clients are exempt.
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  if (PUBLIC_MUTATING_PATHS.has(req.path)) {
    next();
    return;
  }

  const sessionFromCookie = extractSessionTokenFromCookie(req.headers.cookie);
  if (!sessionFromCookie) {
    next();
    return;
  }

  const csrfToken = readCsrfHeader(req);
  if (!csrfToken || !validateCsrfToken(csrfToken, sessionFromCookie)) {
    res.status(403).json({ success: false, error: 'Invalid or missing CSRF token' });
    return;
  }

  next();
}
