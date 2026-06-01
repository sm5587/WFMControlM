// ============================================================
// Alerts API Routes
// ============================================================

import { Router, Request, Response } from 'express';
import { prisma } from '../database/prisma';
import { alertService } from '../services/alert-service';
import { requirePermission } from '../middleware';
import { z } from 'zod';

const router = Router();

const createAlertRuleSchema = z.object({
  name: z.string().min(1),
  jobId: z.string().uuid().optional(),
  triggerType: z.enum([
    'JOB_FAILED', 'JOB_TIMEOUT', 'JOB_LONG_RUNNING',
    'CONSECUTIVE_FAILURES', 'QUEUE_BUILDUP', 'CUSTOM',
  ]),
  condition: z.any().optional(),
  channels: z.array(z.enum(['EMAIL', 'SLACK', 'WEBHOOK', 'SMS', 'IN_APP'])).default(['EMAIL']),
  recipients: z.array(z.string()).default([]),
  slackChannel: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  cooldownMinutes: z.number().min(1).default(30),
});

// GET /api/alerts/rules - List alert rules
router.get('/rules', async (req: Request, res: Response) => {
  try {
    const rules = await prisma.alertRule.findMany({
      include: {
        job: { select: { id: true, name: true } },
        _count: { select: { events: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: rules });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/alerts/rules - Create alert rule
router.post('/rules', requirePermission('ALERTS_RULES', 'write'), async (req: Request, res: Response) => {
  try {
    const validated = createAlertRuleSchema.parse(req.body);
    const rule = await prisma.alertRule.create({
      data: {
        ...validated,
        channels: JSON.stringify(validated.channels),
        recipients: JSON.stringify(validated.recipients),
        condition: validated.condition ? JSON.stringify(validated.condition) : null,
      },
    });
    res.status(201).json({ success: true, data: rule });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/alerts/rules/:id - Update alert rule
router.put('/rules/:id', requirePermission('ALERTS_RULES', 'write'), async (req: Request, res: Response) => {
  try {
    const rule = await prisma.alertRule.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ success: true, data: rule });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/alerts/rules/:id - Delete alert rule
router.delete('/rules/:id', requirePermission('ALERTS_RULES', 'write'), async (req: Request, res: Response) => {
  try {
    await prisma.alertRule.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Alert rule deleted' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/alerts/events - Get alert events
router.get('/events', async (req: Request, res: Response) => {
  try {
    const result = await alertService.getAlertHistory({
      page: parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 50,
      severity: req.query.severity as any,
      acknowledged: req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : undefined,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/alerts/events/:id/acknowledge - Acknowledge an alert (admin only)
router.post('/events/:id/acknowledge', requirePermission('ALERTS_ACK', 'write'), async (req: Request, res: Response) => {
  try {
    const userId = req.body.userId || 'system';
    await alertService.acknowledgeAlert(req.params.id, userId);
    res.json({ success: true, message: 'Alert acknowledged' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/alerts/events/acknowledge-all - Acknowledge all alerts (admin only)
router.post('/events/acknowledge-all', requirePermission('ALERTS_ACK', 'write'), async (req: Request, res: Response) => {
  try {
    const userId = req.body.userId || 'system';
    await prisma.alertEvent.updateMany({
      where: { acknowledged: false },
      data: {
        acknowledged: true,
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      },
    });
    res.json({ success: true, message: 'All alerts acknowledged' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/alerts/summary - Alert summary for dashboard
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUnacknowledged,
      bySeverity,
      byType,
      recentEvents,
    ] = await Promise.all([
      prisma.alertEvent.count({ where: { acknowledged: false } }),
      prisma.alertEvent.groupBy({
        by: ['severity'],
        where: { acknowledged: false },
        _count: true,
      }),
      prisma.alertEvent.groupBy({
        by: ['severity'],
        where: { createdAt: { gte: today } },
        _count: true,
      }),
      prisma.alertEvent.findMany({
        where: { acknowledged: false },
        include: {
          alertRule: { select: { name: true, triggerType: true } },
          execution: { include: { job: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    res.json({
      success: true,
      data: {
        totalUnacknowledged,
        bySeverity: bySeverity.map(s => ({ severity: s.severity, count: s._count })),
        todayByType: byType.map(t => ({ severity: t.severity, count: t._count })),
        recentEvents,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
