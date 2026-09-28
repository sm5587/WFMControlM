// ============================================================
// Escalation Service
// Monitors pending alerts > 1 hour → escalates to "Red" status
// Handles acknowledge, suppress, and email notifications
// ============================================================

import { prisma } from '../database/prisma';
import { alertService } from './alert-service';
import { configService } from './config-service';
import { db2DirectService, BatchJobGroup } from './db2-direct-service';
import { createServiceLogger } from '../utils/logger';
import {
  buildAllAlertsNotifyEmail,
  buildQueueBuildupNotifyEmail,
  escHtml,
} from '../email/notify-email-templates';
import {
  computeDurationMins,
  deriveQueueSeverity,
  isOpenAtPeriodEnd,
  parseMonthPeriod,
  parseQuarterPeriod,
  periodContainsNow,
  type MonthPeriod,
} from '../utils/escalation-report';
import { SYSTEM_ESCALATION_ACTOR } from '../constants/escalation';
import { unprocPunchAlertService } from './unproc-punch-alert-service';
import { payrollDeadlineAlertService } from './payroll-deadline-alert-service';

export { SYSTEM_ESCALATION_ACTOR };

export type PunchNotifyRow = {
  clientId: string;
  name?: string;
  cluster?: string;
  punchCount: number;
  lastUpdateTime?: string | null;
};

export type NotifyAllResult = {
  sent: number;
  skipped: number;
  recipients: string[];
  details: string[];
  error?: string;
  queueIds: string[];
  payrollClientIds: string[];
  punchClientIds: string[];
};

function getEscalationThresholdDate(): Date {
  const mins = configService.getInt('threshold.escalationMins');
  return new Date(Date.now() - mins * 60 * 1000);
}

function getNotifyCooldownDate(): Date {
  const mins = configService.getNotifyCooldownMins();
  return new Date(Date.now() - mins * 60 * 1000);
}

const logger = createServiceLogger('EscalationService');

function getAutoAckDurationMins(): number {
  const mins = configService.getInt('threshold.defaultSuppressMins', 60);
  return mins > 0 ? mins : 60;
}

export interface ImpactedJobRow {
  jobType: string;
  planType: string;
  stalePending: number;
  pending: number;
}

export interface EscalatedAlertSummary {
  id: string;
  clientId: string;
  serverCode: string;
  clientName: string;
  cluster: string;
  stalePendingCount: number;
  totalPending: number;
  /** JOB_TYPE names marked critical for this client (escalation is critical-only). */
  criticalJobNames?: string[];
  status: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  suppressedBy: string | null;
  suppressedAt: string | null;
  suppressUntil: string | null;
  suppressReason: string | null;
  emailSentAt: string | null;
  emailRecipients: string[] | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EscalatedAlertHistoryRow extends EscalatedAlertSummary {
  resolvedAt: string | null;
  durationMins: number;
  severity: 'CRITICAL' | 'WARNING';
}

export interface EscalationMonthlyReport {
  period: MonthPeriod;
  queueBuildup: {
    summary: {
      total: number;
      critical: number;
      warning: number;
      open: number;
      acknowledged: number;
      suppressed: number;
      resolved: number;
      clientsAffected: number;
      avgDurationMins: number;
      byCluster: Record<string, number>;
    };
    rows: EscalatedAlertHistoryRow[];
  };
  punchAlerts: {
    summary: {
      total: number;
      activeStale: number;
      acknowledged: number;
      suppressed: number;
      notified: number;
    };
    rows: Awaited<ReturnType<typeof unprocPunchAlertService.getPunchAlertHistory>>['rows'];
    liveDataAvailable: boolean;
  };
  payrollDeadlineAlerts: {
    summary: {
      total: number;
      open: number;
      acknowledged: number;
      suppressed: number;
      resolved: number;
      notified: number;
      clientsAffected: number;
      avgDurationMins: number;
      byCluster: Record<string, number>;
    };
    rows: Awaited<ReturnType<typeof payrollDeadlineAlertService.getPayrollDeadlineAlertHistory>>['rows'];
  };
}

class EscalationService {
  /**
   * Critical job types with stale pending for a client (from batch groups + CriticalDbJob).
   */
  private filterImpactedJobs(
    clientId: string,
    groups: BatchJobGroup[],
    criticalSet: Set<string>
  ): ImpactedJobRow[] {
    return groups
      .filter(g => criticalSet.has(`${clientId}::${g.jobType || ''}`) && (g.stalePending || 0) > 0)
      .map(g => ({
        jobType: (g.jobType || '').trim(),
        planType: (g.planType || '').trim(),
        stalePending: g.stalePending || 0,
        pending: g.pending || 0,
      }))
      .sort((a, b) => b.stalePending - a.stalePending);
  }

  /**
   * Resolve impacted job types per client for notification emails.
   */
  private async getImpactedJobsByClient(clientIds: string[]): Promise<Map<string, ImpactedJobRow[]>> {
    const uniqueIds = [...new Set(clientIds)];
    const result = new Map<string, ImpactedJobRow[]>();

    if (uniqueIds.length === 0) return result;

    const criticalJobs = await prisma.criticalDbJob.findMany({
      where: { clientId: { in: uniqueIds } },
      select: { clientId: true, jobName: true },
    });
    const criticalSet = new Set(criticalJobs.map(cj => `${cj.clientId}::${cj.jobName}`));
    const days = configService.getInt('engine.dbMonitorBatchDays');

    let batchSummary: Awaited<ReturnType<typeof db2DirectService.getAllBatchStatusSummary>> | null = null;
    try {
      batchSummary = await db2DirectService.getAllBatchStatusSummary(days);
    } catch (err: any) {
      logger.warn(`[Notify] Batch summary unavailable for job types: ${err.message}`);
    }

    for (const clientId of uniqueIds) {
      const cachedGroups = batchSummary?.clients[clientId]?.groups;
      if (cachedGroups?.length) {
        result.set(clientId, this.filterImpactedJobs(clientId, cachedGroups, criticalSet));
        continue;
      }

      try {
        const groups = await db2DirectService.getBatchStatusGrouped(clientId, days);
        result.set(clientId, this.filterImpactedJobs(clientId, groups, criticalSet));
      } catch (err: any) {
        logger.warn(`[Notify] Could not load batch groups for ${clientId}: ${err.message}`);
        result.set(clientId, []);
      }
    }

    return result;
  }

  /**
   * Check current pending alerts and escalate any that have been pending > 1 hour.
   * Called after batch-status-all data is fetched.
   */
  async processEscalations(
    pendingAlerts: { clientId: string; stalePendingCount: number; totalPending: number }[],
    clientServerCodes: Map<string, string> // clientId -> serverCode
  ): Promise<void> {
    const now = new Date();
    const oneHourAgo = getEscalationThresholdDate();

    for (const alert of pendingAlerts) {
      const serverCode = clientServerCodes.get(alert.clientId) || alert.clientId;

      // Check if there's already an active (non-resolved) escalated alert for this client
      const existing = await prisma.escalatedAlert.findFirst({
        where: {
          clientId: alert.clientId,
          resolvedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        // Update counts and lastSeenAt
        await prisma.escalatedAlert.update({
          where: { id: existing.id },
          data: {
            stalePendingCount: alert.stalePendingCount,
            totalPending: alert.totalPending,
            lastSeenAt: now,
          },
        });

        // Check if suppression has expired → reopen
        if (existing.status === 'SUPPRESSED' && existing.suppressUntil && new Date(existing.suppressUntil) < now) {
          await prisma.escalatedAlert.update({
            where: { id: existing.id },
            data: { status: 'OPEN', suppressedBy: null, suppressedAt: null, suppressUntil: null },
          });
          logger.info(`Suppression expired for ${alert.clientId}, reopened`);
        }

        // Auto-ack (system) expires after default suppress window → reopen for re-notification
        if (
          existing.status === 'ACKNOWLEDGED'
          && existing.acknowledgedBy === SYSTEM_ESCALATION_ACTOR
          && existing.acknowledgedAt
        ) {
          const ackExpiresAt = existing.acknowledgedAt.getTime() + getAutoAckDurationMins() * 60 * 1000;
          if (now.getTime() >= ackExpiresAt) {
            await prisma.escalatedAlert.update({
              where: { id: existing.id },
              data: { status: 'OPEN', acknowledgedBy: null, acknowledgedAt: null },
            });
            logger.info(`Auto-ack expired for ${alert.clientId}, reopened`);
          }
        }
      } else {
        // Create new escalated alert — but only if stale pending has been around for a while
        // We create it now and check firstSeenAt for the 1-hour threshold on the read side
        await prisma.escalatedAlert.create({
          data: {
            clientId: alert.clientId,
            serverCode,
            stalePendingCount: alert.stalePendingCount,
            totalPending: alert.totalPending,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
        logger.info(`New escalated alert created for ${alert.clientId} (${alert.stalePendingCount} stale pending)`);
      }
    }

    // Resolve any escalated alerts whose clients are no longer in the pending list
    const activeClientIds = new Set(pendingAlerts.map(a => a.clientId));
    const openAlerts = await prisma.escalatedAlert.findMany({
      where: { resolvedAt: null },
    });

    for (const oa of openAlerts) {
      if (!activeClientIds.has(oa.clientId)) {
        await prisma.escalatedAlert.update({
          where: { id: oa.id },
          data: { resolvedAt: now, status: 'OPEN' },
        });
        logger.info(`Escalated alert resolved for ${oa.clientId} — no longer pending`);
      }
    }

    await this.processAutoEscalationNotifyAndAck();
  }

  /**
   * When escalated alerts are eligible, email recipients (all types) and system-ack for Default Suppress (min).
   */
  private async processAutoEscalationNotifyAndAck(): Promise<void> {
    await this.runAutoEscalationNotifyAndAck();
  }

  private autoNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private autoNotifyInFlight: Promise<void> | null = null;

  /**
   * Debounced auto-notify — use after per-client payroll/punch updates so one email covers a batch.
   */
  scheduleAutoEscalationNotify(delayMs = 5000): void {
    if (!this.isAutoEscalationNotifyMasterEnabled()) {
      return;
    }
    if (this.autoNotifyTimer) clearTimeout(this.autoNotifyTimer);
    this.autoNotifyTimer = setTimeout(() => {
      this.autoNotifyTimer = null;
      this.runAutoEscalationNotifyAndAck().catch(err => {
        logger.warn(`[AutoEscalation] Scheduled notify failed: ${err?.message || err}`);
      });
    }, delayMs);
  }

  private isAutoEscalationNotifyMasterEnabled(): boolean {
    return configService.getBool('engine.autoEscalationNotifyEnabled', true);
  }

  /** Per-type auto-email flags (Admin Config). Manual Notify Team ignores these. */
  private getAutoNotifyTypeFlags(): { queue: boolean; payroll: boolean; punch: boolean } {
    return {
      queue: configService.getBool('engine.autoEscalationNotifyQueueEnabled', true),
      payroll: configService.getBool('engine.autoEscalationNotifyPayrollEnabled', true),
      punch: configService.getBool('engine.autoEscalationNotifyPunchEnabled', true),
    };
  }

  /**
   * Auto-email eligible escalated alert types (per-type flags) and system-ack.
   * Guarded by engine.autoEscalationNotifyEnabled plus per-type flags.
   */
  async runAutoEscalationNotifyAndAck(): Promise<void> {
    if (!this.isAutoEscalationNotifyMasterEnabled()) {
      return;
    }
    if (this.autoNotifyInFlight) {
      return this.autoNotifyInFlight;
    }
    this.autoNotifyInFlight = this.doAutoEscalationNotifyAndAck().finally(() => {
      this.autoNotifyInFlight = null;
    });
    return this.autoNotifyInFlight;
  }

  private async doAutoEscalationNotifyAndAck(): Promise<void> {
    const result = await this.sendAllEligibleEscalationEmails({ respectTypeFlags: true });
    if (result.sent <= 0) {
      if (result.error) {
        logger.warn(`[AutoEscalation] Email not sent: ${result.error}`);
      }
      return;
    }

    logger.info(
      `[AutoEscalation] Notified queue=${result.queueIds.length} payroll=${result.payrollClientIds.length} punch=${result.punchClientIds.length}`,
    );

    const ackMins = getAutoAckDurationMins();
    for (const id of result.queueIds) {
      await this.autoAcknowledgeEscalation(id);
    }
    for (const clientId of result.payrollClientIds) {
      try {
        await payrollDeadlineAlertService.acknowledge(clientId, SYSTEM_ESCALATION_ACTOR);
        logger.info(`[AutoEscalation] Auto-ack payroll ${clientId} for ${ackMins} min`);
      } catch (err: any) {
        logger.warn(`[AutoEscalation] Payroll auto-ack ${clientId}: ${err?.message || err}`);
      }
    }
    for (const clientId of result.punchClientIds) {
      try {
        await unprocPunchAlertService.acknowledge(clientId, SYSTEM_ESCALATION_ACTOR);
        logger.info(`[AutoEscalation] Auto-ack punch ${clientId} for ${ackMins} min`);
      } catch (err: any) {
        logger.warn(`[AutoEscalation] Punch auto-ack ${clientId}: ${err?.message || err}`);
      }
    }
  }

  /** System auto-ack after escalation email — expires via processEscalations. */
  private async autoAcknowledgeEscalation(alertId: string): Promise<void> {
    await prisma.escalatedAlert.update({
      where: { id: alertId },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedBy: SYSTEM_ESCALATION_ACTOR,
        acknowledgedAt: new Date(),
      },
    });
  }

  private notifySectionHtml(title: string, headers: string[], rowsHtml: string): string {
    const head = headers.map(h => `<th style="padding:8px 12px;text-align:left;">${escHtml(h)}</th>`).join('');
    return `
    <h3 style="margin:20px 0 8px;font-size:14px;color:#333;">${escHtml(title)}</h3>
    <table style="width:100%;border-collapse:collapse;margin:0 0 8px;font-size:13px;">
      <thead><tr style="background:#f5f5f5;border-bottom:2px solid #ddd;">${head}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
  }

  /**
   * One email covering stuck jobs, payroll deadlines, and unprocessed punches (Notify Team / auto).
   * When punchRows is omitted, uses server punch cache + stale thresholds (OPEN only).
   * When respectTypeFlags is true (auto path), per-type Admin Config flags gate each section.
   */
  async sendAllEligibleEscalationEmails(options?: {
    punchRows?: PunchNotifyRow[];
    respectTypeFlags?: boolean;
  }): Promise<NotifyAllResult> {
    const empty: NotifyAllResult = {
      sent: 0,
      skipped: 1,
      recipients: [],
      details: [],
      queueIds: [],
      payrollClientIds: [],
      punchClientIds: [],
    };

    if (!alertService.isEmailConfigured()) {
      const err =
        'SMTP not configured — set secrets.smtpHost in Admin > Config and restart the backend';
      return { ...empty, skipped: 0, error: err, details: [err] };
    }

    const allRecipients = await prisma.notificationRecipient.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    if (!allRecipients.length) {
      const msg = 'No active notification recipients configured';
      return { ...empty, details: [msg], error: msg };
    }

    const typeFlags = options?.respectTypeFlags
      ? this.getAutoNotifyTypeFlags()
      : { queue: true, payroll: true, punch: true };

    const queue = typeFlags.queue
      ? await this.collectEligibleQueueNotify()
      : { ids: [] as string[], linesHtml: '' };
    const payroll = typeFlags.payroll
      ? await payrollDeadlineAlertService.listOpenForNotify()
      : [];

    let punchRows: PunchNotifyRow[] = [];
    if (typeFlags.punch) {
      if (options?.punchRows) {
        const punchStatuses = await unprocPunchAlertService.getAlertStatuses();
        punchRows = unprocPunchAlertService.filterNotifyEligible(options.punchRows, punchStatuses);
      } else {
        punchRows = await unprocPunchAlertService.getStaleOpenRowsForNotify();
      }
    }

    const sections: string[] = [];
    const parts: string[] = [];
    if (queue.ids.length) {
      parts.push(`${queue.ids.length} stuck job client(s)`);
      sections.push(this.notifySectionHtml(
        'Stuck jobs',
        ['Client', 'Server', 'Job type', 'Plan', 'Stale', 'Pending', 'Since'],
        queue.linesHtml,
      ));
    }
    if (payroll.length) {
      parts.push(`${payroll.length} payroll deadline client(s)`);
      sections.push(this.notifySectionHtml(
        'Payroll deadline',
        ['Client', 'Code', 'Week end', 'Deadline', 'Pending', 'Late'],
        payroll.map(a => `<tr>
          <td style="padding:6px 12px;font-weight:bold;">${escHtml(a.clientName && a.clientName !== a.clientId ? a.clientName : a.clientId)}</td>
          <td style="padding:6px 12px;font-family:monospace;">${escHtml(a.clientId)}</td>
          <td style="padding:6px 12px;font-family:monospace;">${escHtml(a.weekEndDate || '—')}</td>
          <td style="padding:6px 12px;">${escHtml(a.deadlineAt || '—')}</td>
          <td style="padding:6px 12px;color:#c62828;font-weight:bold;">${a.pendingUnits} / ${a.totalUnits}</td>
          <td style="padding:6px 12px;color:#c62828;font-weight:bold;">${a.lateMinutes != null ? `${a.lateMinutes}m` : '—'}</td>
        </tr>`).join(''),
      ));
    }
    if (punchRows.length) {
      parts.push(`${punchRows.length} unprocessed punch client(s)`);
      sections.push(this.notifySectionHtml(
        'Unprocessed punches',
        ['Client', 'Code', 'Cluster', 'Pending punches', 'Last update'],
        [...punchRows].sort((a, b) => b.punchCount - a.punchCount).map(r => `<tr>
          <td style="padding:6px 12px;font-weight:bold;">${escHtml(r.name && r.name !== r.clientId ? r.name : r.clientId)}</td>
          <td style="padding:6px 12px;font-family:monospace;">${escHtml(r.clientId)}</td>
          <td style="padding:6px 12px;">${escHtml(r.cluster || '—')}</td>
          <td style="padding:6px 12px;color:#c62828;font-weight:bold;">${r.punchCount.toLocaleString()}</td>
          <td style="padding:6px 12px;font-family:monospace;font-size:12px;color:#666;">${escHtml(r.lastUpdateTime ?? '—')}</td>
        </tr>`).join(''),
      ));
    }

    if (!sections.length) {
      const cooldownMins = configService.getNotifyCooldownMins();
      const disabled = options?.respectTypeFlags
        ? [
            !typeFlags.queue ? 'stuck jobs' : null,
            !typeFlags.payroll ? 'payroll deadline' : null,
            !typeFlags.punch ? 'unprocessed punch' : null,
          ].filter(Boolean)
        : [];
      const msg = disabled.length
        ? `No open alerts to notify (auto-email disabled for: ${disabled.join(', ')}; or none qualify / cooldown)`
        : `No open alerts to notify (or all were emailed within the last ${cooldownMins} minutes)`;
      return { ...empty, details: [msg] };
    }

    const emails = allRecipients.map(r => r.email);
    const summary = parts.join(', ');
    const { subject, html } = buildAllAlertsNotifyEmail({
      appName: configService.getAppName(),
      sectionsHtml: sections.join(''),
      summary,
      recipients: emails,
      sentAt: new Date(),
    });

    try {
      const sendResult = await alertService.sendDirectEmail(emails, subject, html);
      if (queue.ids.length) await this.markQueueNotifySent(queue.ids, sendResult.accepted);
      if (payroll.length) {
        await payrollDeadlineAlertService.recordEmailSent(payroll.map(a => a.clientId));
      }
      if (punchRows.length) {
        await unprocPunchAlertService.recordEmailSent(punchRows.map(r => r.clientId));
      }

      const sent = queue.ids.length + payroll.length + punchRows.length;
      const details = [`One email sent to ${sendResult.accepted.join(', ')}: ${summary}`];
      logger.info(`[NotifyAll] ${summary} → ${sendResult.accepted.join(', ')}`);
      return {
        sent,
        skipped: 0,
        recipients: sendResult.accepted,
        details,
        queueIds: queue.ids,
        payrollClientIds: payroll.map(a => a.clientId),
        punchClientIds: punchRows.map(r => r.clientId),
      };
    } catch (err: any) {
      const errMsg = err.message || 'Unknown SMTP error';
      logger.error(`[NotifyAll] Failed: ${errMsg}`);
      return { ...empty, skipped: 0, error: errMsg, details: [errMsg] };
    }
  }

  /**
   * Resolve any open escalated alerts for a single client (used by per-client refresh).
   */
  async resolveClientEscalation(clientId: string): Promise<void> {
    const now = new Date();
    const open = await prisma.escalatedAlert.findMany({
      where: { clientId, resolvedAt: null },
    });
    for (const oa of open) {
      await prisma.escalatedAlert.update({
        where: { id: oa.id },
        data: { resolvedAt: now, status: 'OPEN' },
      });
      logger.info(`Escalated alert resolved for ${clientId} — no longer pending (per-client refresh)`);
    }
  }

  /**
   * Get all escalated alerts (pending > 1 hour, unresolved, not actively suppressed).
   */
  async getEscalatedAlerts(): Promise<EscalatedAlertSummary[]> {
    const now = new Date();
    const oneHourAgo = getEscalationThresholdDate();

    const alerts = await prisma.escalatedAlert.findMany({
      where: {
        resolvedAt: null,
        firstSeenAt: { lte: oneHourAgo },
      },
      orderBy: { stalePendingCount: 'desc' },
    });

    // Enrich with client names and clusters
    const dbClients = await prisma.client.findMany({
      select: { clientId: true, name: true, cluster: true },
    });
    const clientMap = new Map(dbClients.map(c => [c.clientId.toUpperCase(), { name: c.name, cluster: c.cluster || '' }]));

    const criticalByClient = new Map<string, string[]>();
    if (alerts.length > 0) {
      const criticalJobs = await prisma.criticalDbJob.findMany({
        where: { clientId: { in: [...new Set(alerts.map(a => a.clientId))] } },
        select: { clientId: true, jobName: true },
      });
      for (const cj of criticalJobs) {
        const key = cj.clientId.toUpperCase();
        const list = criticalByClient.get(key);
        if (list) list.push(cj.jobName);
        else criticalByClient.set(key, [cj.jobName]);
      }
    }

    return alerts.map(a => {
      const match = clientMap.get(a.serverCode.toUpperCase()) || clientMap.get(a.clientId.toUpperCase());
      return {
        id: a.id,
        clientId: a.clientId,
        serverCode: a.serverCode,
        clientName: match?.name || a.clientId,
        cluster: match?.cluster || '',
        stalePendingCount: a.stalePendingCount,
        totalPending: a.totalPending,
        criticalJobNames: criticalByClient.get(a.clientId.toUpperCase()) ?? [],
        status: a.status,
        acknowledgedBy: a.acknowledgedBy,
        acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
        suppressedBy: a.suppressedBy,
        suppressedAt: a.suppressedAt?.toISOString() || null,
        suppressUntil: a.suppressUntil?.toISOString() || null,
        suppressReason: a.suppressReason,
        emailSentAt: a.emailSentAt?.toISOString() || null,
        emailRecipients: a.emailRecipients ? JSON.parse(a.emailRecipients) : null,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
      };
    });
  }

  /**
   * Acknowledge an escalated alert.
   */
  async acknowledge(alertId: string, userId: string): Promise<void> {
    await prisma.escalatedAlert.update({
      where: { id: alertId },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      },
    });
    logger.info(`Escalated alert ${alertId} acknowledged by ${userId}`);
  }

  /**
   * Suppress an escalated alert for a given duration.
   */
  async suppress(alertId: string, userId: string, durationMinutes: number, reason?: string): Promise<void> {
    const suppressUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
    await prisma.escalatedAlert.update({
      where: { id: alertId },
      data: {
        status: 'SUPPRESSED',
        suppressedBy: userId,
        suppressedAt: new Date(),
        suppressUntil,
        suppressReason: reason || null,
      },
    });
    logger.info(`Escalated alert ${alertId} suppressed by ${userId} until ${suppressUntil.toISOString()}`);
  }

  /** Open stuck-job alerts outside the notify cooldown, rendered for a combined email. */
  async collectEligibleQueueNotify(alertIds?: string[]): Promise<{ ids: string[]; linesHtml: string }> {
    const notifyCooldownSince = getNotifyCooldownDate();
    const where: any = {
      resolvedAt: null,
      status: 'OPEN',
      OR: [
        { emailSentAt: null },
        { emailSentAt: { lt: notifyCooldownSince } },
      ],
    };
    if (alertIds?.length) where.id = { in: alertIds };
    else where.firstSeenAt = { lte: getEscalationThresholdDate() };

    const alerts = await prisma.escalatedAlert.findMany({ where, orderBy: { stalePendingCount: 'desc' } });
    if (!alerts.length) return { ids: [], linesHtml: '' };

    const dbClients = await prisma.client.findMany({ select: { clientId: true, name: true } });
    const nameMap = new Map(dbClients.map(c => [c.clientId.toUpperCase(), c.name]));
    const impactedByClient = await this.getImpactedJobsByClient(alerts.map(a => a.clientId));
    const alertLines: string[] = [];
    for (const a of alerts) {
      const name = nameMap.get(a.serverCode.toUpperCase()) ?? nameMap.get(a.clientId.toUpperCase()) ?? a.clientId;
      const since = escHtml(a.firstSeenAt.toLocaleString());
      const jobs = impactedByClient.get(a.clientId) ?? [];
      if (jobs.length === 0) {
        alertLines.push(`<tr>
        <td style="padding: 6px 12px; font-weight: bold;">${escHtml(name)}</td>
        <td style="padding: 6px 12px; font-family: monospace;">${escHtml(a.serverCode)}</td>
        <td style="padding: 6px 12px; color: #888; font-style: italic;">(no critical job detail)</td>
        <td style="padding: 6px 12px;">—</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">${a.stalePendingCount}</td>
        <td style="padding: 6px 12px;">${a.totalPending}</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">${since}</td>
      </tr>`);
        continue;
      }
      jobs.forEach((job, idx) => {
        const plan = job.planType ? escHtml(job.planType) : '—';
        alertLines.push(`<tr>
        <td style="padding: 6px 12px; font-weight: bold;">${idx === 0 ? escHtml(name) : ''}</td>
        <td style="padding: 6px 12px; font-family: monospace;">${idx === 0 ? escHtml(a.serverCode) : ''}</td>
        <td style="padding: 6px 12px; font-family: monospace; font-weight: 600;">${escHtml(job.jobType)}</td>
        <td style="padding: 6px 12px;">${plan}</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">${job.stalePending}</td>
        <td style="padding: 6px 12px;">${job.pending}</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">${idx === 0 ? since : ''}</td>
      </tr>`);
      });
    }
    return { ids: alerts.map(a => a.id), linesHtml: alertLines.join('') };
  }

  async markQueueNotifySent(ids: string[], recipients: string[]): Promise<void> {
    const now = new Date();
    for (const id of ids) {
      await prisma.escalatedAlert.update({
        where: { id },
        data: { emailSentAt: now, emailRecipients: JSON.stringify(recipients) },
      });
    }
  }

  /**
   * Send email notifications for escalated (red) alerts directly to NotificationRecipients.
   * Does NOT go through AlertRule matching — sends unconditionally to all active recipients.
   */
  async sendEscalationEmails(alertIds?: string[]): Promise<{
    sent: number;
    skipped: number;
    failed: number;
    recipients: string[];
    rejectedRecipients: string[];
    error?: string;
    details: string[];
  }> {
    const now = new Date();
    const notifyCooldownSince = getNotifyCooldownDate();
    const details: string[] = [];

    logger.info(`[Notify] ===== Notify Team triggered${alertIds?.length ? ` for ${alertIds.length} alert(s)` : ' (all open alerts)'} =====`);

    // ── 1. Check SMTP config ───────────────────────────────────────────────
    if (!alertService.isEmailConfigured()) {
      const err =
        'SMTP not configured — set secrets.smtpHost in Admin > Config (e.g. localhost:1025 for Mailpit) and restart the backend';
      logger.error(`[Notify] ${err}`);
      return { sent: 0, skipped: 0, failed: 0, recipients: [], rejectedRecipients: [], error: err, details: [err] };
    }
    logger.info('[Notify] ✓ SMTP transporter is configured');

    // ── 2. Load active recipients ──────────────────────────────────────────
    const allRecipients = await prisma.notificationRecipient.findMany({ orderBy: { name: 'asc' } });
    const recipients = allRecipients.filter(r => r.isActive);

    logger.info(`[Notify] Recipients: ${allRecipients.length} total, ${recipients.length} active`);
    allRecipients.forEach(r => {
      logger.info(`[Notify]   ${r.isActive ? '✓' : '✗'} ${r.name} <${r.email}>`);
    });

    if (recipients.length === 0) {
      const msg = allRecipients.length === 0
        ? 'No notification recipients configured — add recipients in the Notify Team panel'
        : `All ${allRecipients.length} recipient(s) are inactive — activate at least one`;
      logger.warn(`[Notify] ${msg}`);
      return { sent: 0, skipped: 0, failed: 0, recipients: [], rejectedRecipients: [], error: msg, details: [msg] };
    }

    const emails = recipients.map(r => r.email);

    // ── 3. Load alerts to notify ───────────────────────────────────────────
    const where: any = { resolvedAt: null };

    where.OR = [
      { emailSentAt: null },
      { emailSentAt: { lt: notifyCooldownSince } },
    ];

    if (alertIds?.length) {
      where.id = { in: alertIds };
      logger.info(`[Notify] Manual notify for alert IDs: ${alertIds.join(', ')}`);
    } else {
      // Bulk notify: only escalated long enough and OPEN
      where.firstSeenAt = { lte: getEscalationThresholdDate() };
      where.status = 'OPEN';
    }

    const alerts = await prisma.escalatedAlert.findMany({ where, orderBy: { stalePendingCount: 'desc' } });
    logger.info(`[Notify] Alerts to send: ${alerts.length}`);

    if (alerts.length === 0) {
      const cooldownMins = configService.getNotifyCooldownMins();
      const msg = `No eligible open alerts to notify (all already emailed within the last ${cooldownMins} minutes, or none qualify)`;
      logger.info(`[Notify] ${msg}`);
      return { sent: 0, skipped: 1, failed: 0, recipients: emails, rejectedRecipients: [], details: [msg] };
    }

    // ── 4. Enrich with client names + impacted job types ───────────────────
    const dbClients = await prisma.client.findMany({ select: { clientId: true, name: true } });
    const nameMap = new Map(dbClients.map(c => [c.clientId.toUpperCase(), c.name]));
    const impactedByClient = await this.getImpactedJobsByClient(alerts.map(a => a.clientId));

    alerts.forEach(a => {
      const jobs = impactedByClient.get(a.clientId) ?? [];
      const jobTypes = jobs.map(j => j.jobType).join(', ') || '(none)';
      logger.info(
        `[Notify]   Alert: ${a.clientId} / ${a.serverCode} — ${a.stalePendingCount} stale, jobs=[${jobTypes}], lastEmail=${a.emailSentAt?.toISOString() ?? 'never'}`
      );
    });

    const alertLines: string[] = [];
    for (const a of alerts) {
      const name = nameMap.get(a.serverCode.toUpperCase()) ?? nameMap.get(a.clientId.toUpperCase()) ?? a.clientId;
      const since = escHtml(a.firstSeenAt.toLocaleString());
      const jobs = impactedByClient.get(a.clientId) ?? [];

      if (jobs.length === 0) {
        alertLines.push(`<tr>
        <td style="padding: 6px 12px; font-weight: bold;">${escHtml(name)}</td>
        <td style="padding: 6px 12px; font-family: monospace;">${escHtml(a.serverCode)}</td>
        <td style="padding: 6px 12px; color: #888; font-style: italic;">(no critical job detail)</td>
        <td style="padding: 6px 12px;">—</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">${a.stalePendingCount}</td>
        <td style="padding: 6px 12px;">${a.totalPending}</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">${since}</td>
      </tr>`);
        continue;
      }

      jobs.forEach((job, idx) => {
        const plan = job.planType ? escHtml(job.planType) : '—';
        alertLines.push(`<tr>
        <td style="padding: 6px 12px; font-weight: bold;">${idx === 0 ? escHtml(name) : ''}</td>
        <td style="padding: 6px 12px; font-family: monospace;">${idx === 0 ? escHtml(a.serverCode) : ''}</td>
        <td style="padding: 6px 12px; font-family: monospace; font-weight: 600;">${escHtml(job.jobType)}</td>
        <td style="padding: 6px 12px;">${plan}</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">${job.stalePending}</td>
        <td style="padding: 6px 12px;">${job.pending}</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">${idx === 0 ? since : ''}</td>
      </tr>`);
      });
    }

    // ── 5. Build email ─────────────────────────────────────────────────────
    const appName = configService.getAppName();
    const { subject, html } = buildQueueBuildupNotifyEmail({
      appName,
      clientCount: alerts.length,
      alertLinesHtml: alertLines.join(''),
      recipients: emails,
      sentAt: now,
    });

    // ── 6. Send ────────────────────────────────────────────────────────────
    logger.info(`[Notify] Sending email — subject: "${subject}"`);
    logger.info(`[Notify] To: ${emails.join(', ')}`);

    try {
      const sendResult = await alertService.sendDirectEmail(emails, subject, html);
      const accepted = sendResult.accepted;
      const rejected = sendResult.rejected;

      logger.info(`[Notify] ✓ Email sent — accepted: [${accepted.join(', ')}]${rejected.length ? `, REJECTED: [${rejected.join(', ')}]` : ''}`);
      details.push(`Email delivered to ${accepted.length} recipient(s): ${accepted.join(', ')}`);
      if (rejected.length) {
        details.push(`Rejected by SMTP server: ${rejected.join(', ')}`);
        logger.warn(`[Notify] SMTP rejected: ${rejected.join(', ')}`);
      }

      // ── 7. Mark alerts as sent ─────────────────────────────────────────
      for (const alert of alerts) {
        await prisma.escalatedAlert.update({
          where: { id: alert.id },
          data: { emailSentAt: now, emailRecipients: JSON.stringify(emails) },
        });
      }
      logger.info(`[Notify] Updated emailSentAt for ${alerts.length} alert(s)`);
      details.push(`Updated ${alerts.length} alert record(s) with emailSentAt timestamp`);

      logger.info(`[Notify] ===== DONE: ${alerts.length} alert(s) notified to ${accepted.length} recipient(s) =====`);
      return {
        sent: alerts.length,
        skipped: 0,
        failed: 0,
        recipients: accepted,
        rejectedRecipients: rejected,
        details,
      };
    } catch (err: any) {
      const errMsg = err.message || 'Unknown SMTP error';
      logger.error(`[Notify] ✗ Failed to send email: ${errMsg}`);
      logger.error(`[Notify] Stack: ${err.stack ?? 'no stack'}`);
      details.push(`FAILED: ${errMsg}`);
      return {
        sent: 0,
        skipped: 0,
        failed: alerts.length,
        recipients: [],
        rejectedRecipients: [],
        error: errMsg,
        details,
      };
    }
  }

  /**
   * Send a simple test email to all active notification recipients (Mailpit / SMTP smoke test).
   */
  async sendTestEmail(): Promise<{
    sent: boolean;
    recipients: string[];
    error?: string;
    details: string[];
  }> {
    const details: string[] = [];

    if (!alertService.isEmailConfigured()) {
      const err =
        'SMTP not configured — set secrets.smtpHost / secrets.smtpPort in Admin > Config (Mailpit: localhost, 1025)';
      return { sent: false, recipients: [], error: err, details: [err] };
    }

    const recipients = (await prisma.notificationRecipient.findMany({ where: { isActive: true } }))
      .map(r => r.email);
    if (recipients.length === 0) {
      const err = 'No active notification recipients — add one under Alerts > Recipients';
      return { sent: false, recipients: [], error: err, details: [err] };
    }

    const now = new Date().toISOString();
    const appName = configService.getAppName();
    const subject = `[TEST] ${appName} — notification email`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 520px;">
        <h2 style="color: #4338ca;">${appName} — test email</h2>
        <p>If you see this in Mailpit, SMTP is working.</p>
        <p style="color: #666; font-size: 12px;">Sent at ${now}</p>
      </div>`;

    try {
      const result = await alertService.sendDirectEmail(recipients, subject, html);
      details.push(`Accepted: ${result.accepted.join(', ')}`);
      if (result.rejected.length) {
        details.push(`Rejected: ${result.rejected.join(', ')}`);
      }
      return { sent: result.accepted.length > 0, recipients: result.accepted, details };
    } catch (err: any) {
      return {
        sent: false,
        recipients: [],
        error: err.message || 'SMTP send failed',
        details: [err.message || 'SMTP send failed'],
      };
    }
  }

  /**
   * Get notification recipients list.
   */
  async getRecipients() {
    return prisma.notificationRecipient.findMany({ orderBy: { name: 'asc' } });
  }

  /**
   * Add a notification recipient.
   */
  async addRecipient(name: string, email: string) {
    return prisma.notificationRecipient.create({
      data: { name, email },
    });
  }

  /**
   * Remove a notification recipient.
   */
  async removeRecipient(id: string) {
    return prisma.notificationRecipient.delete({ where: { id } });
  }

  /**
   * Toggle a notification recipient active/inactive.
   */
  async toggleRecipient(id: string) {
    const r = await prisma.notificationRecipient.findUniqueOrThrow({ where: { id } });
    return prisma.notificationRecipient.update({
      where: { id },
      data: { isActive: !r.isActive },
    });
  }

  /**
   * Escalation report for a month or quarter: queue-buildup, punch, and payroll deadline alerts.
   */
  async getMonthlyReport(options: {
    year: number;
    month?: number;
    quarter?: number;
    cluster?: string;
    clientId?: string;
  }): Promise<EscalationMonthlyReport> {
    const period = options.quarter != null
      ? parseQuarterPeriod(options.year, options.quarter)
      : parseMonthPeriod(options.year, options.month!);
    const asOf = periodContainsNow(period) ? new Date() : period.end;
    const queueBuildup = await this.getQueueBuildupHistory({
      start: period.start,
      end: period.end,
      asOf,
      cluster: options.cluster,
      clientId: options.clientId,
    });
    const punchAlerts = await unprocPunchAlertService.getPunchAlertHistory({
      start: period.start,
      end: period.end,
      cluster: options.cluster,
      clientId: options.clientId,
      includeLiveStale: periodContainsNow(period),
    });
    const payrollDeadlineAlerts = await payrollDeadlineAlertService.getPayrollDeadlineAlertHistory({
      start: period.start,
      end: period.end,
      asOf,
      cluster: options.cluster,
      clientId: options.clientId,
    });

    return { period, queueBuildup, punchAlerts, payrollDeadlineAlerts };
  }

  /**
   * Critical queue-buildup escalations active during the report window.
   * Includes alerts that started before the period but were still open, or resolved during it.
   */
  async getQueueBuildupHistory(options: {
    start: Date;
    end: Date;
    asOf?: Date;
    cluster?: string;
    clientId?: string;
  }) {
    const { start, end, cluster, clientId, asOf = end } = options;

    const alerts = await prisma.escalatedAlert.findMany({
      where: {
        firstSeenAt: { lte: end },
        OR: [
          { resolvedAt: null },
          { resolvedAt: { gte: start } },
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

    let rows: EscalatedAlertHistoryRow[] = alerts.map(a => {
      const match =
        clientMap.get(a.serverCode.toUpperCase()) || clientMap.get(a.clientId.toUpperCase());
      const durationMins = computeDurationMins(a.firstSeenAt, a.resolvedAt, a.lastSeenAt);
      return {
        id: a.id,
        clientId: a.clientId,
        serverCode: a.serverCode,
        clientName: match?.name || a.clientId,
        cluster: match?.cluster || '',
        stalePendingCount: a.stalePendingCount,
        totalPending: a.totalPending,
        status: a.status,
        acknowledgedBy: a.acknowledgedBy,
        acknowledgedAt: a.acknowledgedAt?.toISOString() || null,
        suppressedBy: a.suppressedBy,
        suppressedAt: a.suppressedAt?.toISOString() || null,
        suppressUntil: a.suppressUntil?.toISOString() || null,
        suppressReason: a.suppressReason,
        emailSentAt: a.emailSentAt?.toISOString() || null,
        emailRecipients: a.emailRecipients ? JSON.parse(a.emailRecipients) : null,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() || null,
        durationMins,
        severity: deriveQueueSeverity(a.stalePendingCount),
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
      critical: rows.filter(r => r.severity === 'CRITICAL').length,
      warning: rows.filter(r => r.severity === 'WARNING').length,
      open: rows.filter(r => isOpenAtPeriodEnd(
        r.resolvedAt ? new Date(r.resolvedAt) : null,
        asOf,
      )).length,
      acknowledged: rows.filter(r => r.status === 'ACKNOWLEDGED').length,
      suppressed: rows.filter(r => r.status === 'SUPPRESSED').length,
      resolved: resolvedRows.length,
      clientsAffected: new Set(rows.map(r => r.clientId)).size,
      avgDurationMins,
      byCluster,
    };

    return { summary, rows };
  }
}

export const escalationService = new EscalationService();
