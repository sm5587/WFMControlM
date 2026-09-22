// ============================================================
// Payroll deadline alerts
// Units still pending after the client SLA deadline → Escalated tab
// ============================================================

import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { configService } from './config-service';

const logger = createServiceLogger('PayrollDeadlineAlert');

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
        await prisma.payrollDeadlineAlert.update({
          where: { clientId: input.clientId },
          data: { resolvedAt: now, lastSeenAt: now, pendingUnits: input.pendingUnits },
        });
        logger.info(`Payroll deadline alert resolved for ${input.clientId}`);
      }
      return;
    }

    const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : null;
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
      rows.push(toRow(a));
    }
    return rows;
  }

  /** Open alerts that have not been emailed inside the notify cooldown. */
  async listOpenForNotify(clientIds?: string[]): Promise<PayrollDeadlineAlertRow[]> {
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
}

export const payrollDeadlineAlertService = new PayrollDeadlineAlertService();
