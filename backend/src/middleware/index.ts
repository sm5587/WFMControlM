// ============================================================
// Middleware - Error handler, Auth & Permission guards
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import { FunctionId } from '../constants/functions';
import { verifySessionToken } from '../utils/jwt-config';

const logger = createServiceLogger('Middleware');

/** Shape stored in JWT payload */
export interface JwtUser {
  userId: string;
  username: string;
  displayName: string;
  /** Flattened permission map: functionId → { r, w } */
  permissions: Record<string, { r: boolean; w: boolean }>;
}

export interface JwtPayload extends JwtUser {
  jti?: string;
  tv?: number;
  isMaster?: boolean;
  timezone?: string;
  exp?: number;
  iat?: number;
}

// Legacy role type — kept for backward compat during transition
export type UserRole = 'admin' | 'monitor';

// Global error handler
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  logger.error(`Unhandled error: ${err.message}`, {
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  res.status(500).json({
    success: false,
    error: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
  });
}

export function extractTokenFromAuthHeader(authHeader?: string): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

export function verifyJwtToken(token: string): JwtPayload {
  return verifySessionToken(token, config.jwtSecret) as JwtPayload;
}

export function hasPermission(
  user: JwtUser,
  functionId: string,
  mode: 'read' | 'write' = 'read',
): boolean {
  const perm = user.permissions?.[functionId];
  return mode === 'read' ? !!perm?.r : !!perm?.w;
}

// Auth middleware — validates JWT, checks revocation, attaches req.user
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const { extractRequestToken } = await import('../utils/session-cookie');
  const token = extractRequestToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  try {
    const decoded = verifyJwtToken(token);
    const { tokenRevocationService } = await import('../services/token-revocation-service');
    const active = await tokenRevocationService.isSessionActive(decoded);
    if (!active) {
      return res.status(401).json({ success: false, error: 'Session revoked or expired — please log in again' });
    }
    (req as any).user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * requirePermission(functionId, mode)
 * mode: 'read' | 'write'
 * Applied AFTER authMiddleware.
 */
export function requirePermission(functionId: FunctionId, mode: 'read' | 'write' = 'read') {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as JwtUser | undefined;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    if (!hasPermission(user, functionId, mode)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Required permission: ${functionId} (${mode})`,
      });
    }
    next();
  };
}

// Convenience shorthands used in routes
export const requireAdmin = requirePermission('PERMISSIONS_EDIT', 'write');

// Request logging middleware
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`Slow request: ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  next();
}
