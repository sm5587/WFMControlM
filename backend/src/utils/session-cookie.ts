// ============================================================
// Session cookie — HttpOnly JWT transport (XSS-safe)
// ============================================================

import { CookieOptions, Request, Response } from 'express';
import { config } from '../config';
import { configService } from '../services/config-service';

export const SESSION_COOKIE_NAME = 'wfm_session';

/** Parse JWT expiresIn strings like 24h, 7d, 30m into milliseconds. */
export function parseJwtDurationMs(expiresIn: string): number {
  const match = /^(\d+)\s*([smhd])$/i.exec(expiresIn.trim());
  if (!match) return 24 * 60 * 60 * 1000;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * (multipliers[unit] ?? multipliers.h);
}

export function getSessionCookieOptions(): CookieOptions {
  const requireHttps = configService.getBool('infra.requireHttps');
  const secure = requireHttps || config.nodeEnv === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: parseJwtDurationMs(config.jwtExpiresIn || '24h'),
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge, ...clearOpts } = getSessionCookieOptions();
  res.clearCookie(SESSION_COOKIE_NAME, clearOpts);
}

export function extractSessionTokenFromCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function extractRequestToken(req: Request): string | null {
  const fromCookie = extractSessionTokenFromCookie(req.headers.cookie);
  if (fromCookie) return fromCookie;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}
