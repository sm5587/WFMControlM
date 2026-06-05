// ============================================================
// Escalation Routes
// Red Tab alerts: pending > 1 hour, acknowledge, suppress, email
// ============================================================

import { Router, Request, Response } from 'express';
import { escalationService } from '../services/escalation-service';
import { alertService } from '../services/alert-service';
import { configService } from '../services/config-service';
import { unprocPunchAlertService } from '../services/unproc-punch-alert-service';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { requirePermission } from '../middleware';
import { z } from 'zod';
import { buildPunchNotifyEmail } from '../email/notify-email-templates';

const router = Router();
const logger = createServiceLogger('EscalationsAPI');

// GET /api/escalations - Get all escalated alerts (red tab data)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const alerts = await escalationService.getEscalatedAlerts();
    res.json({ success: true, data: alerts });
  } catch (error: any) {
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
router.post('/notify-punch', async (req: Request, res: Response) => {
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
