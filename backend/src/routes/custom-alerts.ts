// ============================================================
// Custom Alerts Routes
// User-defined SQL threshold watchers.
//   GET    /api/custom-alerts            → list all rules
//   POST   /api/custom-alerts            → create a rule
//   PUT    /api/custom-alerts/:id        → update a rule
//   DELETE /api/custom-alerts/:id        → delete a rule
//   POST   /api/custom-alerts/:id/run    → run a rule now
//   POST   /api/custom-alerts/test       → evaluate a draft rule without saving
// ============================================================

import { Router, Request, Response } from 'express';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { requirePermission } from '../middleware';
import {
  customAlertService,
  CUSTOM_ALERT_OPERATORS,
  type CustomAlertOperator,
} from '../services/custom-alert-service';

const router = Router();

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440; // 24h

interface RuleInput {
  name?: unknown;
  clientId?: unknown;
  clientName?: unknown;
  sqlQuery?: unknown;
  columnName?: unknown;
  operator?: unknown;
  thresholdValue?: unknown;
  intervalMinutes?: unknown;
  isActive?: unknown;
}

function validateRuleInput(body: RuleInput, partial = false): { ok: true; data: any } | { ok: false; error: string } {
  const data: any = {};

  const requireStr = (key: keyof RuleInput, label: string): string | undefined => {
    const v = body[key];
    if (v === undefined) {
      if (partial) return undefined;
      throw new Error(`${label} is required`);
    }
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`${label} is required`);
    }
    return v.trim();
  };

  try {
    const name = requireStr('name', 'Name');
    if (name !== undefined) data.name = name;

    const clientId = requireStr('clientId', 'Client');
    if (clientId !== undefined) data.clientId = clientId;

    if (body.clientName !== undefined) {
      data.clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
    }

    if (body.sqlQuery !== undefined) {
      if (typeof body.sqlQuery !== 'string' || !body.sqlQuery.trim()) {
        return { ok: false, error: 'SQL query is required' };
      }
      const check = customAlertService.validateQuery(body.sqlQuery);
      if (!check.ok) return { ok: false, error: check.error! };
      data.sqlQuery = body.sqlQuery.trim();
    } else if (!partial) {
      return { ok: false, error: 'SQL query is required' };
    }

    const columnName = requireStr('columnName', 'Column name');
    if (columnName !== undefined) data.columnName = columnName;

    if (body.operator !== undefined) {
      const op = String(body.operator).toUpperCase();
      if (!(CUSTOM_ALERT_OPERATORS as readonly string[]).includes(op)) {
        return { ok: false, error: `Operator must be one of: ${CUSTOM_ALERT_OPERATORS.join(', ')}` };
      }
      data.operator = op as CustomAlertOperator;
    } else if (!partial) {
      data.operator = 'GT';
    }

    if (body.thresholdValue !== undefined) {
      const t = typeof body.thresholdValue === 'number' ? String(body.thresholdValue) : String(body.thresholdValue ?? '').trim();
      if (!t) return { ok: false, error: 'Threshold value is required' };
      data.thresholdValue = t;
    } else if (!partial) {
      return { ok: false, error: 'Threshold value is required' };
    }

    if (body.intervalMinutes !== undefined) {
      const n = Number(body.intervalMinutes);
      if (!Number.isFinite(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
        return { ok: false, error: `Interval must be between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes` };
      }
      data.intervalMinutes = Math.round(n);
    } else if (!partial) {
      data.intervalMinutes = 15;
    }

    if (body.isActive !== undefined) {
      data.isActive = !!body.isActive;
    }

    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// GET /api/custom-alerts — list all rules (newest first)
router.get('/', requirePermission('CUSTOM_ALERTS_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const rules = await prisma.customAlert.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: rules });
  } catch (err: any) {
    logger.error(`Custom alerts list error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/custom-alerts — create a rule
router.post('/', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  const validation = validateRuleInput(req.body, false);
  if (!validation.ok) return res.status(400).json({ success: false, error: validation.error });

  try {
    const user = (req as any).user;
    const rule = await prisma.customAlert.create({
      data: {
        ...validation.data,
        clientName: validation.data.clientName ?? '',
        lastStatus: 'PENDING',
        createdBy: user?.username ?? user?.displayName ?? null,
      },
    });

    // Kick off an initial check in the background so the user sees a status fast.
    customAlertService.runCheck(rule.id).catch(() => { /* logged in service */ });

    res.status(201).json({ success: true, data: rule });
  } catch (err: any) {
    logger.error(`Custom alert create error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/custom-alerts/:id — update a rule
router.put('/:id', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  const validation = validateRuleInput(req.body, true);
  if (!validation.ok) return res.status(400).json({ success: false, error: validation.error });

  try {
    const existing = await prisma.customAlert.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Custom alert not found' });

    const rule = await prisma.customAlert.update({
      where: { id: req.params.id },
      data: validation.data,
    });

    // Re-evaluate immediately since the definition may have changed.
    customAlertService.runCheck(rule.id).catch(() => { /* logged in service */ });

    res.json({ success: true, data: rule });
  } catch (err: any) {
    logger.error(`Custom alert update error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/custom-alerts/:id — delete a rule
router.delete('/:id', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.customAlert.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Custom alert not found' });

    await prisma.customAlert.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Custom alert deleted' });
  } catch (err: any) {
    logger.error(`Custom alert delete error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/custom-alerts/:id/run — run a rule now
router.post('/:id/run', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const evaluation = await customAlertService.runCheck(req.params.id);
    if (!evaluation) return res.status(404).json({ success: false, error: 'Custom alert not found' });

    const rule = await prisma.customAlert.findUnique({ where: { id: req.params.id } });
    res.json({ success: true, data: rule });
  } catch (err: any) {
    logger.error(`Custom alert run error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/custom-alerts/test — evaluate a draft rule without saving
router.post('/test', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  const { clientId, sqlQuery, columnName, operator, thresholdValue } = req.body ?? {};

  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ success: false, error: 'Client is required' });
  }
  if (!columnName || typeof columnName !== 'string') {
    return res.status(400).json({ success: false, error: 'Column name is required' });
  }
  const op = String(operator ?? 'GT').toUpperCase();
  if (!customAlertService.isValidOperator(op)) {
    return res.status(400).json({ success: false, error: `Operator must be one of: ${CUSTOM_ALERT_OPERATORS.join(', ')}` });
  }
  const check = customAlertService.validateQuery(String(sqlQuery ?? ''));
  if (!check.ok) return res.status(400).json({ success: false, error: check.error });

  try {
    const evaluation = await customAlertService.evaluate({
      clientId,
      sqlQuery: String(sqlQuery),
      columnName,
      operator: op,
      thresholdValue: String(thresholdValue ?? ''),
    });
    res.json({ success: true, data: evaluation });
  } catch (err: any) {
    logger.error(`Custom alert test error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
