// ============================================================
// Unprocessed Punch Routes
// GET /api/unprocessed-punch/all
//   → count of TA_UNPROC_PUNCH PROCESS_FLAG='N' last 2 days, all RTA clients in parallel
// GET /api/unprocessed-punch/:clientId
//   → same query for a single client
// ============================================================

import { Router, Request, Response } from 'express';
import {
  unprocessedPunchService,
  type PunchAllCache,
} from '../services/unprocessed-punch-service';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { configService } from '../services/config-service';
import { hasPermission, requirePermission } from '../middleware';

const router = Router();

const REFRESH_SCOPE_PERMISSION = {
  all: 'UNPROC_PUNCH_REFRESH_ALL',
  high: 'UNPROC_PUNCH_REFRESH_HIGH',
  row: 'UNPROC_PUNCH_REFRESH_ROW',
} as const;

type PunchRefreshScope = keyof typeof REFRESH_SCOPE_PERMISSION;

function parseRefreshScope(raw: unknown): PunchRefreshScope {
  if (raw === 'all' || raw === 'high' || raw === 'row') return raw;
  return 'row';
}

export class PunchSyncDisabledError extends Error {
  constructor() {
    super('Punch sync is disabled (engine.punchSyncEnabled=false). Re-enable in Admin → Config.');
    this.name = 'PunchSyncDisabledError';
  }
}

function assertPunchSyncEnabled(): void {
  if (!configService.isPunchSyncEnabled()) {
    throw new PunchSyncDisabledError();
  }
}

function handlePunchSyncError(res: Response, error: unknown): boolean {
  if (error instanceof PunchSyncDisabledError || (error as Error)?.name === 'PunchSyncDisabledError') {
    res.status(503).json({ success: false, error: (error as Error).message });
    return true;
  }
  return false;
}

// Reduced from 5 to 2 to prevent connection pool saturation
const CONCURRENCY = 3;

// Track in-flight fetch so concurrent requests don't each spawn 46 JVM processes
let punchAllInFlight: Promise<PunchAllCache> | null = null;

function getPunchAllCache(): PunchAllCache | null {
  return unprocessedPunchService.getPunchAllCache();
}

function setPunchAllCache(entry: PunchAllCache): void {
  unprocessedPunchService.setPunchAllCache(entry);
}

// Helper: process items with bounded concurrency
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  const processNext = async (): Promise<void> => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await processor(items[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => processNext())
  );

  return results;
}

// GET /api/unprocessed-punch/all — query all RTA-enabled clients
router.get('/all', requirePermission('UNPROC_PUNCH_VIEW', 'read'), async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const cacheTtlMs = configService.getInt('polling.punchCacheTtlMins') * 60 * 1000;
    const cached = getPunchAllCache();
    const isFresh = !forceRefresh && cached && (Date.now() - cached.updatedAtMs) < cacheTtlMs;

    if (isFresh) {
      logger.info(`UnprocessedPunch /all: cache hit (age ${Math.round((Date.now() - cached!.updatedAtMs) / 1000)}s)`);
      return res.json({ success: true, data: cached!.data, fetchedAt: cached!.fetchedAt, fromCache: true });
    }

    const user = (req as any).user;
    const canRefreshAll = hasPermission(user, 'UNPROC_PUNCH_REFRESH_ALL', 'write');
    if (!canRefreshAll) {
      if (getPunchAllCache()) {
        const hit = getPunchAllCache()!;
        return res.json({
          success: true,
          data: hit.data,
          fetchedAt: hit.fetchedAt,
          fromCache: true,
          stale: true,
        });
      }
      return res.status(403).json({
        success: false,
        error: 'Access denied. Required permission: UNPROC_PUNCH_REFRESH_ALL (write)',
      });
    }

    if (!configService.isPunchSyncEnabled()) {
      if (getPunchAllCache()) {
        const hit = getPunchAllCache()!;
        return res.json({
          success: true,
          data: hit.data,
          fetchedAt: hit.fetchedAt,
          fromCache: true,
          stale: true,
        });
      }
      return res.status(503).json({
        success: false,
        error: 'Punch sync is disabled and no cached data is available.',
      });
    }

    // If a fetch is already running, wait for it instead of spawning duplicates
    if (!punchAllInFlight) {
      punchAllInFlight = fetchAllPunchData().finally(() => { punchAllInFlight = null; });
    }

    const result = await punchAllInFlight;
    return res.json({ success: true, data: result.data, fetchedAt: result.fetchedAt });
  } catch (error: any) {
    if (handlePunchSyncError(res, error)) return;
    logger.error(`Unprocessed punch all-clients error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function fetchAllPunchData(): Promise<PunchAllCache> {
  assertPunchSyncEnabled();
  const rtaClients = await prisma.client.findMany({
    where: { payrollEnabled: true, isActive: true },
    select: { clientId: true, name: true, cluster: true },
    orderBy: [{ cluster: 'asc' }, { clientId: 'asc' }],
  });

  if (rtaClients.length === 0) {
    const entry: PunchAllCache = { data: [], fetchedAt: new Date().toISOString(), updatedAtMs: Date.now() };
    setPunchAllCache(entry);
    return entry;
  }

  const results = await processWithConcurrency(rtaClients, CONCURRENCY, async (c) => {
    try {
      const punch = await unprocessedPunchService.getPunchCount(c.clientId);
      return {
        clientId: c.clientId,
        name: c.name,
        cluster: c.cluster || '',
        punchCount: punch.punchCount,
        lastUpdateTime: punch.lastUpdateTime,
        dbCurrentTime: punch.dbCurrentTime,
        executionTimeMs: punch.executionTimeMs,
        error: null,
      };
    } catch (err: any) {
      logger.warn(`UnprocessedPunch all: ${c.clientId} → ${err.message}`);
      return {
        clientId: c.clientId,
        name: c.name,
        cluster: c.cluster || '',
        punchCount: null,
        lastUpdateTime: null,
        dbCurrentTime: null,
        executionTimeMs: null,
        error: err.message,
      };
    }
  });

  const entry: PunchAllCache = { data: results, fetchedAt: new Date().toISOString(), updatedAtMs: Date.now() };
  setPunchAllCache(entry);
  return entry;
}

// GET /api/unprocessed-punch/clients — fast: just the client list from Prisma (no DB2)
router.get('/clients', requirePermission('UNPROC_PUNCH_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const clients = await prisma.client.findMany({
      where: { payrollEnabled: true, isActive: true },
      select: { clientId: true, name: true, cluster: true },
      orderBy: [{ cluster: 'asc' }, { clientId: 'asc' }],
    });
    res.json({
      success: true,
      data: clients.map(c => ({ clientId: c.clientId, name: c.name, cluster: c.cluster || '' }))
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/unprocessed-punch/stream — SSE: push each client result as it completes
router.get('/stream', requirePermission('UNPROC_PUNCH_REFRESH_ALL', 'write'), async (req: Request, res: Response) => {
  req.socket?.setNoDelay(true);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload: object) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      (res as any).flush?.();
    }
  };

  try {
    assertPunchSyncEnabled();
    const rtaClients = await prisma.client.findMany({
      where: { payrollEnabled: true, isActive: true },
      select: { clientId: true, name: true, cluster: true },
      orderBy: [{ cluster: 'asc' }, { clientId: 'asc' }],
    });

    send({ type: 'init', clients: rtaClients.map(c => ({ clientId: c.clientId, name: c.name, cluster: c.cluster || '' })) });

    await processWithConcurrency(rtaClients, CONCURRENCY, async (c) => {
      try {
        const punch = await unprocessedPunchService.getPunchCount(c.clientId);
        send({
          type: 'row',
          clientId: c.clientId,
          name: c.name,
          cluster: c.cluster || '',
          punchCount: punch.punchCount,
          lastUpdateTime: punch.lastUpdateTime,
          dbCurrentTime: punch.dbCurrentTime,
          executionTimeMs: punch.executionTimeMs,
          error: null,
        });
      } catch (err: any) {
        logger.warn(`Punch stream ${c.clientId} error: ${err.message}`);
        send({
          type: 'row',
          clientId: c.clientId,
          name: c.name,
          cluster: c.cluster || '',
          punchCount: null,
          error: err.message,
        });
      }
    });

    send({ type: 'complete' });
    res.end();
  } catch (error: any) {
    logger.error(`Punch stream error: ${error.message}`);
    send({ type: 'error', message: error.message });
    res.end();
  }
});

// GET /api/unprocessed-punch/:clientId — query a specific client (?scope=all|high|row)
router.get('/:clientId', (req: Request, res: Response, next) => {
  const scope = parseRefreshScope(req.query.scope);
  return requirePermission(REFRESH_SCOPE_PERMISSION[scope], 'write')(req, res, next);
}, async (req: Request, res: Response) => {
  try {
    assertPunchSyncEnabled();
    const { clientId } = req.params;
    const punch = await unprocessedPunchService.getPunchCount(clientId);
    res.json({ success: true, data: punch });
  } catch (error: any) {
    if (handlePunchSyncError(res, error)) return;
    logger.error(`Unprocessed punch ${req.params.clientId} error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
