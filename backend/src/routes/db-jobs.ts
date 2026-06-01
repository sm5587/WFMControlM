// ============================================================
// DB Jobs Routes
// Endpoints for RFX_QUEUE monitoring and critical job marking
// Jobs are cached daily in SQLite; refreshed on-demand per client.
// ============================================================

import { Router, Request, Response } from 'express';
import { db2DirectService } from '../services/db2-direct-service';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';

const router = Router();
const logger = createServiceLogger('DBJobsAPI');

// ============================================================
// Helpers
// ============================================================

/** Check whether a date is today (same calendar day). */
function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/** Build enriched client info list (name, cluster, whiteGlove). */
async function getClientInfoList() {
  const dbClients = await prisma.client.findMany({
    select: { clientId: true, name: true, cluster: true, whiteGlove: true },
  });
  const nameMap = new Map(
    dbClients.map(c => [c.clientId.toUpperCase(), { name: c.name, cluster: c.cluster, whiteGlove: c.whiteGlove }])
  );

  const availableClients = await db2DirectService.getAvailableClients();
  const serverCodeAliases: Record<string, string> = { 'HMG': 'HNMG' };

  return availableClients.map(c => {
    const resolvedCode = serverCodeAliases[c.serverCode.toUpperCase()] || c.serverCode.toUpperCase();
    const match = nameMap.get(resolvedCode) || nameMap.get(c.serverCode.toUpperCase()) || nameMap.get(c.clientId.toUpperCase());
    return {
      clientId: c.clientId,
      serverCode: c.serverCode,
      name: match?.name || c.clientId,
      cluster: match?.cluster || '',
      whiteGlove: match?.whiteGlove || false,
    };
  });
}

/** Fetch jobs from DB2 for a single client and cache them. */
async function fetchAndCacheClient(clientId: string): Promise<{ jobs: any[]; error?: string }> {
  try {
    const result = await db2DirectService.getQueueJobs(clientId);
    if (result.success && result.rows) {
      const jobs = result.rows.map(row => {
        const mapped: Record<string, any> = {};
        for (const [key, val] of Object.entries(row)) {
          const camel = key.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
          mapped[camel] = typeof val === 'string' ? val.trim() : val;
        }
        return mapped;
      });

      await prisma.cachedQueueJob.upsert({
        where: { clientId },
        create: { clientId, jobData: JSON.stringify(jobs), jobCount: jobs.length, fetchedAt: new Date() },
        update: { jobData: JSON.stringify(jobs), jobCount: jobs.length, error: null, fetchedAt: new Date() },
      });

      return { jobs };
    } else {
      const error = result.error || 'Query failed';
      await prisma.cachedQueueJob.upsert({
        where: { clientId },
        create: { clientId, jobData: '[]', jobCount: 0, error, fetchedAt: new Date() },
        update: { jobData: '[]', jobCount: 0, error, fetchedAt: new Date() },
      });
      return { jobs: [], error };
    }
  } catch (err: any) {
    await prisma.cachedQueueJob.upsert({
      where: { clientId },
      create: { clientId, jobData: '[]', jobCount: 0, error: err.message, fetchedAt: new Date() },
      update: { jobData: '[]', jobCount: 0, error: err.message, fetchedAt: new Date() },
    });
    return { jobs: [], error: err.message };
  }
}

// ============================================================
// Routes
// ============================================================

// GET /api/db-jobs/queue-all
// FAST: always returns clientInfo + whatever cache exists (even stale).
// Never triggers a bulk DB2 fetch. Frontend shows clients immediately.
router.get('/queue-all', async (req: Request, res: Response) => {
  try {
    // Always return client list instantly (reads local connection files + Prisma)
    const clientInfo = await getClientInfoList();

    // Return whatever cache exists — fresh or stale
    const cached = await prisma.cachedQueueJob.findMany();
    const criticalJobs = await prisma.criticalDbJob.findMany();
    const criticalSet = new Set(criticalJobs.map(cj => `${cj.clientId}::${cj.jobName}`));

    const clients: Record<string, any> = {};
    const clientFetchTimes: Record<string, string> = {};
    let latestFetchedAt: Date | null = null;

    for (const c of cached) {
      const jobs = JSON.parse(c.jobData).map((job: any) => ({
        ...job,
        isCritical: criticalSet.has(`${c.clientId}::${job.jobType || ''}`),
      }));
      clients[c.clientId] = {
        jobs,
        error: c.error || undefined,
      };
      clientFetchTimes[c.clientId] = c.fetchedAt.toISOString();
      if (!latestFetchedAt || c.fetchedAt > latestFetchedAt) latestFetchedAt = c.fetchedAt;
    }

    // Determine freshness
    const hasFreshCache = cached.length > 0 && cached.every(c => isToday(c.fetchedAt));

    res.json({
      success: true,
      data: {
        clients,
        clientInfo,
        fetchedAt: latestFetchedAt ? latestFetchedAt.toISOString() : null,
        cached: hasFreshCache,
        stale: cached.length > 0 && !hasFreshCache,
        empty: cached.length === 0,
        clientFetchTimes,
      },
    });
  } catch (error: any) {
    logger.error(`Queue all-clients error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-jobs/fetch-all
// SLOW: fetches queue jobs from ALL DB2 clients, caches results, returns data.
// Called explicitly by user clicking "Fetch All from DB2".
router.post('/fetch-all', async (_req: Request, res: Response) => {
  try {
    logger.info('Bulk DB2 fetch triggered — fetching queue jobs from all clients');
    const result = await db2DirectService.getAllQueueJobs();

    // Cache each client's result
    for (const [clientId, data] of Object.entries(result.clients)) {
      await prisma.cachedQueueJob.upsert({
        where: { clientId },
        create: {
          clientId,
          jobData: JSON.stringify(data.jobs),
          jobCount: data.jobs.length,
          error: data.error || null,
          fetchedAt: new Date(),
        },
        update: {
          jobData: JSON.stringify(data.jobs),
          jobCount: data.jobs.length,
          error: data.error || null,
          fetchedAt: new Date(),
        },
      });
    }

    // Return enriched data
    const criticalJobs = await prisma.criticalDbJob.findMany();
    const criticalSet = new Set(criticalJobs.map(cj => `${cj.clientId}::${cj.jobName}`));

    const enrichedClients: Record<string, any> = {};
    for (const [clientId, data] of Object.entries(result.clients)) {
      enrichedClients[clientId] = {
        ...data,
        jobs: data.jobs.map((job: any) => ({
          ...job,
          isCritical: criticalSet.has(`${clientId}::${job.jobType || ''}`),
        })),
      };
    }

    const cacheInfo = await prisma.cachedQueueJob.findMany({
      select: { clientId: true, fetchedAt: true },
    });
    const clientFetchTimes: Record<string, string> = {};
    for (const c of cacheInfo) {
      clientFetchTimes[c.clientId] = c.fetchedAt.toISOString();
    }

    const clientInfo = await getClientInfoList();

    logger.info(`Bulk fetch complete — ${Object.keys(result.clients).length} clients cached`);
    res.json({
      success: true,
      data: {
        clients: enrichedClients,
        clientInfo,
        fetchedAt: result.fetchedAt,
        cached: true,
        stale: false,
        empty: false,
        clientFetchTimes,
      },
    });
  } catch (error: any) {
    logger.error(`Bulk fetch error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-jobs/:clientId/refresh
// Force-refresh a single client from DB2, bypassing the daily cache.
router.post('/:clientId/refresh', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    logger.info(`On-demand refresh for client ${clientId}`);
    const result = await fetchAndCacheClient(clientId);

    // Enrich with critical flags
    const criticalJobs = await prisma.criticalDbJob.findMany({
      where: { clientId },
    });
    const criticalSet = new Set(criticalJobs.map(cj => cj.jobName));

    const jobs = result.jobs.map((job: any) => ({
      ...job,
      isCritical: criticalSet.has(job.jobType || ''),
    }));

    res.json({
      success: true,
      data: {
        jobs,
        error: result.error,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    logger.error(`Refresh error for ${req.params.clientId}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-jobs/:clientId/queue - Fetch queue jobs for a specific client (from cache or DB2)
router.get('/:clientId/queue', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    // Check cache first
    const cached = await prisma.cachedQueueJob.findUnique({ where: { clientId } });
    let jobs: any[];
    let fetchedAt: string;

    if (cached && isToday(cached.fetchedAt)) {
      jobs = JSON.parse(cached.jobData);
      fetchedAt = cached.fetchedAt.toISOString();
    } else {
      // Fetch and cache
      const result = await fetchAndCacheClient(clientId);
      if (result.error) {
        return res.status(500).json({ success: false, error: result.error });
      }
      jobs = result.jobs;
      fetchedAt = new Date().toISOString();
    }

    // Enrich with critical flags
    const criticalJobs = await prisma.criticalDbJob.findMany({
      where: { clientId },
    });
    const criticalSet = new Set(criticalJobs.map(cj => cj.jobName));

    const enriched = jobs.map((job: any) => ({
      ...job,
      isCritical: criticalSet.has(job.jobType || ''),
    }));

    res.json({ success: true, data: enriched, fetchedAt });
  } catch (error: any) {
    logger.error(`Queue jobs error for ${req.params.clientId}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-jobs/critical/batch - Mark multiple jobs as critical in one call
router.post('/critical/batch', async (req: Request, res: Response) => {
  try {
    const { jobs } = req.body;
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ success: false, error: 'jobs array is required' });
    }

    const normalized = jobs
      .map((j: any) => ({
        clientId: String(j?.clientId ?? '').replace(/[^a-zA-Z0-9_]/g, ''),
        jobName: String(j?.jobName ?? '').substring(0, 200),
      }))
      .filter((j: { clientId: string; jobName: string }) => j.clientId && j.jobName);

    if (normalized.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid jobs to mark' });
    }

    const uniqueRecords = Array.from(
      new Map(normalized.map((j: { clientId: string; jobName: string }) => [`${j.clientId}::${j.jobName}`, j])).values()
    );

    await prisma.$transaction(
      uniqueRecords.map((record: { clientId: string; jobName: string }) =>
        prisma.criticalDbJob.upsert({
          where: { clientId_jobName: { clientId: record.clientId, jobName: record.jobName } },
          update: {},
          create: record,
        })
      )
    );

    logger.info(
      `Batch-marked critical jobs: requested=${jobs.length}, valid=${normalized.length}, unique=${uniqueRecords.length}`
    );
    res.json({ success: true, data: { requested: jobs.length, marked: uniqueRecords.length } });
  } catch (error: any) {
    logger.error(`Batch mark critical error: ${error?.stack || error?.message || String(error)}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/db-jobs/critical - Mark a job as critical
router.post('/critical', async (req: Request, res: Response) => {
  try {
    const { clientId, jobName } = req.body;
    if (!clientId || !jobName) {
      return res.status(400).json({ success: false, error: 'clientId and jobName are required' });
    }

    const safeClientId = String(clientId).replace(/[^a-zA-Z0-9_]/g, '');
    const safeJobName = String(jobName).substring(0, 200);

    const existing = await prisma.criticalDbJob.findUnique({
      where: { clientId_jobName: { clientId: safeClientId, jobName: safeJobName } },
    });

    if (existing) {
      return res.json({ success: true, data: existing, message: 'Already marked as critical' });
    }

    const criticalJob = await prisma.criticalDbJob.create({
      data: { clientId: safeClientId, jobName: safeJobName },
    });

    logger.info(`Marked job as critical: ${safeClientId}/${safeJobName}`);
    res.json({ success: true, data: criticalJob });
  } catch (error: any) {
    logger.error(`Mark critical error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/db-jobs/critical - Unmark a job as critical
router.delete('/critical', async (req: Request, res: Response) => {
  try {
    const { clientId, jobName } = req.body;
    if (!clientId || !jobName) {
      return res.status(400).json({ success: false, error: 'clientId and jobName are required' });
    }

    await prisma.criticalDbJob.deleteMany({
      where: { clientId: String(clientId), jobName: String(jobName) },
    });

    logger.info(`Unmarked critical job: ${clientId}/${jobName}`);
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Unmark critical error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/db-jobs/critical - List all critical jobs
router.get('/critical', async (_req: Request, res: Response) => {
  try {
    const criticalJobs = await prisma.criticalDbJob.findMany({
      orderBy: [{ clientId: 'asc' }, { jobName: 'asc' }],
    });
    res.json({ success: true, data: criticalJobs });
  } catch (error: any) {
    logger.error(`List critical jobs error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
