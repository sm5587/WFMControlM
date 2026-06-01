// ============================================================
// Escalation Service
// Monitors pending alerts > 1 hour → escalates to "Red" status
// Handles acknowledge, suppress, and email notifications
// ============================================================

import { prisma } from '../database/prisma';
import { alertService } from './alert-service';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';

function getEscalationThresholdDate(): Date {
  const mins = configService.getInt('threshold.escalationMins', 60);
  return new Date(Date.now() - mins * 60 * 1000);
}

const logger = createServiceLogger('EscalationService');

export interface EscalatedAlertSummary {
  id: string;
  clientId: string;
  serverCode: string;
  clientName: string;
  cluster: string;
  stalePendingCount: number;
  totalPending: number;
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

class EscalationService {
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
    const oneHourAgo = getEscalationThresholdDate();
    const details: string[] = [];

    logger.info(`[Notify] ===== Notify Team triggered${alertIds?.length ? ` for ${alertIds.length} alert(s)` : ' (all open alerts)'} =====`);

    // ── 1. Check SMTP config ───────────────────────────────────────────────
    if (!alertService.isEmailConfigured()) {
      const err = 'SMTP not configured — set SMTP_HOST and SMTP_USER in environment variables';
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
    const where: any = {
      resolvedAt: null,
      firstSeenAt: { lte: oneHourAgo },
    };
    // If specific IDs were given, use them regardless of status/email-sent filter
    if (alertIds?.length) {
      where.id = { in: alertIds };
      logger.info(`[Notify] Filtering to specific IDs: ${alertIds.join(', ')}`);
    } else {
      // Default: only OPEN, not already emailed in last hour
      where.status = 'OPEN';
      where.OR = [
        { emailSentAt: null },
        { emailSentAt: { lt: oneHourAgo } },
      ];
    }

    const alerts = await prisma.escalatedAlert.findMany({ where, orderBy: { stalePendingCount: 'desc' } });
    logger.info(`[Notify] Alerts to send: ${alerts.length}`);

    if (alerts.length === 0) {
      const msg = 'No eligible open alerts to notify (all already emailed within the last hour, or none qualify)';
      logger.info(`[Notify] ${msg}`);
      return { sent: 0, skipped: 1, failed: 0, recipients: emails, rejectedRecipients: [], details: [msg] };
    }

    alerts.forEach(a => {
      logger.info(`[Notify]   Alert: ${a.clientId} / ${a.serverCode} — ${a.stalePendingCount} stale pending, lastEmail=${a.emailSentAt?.toISOString() ?? 'never'}`);
    });

    // ── 4. Enrich with client names ────────────────────────────────────────
    const dbClients = await prisma.client.findMany({ select: { clientId: true, name: true } });
    const nameMap = new Map(dbClients.map(c => [c.clientId.toUpperCase(), c.name]));

    const alertLines = alerts.map(a => {
      const name = nameMap.get(a.serverCode.toUpperCase()) ?? nameMap.get(a.clientId.toUpperCase()) ?? a.clientId;
      const since = a.firstSeenAt.toLocaleString();
      return `<tr>
        <td style="padding: 6px 12px; font-weight: bold;">${name}</td>
        <td style="padding: 6px 12px; font-family: monospace;">${a.serverCode}</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">${a.stalePendingCount}</td>
        <td style="padding: 6px 12px;">${a.totalPending}</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">${since}</td>
      </tr>`;
    });

    // ── 5. Build email ─────────────────────────────────────────────────────
    const subject = `[CRITICAL] WFM Control-M: ${alerts.length} Client(s) with Stale Pending Jobs > 1 Hour`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
        <div style="background: #c62828; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">⚠️ WFM Control-M — Escalation Alert</h2>
          <p style="margin: 6px 0 0; opacity: 0.85; font-size: 14px;">CRITICAL · QUEUE_BUILDUP · ${now.toISOString()}</p>
        </div>
        <div style="border: 1px solid #ddd; border-top: none; padding: 20px 24px; border-radius: 0 0 8px 8px;">
          <p style="font-size: 15px; color: #333;">
            <strong>${alerts.length} client(s)</strong> have jobs pending for more than 1 hour and require immediate attention.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
            <thead>
              <tr style="background: #f5f5f5; border-bottom: 2px solid #ddd;">
                <th style="padding: 8px 12px; text-align: left;">Client</th>
                <th style="padding: 8px 12px; text-align: left;">Server Code</th>
                <th style="padding: 8px 12px; text-align: left;">Stale Pending</th>
                <th style="padding: 8px 12px; text-align: left;">Total Pending</th>
                <th style="padding: 8px 12px; text-align: left;">Since</th>
              </tr>
            </thead>
            <tbody>
              ${alertLines.join('')}
            </tbody>
          </table>
          <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;">
          <p style="color: #888; font-size: 12px;">
            Sent by WFM Control-M at ${now.toISOString()} to: ${emails.join(', ')}
          </p>
        </div>
      </div>
    `;

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
}

export const escalationService = new EscalationService();
