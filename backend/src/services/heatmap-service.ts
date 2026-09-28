// ============================================================
// Heat Map Service
// Per-client store counts (active EFF/END date): ITERATION_TYPE 6 vs 7
// ============================================================

import { prisma } from '../database/prisma';
import { db2DirectService } from './db2-direct-service';
import { configService } from './config-service';
import { logger } from '../utils/logger';
import { parseHeatMapWeekRow, heatMapWeeklyCountsSql, type HeatMapWeekCounts } from '../constants/heatmap';

export interface HeatMapClient {
  clientId: string;
  name: string;
  timezone: string;
  cluster: string | null;
}

export interface HeatMapRow {
  clientId: string;
  name: string;
  timezone: string;
  cluster: string | null;
  weeks: HeatMapWeekCounts[];
  mismatchCount: number;
  hasMismatch: boolean;
  error?: string;
}

class HeatMapService {
  async listClients(): Promise<HeatMapClient[]> {
    const clients = await prisma.client.findMany({
      where: {
        isActive: true,
        db2Host: { not: null },
      },
      select: {
        clientId: true,
        name: true,
        timezone: true,
        cluster: true,
      },
      orderBy: { clientId: 'asc' },
    });
    return clients.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      timezone: c.timezone || 'UTC',
      cluster: c.cluster ?? null,
    }));
  }

  async scanClient(clientId: string): Promise<HeatMapRow> {
    const startMs = Date.now();
    logger.info(`Heat Map: scan start ${clientId}`);
    const client = await prisma.client.findUnique({
      where: { clientId },
      select: { clientId: true, name: true, timezone: true, cluster: true, isActive: true, db2Host: true },
    });
    if (!client || !client.isActive || !client.db2Host) {
      logger.info(`Heat Map: scan ${clientId} → skipped (not available) in ${Date.now() - startMs}ms`);
      return {
        clientId,
        name: client?.name || clientId,
        timezone: client?.timezone || 'UTC',
        cluster: client?.cluster ?? null,
        weeks: [],
        mismatchCount: 0,
        hasMismatch: false,
        error: 'Client not available for DB2 scan',
      };
    }

    try {
      const result = await db2DirectService.queryClient(
        clientId,
        heatMapWeeklyCountsSql(),
        'HeatMap/WeeklyCounts',
      );
      if (!result.success) {
        throw new Error(result.error || 'Heat Map weekly query failed');
      }

      const weeks: HeatMapWeekCounts[] = [];
      for (const raw of result.rows || []) {
        const week = parseHeatMapWeekRow(raw);
        if (week) weeks.push(week);
      }

      const mismatchCount = weeks.filter((w) => w.mismatch).length;
      const executionTimeMs = Date.now() - startMs;
      logger.info(
        `Heat Map: scan ${client.clientId} → ${weeks.length} week(s) `
        + `mismatches=${mismatchCount} in ${executionTimeMs}ms`,
      );
      return {
        clientId: client.clientId,
        name: client.name,
        timezone: client.timezone || 'UTC',
        cluster: client.cluster ?? null,
        weeks,
        mismatchCount,
        hasMismatch: mismatchCount > 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Heat Map: scan failed for ${clientId}: ${message}`);
      return {
        clientId: client.clientId,
        name: client.name,
        timezone: client.timezone || 'UTC',
        cluster: client.cluster ?? null,
        weeks: [],
        mismatchCount: 0,
        hasMismatch: false,
        error: message,
      };
    }
  }

  async getSnapshot(): Promise<{ rows: HeatMapRow[]; fetchedAt: string }> {
    const startMs = Date.now();
    const clients = await this.listClients();
    logger.info(`Heat Map: snapshot start (${clients.length} client(s))`);
    const concurrency = Math.max(1, Math.min(10, configService.getInt('engine.db2QueryConcurrency', 5)));
    const rows: HeatMapRow[] = [];
    let idx = 0;

    const worker = async () => {
      while (idx < clients.length) {
        const c = clients[idx++];
        rows.push(await this.scanClient(c.clientId));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, clients.length || 1) }, () => worker()),
    );

    rows.sort((a, b) => a.clientId.localeCompare(b.clientId));
    const mismatchClients = rows.filter((r) => r.hasMismatch).length;
    const errorClients = rows.filter((r) => !!r.error).length;
    logger.info(
      `Heat Map: snapshot done → ${rows.length} client(s) `
      + `mismatches=${mismatchClients} errors=${errorClients} in ${Date.now() - startMs}ms`,
    );
    return { rows, fetchedAt: new Date().toISOString() };
  }
}

export const heatMapService = new HeatMapService();
