// ============================================================
// Unproc Punch Alert Service
// Tracks acknowledge / suppress state for unprocessed punch alerts
// Live data comes from DB2; status is persisted in SQLite
// ============================================================

import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';

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

      if (a.status !== 'OPEN') {
        result[a.clientId] = {
          id: a.id,
          status: a.status,
          acknowledgedBy: a.acknowledgedBy,
          acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
          suppressedBy: a.suppressedBy,
          suppressedAt: a.suppressedAt?.toISOString() || null,
          suppressUntil: a.suppressUntil?.toISOString() || null,
          suppressReason: a.suppressReason,
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
}

export const unprocPunchAlertService = new UnprocPunchAlertService();
