// ============================================================
// Auth Routes - Register / Login / Me / Logout
// Credentials stored in User table; permissions embedded in JWT
// ============================================================

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { authMiddleware } from '../middleware';
import {
  clearSessionCookie,
  extractRequestToken,
  setSessionCookie,
} from '../utils/session-cookie';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { APP_FUNCTIONS } from '../constants/functions';
import { tokenRevocationService } from '../services/token-revocation-service';
import { loginRateLimiter } from '../middleware/login-rate-limit';
import { extractSsoEmail, extractSsoEmailDetailed, isAllowedSsoDomain } from '../utils/sso-email';
import { resolveSsoAccessStatus } from '../services/access-request-service';

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

/** Build and sign a JWT with embedded permissions + revocation metadata */
async function signToken(
  userId: string,
  username: string,
  displayName: string,
  timezone: string = 'Asia/Kolkata',
): Promise<string> {
  const permissions = await loadPermissions(userId);
  return tokenRevocationService.createSessionToken({
    userId,
    username,
    displayName,
    timezone,
    permissions,
  });
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
router.post('/login', loginRateLimiter, async (req: Request, res: Response) => {
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

      const allPerms: Record<string, { r: boolean; w: boolean }> = {};
      Object.values(APP_FUNCTIONS).forEach(fn => {
        allPerms[fn.id] = { r: true, w: true };
      });

      const token = await tokenRevocationService.createSessionToken({
        userId: 'master',
        username,
        displayName: 'WFM Admin',
        timezone: 'Asia/Kolkata',
        permissions: allPerms,
        isMaster: true,
      });

      logger.warn(
        `[SECURITY] ⚠ MASTER LOGIN USED — username: ${username}, IP: ${ip}, ` +
        `time: ${new Date().toISOString()}`,
      );

      setSessionCookie(res, token);

      return res.json({
        success: true,
        data: {
          user: { id: 'master', username, displayName: 'WFM Admin', email: null, isMaster: true },
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

    const profileCount = await prisma.userProfile.count({ where: { userId: user.id } });
    if (profileCount === 0) {
      logger.warn(`[LOGIN] No profile assigned user=${username} ip=${ip}`);
      return res.status(403).json({
        success: false,
        error: 'No profile assigned. Contact an administrator to grant access.',
      });
    }

    const token = await signToken(user.id, user.username, user.displayName, user.timezone);
    logger.info(`[LOGIN] Success user=${username} ip=${ip}`);

    setSessionCookie(res, token);

    res.json({
      success: true,
      data: {
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

// ── GET /api/auth/sso-status ─────────────────────────────────
// Returns SSO email + access request state (creates pending request if new)
router.get('/sso-status', async (req: Request, res: Response) => {
  try {
    if (!config.sso.enabled) {
      return res.json({
        success: true,
        data: { ssoEnabled: false, email: null, status: null, canLogin: false },
      });
    }

    const { email, domainRejected, rejectedEmail } = extractSsoEmailDetailed(req);

    if (domainRejected) {
      const allowed = config.sso.allowedDomain || 'zebra.com';
      return res.json({
        success: true,
        data: {
          ssoEnabled: true,
          email: rejectedEmail || null,
          status: 'DOMAIN_DENIED',
          canLogin: false,
          message: `Access is restricted to @${allowed} accounts only.`,
        },
      });
    }

    if (!email) {
      return res.json({
        success: true,
        data: { ssoEnabled: true, email: null, status: null, canLogin: false },
      });
    }

    const ip = req.ip || req.socket?.remoteAddress || undefined;
    const status = await resolveSsoAccessStatus(email, ip);
    res.json({ success: true, data: status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/auth/sso-login ─────────────────────────────────
// Issue session for approved SSO user (email from LB header + profile assigned)
router.post('/sso-login', async (req: Request, res: Response) => {
  try {
    if (!config.sso.enabled) {
      return res.status(403).json({ success: false, error: 'SSO/LDAP login is not enabled.' });
    }

    const email = extractSsoEmail(req);
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    if (!email) {
      return res.status(400).json({ success: false, error: 'SSO email not available. Sign in through the corporate load balancer.' });
    }

    const allowed = config.sso.allowedDomain || 'zebra.com';
    if (!isAllowedSsoDomain(email)) {
      return res.status(403).json({ success: false, error: `Access is restricted to @${allowed} accounts only.` });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { profiles: true },
    });

    if (!user || !user.isActive) {
      logger.warn(`[SSO-LOGIN] User not found or inactive email=${email} ip=${ip}`);
      return res.status(403).json({ success: false, error: 'Access not granted. Your request may still be pending approval.' });
    }

    if (user.profiles.length === 0) {
      return res.status(403).json({ success: false, error: 'No profile assigned yet. Contact an administrator.' });
    }

    const token = await signToken(user.id, user.username, user.displayName, user.timezone);
    logger.info(`[SSO-LOGIN] Success email=${email} user=${user.username} ip=${ip}`);

    setSessionCookie(res, token);

    res.json({
      success: true,
      data: {
        user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email, timezone: user.timezone },
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const token = extractRequestToken(req);
    if (token) {
      await tokenRevocationService.revokeTokenString(token, 'logout');
    }
    clearSessionCookie(res);
    res.json({ success: true, message: 'Logged out' });
  } catch (err: any) {
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
router.post('/refresh-permissions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const priorToken = extractRequestToken(req);
    if (priorToken) {
      await tokenRevocationService.revokeTokenString(priorToken, 'refresh');
    }

    if (user.isMaster || user.userId === 'master') {
      const allPerms: Record<string, { r: boolean; w: boolean }> = {};
      Object.values(APP_FUNCTIONS).forEach(fn => {
        allPerms[fn.id] = { r: true, w: true };
      });
      const token = await tokenRevocationService.createSessionToken({
        userId: 'master',
        username: user.username,
        displayName: user.displayName || 'WFM Admin',
        timezone: user.timezone || 'Asia/Kolkata',
        permissions: allPerms,
        isMaster: true,
      });
      setSessionCookie(res, token);
      return res.json({ success: true, message: 'Permissions refreshed' });
    }
    const { userId, username, displayName, timezone } = user;
    const token = await signToken(userId, username, displayName, timezone || 'Asia/Kolkata');
    setSessionCookie(res, token);
    res.json({ success: true, message: 'Permissions refreshed' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export { signToken };
export default router;
