import { prisma } from '../database/prisma';
import {
  localToUtc,
  utcToDisplay,
  fmtInIanaTz,
  getFireTimesUtcInWindow,
  hasFireLaterToday,
} from '../utils/outage-cron-utils';

export interface OutageImpactRequest {
  clusters?: string[];
  clientIds?: string[];
  clientDbIds?: string[];
  startLocal: string;
  endLocal: string;
  inputTimezone: string;
  noRetryToday?: boolean;
}

export interface OutageImpactJob {
  jobId: string;
  clientId: string;
  clientName?: string;
  cluster: string;
  name: string;
  cronExpression: string;
  serverTimezone: string;
  command?: string;
  fireTimesUtc: string[];
  fireTimesDisplay: string[];
  fireTimesServer: string[];
  fireCount: number;
  willRetryToday: boolean;
}

export interface OutageImpactResult {
  rows: OutageImpactJob[];
  summary: {
    uniqueJobs: number;
    totalFireTimes: number;
    uniqueClients: number;
    excludedRetryToday: number;
    parseErrors: number;
  };
  window: {
    startLocal: string;
    endLocal: string;
    inputTimezone: string;
    startUtc: string;
    endUtc: string;
  };
  plannedTotal?: number;
  cancelled?: boolean;
}

export type OutageImpactStreamEvent =
  | {
      type: 'start';
      plannedTotal: number;
      window: OutageImpactResult['window'];
    }
  | {
      type: 'progress';
      completed: number;
      plannedTotal: number;
      clientId: string;
      rows: OutageImpactJob[];
      impactedJobs: number;
    }
  | {
      type: 'complete';
      data: OutageImpactResult;
    };

export interface OutageImpactOptions {
  onProgress?: (event: OutageImpactStreamEvent) => void;
  isCancelled?: () => boolean;
}

function buildOutageImpactResult(
  rows: OutageImpactJob[],
  window: OutageImpactResult['window'],
  excludedRetryToday: number,
  parseErrors: number,
  plannedTotal: number,
  cancelled = false,
): OutageImpactResult {
  return {
    rows,
    summary: {
      uniqueJobs: rows.length,
      totalFireTimes: rows.reduce((n, r) => n + r.fireCount, 0),
      uniqueClients: new Set(rows.map(r => r.clientId)).size,
      excludedRetryToday,
      parseErrors,
    },
    window,
    plannedTotal,
    cancelled: cancelled || undefined,
  };
}

function evaluateJob(
  job: {
    id: string;
    name: string;
    cronExpression: string | null;
    serverTimezone: string | null;
    timezone: string | null;
    command: string | null;
    client: { clientId: string; name: string; cluster: string | null; timezone: string | null } | null;
  },
  windowStartUtc: Date,
  windowEndUtc: Date,
  inputTimezone: string,
  startLocal: string,
  noRetryToday: boolean,
): { row?: OutageImpactJob; parseError?: boolean; excludedRetry?: boolean } {
  if (!job.cronExpression || !job.client) return {};

  const serverTz = job.serverTimezone || job.client.timezone || job.timezone || 'UTC';
  const { fireTimesUtc, error } = getFireTimesUtcInWindow(
    job.cronExpression,
    serverTz,
    windowStartUtc,
    windowEndUtc,
  );
  if (error) return { parseError: true };
  if (fireTimesUtc.length === 0) return {};

  const willRetry = hasFireLaterToday(
    job.cronExpression,
    serverTz,
    windowEndUtc,
    inputTimezone,
    startLocal,
  );

  if (noRetryToday && willRetry) return { excludedRetry: true };

  return {
    row: {
      jobId: job.id,
      clientId: job.client.clientId,
      clientName: job.client.name,
      cluster: job.client.cluster ?? '',
      name: job.name,
      cronExpression: job.cronExpression,
      serverTimezone: serverTz,
      command: job.command ?? undefined,
      fireTimesUtc: fireTimesUtc.map(d => d.toISOString()),
      fireTimesDisplay: fireTimesUtc.map(d => utcToDisplay(d, inputTimezone)),
      fireTimesServer: fireTimesUtc.map(d => fmtInIanaTz(d, serverTz)),
      fireCount: fireTimesUtc.length,
      willRetryToday: willRetry,
    },
  };
}

export async function computeOutageImpact(
  input: OutageImpactRequest,
  options: OutageImpactOptions = {},
): Promise<OutageImpactResult> {
  const { onProgress, isCancelled } = options;
  const windowStartUtc = localToUtc(input.startLocal, input.inputTimezone);
  const windowEndUtc = localToUtc(input.endLocal, input.inputTimezone);
  if (windowEndUtc <= windowStartUtc) {
    throw new Error('Outage end must be after start');
  }

  const window: OutageImpactResult['window'] = {
    startLocal: input.startLocal,
    endLocal: input.endLocal,
    inputTimezone: input.inputTimezone,
    startUtc: windowStartUtc.toISOString(),
    endUtc: windowEndUtc.toISOString(),
  };

  const clusters = (input.clusters ?? [])
    .filter(Boolean)
    .map(cl => (/^CL/i.test(cl.trim()) ? cl.trim().toUpperCase() : `CL${cl.trim()}`));
  const clientIds = (input.clientIds ?? []).filter(Boolean);
  const clientDbIds = (input.clientDbIds ?? []).filter(Boolean);

  const clientWhere: any = { isActive: true };
  if (clientDbIds.length > 0) {
    clientWhere.id = { in: clientDbIds };
  } else if (clientIds.length > 0) {
    clientWhere.clientId = { in: clientIds };
  } else if (clusters.length > 0) {
    clientWhere.cluster = { in: clusters };
  }

  const jobs = await prisma.job.findMany({
    where: {
      deleteStatus: null,
      isActive: true,
      cronExpression: { not: null },
      category: 'client-cron',
      client: clientWhere,
    },
    include: {
      client: { select: { id: true, clientId: true, name: true, cluster: true, timezone: true } },
    },
    orderBy: [{ client: { clientId: 'asc' } }, { name: 'asc' }],
  });

  const jobsByClient = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const cid = job.client?.clientId ?? 'unknown';
    if (!jobsByClient.has(cid)) jobsByClient.set(cid, []);
    jobsByClient.get(cid)!.push(job);
  }
  const orderedClientIds = [...jobsByClient.keys()].sort();

  onProgress?.({ type: 'start', plannedTotal: orderedClientIds.length, window });

  const allRows: OutageImpactJob[] = [];
  let parseErrors = 0;
  let excludedRetryToday = 0;
  const noRetryToday = input.noRetryToday !== false;

  for (let i = 0; i < orderedClientIds.length; i++) {
    if (isCancelled?.()) {
      const rows = allRows.sort((a, b) =>
        (a.fireTimesUtc[0] ?? '').localeCompare(b.fireTimesUtc[0] ?? ''),
      );
      const result = buildOutageImpactResult(
        rows,
        window,
        excludedRetryToday,
        parseErrors,
        orderedClientIds.length,
        true,
      );
      onProgress?.({ type: 'complete', data: result });
      return result;
    }

    const clientId = orderedClientIds[i];
    const clientJobs = jobsByClient.get(clientId) ?? [];
    const clientRows: OutageImpactJob[] = [];

    for (const job of clientJobs) {
      const outcome = evaluateJob(
        job,
        windowStartUtc,
        windowEndUtc,
        input.inputTimezone,
        input.startLocal,
        noRetryToday,
      );
      if (outcome.parseError) parseErrors++;
      if (outcome.excludedRetry) excludedRetryToday++;
      if (outcome.row) clientRows.push(outcome.row);
    }

    if (clientRows.length > 0) {
      allRows.push(...clientRows);
    }

    onProgress?.({
      type: 'progress',
      completed: i + 1,
      plannedTotal: orderedClientIds.length,
      clientId,
      rows: clientRows,
      impactedJobs: clientRows.length,
    });
  }

  const rows = allRows.sort((a, b) =>
    (a.fireTimesUtc[0] ?? '').localeCompare(b.fireTimesUtc[0] ?? ''),
  );

  const result = buildOutageImpactResult(
    rows,
    window,
    excludedRetryToday,
    parseErrors,
    orderedClientIds.length,
  );
  onProgress?.({ type: 'complete', data: result });
  return result;
}
