// ============================================================
// Heat Map Routes
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { wipHeatMapService } from '../services/wip-heatmap-service';
import { configService } from '../services/config-service';
import { HEATMAP_ENABLED_KEY } from '../constants/app-display';
import { requirePermission } from '../middleware';
import { logger } from '../utils/logger';

const router = Router();

function requireHeatMapEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!configService.getBool(HEATMAP_ENABLED_KEY, false)) {
    res.status(404).json({ success: false, error: 'Heat Map feature is disabled' });
    return;
  }
  next();
}

router.get(
  '/clients',
  requireHeatMapEnabled,
  requirePermission('HEATMAP_VIEW', 'read'),
  async (_req: Request, res: Response) => {
    try {
      const clients = await wipHeatMapService.listClients();
      logger.info(`Heat Map: clients list → ${clients.length} client(s)`);
      res.json({ success: true, data: { clients } });
    } catch (err) {
      logger.error('Heat Map clients list failed', err);
      res.status(500).json({ success: false, error: 'Failed to list Heat Map clients' });
    }
  },
);

router.get(
  '/client/:clientId',
  requireHeatMapEnabled,
  requirePermission('HEATMAP_VIEW', 'read'),
  async (req: Request, res: Response) => {
    try {
      const clientId = String(req.params.clientId || '').trim();
      if (!clientId) {
        res.status(400).json({ success: false, error: 'clientId is required' });
        return;
      }
      const row = await wipHeatMapService.scanClient(clientId);
      res.json({ success: true, data: row });
    } catch (err) {
      logger.error('Heat Map client scan failed', err);
      res.status(500).json({ success: false, error: 'Failed to scan Heat Map client' });
    }
  },
);

router.get(
  '/',
  requireHeatMapEnabled,
  requirePermission('HEATMAP_VIEW', 'read'),
  async (_req: Request, res: Response) => {
    try {
      const snapshot = await wipHeatMapService.getSnapshot();
      res.json({ success: true, data: snapshot });
    } catch (err) {
      logger.error('Heat Map snapshot failed', err);
      res.status(500).json({ success: false, error: 'Failed to load Heat Map' });
    }
  },
);

export default router;
