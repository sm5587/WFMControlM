// ============================================================
// Clients & Sync API Routes
// ============================================================

import { Router, Request, Response } from 'express';
import { prisma } from '../database/prisma';
import { syncService } from '../services/sync-service';
import { db2DirectService } from '../services/db2-direct-service';
import { createServiceLogger } from '../utils/logger';
import { requirePermission } from '../middleware';
import { z } from 'zod';

const router = Router();
const logger = createServiceLogger('ClientsAPI');

// ---- CLIENTS ----

// POST /api/clients - Create a new client with optional app servers
const CreateClientSchema = z.object({
  clientId: z.string().min(1).max(20).regex(/^[A-Z0-9_-]+$/, 'Client ID must be uppercase alphanumeric'),
  name: z.string().min(1).max(120),
  cluster: z.string().default(''),
  timezone: z.string().default('America/Chicago'),
  isActive: z.boolean().default(true),
  whiteGlove: z.boolean().default(false),
  clientType: z.enum(['BAU', 'IMPL']).default('BAU'),
  // DB2 connection
  db2Host: z.string().optional(),
  db2Port: z.number().int().default(50000),
  db2Database: z.string().optional(),
  db2Schema: z.string().optional(),
  // App servers — one entry per environment row
  appServers: z.array(z.object({
    environment: z.enum(['Prod', 'PP']),
    serverNum: z.string().default('01'),
    dns: z.string().min(1),
    sshPort: z.number().int().default(22),
  })).default([]),
});

router.post('/', requirePermission('CLIENTS_CREATE', 'write'), async (req: Request, res: Response) => {
  try {
    const parsed = CreateClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.errors.map(e => e.message).join('; ') });
    }
    const { appServers, ...clientData } = parsed.data;

    // Reject duplicates
    const existing = await prisma.client.findUnique({ where: { clientId: clientData.clientId } });
    if (existing) {
      return res.status(409).json({ success: false, error: `Client ID "${clientData.clientId}" already exists` });
    }

    const client = await prisma.client.create({
      data: {
        ...clientData,
        tags: '[]',
        appServers: appServers.length > 0
          ? { create: appServers.map(s => ({ ...s, isActive: true })) }
          : undefined,
      },
      include: {
        appServers: true,
        _count: { select: { jobs: true } },
      },
    });

    logger.info(`Created new client: ${client.clientId} (${client.name}) with ${appServers.length} servers`);
    res.status(201).json({ success: true, data: client });
  } catch (error: any) {
    logger.error(`Error creating client: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/clients/detect-timezones - Detect timezone from appservers (admin only)
router.post('/detect-timezones', requirePermission('CLIENTS_DETECT_TZ', 'write'), async (req: Request, res: Response) => {
  try {
    const { cluster, clientIds, force } = req.body || {};
    const label = cluster ? `cluster ${cluster}` : clientIds?.length ? `${clientIds.length} clients` : 'all clients';
    logger.info(`Timezone detection triggered for ${label}${force ? ' (forced)' : ''}`);
    const result = await syncService.detectAllTimezones({ cluster, clientIds, force: !!force });
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Timezone detection failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/clients - List all clients with server counts
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, isActive } = req.query;

    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) {
      where.OR = [
        { clientId: { contains: search as string } },
        { name: { contains: search as string } },
      ];
    }

    const clients = await prisma.client.findMany({
      where,
      include: {
        _count: { select: { appServers: true, jobs: true, syncHistory: true } },
        appServers: {
          select: { environment: true, timezone: true, tzLastAttemptAt: true },
        },
      },
      orderBy: { clientId: 'asc' },
    });

    // Build DB2 connection map from connection files (keyed by serverCode ⟶ Prisma clientId).
    // Wrapped in its own try/catch so a missing/unreadable conn directory NEVER
    // prevents the Prisma client list from being returned.
    const dbMap = new Map<string, { host: string; port: string; database: string; fileClientId: string }>();
    try {
      const dbClients = await db2DirectService.getAvailableClients();
      for (const dc of dbClients) {
        const info = { host: dc.host, port: dc.port, database: dc.database, fileClientId: dc.clientId };
        dbMap.set(dc.serverCode.toUpperCase(), info);
        dbMap.set(dc.clientId.toUpperCase(), info);
      }
    } catch (db2Err: any) {
      logger.warn(`DB2 connection file scan failed (clients will load without DB2 info): ${db2Err.message}`);
    }

    // Enrich with environment counts
    const enriched = clients.map(client => {
      const ppCount = client.appServers.filter(s => s.environment === 'PP').length;
      const prodCount = client.appServers.filter(s => s.environment === 'Prod').length;
      // A client is active only if at least one Prod server has a detected timezone
      const tzSynced = client.appServers.some(s => s.environment === 'Prod' && !!s.timezone);
      const lastTzAttemptAt = client.appServers
        .filter(s => s.environment === 'Prod' && s.tzLastAttemptAt)
        .map(s => s.tzLastAttemptAt!)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const dbInfo = dbMap.get(client.clientId.toUpperCase()) || null;
      const { appServers, db2Password, ...rest } = client as any;
      return {
        ...rest,
        db2PasswordSet: !!db2Password,
        lastTzAttemptAt,
        serverCounts: { PP: ppCount, Prod: prodCount, total: ppCount + prodCount },
        db2Connection: dbInfo ? { host: dbInfo.host, port: dbInfo.port, database: dbInfo.database } : null,
      };
    });

    res.json({ success: true, data: enriched, total: enriched.length });
  } catch (error: any) {
    logger.error(`Error listing clients: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/clients/:id - Get client detail with servers
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        appServers: { orderBy: [{ environment: 'asc' }, { serverNum: 'asc' }] },
        _count: { select: { jobs: true, syncHistory: true } },
      },
    });

    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const { db2Password, ...safeClient } = client as any;
    res.json({ success: true, data: { ...safeClient, db2PasswordSet: !!db2Password } });
  } catch (error: any) {
    logger.error(`Error fetching client: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/clients/:id - Update client details (admin only)
router.patch('/:id', requirePermission('CLIENTS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const boolKeys = ['whiteGlove', 'isActive'];
    const numKeys  = ['db2Port'];
    const allowed  = ['name', 'timezone', 'clientType', 'cluster',
                      'whiteGlove', 'isActive', 'db2Host', 'db2Port', 'db2Database', 'db2Schema',
                      'db2Username', 'db2Password'];
    const data: Record<string, any> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (boolKeys.includes(key)) data[key] = Boolean(req.body[key]);
        else if (numKeys.includes(key)) data[key] = Number(req.body[key]);
        else data[key] = req.body[key];
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const client = await prisma.client.update({
      where: { id: req.params.id },
      data,
    });

    logger.info(`Updated client ${client.clientId}: ${JSON.stringify(data)}`);
    res.json({ success: true, data: client });
  } catch (error: any) {
    logger.error(`Error updating client: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/clients/:id/jobs - Get jobs for a specific client
router.get('/:id/jobs', async (req: Request, res: Response) => {
  try {
    const { page = '1', pageSize = '50', sourceSystem } = req.query;

    const where: any = { clientId: req.params.id, deleteStatus: null };
    if (sourceSystem) where.sourceSystem = sourceSystem;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (parseInt(page as string) - 1) * parseInt(pageSize as string),
        take: parseInt(pageSize as string),
      }),
      prisma.job.count({ where }),
    ]);

    res.json({
      success: true,
      data: jobs,
      pagination: {
        page: parseInt(page as string),
        pageSize: parseInt(pageSize as string),
        total,
        totalPages: Math.ceil(total / parseInt(pageSize as string)),
      },
    });
  } catch (error: any) {
    logger.error(`Error fetching client jobs: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/clients/:id/servers - Get servers for a client
router.get('/:id/servers', async (req: Request, res: Response) => {
  try {
    const { environment } = req.query;

    const where: any = { clientId: req.params.id };
    if (environment) where.environment = environment;

    const servers = await prisma.appServer.findMany({
      where,
      orderBy: [{ environment: 'asc' }, { serverNum: 'asc' }],
    });

    res.json({ success: true, data: servers });
  } catch (error: any) {
    logger.error(`Error fetching servers: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/clients/:id/servers — add a new app server
router.post('/:id/servers', requirePermission('CLIENTS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const { environment, serverNum, dns, sshPort } = req.body;
    if (!dns) return res.status(400).json({ success: false, error: 'dns is required' });
    const server = await prisma.appServer.create({
      data: {
        clientId: req.params.id,
        environment: environment || 'Prod',
        serverNum: serverNum || '01',
        dns,
        sshPort: sshPort ? Number(sshPort) : 22,
        isActive: true,
      },
    });
    res.status(201).json({ success: true, data: server });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/clients/:id/servers/:serverId — update server fields
router.patch('/:id/servers/:serverId', requirePermission('CLIENTS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const { dns, sshPort, isActive, serverNum, environment } = req.body;
    const data: any = {};
    if (dns       !== undefined) data.dns         = dns;
    if (sshPort   !== undefined) data.sshPort     = Number(sshPort);
    if (isActive  !== undefined) data.isActive    = Boolean(isActive);
    if (serverNum !== undefined) data.serverNum   = serverNum;
    if (environment !== undefined) data.environment = environment;
    const server = await prisma.appServer.update({ where: { id: req.params.serverId }, data });
    res.json({ success: true, data: server });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/clients/:id/servers/:serverId — remove a server
router.delete('/:id/servers/:serverId', requirePermission('CLIENTS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    await prisma.appServer.delete({ where: { id: req.params.serverId } });
    res.json({ success: true, message: 'Server removed' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- SYNC ----

// POST /api/clients/:id/sync - Trigger sync for a single client
router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const { syncType = 'FULL_SYNC', force } = req.body;
    const clientId = req.params.id;

    logger.info(`Sync triggered for client ${clientId}, type: ${syncType}${force ? ' (forced)' : ''}`);

    let results;
    if (syncType === 'CRON_SYNC') {
      results = [await syncService.syncClientCrons(clientId, !!force)];
    } else {
      results = await syncService.syncClient(clientId, !!force);
    }

    res.json({ success: true, data: results });
  } catch (error: any) {
    logger.error(`Sync failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/clients/sync-all - Trigger sync for ALL active clients (admin only)
router.post('/sync-all', requirePermission('CLIENTS_SYNC', 'write'), async (req: Request, res: Response) => {
  try {
    const { force } = req.body || {};
    logger.info(`Full sync triggered for all clients${force ? ' (forced)' : ''}`);
    const result = await syncService.syncAllClients(!!force);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Sync-all failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/clients/sync-all-crons - Sync cron jobs from all active clients (admin only)
router.post('/sync-all-crons', requirePermission('CLIENTS_SYNC', 'write'), async (req: Request, res: Response) => {
  try {
    const { force } = req.body || {};
    logger.info(`Cron sync triggered for all clients${force ? ' (forced)' : ''}`);
    const result = await syncService.syncAllCrons(!!force);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Sync-all-crons failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/clients/:id/sync-history - Get sync history for a client
router.get('/:id/sync-history', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const history = await syncService.getSyncHistory(req.params.id, limit);
    res.json({ success: true, data: history });
  } catch (error: any) {
    logger.error(`Error fetching sync history: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/clients/:id/check-logs - Check log files for a client's jobs (admin only)
router.post('/:id/check-logs', requirePermission('CLIENTS_SYNC', 'write'), async (req: Request, res: Response) => {
  try {
    const clientId = req.params.id;
    logger.info(`Log check triggered for client ${clientId}`);
    const results = await syncService.checkClientLogs(clientId);
    const failures = results.filter(r => r.hasFailure || !r.triggered);
    res.json({
      success: true,
      data: {
        totalChecked: results.length,
        triggered: results.filter(r => r.triggered).length,
        failures: failures.length,
        results,
      },
    });
  } catch (error: any) {
    logger.error(`Log check failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/clients/bulk-update-passwords - Update DB password for all active clients that have DB2 configured
router.post('/bulk-update-passwords', requirePermission('CLIENTS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    if (!password || typeof password !== 'string' || password.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Password is required' });
    }

    const clients = await prisma.client.findMany({
      where: {
        isActive: true,
        db2Host: { not: null },
        db2Database: { not: null },
      },
      select: { id: true, clientId: true },
    });

    let updated = 0;
    let errors: string[] = [];

    for (const client of clients) {
      try {
        await prisma.client.update({
          where: { id: client.id },
          data: { db2Password: password.trim() },
        });
        updated++;
      } catch (err: any) {
        errors.push(`${client.clientId}: ${err.message}`);
      }
    }

    logger.info(`Bulk password update complete: ${updated}/${clients.length} updated, ${errors.length} errors`);
    res.json({
      success: true,
      data: { total: clients.length, updated, errors: errors.length > 0 ? errors : undefined },
    });
  } catch (error: any) {
    logger.error(`Bulk password update failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
