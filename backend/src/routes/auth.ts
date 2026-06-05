// ============================================================
// Auth Routes - Register / Login / Me
// Credentials stored in User table; permissions embedded in JWT
// ============================================================

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { authMiddleware } from '../middleware';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { APP_FUNCTIONS } from '../constants/functions';

const router = Router();
const logger = createServiceLogger('Auth');

// ── helpers ─────────────────────────────────────────────────

/** Load user's flattened permission map from DB (union across all assigned profiles) */
async function loadPermissions(userId: string): Promise<Record<string, { r: boolean; w: boolean }>> {
  const rows = await prisma.userProfile.findMany({
    where: { userId },
    include: { profile: { include: { permissions: true } } },
  });

  const map: Record<string, { r: boolean; w: boolean }> = {};
  for (const up of rows) {
    for (const perm of up.profile.permissions) {
      const existing = map[perm.functionId];
      map[perm.functionId] = {
        r: (existing?.r || perm.canRead),
        w: (existing?.w || perm.canWrite),
      };
    }
  }
  return map;
}

/** Build and sign a JWT with embedded permissions */
async function signToken(userId: string, username: string, displayName: string, timezone: string = 'Asia/Kolkata'): Promise<string> {
  const permissions = await loadPermissions(userId);
  return jwt.sign(
    { userId, username, displayName, timezone, permissions },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn } as any,
  );
}

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, displayName, password } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'username, email and password are required' });
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Username or email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, email, displayName: displayName || username, passwordHash, isActive: true },
    });

    res.status(201).json({
      success: true,
      data: {
        id: user.id, username: user.username, email: user.email, displayName: user.displayName,
        message: 'User created. An admin must assign a profile before login grants any access.',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    logger.info(`[LOGIN] Attempt user=${username || 'missing'} ip=${ip}`);

    if (!username || !password) {
      logger.warn(`[LOGIN] Missing credentials user=${username || 'missing'} ip=${ip}`);
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    if (!config.jwtSecret || !config.jwtExpiresIn) {
      logger.error(`[LOGIN] JWT config missing. jwtSecretLen=${config.jwtSecret?.length || 0} jwtExpiresIn=${config.jwtExpiresIn || '(empty)'} ip=${ip}`);
      return res.status(500).json({ success: false, error: 'Authentication service is not configured' });
    }

    // ── Break-glass master account (bypasses DB, granted all permissions) ───
    if (config.master.username && username === config.master.username) {
      if (!config.master.passwordHash) {
        logger.warn(`[SECURITY] Master login attempted but MASTER_PASSWORD_HASH not set — denied (IP: ${ip})`);
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const masterValid = await bcrypt.compare(password, config.master.passwordHash);
      if (!masterValid) {
        logger.warn(`[SECURITY] MASTER LOGIN FAILED — invalid password from IP: ${ip}`);
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      // Grant every function with full read+write
      const allPerms: Record<string, { r: boolean; w: boolean }> = {};
      Object.values(APP_FUNCTIONS).forEach(fn => {
        allPerms[fn.id] = { r: true, w: true };
      });

      const token = jwt.sign(
        { userId: 'master', username, displayName: 'Master Admin', timezone: 'Asia/Kolkata', permissions: allPerms, isMaster: true },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn } as any,
      );

      logger.warn(
        `[SECURITY] ⚠ MASTER LOGIN USED — username: ${username}, IP: ${ip}, ` +
        `time: ${new Date().toISOString()}`,
      );

      return res.json({
        success: true,
        data: {
          token,
          user: { id: 'master', username, displayName: 'Master Admin', email: null },
        },
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isActive) {
      logger.warn(`[LOGIN] Invalid user or inactive user=${username} ip=${ip}`);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      logger.warn(`[LOGIN] Invalid password user=${username} ip=${ip}`);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = await signToken(user.id, user.username, user.displayName, user.timezone);
    logger.info(`[LOGIN] Success user=${username} ip=${ip}`);

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email, timezone: user.timezone },
      },
    });
  } catch (err: any) {
    logger.error(`[LOGIN] Unexpected error: ${err.message}`, {
      stack: err.stack,
      username: req.body?.username || 'missing',
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const u = (req as any).user;
  res.json({
    success: true,
    data: { id: u.userId, username: u.username, displayName: u.displayName, timezone: u.timezone || 'Asia/Kolkata', permissions: u.permissions },
  });
});

// ── POST /api/auth/refresh-permissions ──────────────────────
// Reissue token with latest permissions (call after admin changes profile assignment)
router.post('/refresh-permissions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId, username, displayName, timezone } = (req as any).user;
    const token = await signToken(userId, username, displayName, timezone || 'Asia/Kolkata');
    res.json({ success: true, data: { token } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export { signToken };
export default router;
