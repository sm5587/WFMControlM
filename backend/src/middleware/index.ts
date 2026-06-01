// ============================================================
// Middleware - Error handler, Auth & Permission guards
// ============================================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import { FunctionId } from '../constants/functions';

const logger = createServiceLogger('Middleware');

/** Shape stored in JWT payload */
export interface JwtUser {
  userId: string;
  username: string;
  displayName: string;
  /** Flattened permission map: functionId → { r, w } */
  permissions: Record<string, { r: boolean; w: boolean }>;
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

// Auth middleware — validates JWT, attaches req.user
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    (req as any).user = decoded;
    next();
  } catch (err) {
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
    const perm = user.permissions?.[functionId];
    const allowed = mode === 'read' ? perm?.r : perm?.w;
    if (!allowed) {
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
