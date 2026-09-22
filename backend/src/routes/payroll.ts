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
import { parseFrequencies, parsePayrollDeadlineLocalTime, sanitizePayrollDeadlineDays } from '../constants/payroll';
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
        payrollDeadlineDaysAfterWeekEnd: true,
        payrollDeadlineLocalTime: true,
        timezone: true,
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

router.patch('/:clientId/deadline', requirePayrollJobsEnabled, requirePermission('PAYROLL_SYNC', 'write'), async (req: Request, res: Response) => {
  try {
    const clientId = req.params.clientId;
    const existing = await prisma.client.findUnique({
      where: { clientId },
      select: { clientId: true, payrollEnabled: true },
    });
    if (!existing) {
      res.status(404).json({ success: false, error: `Client not found: ${clientId}` });
      return;
    }

    const body = req.body || {};
    const clear =
      body.daysAfterWeekEnd === null
      || body.daysAfterWeekEnd === undefined
      || body.daysAfterWeekEnd === ''
      || body.localTime === null
      || body.localTime === undefined
      || body.localTime === '';

    let payrollDeadlineDaysAfterWeekEnd: number | null = null;
    let payrollDeadlineLocalTime: string | null = null;

    if (!clear) {
      const days = sanitizePayrollDeadlineDays(body.daysAfterWeekEnd);
      const time = parsePayrollDeadlineLocalTime(body.localTime);
      if (days == null) {
        res.status(400).json({ success: false, error: 'daysAfterWeekEnd must be an integer from 0 to 7' });
        return;
      }
      if (!time) {
        res.status(400).json({ success: false, error: 'localTime must be HH:mm (00:00–23:59)' });
        return;
      }
      payrollDeadlineDaysAfterWeekEnd = days;
      payrollDeadlineLocalTime = time;
    }

    const updated = await prisma.client.update({
      where: { clientId },
      data: { payrollDeadlineDaysAfterWeekEnd, payrollDeadlineLocalTime },
      select: {
        clientId: true,
        payrollDeadlineDaysAfterWeekEnd: true,
        payrollDeadlineLocalTime: true,
        timezone: true,
      },
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    logger.error(`Payroll deadline update error for ${req.params.clientId}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
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

router.get('/monitor/clients', requirePayrollMonitorEnabled, requirePermission('PAYROLL_MONITOR_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const clients = await payrollService.listMonitorClients();
    const stalledGraceMins = configService.getInt('threshold.payrollStalledGraceMins', 30);
    res.json({
      success: true,
      data: {
        stalledGraceMins,
        clients: clients.map(c => ({
          clientId: c.clientId,
          name: c.name,
          timezone: c.timezone,
          payrollFileGen: c.payrollFileGen,
          frequencies: parseFrequencies(c.payrollCycle),
          payrollDeadlineDaysAfterWeekEnd: c.payrollDeadlineDaysAfterWeekEnd,
          payrollDeadlineLocalTime: c.payrollDeadlineLocalTime,
        })),
      },
    });
  } catch (error: any) {
    logger.error(`Payroll monitor clients list error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/monitor/client/:clientId', requirePayrollMonitorEnabled, requirePermission('PAYROLL_MONITOR_VIEW', 'read'), async (req: Request, res: Response) => {
  try {
    const result = await payrollService.getMonitorClientScan(req.params.clientId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Payroll monitor client scan error for ${req.params.clientId}: ${error.message}`);
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
