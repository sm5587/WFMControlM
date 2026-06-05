// ============================================================
// DB Monitor Routes
// Endpoints for DB2 database monitoring per client
// ============================================================

import { Router, Request, Response } from 'express';
import { dbMonitorService } from '../services/db-monitor-service';
import { keeperService } from '../services/keeper-service';
import { db2Pool } from '../services/db2-connection-pool';
import { db2DirectService } from '../services/db2-direct-service';
import { prisma } from '../database/prisma';
import { escalationService } from '../services/escalation-service';
import { configService } from '../services/config-service';
import { logger } from '../utils/logger';

const router = Router();

// ============================================================
// DB2 Direct Connection Endpoints
// ============================================================

// GET /api/db-monitor/db-clients - List available clients with DB2 configured
router.get('/db-clients', async (_req: Request, res: Response) => {
  try {
    const clients = await db2DirectService.getAvailableClients();

    // Enrich with client names and cluster from the database
    // Match by serverCode (from JDBC hostname) since DB stores short codes (WAW, BLK)
    // while connection files use longer names (WAWA, BELK)
    // Some DB hostnames differ from app server hostnames (e.g. hmg vs hnmg)
    const serverCodeAliases: Record<string, string> = {
      'HMG': 'HNMG', // HNMDE DB file -> z182sp-hmgrws... but seed uses HNMG
    };
    const dbClients = await prisma.client.findMany({
      select: { clientId: true, name: true, cluster: true },
    });
    const nameMap = new Map(dbClients.map(c => [c.clientId.toUpperCase(), { name: c.name, cluster: c.cluster }]));
    const enriched = clients.map(c => {
      const resolvedCode = serverCodeAliases[c.serverCode.toUpperCase()] || c.serverCode.toUpperCase();
      const match = nameMap.get(resolvedCode) || nameMap.get(c.serverCode.toUpperCase()) || nameMap.get(c.clientId.toUpperCase());
      return {
        ...c,
        name: match?.name || c.clientId,
        cluster: match?.cluster || '',
        matchedClientId: match ? (nameMap.has(resolvedCode) ? resolvedCode : (nameMap.has(c.serverCode.toUpperCase()) ? c.serverCode.toUpperCase() : c.clientId.toUpperCase())) : null,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (error: any) {
    logger.error(`DB clients list error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/db-clients/batch-status-all - Batch status for ALL clients
router.get('/db-clients/batch-status-all', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string, 10) || 2;
    const result = await db2DirectService.getAllBatchStatusSummary(days);

    // Enrich pendingAlerts with client names
    const dbClients = await prisma.client.findMany({
      select: { clientId: true, name: true },
    });
    const nameMap = new Map(dbClients.map(c => [c.clientId, c.name]));
    const enrichedAlerts = result.pendingAlerts.map(a => ({
      ...a,
      clientName: nameMap.get(a.clientId) || a.clientId,
    }));

    res.json({ success: true, data: { ...result, pendingAlerts: enrichedAlerts, clientNames: Object.fromEntries(nameMap) } });

    // Process escalations in the background (don't block the response)
    // Only critical DB jobs should drive escalated alerts / notifications.
    const criticalJobs = await prisma.criticalDbJob.findMany({
      select: { clientId: true, jobName: true },
    });
    const criticalSet = new Set(criticalJobs.map(cj => `${cj.clientId}::${cj.jobName}`));

    const criticalPendingAlerts: { clientId: string; stalePendingCount: number; totalPending: number }[] = [];
    for (const [clientId, clientData] of Object.entries(result.clients || {})) {
      const groups = clientData?.groups || [];
      const criticalGroups = groups.filter(g => criticalSet.has(`${clientId}::${g.jobType || ''}`));
      const stalePendingCount = criticalGroups.reduce((sum, g) => sum + (g.stalePending || 0), 0);
      if (stalePendingCount <= 0) continue;

      const totalPending = criticalGroups.reduce((sum, g) => sum + (g.pending || 0), 0);
      criticalPendingAlerts.push({ clientId, stalePendingCount, totalPending });
    }

    logger.info(
      `[EscalationFilter] totalAlerts=${result.pendingAlerts.length}, criticalAlerts=${criticalPendingAlerts.length}, criticalJobs=${criticalJobs.length}`
    );

    const availableClients = await db2DirectService.getAvailableClients();
    const clientServerCodes = new Map(availableClients.map(c => [c.clientId, c.serverCode]));
    escalationService.processEscalations(criticalPendingAlerts, clientServerCodes).catch(err => {
      logger.error(`Escalation processing error: ${err.message}`);
    });
  } catch (error: any) {
    logger.error(`Batch status all-clients error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/db-clients/:clientId/test - Test DB2 connection
router.get('/db-clients/:clientId/test', async (req: Request, res: Response) => {
  try {
    const result = await db2DirectService.testConnection(req.params.clientId);
    if (!result.success) {
      return res.json({ success: false, error: result.error || 'Connection failed' });
    }
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`DB connection test error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/db-clients/:clientId/batch-status - Grouped batch status
router.get('/db-clients/:clientId/batch-status', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const days = parseInt(req.query.days as string, 10) || 2;
    const groups = await db2DirectService.getBatchStatusGrouped(clientId, days);
    db2DirectService.patchBatchSummaryClient(clientId, groups, days);
    res.json({ success: true, data: groups });

    // Process escalations for this client in the background, just like batch-status-all does.
    const criticalJobs = await prisma.criticalDbJob.findMany({
      where: { clientId },
      select: { jobName: true },
    });
    const criticalNames = new Set(criticalJobs.map(cj => cj.jobName));
    const criticalGroups = groups.filter(g => criticalNames.has(g.jobType || ''));
    const criticalStale = criticalGroups.reduce((sum, g) => sum + (g.stalePending || 0), 0);
    const allStale = groups.reduce((sum, g) => sum + (g.stalePending || 0), 0);

    if (criticalJobs.length > 0 && criticalStale > 0) {
      const totalPending = criticalGroups.reduce((sum, g) => sum + (g.pending || 0), 0);
      const availableClients = await db2DirectService.getAvailableClients();
      const clientServerCodes = new Map(availableClients.map(c => [c.clientId, c.serverCode]));
      escalationService.processEscalations(
        [{ clientId, stalePendingCount: criticalStale, totalPending }],
        clientServerCodes
      ).catch(err => {
        logger.error(`Per-client escalation processing error (${clientId}): ${err.message}`);
      });
    } else if (allStale <= 0) {
      // No stale pending left — resolve any open escalation for this client
      escalationService.resolveClientEscalation(clientId).catch(err => {
        logger.error(`Per-client escalation resolve error (${clientId}): ${err.message}`);
      });
    }
  } catch (error: any) {
    const msg = error.message || 'Failed to fetch batch status';
    const isConnectionError = /ERRORCODE=-4499|SQLSTATE=08001|connection reset|timed out|ECONNREFUSED|ETIMEDOUT/i.test(msg);
    logger.error(`Batch status error for ${clientId}: ${msg}`);
    res.status(isConnectionError ? 503 : 500).json({
      success: false,
      error: isConnectionError
        ? `Unable to connect to ${clientId} database. The server may be unreachable.`
        : msg,
      connectionError: isConnectionError,
    });
  }
});

// GET /api/db-monitor/db-clients/:clientId/batch-status/:jobType - Batch details for a job type
router.get('/db-clients/:clientId/batch-status/:jobType', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string, 10) || configService.getInt('engine.dbMonitorBatchDays');
    const planType = (req.query.planType as string) || '';
    const details = await db2DirectService.getBatchStatusDetails(
      req.params.clientId,
      req.params.jobType,
      planType,
      days
    );
    res.json({ success: true, data: details });
  } catch (error: any) {
    const msg = error.message || 'Failed to fetch batch details';
    const isConnectionError = /ERRORCODE=-4499|SQLSTATE=08001|connection reset|timed out|ECONNREFUSED|ETIMEDOUT/i.test(msg);
    logger.error(`Batch detail error for ${req.params.clientId}: ${msg}`);
    res.status(isConnectionError ? 503 : 500).json({
      success: false,
      error: isConnectionError
        ? `Unable to connect to ${req.params.clientId} database. The server may be unreachable.`
        : msg,
      connectionError: isConnectionError,
    });
  }
});

// ============================================================
// Existing SSH-based DB Monitor Endpoints
// ============================================================

// GET /api/db-monitor/status - Overview of all clients' DB2 configuration
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const clients = await dbMonitorService.getClientsDBStatus();
    const keeper = keeperService.getStatus();
    res.json({
      success: true,
      data: {
        keeper,
        clients,
        summary: {
          total: clients.length,
          configured: clients.filter(c => c.db2Configured).length,
          unconfigured: clients.filter(c => !c.db2Configured).length,
        },
      },
    });
  } catch (error: any) {
    logger.error(`DB Monitor status error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-monitor/:id/test - Test DB2 connection for a client
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const result = await dbMonitorService.testConnection(req.params.id);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`DB connection test error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/:id/jobs - Get job statuses from DB2
router.get('/:id/jobs', async (req: Request, res: Response) => {
  try {
    const results = await dbMonitorService.getJobStatuses(req.params.id);
    res.json({
      success: true,
      data: {
        jobs: results,
        total: results.length,
      },
    });
  } catch (error: any) {
    logger.error(`DB job status error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/:id/tables - Get table info from DB2
router.get('/:id/tables', async (req: Request, res: Response) => {
  try {
    const tables = await dbMonitorService.getTableInfo(req.params.id);
    res.json({ success: true, data: tables });
  } catch (error: any) {
    logger.error(`DB table info error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-monitor/:id/query - Execute a read-only query on client DB2
router.post('/:id/query', async (req: Request, res: Response) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ success: false, error: 'SQL query is required' });
    }

    // Safety: only allow SELECT statements
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT')) {
      return res.status(400).json({ success: false, error: 'Only SELECT queries are allowed' });
    }

    // Block dangerous keywords
    const blocked = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'];
    for (const kw of blocked) {
      if (trimmed.includes(kw)) {
        return res.status(400).json({ success: false, error: `${kw} statements are not allowed` });
      }
    }

    const result = await dbMonitorService.executeQuery(req.params.id, sql);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`DB query error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/keeper - Get Keeper integration status
router.get('/keeper', async (_req: Request, res: Response) => {
  try {
    const status = keeperService.getStatus();
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-monitor/keeper/clear-cache - Clear Keeper credential cache
router.post('/keeper/clear-cache', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.body || {};
    keeperService.clearCache(clientId);
    res.json({ success: true, message: clientId ? `Cache cleared for ${clientId}` : 'All cache cleared' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-monitor/pool - Connection pool statistics
router.get('/pool', async (_req: Request, res: Response) => {
  try {
    const stats = db2Pool.getStats();
    res.json({ success: true, data: stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
