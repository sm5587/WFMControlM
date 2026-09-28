// ============================================================
// Payroll deadline alerts
// Units still pending after the client SLA deadline → Escalated tab
// ============================================================

import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import {
  alertOverlapsPeriod,
  computeDurationMins,
  isDateInRange,
  isOpenAtPeriodEnd,
} from '../utils/escalation-report';
import { SYSTEM_ESCALATION_ACTOR } from '../constants/escalation';
import { configService } from './config-service';

const logger = createServiceLogger('PayrollDeadlineAlert');

function getAutoAckDurationMins(): number {
  const mins = configService.getInt('threshold.defaultSuppressMins', 60);
  return mins > 0 ? mins : 60;
}

function derivePayrollActivities(
  row: {
    firstSeenAt?: Date | null;
    acknowledgedAt?: Date | null;
    suppressedAt?: Date | null;
    emailSentAt?: Date | null;
    resolvedAt?: Date | null;
  },
  start: Date,
  end: Date,
): string[] {
  const activities: string[] = [];
  if (isDateInRange(row.firstSeenAt, start, end)) activities.push('Opened');
  if (isDateInRange(row.acknowledgedAt, start, end)) activities.push('Acknowledged');
  if (isDateInRange(row.suppressedAt, start, end)) activities.push('Suppressed');
  if (isDateInRange(row.emailSentAt, start, end)) activities.push('Notified');
  if (isDateInRange(row.resolvedAt, start, end)) activities.push('Resolved');
  return activities;
}

export interface PayrollDeadlineAlertRow {
  id: string;
  clientId: string;
  clientName: string;
  weekEndDate: string;
  deadlineAt: string | null;
  pendingUnits: number;
  totalUnits: number;
  lateMinutes: number | null;
  status: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  suppressedBy: string | null;
  suppressUntil: string | null;
  suppressReason: string | null;
  emailSentAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolveReason?: string | null;
}

export interface PayrollDeadlineSyncInput {
  clientId: string;
  clientName?: string;
  weekEndDate: string;
  deadlineAt: string | null;
  pendingUnits: number;
  totalUnits: number;
  lateMinutes: number | null;
  late: boolean;
}

function toRow(a: {
  id: string;
  clientId: string;
  clientName: string;
  weekEndDate: string;
  deadlineAt: Date | null;
  pendingUnits: number;
  totalUnits: number;
  lateMinutes: number | null;
  status: string;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  suppressedBy: string | null;
  suppressUntil: Date | null;
  suppressReason: string | null;
  emailSentAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  resolveReason?: string | null;
}): PayrollDeadlineAlertRow {
  return {
    id: a.id,
    clientId: a.clientId,
    clientName: a.clientName || a.clientId,
    weekEndDate: a.weekEndDate,
    deadlineAt: a.deadlineAt?.toISOString() || null,
    pendingUnits: a.pendingUnits,
    totalUnits: a.totalUnits,
    lateMinutes: a.lateMinutes,
    status: a.status,
    acknowledgedBy: a.acknowledgedBy,
    acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
    suppressedBy: a.suppressedBy,
    suppressUntil: a.suppressUntil?.toISOString() || null,
    suppressReason: a.suppressReason,
    emailSentAt: a.emailSentAt?.toISOString() || null,
    firstSeenAt: a.firstSeenAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() || null,
    resolvedBy: a.resolvedBy || null,
    resolveReason: a.resolveReason || null,
  };
}

class PayrollDeadlineAlertService {
  /** Open or clear the alert from a monitor/status evaluation. */
  async sync(input: PayrollDeadlineSyncInput): Promise<void> {
    const now = new Date();
    const existing = await prisma.payrollDeadlineAlert.findUnique({
      where: { clientId: input.clientId },
    });

    if (!input.late || input.pendingUnits <= 0) {
      if (existing && !existing.resolvedAt) {
        // Keep the last late snapshot (pending/total/lateMinutes) for Reports;
        // clearing writes pendingUnits=0 which would wipe the historical count.
        await prisma.payrollDeadlineAlert.update({
          where: { clientId: input.clientId },
          data: {
            resolvedAt: now,
            lastSeenAt: now,
            ...(input.pendingUnits > 0
              ? {
                  pendingUnits: input.pendingUnits,
                  totalUnits: input.totalUnits,
                  lateMinutes: input.lateMinutes,
                }
              : {}),
          },
        });
        logger.info(`Payroll deadline alert resolved for ${input.clientId}`);
      }
      return;
    }

    const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : null;

    // Manual (or prior) resolve for this pay week stays closed until a new weekEndDate.
    if (existing?.resolvedAt && existing.weekEndDate === input.weekEndDate) {
      await prisma.payrollDeadlineAlert.update({
        where: { clientId: input.clientId },
        data: {
          clientName: input.clientName || existing.clientName || input.clientId,
          deadlineAt,
          pendingUnits: input.pendingUnits,
          totalUnits: input.totalUnits,
          lateMinutes: input.lateMinutes,
          lastSeenAt: now,
        },
      });
      return;
    }

    const sameIncident = !!existing
      && !existing.resolvedAt
      && existing.weekEndDate === input.weekEndDate;

    let status = 'OPEN';
    let acknowledgedBy: string | null = null;
    let acknowledgedAt: Date | null = null;
    let suppressedBy: string | null = null;
    let suppressedAt: Date | null = null;
    let suppressUntil: Date | null = null;
    let suppressReason: string | null = null;
    let firstSeenAt = now;

    if (sameIncident && existing) {
      firstSeenAt = existing.firstSeenAt;
      if (existing.status === 'SUPPRESSED' && existing.suppressUntil && existing.suppressUntil > now) {
        status = 'SUPPRESSED';
        suppressedBy = existing.suppressedBy;
        suppressedAt = existing.suppressedAt;
        suppressUntil = existing.suppressUntil;
        suppressReason = existing.suppressReason;
      } else if (existing.status === 'ACKNOWLEDGED') {
        status = 'ACKNOWLEDGED';
        acknowledgedBy = existing.acknowledgedBy;
        acknowledgedAt = existing.acknowledgedAt;
      }
    }

    await prisma.payrollDeadlineAlert.upsert({
      where: { clientId: input.clientId },
      create: {
        clientId: input.clientId,
        clientName: input.clientName || input.clientId,
        weekEndDate: input.weekEndDate,
        deadlineAt,
        pendingUnits: input.pendingUnits,
        totalUnits: input.totalUnits,
        lateMinutes: input.lateMinutes,
        status: 'OPEN',
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: null,
        resolvedBy: null,
        resolveReason: null,
      },
      update: {
        clientName: input.clientName || existing?.clientName || input.clientId,
        weekEndDate: input.weekEndDate,
        deadlineAt,
        pendingUnits: input.pendingUnits,
        totalUnits: input.totalUnits,
        lateMinutes: input.lateMinutes,
        status,
        acknowledgedBy,
        acknowledgedAt,
        suppressedBy,
        suppressedAt,
        suppressUntil,
        suppressReason,
        firstSeenAt,
        lastSeenAt: now,
        resolvedAt: null,
        resolvedBy: null,
        resolveReason: null,
        ...(sameIncident ? {} : { emailSentAt: null }),
      },
    });
    if (!sameIncident) {
      logger.info(
        `Payroll deadline alert opened for ${input.clientId}: ${input.pendingUnits} pending after ${input.deadlineAt}`,
      );
    }
  }

  async listActive(): Promise<PayrollDeadlineAlertRow[]> {
    const now = new Date();
    const alerts = await prisma.payrollDeadlineAlert.findMany({
      where: { resolvedAt: null },
      orderBy: { firstSeenAt: 'asc' },
    });

    const rows: PayrollDeadlineAlertRow[] = [];
    for (const a of alerts) {
      if (a.status === 'SUPPRESSED' && a.suppressUntil && a.suppressUntil < now) {
        const reopened = await prisma.payrollDeadlineAlert.update({
          where: { id: a.id },
          data: {
            status: 'OPEN',
            suppressedBy: null,
            suppressedAt: null,
            suppressUntil: null,
            suppressReason: null,
          },
        });
        rows.push(toRow(reopened));
        continue;
      }
      if (
        a.status === 'ACKNOWLEDGED'
        && a.acknowledgedBy === SYSTEM_ESCALATION_ACTOR
        && a.acknowledgedAt
      ) {
        const ackExpiresAt = a.acknowledgedAt.getTime() + getAutoAckDurationMins() * 60 * 1000;
        if (now.getTime() >= ackExpiresAt) {
          const reopened = await prisma.payrollDeadlineAlert.update({
            where: { id: a.id },
            data: { status: 'OPEN', acknowledgedBy: null, acknowledgedAt: null },
          });
          logger.info(`Auto-ack expired for payroll deadline ${a.clientId}, reopened`);
          rows.push(toRow(reopened));
          continue;
        }
      }
      rows.push(toRow(a));
    }
    return rows;
  }

  /** Open alerts that have not been emailed inside the notify cooldown. */
  async listOpenForNotify(clientIds?: string[]): Promise<PayrollDeadlineAlertRow[]> {
    // Reopen expired system auto-acks so they can be re-notified.
    await this.expireSystemAutoAcks(clientIds);

    const alerts = await prisma.payrollDeadlineAlert.findMany({
      where: {
        resolvedAt: null,
        status: 'OPEN',
        ...(clientIds?.length ? { clientId: { in: clientIds } } : {}),
      },
      orderBy: { firstSeenAt: 'asc' },
    });
    const cooldownMs = configService.getNotifyCooldownMins() * 60 * 1000;
    const cutoff = Date.now() - cooldownMs;
    return alerts
      .filter(a => !a.emailSentAt || a.emailSentAt.getTime() < cutoff)
      .map(toRow);
  }

  private async expireSystemAutoAcks(clientIds?: string[]): Promise<void> {
    const now = new Date();
    const candidates = await prisma.payrollDeadlineAlert.findMany({
      where: {
        resolvedAt: null,
        status: 'ACKNOWLEDGED',
        acknowledgedBy: SYSTEM_ESCALATION_ACTOR,
        ...(clientIds?.length ? { clientId: { in: clientIds } } : {}),
      },
    });
    const ackMs = getAutoAckDurationMins() * 60 * 1000;
    for (const a of candidates) {
      if (!a.acknowledgedAt) continue;
      if (now.getTime() >= a.acknowledgedAt.getTime() + ackMs) {
        await prisma.payrollDeadlineAlert.update({
          where: { id: a.id },
          data: { status: 'OPEN', acknowledgedBy: null, acknowledgedAt: null },
        });
        logger.info(`Auto-ack expired for payroll deadline ${a.clientId}, reopened`);
      }
    }
  }

  async recordEmailSent(clientIds: string[]): Promise<void> {
    if (!clientIds.length) return;
    const now = new Date();
    await prisma.payrollDeadlineAlert.updateMany({
      where: { clientId: { in: clientIds }, resolvedAt: null },
      data: { emailSentAt: now },
    });
    logger.info(`Recorded payroll deadline notify email for ${clientIds.length} client(s)`);
  }

  async acknowledge(clientId: string, userId: string): Promise<void> {
    const existing = await prisma.payrollDeadlineAlert.findUnique({ where: { clientId } });
    if (!existing || existing.resolvedAt) {
      throw new Error(`No open payroll deadline alert for ${clientId}`);
    }
    await prisma.payrollDeadlineAlert.update({
      where: { clientId },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
        suppressedBy: null,
        suppressedAt: null,
        suppressUntil: null,
        suppressReason: null,
      },
    });
  }

  async suppress(clientId: string, userId: string, durationMinutes: number, reason?: string): Promise<void> {
    const existing = await prisma.payrollDeadlineAlert.findUnique({ where: { clientId } });
    if (!existing || existing.resolvedAt) {
      throw new Error(`No open payroll deadline alert for ${clientId}`);
    }
    const until = new Date(Date.now() + durationMinutes * 60 * 1000);
    await prisma.payrollDeadlineAlert.update({
      where: { clientId },
      data: {
        status: 'SUPPRESSED',
        suppressedBy: userId,
        suppressedAt: new Date(),
        suppressUntil: until,
        suppressReason: reason || null,
      },
    });
  }

  /**
   * True when the deadline alert was resolved for this pay week (manual or auto).
   * Monitor / dashboard treat that as accepted: no Late attention until a new weekEndDate.
   */
  async isResolvedForWeek(clientId: string, weekEndDate: string): Promise<boolean> {
    if (!weekEndDate) return false;
    const existing = await prisma.payrollDeadlineAlert.findUnique({
      where: { clientId },
      select: { resolvedAt: true, weekEndDate: true },
    });
    return !!existing?.resolvedAt && existing.weekEndDate === weekEndDate;
  }

  /**
   * Manually close the alert with a required reason. Leaves Escalated list
   * (resolvedAt set) but remains in Reports history for the period.
   * Sync will not reopen for the same weekEndDate.
   */
  async resolve(clientId: string, userId: string, reason: string): Promise<void> {
    const trimmed = (reason || '').trim();
    if (!trimmed) {
      throw new Error('Resolve reason is required');
    }
    const existing = await prisma.payrollDeadlineAlert.findUnique({ where: { clientId } });
    if (!existing || existing.resolvedAt) {
      throw new Error(`No open payroll deadline alert for ${clientId}`);
    }
    const now = new Date();
    await prisma.payrollDeadlineAlert.update({
      where: { clientId },
      data: {
        status: 'RESOLVED',
        resolvedAt: now,
        resolvedBy: userId,
        resolveReason: trimmed,
        lastSeenAt: now,
        suppressedBy: null,
        suppressedAt: null,
        suppressUntil: null,
        suppressReason: null,
      },
    });
    logger.info(`Payroll deadline alert manually resolved for ${clientId} by ${userId}`);
  }

  /**
   * Payroll deadline alert rows for a monthly/quarterly report.
   * Includes incidents that overlapped the window (or had ack/suppress/notify/resolve activity in it).
   */
  async getPayrollDeadlineAlertHistory(options: {
    start: Date;
    end: Date;
    asOf?: Date;
    cluster?: string;
    clientId?: string;
  }) {
    const { start, end, cluster, clientId, asOf = end } = options;

    const alerts = await prisma.payrollDeadlineAlert.findMany({
      where: {
        OR: [
          {
            firstSeenAt: { lte: end },
            OR: [
              { resolvedAt: null },
              { resolvedAt: { gte: start } },
            ],
          },
          { acknowledgedAt: { gte: start, lte: end } },
          { suppressedAt: { gte: start, lte: end } },
          { emailSentAt: { gte: start, lte: end } },
          { resolvedAt: { gte: start, lte: end } },
        ],
      },
      orderBy: { firstSeenAt: 'desc' },
    });

    const dbClients = await prisma.client.findMany({
      select: { clientId: true, name: true, cluster: true },
    });
    const clientMap = new Map(
      dbClients.map(c => [c.clientId.toUpperCase(), { name: c.name, cluster: c.cluster || '' }])
    );

    let rows = alerts
      .filter(a => alertOverlapsPeriod(a.firstSeenAt, a.resolvedAt, start, end)
        || derivePayrollActivities(a, start, end).length > 0)
      .map(a => {
        const match = clientMap.get(a.clientId.toUpperCase());
        const durationMins = computeDurationMins(a.firstSeenAt, a.resolvedAt, a.lastSeenAt);
        const activities = derivePayrollActivities(a, start, end);
        return {
          id: a.id,
          clientId: a.clientId,
          clientName: match?.name || a.clientName || a.clientId,
          cluster: match?.cluster || '',
          weekEndDate: a.weekEndDate,
          deadlineAt: a.deadlineAt?.toISOString() || null,
          pendingUnits: a.pendingUnits,
          totalUnits: a.totalUnits,
          lateMinutes: a.lateMinutes,
          status: a.status,
          acknowledgedBy: a.acknowledgedBy,
          acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
          suppressedBy: a.suppressedBy,
          suppressUntil: a.suppressUntil?.toISOString() || null,
          suppressReason: a.suppressReason,
          emailSentAt: a.emailSentAt?.toISOString() || null,
          firstSeenAt: a.firstSeenAt.toISOString(),
          lastSeenAt: a.lastSeenAt.toISOString(),
          resolvedAt: a.resolvedAt?.toISOString() || null,
          resolvedBy: a.resolvedBy || null,
          resolveReason: a.resolveReason || null,
          durationMins,
          activities,
        };
      });

    if (clientId) {
      rows = rows.filter(r => r.clientId.toUpperCase() === clientId.toUpperCase());
    }
    if (cluster) {
      rows = rows.filter(r => r.cluster === cluster);
    }

    const byCluster: Record<string, number> = {};
    for (const r of rows) {
      const key = r.cluster || '(none)';
      byCluster[key] = (byCluster[key] || 0) + 1;
    }

    const resolvedRows = rows.filter(r => r.resolvedAt);
    const avgDurationMins = resolvedRows.length
      ? Math.round(resolvedRows.reduce((s, r) => s + r.durationMins, 0) / resolvedRows.length)
      : 0;

    const summary = {
      total: rows.length,
      open: rows.filter(r => isOpenAtPeriodEnd(
        r.resolvedAt ? new Date(r.resolvedAt) : null,
        asOf,
      )).length,
      acknowledged: rows.filter(r => r.activities.includes('Acknowledged') || r.status === 'ACKNOWLEDGED').length,
      suppressed: rows.filter(r => r.activities.includes('Suppressed') || r.status === 'SUPPRESSED').length,
      resolved: resolvedRows.length,
      notified: rows.filter(r => r.activities.includes('Notified')).length,
      clientsAffected: new Set(rows.map(r => r.clientId)).size,
      avgDurationMins,
      byCluster,
    };

    return { summary, rows };
  }
}

export const payrollDeadlineAlertService = new PayrollDeadlineAlertService();
