// ============================================================
// Config Routes — Admin-only read/write for AppConfig
// ============================================================

import { Router, Request, Response } from 'express';
import { applyDbConfig, config } from '../config';
import { configService } from '../services/config-service';
import { alertService } from '../services/alert-service';
import { requirePermission } from '../middleware';
import { createServiceLogger } from '../utils/logger';
import { z } from 'zod';

const router = Router();
const logger = createServiceLogger('ConfigAPI');

// GET /api/config — Get all config (admin sees all, others get public only)
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const perm = user?.permissions?.['PERMISSIONS_EDIT'];
    const isAdmin = perm?.w;

    if (isAdmin) {
      res.json({ success: true, data: configService.getAll() });
    } else {
      res.json({ success: true, data: configService.getPublicConfig() });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/public — Get only non-secret config (no auth required at API level, but behind authMiddleware)
router.get('/public', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: configService.getPublicConfig() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/config — Update one or more config values (admin only)
const updateSchema = z.object({
  updates: z.array(z.object({
    key: z.string().min(1),
    value: z.string(),
  })).min(1).max(100),
});

router.patch('/', requirePermission('PERMISSIONS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const { updates } = updateSchema.parse(req.body);
    const user = (req as any).user;
    const userId = user?.username || user?.userId || 'admin';

    const result = await configService.bulkUpdate(updates, userId);

    const smtpTouched = updates.some(u => u.key.startsWith('secrets.smtp'));
    if (smtpTouched || result.categories.includes('SECRETS')) {
      applyDbConfig();
      alertService.reloadTransporter();
      logger.info(`SMTP settings reloaded after config update (host=${config.smtp.host}:${config.smtp.port})`);
    }

    logger.info(`Config bulk update by ${userId}: ${result.updated} key(s), categories=[${result.categories.join(',')}], restart=${result.requiresRestart}`);

    res.json({
      success: true,
      data: {
        updated: result.updated,
        requiresRestart: result.requiresRestart,
        categories: result.categories,
      },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    logger.error(`Config update error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/reveal — Reveal a secret value (admin only)
const revealSchema = z.object({
  key: z.string().min(1),
});

router.post('/reveal', requirePermission('PERMISSIONS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const { key } = revealSchema.parse(req.body);
    const value = configService.revealSecret(key);
    if (value === null) {
      return res.status(404).json({ success: false, error: 'Secret not found or key is not a secret' });
    }
    const user = (req as any).user;
    logger.info(`Secret "${key}" revealed by ${user?.username || 'unknown'}`);
    res.json({ success: true, data: { value } });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
