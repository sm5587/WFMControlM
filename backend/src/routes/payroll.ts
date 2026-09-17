// ============================================================
// Payroll Routes
// Regular / adjustment pay-file tracking per client
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { payrollService } from '../services/payroll-service';
import { db2DirectService } from '../services/db2-direct-service';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { configService } from '../services/config-service';
import { PAYROLL_ENABLED_KEY, PAYROLL_MONITOR_ENABLED_KEY } from '../constants/app-display';
import { parseFrequencies } from '../constants/payroll';
import { requirePermission } from '../middleware';

const router = Router();

function requirePayrollJobsEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!configService.getBool(PAYROLL_ENABLED_KEY, false)) {
    res.status(404).json({ success: false, error: 'Payroll Jobs feature is disabled' });
    return;
  }
  next();
}

function requirePayrollMonitorEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!configService.getBool(PAYROLL_MONITOR_ENABLED_KEY, false)) {
    res.status(404).json({ success: false, error: 'Payroll Monitor feature is disabled' });
    return;
  }
  next();
}

const serverCodeAliases: Record<string, string> = {
  HMG: 'HNMG',
};

function resolveClientId(
  c: { clientId: string; serverCode: string },
  existingIds: Set<string>,
): string | null {
  const resolvedCode = serverCodeAliases[c.serverCode.toUpperCase()] || c.serverCode.toUpperCase();
  if (existingIds.has(resolvedCode)) return resolvedCode;
  if (existingIds.has(c.serverCode.toUpperCase())) return c.serverCode.toUpperCase();
  if (existingIds.has(c.clientId.toUpperCase())) return c.clientId.toUpperCase();
  return null;
}

async function syncPayrollClients(): Promise<void> {
  const allClients = await db2DirectService.getAvailableClients();
  logger.info(`Payroll sync: checking ${allClients.length} clients for payroll PFs`);

  const dbClients = await prisma.client.findMany({ select: { clientId: true } });
  const existingIds = new Set(dbClients.map(c => c.clientId.toUpperCase()));

  const CONCURRENCY = 5;
  let idx = 0;

  const processNext = async (): Promise<void> => {
    if (idx >= allClients.length) return;
    const c = allClients[idx++];

    try {
      const matchedId = resolveClientId(c, existingIds);
      const features = await payrollService.syncClientFeatures(c.clientId);
      const data = {
        payrollEnabled: features.payrollEnabled,
        payrollCycle: features.payrollCycle,
        payrollFileGen: features.payrollFileGen,
        priorPeriodEdit: features.priorPeriodEdit,
        priorPeriodEditLimit: features.priorPeriodEditLimit,
        payrollSyncedAt: new Date(),
      };

      if (matchedId) {
        await prisma.client.update({
          where: { clientId: matchedId },
          data,
        });
      } else {
        await prisma.client.upsert({
          where: { clientId: c.clientId },
          update: data,
          create: {
            clientId: c.clientId,
            name: c.clientId,
            ...data,
            db2Host: c.host,
            db2Port: parseInt(c.port || '50000', 10),
            db2Database: c.database,
          },
        });
      }

      logger.info(
        `Payroll sync: ${c.clientId} (→${matchedId || c.clientId}) ` +
        `RTA=${features.payrollEnabled} freq=${features.payrollCycle} ` +
        `fileGen=${features.payrollFileGen || '-'} adj=${features.priorPeriodEdit}/${features.priorPeriodEditLimit}`,
      );
    } catch (err: any) {
      logger.warn(`Payroll sync: ${c.clientId} → ${err.message}`);
    }

    await processNext();
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, allClients.length) }, () => processNext()),
  );

  logger.info('Payroll sync complete');
}

router.get('/clients', requirePayrollJobsEnabled, requirePermission('PAYROLL_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const clients = await prisma.client.findMany({
      where: { payrollEnabled: true },
      select: {
        clientId: true,
        name: true,
        payrollCycle: true,
        payrollFileGen: true,
        priorPeriodEdit: true,
        priorPeriodEditLimit: true,
        payrollSyncedAt: true,
      },
      orderBy: { clientId: 'asc' },
    });

    res.json({
      success: true,
      data: clients.map(c => ({
        ...c,
        payrollFrequencies: parseFrequencies(c.payrollCycle),
      })),
    });
  } catch (error: any) {
    logger.error(`Payroll clients list error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sync-clients', requirePayrollJobsEnabled, requirePermission('PAYROLL_SYNC', 'write'), (_req: Request, res: Response) => {
  res.status(202).json({
    success: true,
    message: 'Sync started. Client list will reflect results as each DB2 is checked.',
  });

  syncPayrollClients().catch(err =>
    logger.error(`Payroll background sync failed: ${err.message}`),
  );
});

router.get('/monitor', requirePayrollMonitorEnabled, requirePermission('PAYROLL_MONITOR_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const result = await payrollService.getMonitorSnapshot();
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Payroll monitor snapshot error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/monitor/:clientId', requirePayrollMonitorEnabled, requirePermission('PAYROLL_MONITOR_VIEW', 'read'), async (req: Request, res: Response) => {
  try {
    const distListId = typeof req.query.distListId === 'string' ? req.query.distListId : '';
    if (!distListId) {
      res.status(400).json({ success: false, error: 'distListId query parameter is required' });
      return;
    }
    const result = await payrollService.getMonitorDetail(req.params.clientId, distListId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Payroll monitor detail error for ${req.params.clientId}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:clientId', requirePayrollJobsEnabled, requirePermission('PAYROLL_VIEW', 'read'), async (req: Request, res: Response) => {
  try {
    const weekEnd = typeof req.query.weekEnd === 'string' ? req.query.weekEnd : undefined;
    const frequency = typeof req.query.frequency === 'string' ? req.query.frequency : undefined;
    const result = await payrollService.getPayrollStatus(req.params.clientId, weekEnd, frequency);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Payroll query error for ${req.params.clientId}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
