// ============================================================
// Purge Service
// Deletes old rows from high-growth tables based on admin-
// configured retention periods stored in PurgeConfig.
//
// Runs nightly at 02:00 server time via scheduler in index.ts.
// Can also be triggered on-demand via POST /api/admin/purge/run.
// ============================================================

import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('PurgeService');

export interface PurgeResult {
  table:   string;
  label:   string;
  deleted: number;
  skipped: boolean;  // true when disabled or retainDays = -1
  error?:  string;
}

export interface PurgeRunSummary {
  startedAt:   string;
  completedAt: string;
  durationMs:  number;
  results:     PurgeResult[];
  totalDeleted: number;
}

class PurgeService {
  /**
   * Run all enabled purge tasks based on current PurgeConfig.
   * Called nightly and on-demand from the admin UI.
   */
  async runAll(): Promise<PurgeRunSummary> {
    const t0 = Date.now();
    logger.info('Starting nightly data purge...');

    const configs = await prisma.purgeConfig.findMany({ orderBy: { id: 'asc' } });
    const results: PurgeResult[] = [];

    for (const cfg of configs) {
      const result = await this.runOne(cfg.id, cfg.label, cfg.retainDays, cfg.enabled);
      results.push(result);

      // Update lastPurgeAt and lastPurgeCount regardless of skip/error
      await prisma.purgeConfig.update({
        where: { id: cfg.id },
        data: {
          lastPurgeAt:    new Date(),
          lastPurgeCount: result.deleted,
        },
      });
    }

    const summary: PurgeRunSummary = {
      startedAt:    new Date(t0).toISOString(),
      completedAt:  new Date().toISOString(),
      durationMs:   Date.now() - t0,
      results,
      totalDeleted: results.reduce((s, r) => s + r.deleted, 0),
    };

    logger.info(`Purge complete: ${summary.totalDeleted} rows deleted in ${summary.durationMs}ms`);
    return summary;
  }

  /**
   * Run purge for a single table by config id.
   * Used for on-demand single-table runs from the UI.
   */
  async runOne(id: string, label: string, retainDays: number, enabled: boolean): Promise<PurgeResult> {
    if (!enabled || retainDays < 0) {
      return { table: id, label, deleted: 0, skipped: true };
    }

    try {
      const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
      let deleted = 0;

      switch (id) {
        case 'syncHistory':
          const sh = await prisma.syncHistory.deleteMany({
            where: { createdAt: { lt: cutoff } },
          });
          deleted = sh.count;
          break;

        case 'jobExecution':
          const je = await prisma.jobExecution.deleteMany({
            where: { createdAt: { lt: cutoff } },
          });
          deleted = je.count;
          break;

        case 'alertEvent':
          // Only purge acknowledged events; active unacknowledged events are preserved
          const ae = await prisma.alertEvent.deleteMany({
            where: {
              createdAt:    { lt: cutoff },
              acknowledged: true,
            },
          });
          deleted = ae.count;
          break;

        case 'escalatedAlert':
          // Only purge resolved/suppressed alerts older than cutoff
          const ea = await prisma.escalatedAlert.deleteMany({
            where: {
              resolvedAt: { lt: cutoff },
              status:     { in: ['ACKNOWLEDGED', 'SUPPRESSED'] },
            },
          });
          deleted = ea.count;
          break;

        case 'auditLog':
          const al = await prisma.auditLog.deleteMany({
            where: { createdAt: { lt: cutoff } },
          });
          deleted = al.count;
          break;

        case 'cachedCronJob':
          const cc = await prisma.cachedCronJob.deleteMany({
            where: { fetchedAt: { lt: cutoff } },
          });
          deleted = cc.count;
          break;

        default:
          logger.warn(`Unknown purge table: ${id}`);
          return { table: id, label, deleted: 0, skipped: true };
      }

      logger.info(`  ${label}: deleted ${deleted} rows older than ${retainDays}d`);
      return { table: id, label, deleted, skipped: false };

    } catch (err: any) {
      logger.error(`  ${label}: purge failed — ${err.message}`);
      return { table: id, label, deleted: 0, skipped: false, error: err.message };
    }
  }

  /**
   * Return current row counts for each purgeable table (for UI display).
   */
  async getRowCounts(): Promise<Record<string, number>> {
    const [sh, je, ae, ea, al, cc] = await Promise.all([
      prisma.syncHistory.count(),
      prisma.jobExecution.count(),
      prisma.alertEvent.count(),
      prisma.escalatedAlert.count(),
      prisma.auditLog.count(),
      prisma.cachedCronJob.count(),
    ]);
    return {
      syncHistory:    sh,
      jobExecution:   je,
      alertEvent:     ae,
      escalatedAlert: ea,
      auditLog:       al,
      cachedCronJob:  cc,
    };
  }
}

export const purgeService = new PurgeService();
