// ============================================================
// Login rate limit — brute-force / credential-stuffing protection
// ============================================================

import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('LoginRateLimit');

/** 15-minute window */
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Max failed login attempts per IP within the window */
export const LOGIN_RATE_LIMIT_MAX = 10;

export function createLoginRateLimiter(
  max: number = LOGIN_RATE_LIMIT_MAX,
  windowMs: number = LOGIN_RATE_LIMIT_WINDOW_MS,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, error: 'Too many login attempts. Please try again later.' },
    handler: (req, res, _next, options) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      logger.warn(`[SECURITY] Login rate limit exceeded ip=${ip}`);
      res.status(options.statusCode).json(options.message);
    },
  });
}

export const loginRateLimiter = createLoginRateLimiter();
