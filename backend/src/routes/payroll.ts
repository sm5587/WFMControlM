// ============================================================
// Payroll Routes
// Endpoints for querying TA_UNIT_PAY_STATUS per client
// Uses db2DirectService (jjs/JDBC) — same as DB Monitor
// ============================================================

import { Router, Request, Response } from 'express';
import { payrollService } from '../services/payroll-service';
import { db2DirectService } from '../services/db2-direct-service';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';

const router = Router();

// ============================================================
// Background sync: query each client DB2 for RTA_INTEGRATION
// feature flag, persist results so clients list is served locally
// ============================================================
async function syncPayrollClients(): Promise<void> {
  const allClients = await db2DirectService.getAvailableClients();
  logger.info(`Payroll sync: checking ${allClients.length} clients for RTA_INTEGRATION`);

  // Build a lookup of existing clients by clientId so we can match
  // DB connection file serverCodes (WAW, BLK) to seeded records
  const dbClients = await prisma.client.findMany({ select: { clientId: true } });
  const existingIds = new Set(dbClients.map(c => c.clientId.toUpperCase()));

  // Alias map for serverCodes that differ from seed cids
  const serverCodeAliases: Record<string, string> = {
    'HMG': 'HNMG',
  };

  const CONCURRENCY = 5;
  let idx = 0;

  const processNext = async (): Promise<void> => {
    if (idx >= allClients.length) return;
    const c = allClients[idx++];

    try {
      // Resolve the correct clientId: prefer serverCode match, then alias, then filename
      const resolvedCode = serverCodeAliases[c.serverCode.toUpperCase()] || c.serverCode.toUpperCase();
      const matchedId = existingIds.has(resolvedCode)
        ? resolvedCode
        : existingIds.has(c.serverCode.toUpperCase())
          ? c.serverCode.toUpperCase()
          : existingIds.has(c.clientId.toUpperCase())
            ? c.clientId.toUpperCase()
            : null;

      const sql = `SELECT FEATURE_VALUE FROM RWSUSER.PRODUCT_FEATURE ` +
        `WHERE feature_id LIKE 'RTA_INTEGRATION' FETCH FIRST 1 ROW ONLY`;
      const result = await db2DirectService.queryClient(c.clientId, sql, 'Payroll/Route');

      const enabled =
        result.success && result.rows && result.rows.length > 0
          ? (result.rows[0].FEATURE_VALUE || '').trim().toUpperCase() === 'Y'
          : false;

      if (matchedId) {
        // Update the existing seeded client record
        await prisma.client.update({
          where: { clientId: matchedId },
          data: { payrollEnabled: enabled, payrollSyncedAt: new Date() },
        });
      } else {
        // No matching seed record — upsert by connection file clientId
        await prisma.client.upsert({
          where: { clientId: c.clientId },
          update: { payrollEnabled: enabled, payrollSyncedAt: new Date() },
          create: {
            clientId: c.clientId,
            name: c.clientId,
            payrollEnabled: enabled,
            payrollSyncedAt: new Date(),
            db2Host: c.host,
            db2Port: parseInt(c.port || '50000', 10),
            db2Database: c.database,
          },
        });
      }

      logger.info(`Payroll sync: ${c.clientId} (→${matchedId || c.clientId}) → enabled=${enabled}`);
    } catch (err: any) {
      logger.warn(`Payroll sync: ${c.clientId} → ${err.message}`);
    }

    await processNext();
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, allClients.length) }, () => processNext())
  );

  logger.info('Payroll sync complete');
}

// GET /api/payroll/clients — Serve from local DB (payrollEnabled = true only)
router.get('/clients', async (_req: Request, res: Response) => {
  try {
    const clients = await prisma.client.findMany({
      where: { payrollEnabled: true },
      select: { clientId: true, name: true, payrollCycle: true, payrollSyncedAt: true },
      orderBy: { clientId: 'asc' },
    });

    res.json({ success: true, data: clients });
  } catch (error: any) {
    logger.error(`Payroll clients list error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/payroll/sync-clients — Start background sync of RTA_INTEGRATION per client
// Returns 202 immediately; sync updates payrollEnabled in local DB as results come in
router.post('/sync-clients', (_req: Request, res: Response) => {
  res.status(202).json({
    success: true,
    message: 'Sync started. Client list will reflect results as each DB2 is checked.',
  });

  // Fire and forget — does not block the response
  syncPayrollClients().catch(err =>
    logger.error(`Payroll background sync failed: ${err.message}`)
  );
});

// GET /api/payroll/:clientId — Fetch TA_UNIT_PAY_STATUS for a single client
router.get('/:clientId', async (req: Request, res: Response) => {
  try {
    const result = await payrollService.getPayrollStatus(req.params.clientId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Payroll query error for ${req.params.clientId}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
