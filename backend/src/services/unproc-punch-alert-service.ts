// ============================================================
// Unproc Punch Alert Service
// Tracks acknowledge / suppress state for unprocessed punch alerts
// Live data comes from DB2; status is persisted in SQLite
// ============================================================

import { prisma } from '../database/prisma';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';
import { derivePunchActivities } from '../utils/escalation-report';
import { filterStalePunchRows, staleAgeMins } from '../utils/punch-stale';
import { unprocessedPunchService } from './unprocessed-punch-service';

const logger = createServiceLogger('UnprocPunchAlertService');

class UnprocPunchAlertService {
  /**
   * Get all persisted punch alert statuses (non-OPEN only, since OPEN is default).
   * Returns a Map<clientId, record> for easy merging with live data.
   */
  async getAlertStatuses(): Promise<Record<string, any>> {
    const now = new Date();
    const alerts = await prisma.unprocPunchAlert.findMany();

    const result: Record<string, any> = {};

    for (const a of alerts) {
      // Check if suppression has expired → reopen
      if (a.status === 'SUPPRESSED' && a.suppressUntil && new Date(a.suppressUntil) < now) {
        await prisma.unprocPunchAlert.update({
          where: { id: a.id },
          data: { status: 'OPEN', suppressedBy: null, suppressedAt: null, suppressUntil: null, suppressReason: null },
        });
        logger.info(`Suppression expired for punch alert ${a.clientId}, reopened`);
        continue; // OPEN is default, no need to include
      }

      if (a.status !== 'OPEN' || a.emailSentAt) {
        result[a.clientId] = {
          id: a.id,
          status: a.status,
          acknowledgedBy: a.acknowledgedBy,
          acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
          suppressedBy: a.suppressedBy,
          suppressedAt: a.suppressedAt?.toISOString() || null,
          suppressUntil: a.suppressUntil?.toISOString() || null,
          suppressReason: a.suppressReason,
          emailSentAt: a.emailSentAt?.toISOString() || null,
        };
      }
    }

    return result;
  }

  /**
   * Acknowledge an unproc punch alert for a client.
   */
  async acknowledge(clientId: string, userId: string): Promise<void> {
    await prisma.unprocPunchAlert.upsert({
      where: { clientId },
      create: {
        clientId,
        status: 'ACKNOWLEDGED',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      },
      update: {
        status: 'ACKNOWLEDGED',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
        suppressedBy: null,
        suppressedAt: null,
        suppressUntil: null,
        suppressReason: null,
      },
    });
    logger.info(`Punch alert for ${clientId} acknowledged by ${userId}`);
  }

  /**
   * Suppress an unproc punch alert for a client for a given duration.
   */
  async suppress(clientId: string, userId: string, durationMinutes: number, reason?: string): Promise<void> {
    const suppressUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
    await prisma.unprocPunchAlert.upsert({
      where: { clientId },
      create: {
        clientId,
        status: 'SUPPRESSED',
        suppressedBy: userId,
        suppressedAt: new Date(),
        suppressUntil,
        suppressReason: reason || null,
      },
      update: {
        status: 'SUPPRESSED',
        suppressedBy: userId,
        suppressedAt: new Date(),
        suppressUntil,
        suppressReason: reason || null,
        acknowledgedBy: null,
        acknowledgedAt: null,
      },
    });
    logger.info(`Punch alert for ${clientId} suppressed by ${userId} until ${suppressUntil.toISOString()}`);
  }

  /**
   * Reset a punch alert back to OPEN (e.g. when the issue is resolved or manually reopened).
   */
  /**
   * Record that a notify email was sent for a client (respects notify cooldown on re-send).
   */
  async recordEmailSent(clientIds: string[]): Promise<void> {
    const now = new Date();
    for (const clientId of clientIds) {
      await prisma.unprocPunchAlert.upsert({
        where: { clientId },
        create: { clientId, status: 'OPEN', emailSentAt: now },
        update: { emailSentAt: now },
      });
    }
    logger.info(`Recorded punch notify email for ${clientIds.length} client(s)`);
  }

  /**
   * Filter punch rows to those eligible for notify (outside cooldown window).
   */
  filterNotifyEligible<T extends { clientId: string }>(
    rows: T[],
    statuses: Record<string, { emailSentAt?: string | null }>
  ): T[] {
    const cooldownMs = configService.getNotifyCooldownMins() * 60 * 1000;
    const cutoff = Date.now() - cooldownMs;
    return rows.filter(r => {
      const sentAt = statuses[r.clientId]?.emailSentAt;
      if (!sentAt) return true;
      return new Date(sentAt).getTime() < cutoff;
    });
  }

  async resetToOpen(clientId: string): Promise<void> {
    const existing = await prisma.unprocPunchAlert.findUnique({ where: { clientId } });
    if (existing) {
      await prisma.unprocPunchAlert.update({
        where: { clientId },
        data: {
          status: 'OPEN',
          acknowledgedBy: null,
          acknowledgedAt: null,
          suppressedBy: null,
          suppressedAt: null,
          suppressUntil: null,
          suppressReason: null,
        },
      });
    }
  }

  /**
   * Punch alert rows for a monthly report: workflow history plus live stale clients (current month).
   */
  async getPunchAlertHistory(options: {
    start: Date;
    end: Date;
    cluster?: string;
    clientId?: string;
    includeLiveStale?: boolean;
  }) {
    const { start, end, cluster, clientId, includeLiveStale = false } = options;

    const alerts = await prisma.unprocPunchAlert.findMany({
      where: {
        OR: [
          { acknowledgedAt: { gte: start, lte: end } },
          { suppressedAt: { gte: start, lte: end } },
          { emailSentAt: { gte: start, lte: end } },
          { createdAt: { gte: start, lte: end } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    });

    const dbClients = await prisma.client.findMany({
      select: { clientId: true, name: true, cluster: true },
    });
    const clientMap = new Map(
      dbClients.map(c => [c.clientId.toUpperCase(), { name: c.name, cluster: c.cluster || '' }])
    );

    const rowMap = new Map<string, {
      clientId: string;
      clientName: string;
      cluster: string;
      punchCount: number | null;
      staleAgeMins: number | null;
      lastUpdateTime: string | null;
      status: string;
      activities: string[];
      acknowledgedBy: string | null;
      acknowledgedAt: string | null;
      suppressedBy: string | null;
      suppressedAt: string | null;
      suppressUntil: string | null;
      suppressReason: string | null;
      emailSentAt: string | null;
    }>();

    for (const a of alerts) {
      const activities = derivePunchActivities(a, start, end);
      if (activities.length === 0) continue;

      const match = clientMap.get(a.clientId.toUpperCase());
      rowMap.set(a.clientId.toUpperCase(), {
        clientId: a.clientId,
        clientName: match?.name || a.clientId,
        cluster: match?.cluster || '',
        punchCount: null,
        staleAgeMins: null,
        lastUpdateTime: null,
        status: a.status,
        activities,
        acknowledgedBy: a.acknowledgedBy,
        acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
        suppressedBy: a.suppressedBy,
        suppressedAt: a.suppressedAt?.toISOString() || null,
        suppressUntil: a.suppressUntil?.toISOString() || null,
        suppressReason: a.suppressReason,
        emailSentAt: a.emailSentAt?.toISOString() || null,
      });
    }

    if (includeLiveStale) {
      const cache = unprocessedPunchService.getPunchAllCache();
      if (cache?.data?.length) {
        const punchCountMin = configService.getInt('threshold.punchCountMin', 100);
        const staleHoursMins = configService.getInt('threshold.staleHoursMins', 60);
        const staleRows = filterStalePunchRows(cache.data, punchCountMin, staleHoursMins);
        const persistedStatuses = await prisma.unprocPunchAlert.findMany({
          where: { clientId: { in: staleRows.map(r => r.clientId) } },
        });
        const statusMap = new Map(persistedStatuses.map(s => [s.clientId.toUpperCase(), s]));

        for (const live of staleRows) {
          const key = live.clientId.toUpperCase();
          const match = clientMap.get(key);
          const persisted = statusMap.get(key);
          const existing = rowMap.get(key);
          const liveFields = {
            punchCount: live.punchCount,
            staleAgeMins: staleAgeMins(live),
            lastUpdateTime: live.lastUpdateTime ?? null,
          };

          if (existing) {
            rowMap.set(key, {
              ...existing,
              ...liveFields,
              status: persisted?.status ?? existing.status,
              activities: existing.activities.includes('Active Stale')
                ? existing.activities
                : ['Active Stale', ...existing.activities],
            });
          } else {
            rowMap.set(key, {
              clientId: live.clientId,
              clientName: live.name || match?.name || live.clientId,
              cluster: live.cluster || match?.cluster || '',
              ...liveFields,
              status: persisted?.status ?? 'OPEN',
              activities: ['Active Stale'],
              acknowledgedBy: persisted?.acknowledgedBy ?? null,
              acknowledgedAt: persisted?.acknowledgedAt?.toISOString() || null,
              suppressedBy: persisted?.suppressedBy ?? null,
              suppressedAt: persisted?.suppressedAt?.toISOString() || null,
              suppressUntil: persisted?.suppressUntil?.toISOString() || null,
              suppressReason: persisted?.suppressReason ?? null,
              emailSentAt: persisted?.emailSentAt?.toISOString() || null,
            });
          }
        }
      }
    }

    let rows = Array.from(rowMap.values())
      .filter(r => {
        if (clientId && r.clientId.toUpperCase() !== clientId.toUpperCase()) return false;
        if (cluster && r.cluster !== cluster) return false;
        return true;
      })
      .sort((a, b) => (b.staleAgeMins ?? 0) - (a.staleAgeMins ?? 0));

    const summary = {
      total: rows.length,
      activeStale: rows.filter(r => r.activities.includes('Active Stale')).length,
      acknowledged: rows.filter(r => r.activities.includes('Acknowledged')).length,
      suppressed: rows.filter(r => r.activities.includes('Suppressed')).length,
      notified: rows.filter(r => r.activities.includes('Notified')).length,
    };

    return { rows, summary, liveDataAvailable: includeLiveStale && !!unprocessedPunchService.getPunchAllCache() };
  }
}

export const unprocPunchAlertService = new UnprocPunchAlertService();
