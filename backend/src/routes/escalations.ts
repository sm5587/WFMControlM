// ============================================================
// Escalation Routes
// Red Tab alerts: pending > 1 hour, acknowledge, suppress, email
// ============================================================

import { Router, Request, Response } from 'express';
import { escalationService } from '../services/escalation-service';
import { alertService } from '../services/alert-service';
import { configService } from '../services/config-service';
import { unprocPunchAlertService } from '../services/unproc-punch-alert-service';
import { payrollDeadlineAlertService } from '../services/payroll-deadline-alert-service';
import { payrollService } from '../services/payroll-service';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { requirePermission } from '../middleware';
import { z } from 'zod';
import { buildPunchNotifyEmail, buildPayrollDeadlineNotifyEmail, buildAllAlertsNotifyEmail, escHtml } from '../email/notify-email-templates';

const router = Router();
const logger = createServiceLogger('EscalationsAPI');

router.use((req, res, next) => {
  if (req.method === 'GET') {
    return requirePermission('ALERTS_VIEW', 'read')(req, res, next);
  }
  return next();
});

// GET /api/escalations - Get all escalated alerts (red tab data)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const alerts = await escalationService.getEscalatedAlerts();
    res.json({ success: true, data: alerts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const reportQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12).optional(),
  quarter: z.coerce.number().int().min(1).max(4).optional(),
  cluster: z.string().optional(),
  clientId: z.string().optional(),
}).refine(
  (d) => (d.month != null) !== (d.quarter != null),
  { message: 'Provide either month or quarter' }
);

// GET /api/escalations/report - Escalation report (queue buildup + punch alerts) for a month or quarter
router.get('/report', async (req: Request, res: Response) => {
  try {
    const { year, month, quarter, cluster, clientId } = reportQuerySchema.parse(req.query);
    const report = await escalationService.getMonthlyReport({ year, month, quarter, cluster, clientId });
    res.json({ success: true, data: report });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/:id/acknowledge - Acknowledge an escalated alert (admin only)
router.post('/:id/acknowledge', requirePermission('ALERTS_ACK', 'write'), async (req: Request, res: Response) => {
  try {
    const userId = req.body.userId || 'system';
    await escalationService.acknowledge(req.params.id, userId);
    res.json({ success: true, message: 'Alert acknowledged' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/:id/suppress - Suppress an escalated alert
const suppressSchema = z.object({
  userId: z.string().default('system'),
  durationMinutes: z.number().min(1).max(10080), // Up to 7 days
  reason: z.string().optional(),
});

router.post('/:id/suppress', requirePermission('ALERTS_SUPPRESS', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId, durationMinutes, reason } = suppressSchema.parse(req.body);
    await escalationService.suppress(req.params.id, userId, durationMinutes, reason);
    res.json({ success: true, message: `Alert suppressed for ${durationMinutes} minutes` });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/test-email - SMTP smoke test (all active recipients)
router.post('/test-email', requirePermission('ALERTS_NOTIFY', 'write'), async (_req: Request, res: Response) => {
  try {
    const result = await escalationService.sendTestEmail();
    if (result.error && !result.sent) {
      return res.status(result.recipients.length === 0 && result.error.includes('recipients') ? 400 : 503)
        .json({ success: false, error: result.error, data: result });
    }
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/notify - Send email notifications for escalated alerts
router.post('/notify', requirePermission('ALERTS_NOTIFY', 'write'), async (req: Request, res: Response) => {
  try {
    const alertIds: string[] | undefined = req.body.alertIds;
    logger.info(`Notify Team triggered — alertIds: ${alertIds?.length ? alertIds.join(', ') : 'all open'}`);

    const result = await escalationService.sendEscalationEmails(alertIds);

    if (result.error) {
      logger.warn(`Notify Team completed with error: ${result.error}`);
    } else {
      logger.info(`Notify Team complete: sent=${result.sent}, skipped=${result.skipped}, failed=${result.failed}, recipients=[${result.recipients.join(', ')}]`);
    }

    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error(`Notify Team unexpected error: ${error.message}\n${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

const combinedPunchRowSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().optional().default(''),
  cluster: z.string().optional().default(''),
  punchCount: z.number(),
  lastUpdateTime: z.string().nullable().optional(),
});

function notifySection(title: string, headers: string[], rowsHtml: string): string {
  const head = headers.map(h => `<th style="padding:8px 12px;text-align:left;">${escHtml(h)}</th>`).join('');
  return `
    <h3 style="margin:20px 0 8px;font-size:14px;color:#333;">${escHtml(title)}</h3>
    <table style="width:100%;border-collapse:collapse;margin:0 0 8px;font-size:13px;">
      <thead><tr style="background:#f5f5f5;border-bottom:2px solid #ddd;">${head}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

// POST /api/escalations/notify-all — one email covering stuck jobs, payroll deadlines, and punches
router.post('/notify-all', requirePermission('ALERTS_NOTIFY', 'write'), async (req: Request, res: Response) => {
  try {
    if (!alertService.isEmailConfigured()) {
      return res.status(500).json({ success: false, error: 'SMTP not configured' });
    }
    const allRecipients = await prisma.notificationRecipient.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    if (!allRecipients.length) {
      return res.json({ success: true, data: { sent: 0, skipped: 1, details: ['No active notification recipients configured'] } });
    }

    const queue = await escalationService.collectEligibleQueueNotify();
    const payroll = await payrollDeadlineAlertService.listOpenForNotify();
    const punchBody = z.array(combinedPunchRowSchema).parse(req.body?.punchRows ?? []);
    const punchStatuses = await unprocPunchAlertService.getAlertStatuses();
    const punchRows = unprocPunchAlertService.filterNotifyEligible(punchBody, punchStatuses);

    const sections: string[] = [];
    const parts: string[] = [];
    if (queue.ids.length) {
      parts.push(`${queue.ids.length} stuck job client(s)`);
      sections.push(notifySection(
        'Stuck jobs',
        ['Client', 'Server', 'Job type', 'Plan', 'Stale', 'Pending', 'Since'],
        queue.linesHtml,
      ));
    }
    if (payroll.length) {
      parts.push(`${payroll.length} payroll deadline client(s)`);
      sections.push(notifySection(
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
      sections.push(notifySection(
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
      return res.json({
        success: true,
        data: {
          sent: 0,
          skipped: 1,
          details: [`No open alerts to notify (or all were emailed within the last ${cooldownMins} minutes)`],
        },
      });
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
    const result = await alertService.sendDirectEmail(emails, subject, html);
    if (queue.ids.length) await escalationService.markQueueNotifySent(queue.ids, result.accepted);
    if (payroll.length) await payrollDeadlineAlertService.recordEmailSent(payroll.map(a => a.clientId));
    if (punchRows.length) await unprocPunchAlertService.recordEmailSent(punchRows.map(r => r.clientId));

    logger.info(`notify-all: ${summary} sent to ${result.accepted.join(', ')}`);
    res.json({
      success: true,
      data: {
        sent: queue.ids.length + payroll.length + punchRows.length,
        recipients: result.accepted,
        details: [`One email sent to ${result.accepted.join(', ')}: ${summary}`],
      },
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    logger.error(`notify-all error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- Notification Recipients ----

// GET /api/escalations/recipients - List notification recipients
router.get('/recipients', async (_req: Request, res: Response) => {
  try {
    const recipients = await escalationService.getRecipients();
    res.json({ success: true, data: recipients });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const recipientSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

// POST /api/escalations/recipients - Add a notification recipient (admin only)
router.post('/recipients', requirePermission('RECIPIENTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, email } = recipientSchema.parse(req.body);
    const recipient = await escalationService.addRecipient(name, email);
    res.status(201).json({ success: true, data: recipient });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    if (error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Email already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/escalations/recipients/:id - Remove a notification recipient (admin only)
router.delete('/recipients/:id', requirePermission('RECIPIENTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    await escalationService.removeRecipient(req.params.id);
    res.json({ success: true, message: 'Recipient removed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/recipients/:id/toggle - Toggle recipient active/inactive (admin only)
router.post('/recipients/:id/toggle', requirePermission('RECIPIENTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const recipient = await escalationService.toggleRecipient(req.params.id);
    res.json({ success: true, data: recipient });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

// POST /api/escalations/notify-punch — Email team about clients with >100 pending punches
router.post('/notify-punch', requirePermission('ALERTS_NOTIFY', 'write'), async (req: Request, res: Response) => {
  try {
    const rows: Array<{ clientId: string; name: string; cluster: string; punchCount: number; lastUpdateTime: string | null }> =
      req.body.rows ?? [];

    if (!rows.length) {
      return res.json({ success: true, data: { sent: 0, skipped: 1, details: ['No punch alert rows provided'] } });
    }

    const punchStatuses = await unprocPunchAlertService.getAlertStatuses();
    const eligibleRows = unprocPunchAlertService.filterNotifyEligible(rows, punchStatuses);
    if (!eligibleRows.length) {
      const cooldownMins = configService.getNotifyCooldownMins();
      return res.json({
        success: true,
        data: {
          sent: 0,
          skipped: rows.length,
          details: [`All selected clients were notified within the last ${cooldownMins} minutes`],
        },
      });
    }

    if (!alertService.isEmailConfigured()) {
      return res.status(500).json({ success: false, error: 'SMTP not configured' });
    }

    const allRecipients = await prisma.notificationRecipient.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    if (!allRecipients.length) {
      return res.json({ success: true, data: { sent: 0, skipped: 1, details: ['No active notification recipients configured'] } });
    }

    const emails = allRecipients.map(r => r.email);
    const now = new Date();

    const rowLines = eligibleRows
      .sort((a, b) => b.punchCount - a.punchCount)
      .map(r => `<tr>
        <td style="padding:6px 12px;font-weight:bold;">${r.name && r.name !== r.clientId ? r.name : r.clientId}</td>
        <td style="padding:6px 12px;font-family:monospace;">${r.clientId}</td>
        <td style="padding:6px 12px;">${r.cluster || '—'}</td>
        <td style="padding:6px 12px;color:#c62828;font-weight:bold;">${r.punchCount.toLocaleString()}</td>
        <td style="padding:6px 12px;font-family:monospace;font-size:12px;color:#666;">${r.lastUpdateTime ?? '—'}</td>
      </tr>`)
      .join('');

    const appName = configService.getAppName();
    const { subject, html } = buildPunchNotifyEmail({
      appName,
      clientCount: eligibleRows.length,
      rowLinesHtml: rowLines,
      recipients: emails,
      sentAt: now,
    });

    const result = await alertService.sendDirectEmail(emails, subject, html);
    await unprocPunchAlertService.recordEmailSent(eligibleRows.map(r => r.clientId));
    logger.info(`notify-punch: sent to ${result.accepted.join(', ')}`);
    res.json({
      success: true,
      data: {
        sent: eligibleRows.length,
        skipped: rows.length - eligibleRows.length,
        recipients: result.accepted,
        details: [`Email sent to ${result.accepted.join(', ')}`],
      },
    });
  } catch (error: any) {
    logger.error(`notify-punch error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- Unproc Punch Alert status tracking (Acknowledge / Suppress) ----

// GET /api/escalations/punch-alerts — Get all punch alert statuses
router.get('/punch-alerts', async (_req: Request, res: Response) => {
  try {
    const statuses = await unprocPunchAlertService.getAlertStatuses();
    res.json({ success: true, data: statuses });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/punch-alerts/:clientId/acknowledge — Acknowledge a punch alert
router.post('/punch-alerts/:clientId/acknowledge', requirePermission('ALERTS_ACK', 'write'), async (req: Request, res: Response) => {
  try {
    const userId = req.body.userId || 'system';
    await unprocPunchAlertService.acknowledge(req.params.clientId, userId);
    res.json({ success: true, message: 'Punch alert acknowledged' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/escalations/punch-alerts/:clientId/suppress — Suppress a punch alert
const punchSuppressSchema = z.object({
  userId: z.string().default('system'),
  durationMinutes: z.number().min(1).max(10080),
  reason: z.string().optional(),
});

router.post('/punch-alerts/:clientId/suppress', requirePermission('ALERTS_SUPPRESS', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId, durationMinutes, reason } = punchSuppressSchema.parse(req.body);
    await unprocPunchAlertService.suppress(req.params.clientId, userId, durationMinutes, reason);
    res.json({ success: true, message: `Punch alert suppressed for ${durationMinutes} minutes` });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/payroll-deadlines', async (_req: Request, res: Response) => {
  try {
    const alerts = await payrollDeadlineAlertService.listActive();
    res.json({ success: true, data: alerts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/payroll-deadlines/notify', requirePermission('ALERTS_NOTIFY', 'write'), async (req: Request, res: Response) => {
  try {
    const clientIds: string[] | undefined = Array.isArray(req.body?.clientIds) ? req.body.clientIds : undefined;
    const eligible = await payrollDeadlineAlertService.listOpenForNotify(clientIds);
    if (!eligible.length) {
      const cooldownMins = configService.getNotifyCooldownMins();
      return res.json({
        success: true,
        data: {
          sent: 0,
          skipped: clientIds?.length || 1,
          details: [`No open payroll deadline alerts to notify (or all were emailed within the last ${cooldownMins} minutes)`],
        },
      });
    }

    if (!alertService.isEmailConfigured()) {
      return res.status(500).json({ success: false, error: 'SMTP not configured' });
    }

    const allRecipients = await prisma.notificationRecipient.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    if (!allRecipients.length) {
      return res.json({ success: true, data: { sent: 0, skipped: 1, details: ['No active notification recipients configured'] } });
    }

    const emails = allRecipients.map(r => r.email);
    const now = new Date();
    const rowLines = eligible.map(a => `<tr>
        <td style="padding:6px 12px;font-weight:bold;">${escHtml(a.clientName && a.clientName !== a.clientId ? a.clientName : a.clientId)}</td>
        <td style="padding:6px 12px;font-family:monospace;">${escHtml(a.clientId)}</td>
        <td style="padding:6px 12px;font-family:monospace;">${escHtml(a.weekEndDate || '—')}</td>
        <td style="padding:6px 12px;">${escHtml(a.deadlineAt || '—')}</td>
        <td style="padding:6px 12px;color:#c62828;font-weight:bold;">${a.pendingUnits} / ${a.totalUnits}</td>
        <td style="padding:6px 12px;color:#c62828;font-weight:bold;">${a.lateMinutes != null ? `${a.lateMinutes}m` : '—'}</td>
      </tr>`).join('');

    const appName = configService.getAppName();
    const { subject, html } = buildPayrollDeadlineNotifyEmail({
      appName,
      clientCount: eligible.length,
      rowLinesHtml: rowLines,
      recipients: emails,
      sentAt: now,
    });

    const result = await alertService.sendDirectEmail(emails, subject, html);
    await payrollDeadlineAlertService.recordEmailSent(eligible.map(a => a.clientId));
    logger.info(`payroll-deadline notify: sent to ${result.accepted.join(', ')}`);
    res.json({
      success: true,
      data: {
        sent: eligible.length,
        skipped: (clientIds?.length || eligible.length) - eligible.length,
        recipients: result.accepted,
        details: [`Email sent to ${result.accepted.join(', ')}`],
      },
    });
  } catch (error: any) {
    logger.error(`payroll-deadline notify error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/payroll-deadlines/refresh', requirePermission('ALERTS_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const result = await payrollService.refreshDeadlineAlerts();
    const alerts = await payrollDeadlineAlertService.listActive();
    res.json({ success: true, data: alerts, meta: result });
  } catch (error: any) {
    logger.error(`payroll deadline refresh error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/payroll-deadlines/:clientId/acknowledge', requirePermission('ALERTS_ACK', 'write'), async (req: Request, res: Response) => {
  try {
    const userId = req.body.userId || 'system';
    await payrollDeadlineAlertService.acknowledge(req.params.clientId, userId);
    res.json({ success: true, message: 'Payroll deadline alert acknowledged' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/payroll-deadlines/:clientId/suppress', requirePermission('ALERTS_SUPPRESS', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId, durationMinutes, reason } = punchSuppressSchema.parse(req.body);
    await payrollDeadlineAlertService.suppress(req.params.clientId, userId, durationMinutes, reason);
    res.json({ success: true, message: `Payroll deadline alert suppressed for ${durationMinutes} minutes` });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});
