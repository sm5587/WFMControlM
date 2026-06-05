// ============================================================
// Unprocessed Punch Routes
// GET /api/unprocessed-punch/all
//   → count of TA_UNPROC_PUNCH PROCESS_FLAG='N' last 2 days, all RTA clients in parallel
// GET /api/unprocessed-punch/:clientId
//   → same query for a single client
// ============================================================

import { Router, Request, Response } from 'express';
import { unprocessedPunchService } from '../services/unprocessed-punch-service';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { configService } from '../services/config-service';

const router = Router();

// Reduced from 5 to 2 to prevent connection pool saturation
const CONCURRENCY = 3;

// ---- Server-side cache (mirrors batchSummaryCache pattern) ----
interface PunchAllCache {
  data: any[];
  fetchedAt: string;
  updatedAtMs: number;
}
let punchAllCache: PunchAllCache | null = null;
// Track in-flight fetch so concurrent requests don't each spawn 46 JVM processes
let punchAllInFlight: Promise<PunchAllCache> | null = null;

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
router.get('/all', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const cacheTtlMs = configService.getInt('polling.punchCacheTtlMins') * 60 * 1000;
    const isFresh = !forceRefresh && punchAllCache && (Date.now() - punchAllCache.updatedAtMs) < cacheTtlMs;

    if (isFresh) {
      logger.info(`UnprocessedPunch /all: cache hit (age ${Math.round((Date.now() - punchAllCache!.updatedAtMs) / 1000)}s)`);
      return res.json({ success: true, data: punchAllCache!.data, fetchedAt: punchAllCache!.fetchedAt, fromCache: true });
    }

    // If a fetch is already running, wait for it instead of spawning duplicates
    if (!punchAllInFlight) {
      punchAllInFlight = fetchAllPunchData().finally(() => { punchAllInFlight = null; });
    }

    const result = await punchAllInFlight;
    return res.json({ success: true, data: result.data, fetchedAt: result.fetchedAt });
  } catch (error: any) {
    logger.error(`Unprocessed punch all-clients error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function fetchAllPunchData(): Promise<PunchAllCache> {
  const rtaClients = await prisma.client.findMany({
    where: { payrollEnabled: true, isActive: true },
    select: { clientId: true, name: true, cluster: true },
    orderBy: [{ cluster: 'asc' }, { clientId: 'asc' }],
  });

  if (rtaClients.length === 0) {
    const entry: PunchAllCache = { data: [], fetchedAt: new Date().toISOString(), updatedAtMs: Date.now() };
    punchAllCache = entry;
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
  punchAllCache = entry;
  return entry;
}

// GET /api/unprocessed-punch/clients — fast: just the client list from Prisma (no DB2)
router.get('/clients', async (_req: Request, res: Response) => {
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
router.get('/stream', async (req: Request, res: Response) => {
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

// GET /api/unprocessed-punch/:clientId — query a specific client
router.get('/:clientId', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const punch = await unprocessedPunchService.getPunchCount(clientId);
    res.json({ success: true, data: punch });
  } catch (error: any) {
    logger.error(`Unprocessed punch ${req.params.clientId} error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
