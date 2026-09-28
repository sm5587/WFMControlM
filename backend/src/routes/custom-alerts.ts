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
import { configService } from '../services/config-service';
import {
  customAlertService,
  CUSTOM_ALERT_OPERATORS,
  CUSTOM_ALERT_SCHEDULE_TYPES,
  CUSTOM_ALERT_MIN_INTERVAL,
  buildCronExpressions,
  normalizeAggregateQuery,
  type CustomAlertOperator,
} from '../services/custom-alert-service';

const CUSTOM_ALERT_QUERY_TIMEOUT_KEY = 'engine.customAlertQueryTimeoutSec';
const DEFAULT_QUERY_TIMEOUT_SEC = 30;

const router = Router();

const MIN_INTERVAL = CUSTOM_ALERT_MIN_INTERVAL; // 15 minutes
const MAX_INTERVAL = 1440; // 24h

interface RuleInput {
  name?: unknown;
  clientId?: unknown;
  clientName?: unknown;
  clientIds?: unknown;
  clientNames?: unknown;
  sqlQuery?: unknown;
  operator?: unknown;
  thresholdValue?: unknown;
  intervalMinutes?: unknown;
  isActive?: unknown;
  notifyEmails?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  scheduleType?: unknown;
  scheduleConfig?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Grace period (ms) allowed for a start time in the past, to absorb the delay
// between the user picking "now" and the request reaching the server.
const START_GRACE_MS = 2 * 60 * 1000;

// Parse an ISO date-time string into a Date, or null if missing/invalid.
function parseDateTime(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Parse + validate the optional notifyEmails array. Returns null if a value
// is not a valid email; empty array is allowed (in-app only).
function parseNotifyEmails(value: unknown): { ok: true; emails: string[] } | { ok: false; bad: string } {
  if (value === undefined || value === null) return { ok: true, emails: [] };
  const arr = Array.isArray(value) ? value : [value];
  const emails: string[] = [];
  for (const v of arr) {
    const e = typeof v === 'string' ? v.trim() : '';
    if (!e) continue;
    if (!EMAIL_RE.test(e)) return { ok: false, bad: e };
    if (!emails.includes(e)) emails.push(e);
  }
  return { ok: true, emails };
}

// Parse a client selection from the request body into parallel id/name arrays.
// Accepts the new `clientIds`/`clientNames` arrays, or falls back to the
// legacy single `clientId`/`clientName`.
function parseClientSelection(body: RuleInput): { ids: string[]; names: string[] } | null {
  const ids: string[] = [];
  const names: string[] = [];

  if (Array.isArray(body.clientIds)) {
    const rawNames = Array.isArray(body.clientNames) ? body.clientNames : [];
    body.clientIds.forEach((cid, i) => {
      const id = typeof cid === 'string' ? cid.trim() : String(cid ?? '').trim();
      if (!id || ids.includes(id)) return;
      ids.push(id);
      const nm = rawNames[i];
      names.push(typeof nm === 'string' ? nm.trim() : '');
    });
  } else if (typeof body.clientId === 'string' && body.clientId.trim()) {
    ids.push(body.clientId.trim());
    names.push(typeof body.clientName === 'string' ? body.clientName.trim() : '');
  }

  return ids.length > 0 ? { ids, names } : null;
}

// Parse the JSON array fields on a stored rule into real arrays for responses.
function serializeRule(rule: any) {
  const safeParse = (v: any, fallback: any) => {
    try { const p = JSON.parse(v ?? ''); return p ?? fallback; } catch { return fallback; }
  };
  return {
    ...rule,
    clientIds: safeParse(rule.clientIds, []),
    clientNames: safeParse(rule.clientNames, []),
    results: safeParse(rule.results, []),
    notifyEmails: safeParse(rule.notifyEmails, []),
    scheduleConfig: safeParse(rule.scheduleConfig, { times: [], daysOfWeek: [], daysOfMonth: [] }),
  };
}

// Validate + normalize the schedule frequency portion of a request. Returns the
// fields to persist, or an error string.
function parseSchedule(body: RuleInput, partial: boolean):
  | { ok: true; data: { scheduleType?: string; scheduleConfig?: string } }
  | { ok: false; error: string } {
  const effectiveType = body.scheduleType !== undefined
    ? String(body.scheduleType).toUpperCase()
    : (partial ? undefined : 'INTERVAL');

  if (effectiveType === undefined) return { ok: true, data: {} }; // partial update, unchanged

  if (!(CUSTOM_ALERT_SCHEDULE_TYPES as readonly string[]).includes(effectiveType)) {
    return { ok: false, error: `Schedule type must be one of: ${CUSTOM_ALERT_SCHEDULE_TYPES.join(', ')}` };
  }

  if (effectiveType === 'INTERVAL') {
    return { ok: true, data: { scheduleType: 'INTERVAL', scheduleConfig: '{}' } };
  }

  const raw: any = body.scheduleConfig ?? {};
  const times = Array.isArray(raw.times) ? raw.times.map((t: any) => String(t).trim()).filter(Boolean) : [];
  const daysOfWeek = Array.isArray(raw.daysOfWeek)
    ? raw.daysOfWeek.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [];
  const daysOfMonth = Array.isArray(raw.daysOfMonth)
    ? raw.daysOfMonth.map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 31)
    : [];

  if (times.length === 0) return { ok: false, error: 'Please add at least one check time' };
  for (const t of times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      return { ok: false, error: `Invalid time "${t}" — use HH:mm` };
    }
  }
  if (effectiveType === 'WEEKLY' && daysOfWeek.length === 0) {
    return { ok: false, error: 'Please select at least one day of the week' };
  }
  if (effectiveType === 'MONTHLY' && daysOfMonth.length === 0) {
    return { ok: false, error: 'Please select at least one day of the month' };
  }

  const cfg = { times, daysOfWeek, daysOfMonth };
  if (buildCronExpressions(effectiveType, cfg).length === 0) {
    return { ok: false, error: 'Schedule is incomplete' };
  }
  return { ok: true, data: { scheduleType: effectiveType, scheduleConfig: JSON.stringify(cfg) } };
}

// True when the current time is inside the rule's schedule window, i.e. it is
// eligible to run right now. Used to decide whether to fire an immediate check.
function withinWindow(rule: any): boolean {
  const now = Date.now();
  if (rule.startAt && now < new Date(rule.startAt).getTime()) return false;
  if (rule.endAt && now >= new Date(rule.endAt).getTime()) return false;
  return true;
}

// Whether to fire an immediate check right after create/update. Interval alerts
// run straight away for fast feedback; cron alerts wait for their next
// scheduled occurrence so they only run "exactly at" the configured time.
function shouldRunImmediately(rule: any): boolean {
  const type = rule.scheduleType || 'INTERVAL';
  return type === 'INTERVAL' && withinWindow(rule);
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

    // Client selection (multi-client). Only enforce/apply when the caller
    // provided any client field, or when this is a full (non-partial) create.
    const clientFieldProvided =
      body.clientIds !== undefined || body.clientId !== undefined;
    if (clientFieldProvided || !partial) {
      const selection = parseClientSelection(body);
      if (!selection) {
        return { ok: false, error: 'Please select at least one client' };
      }
      data.clientIds = JSON.stringify(selection.ids);
      data.clientNames = JSON.stringify(selection.names);
      // Keep legacy single-client columns populated with the first client.
      data.clientId = selection.ids[0];
      data.clientName = selection.names[0] ?? '';
    }

    if (body.sqlQuery !== undefined) {
      if (typeof body.sqlQuery !== 'string' || !body.sqlQuery.trim()) {
        return { ok: false, error: 'SQL query is required' };
      }
      const check = customAlertService.validateQuery(body.sqlQuery);
      if (!check.ok) return { ok: false, error: check.error! };
      // Persist with the leading SELECT + aggregate function uppercased.
      data.sqlQuery = normalizeAggregateQuery(body.sqlQuery);
    } else if (!partial) {
      return { ok: false, error: 'SQL query is required' };
    }

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

    // Schedule frequency (INTERVAL vs DAILY/WEEKLY/MONTHLY).
    const sched = parseSchedule(body, partial);
    if (!sched.ok) return { ok: false, error: sched.error };
    if (sched.data.scheduleType !== undefined) data.scheduleType = sched.data.scheduleType;
    if (sched.data.scheduleConfig !== undefined) data.scheduleConfig = sched.data.scheduleConfig;

    if (body.isActive !== undefined) {
      data.isActive = !!body.isActive;
    }

    if (body.notifyEmails !== undefined) {
      const parsed = parseNotifyEmails(body.notifyEmails);
      if (!parsed.ok) return { ok: false, error: `Invalid email address: ${parsed.bad}` };
      data.notifyEmails = JSON.stringify(parsed.emails);
    } else if (!partial) {
      data.notifyEmails = '[]';
    }

    // Schedule window. Both start and end are required and are provided
    // together by the client. Start must not be in the past (create only),
    // and end must be strictly after start.
    const scheduleProvided = body.startAt !== undefined || body.endAt !== undefined;
    if (scheduleProvided || !partial) {
      const startAt = parseDateTime(body.startAt);
      const endAt = parseDateTime(body.endAt);
      if (!startAt) return { ok: false, error: 'Start date & time is required' };
      if (!endAt) return { ok: false, error: 'End date & time is required' };
      // Allow a small grace so a start time chosen "now" isn't rejected by the
      // few seconds elapsed between selecting it and submitting.
      if (!partial && startAt.getTime() < Date.now() - START_GRACE_MS) {
        return { ok: false, error: 'Start date & time cannot be before the current time' };
      }
      if (endAt.getTime() <= startAt.getTime()) {
        return { ok: false, error: 'End date & time must be after the start date & time' };
      }
      data.startAt = startAt;
      data.endAt = endAt;
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
    res.json({ success: true, data: rules.map(serializeRule) });
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
        results: '[]',
        createdBy: user?.username ?? user?.displayName ?? null,
      },
    });

    // Kick off an initial check in the background so the user sees a status fast,
    // but only for interval alerts inside their schedule window.
    if (shouldRunImmediately(rule)) {
      customAlertService.runCheck(rule.id).catch(() => { /* logged in service */ });
    }

    res.status(201).json({ success: true, data: serializeRule(rule) });
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

    // Re-evaluate immediately since the definition may have changed, but only
    // for interval alerts inside their schedule window.
    if (shouldRunImmediately(rule)) {
      customAlertService.runCheck(rule.id).catch(() => { /* logged in service */ });
    }

    res.json({ success: true, data: serializeRule(rule) });
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
    res.json({ success: true, data: rule ? serializeRule(rule) : null });
  } catch (err: any) {
    logger.error(`Custom alert run error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/custom-alerts/test — evaluate a draft rule (all selected clients) without saving
router.post('/test', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  const { sqlQuery, operator, thresholdValue } = req.body ?? {};

  const selection = parseClientSelection(req.body ?? {});
  if (!selection) {
    return res.status(400).json({ success: false, error: 'Please select at least one client' });
  }
  const op = String(operator ?? 'GT').toUpperCase();
  if (!customAlertService.isValidOperator(op)) {
    return res.status(400).json({ success: false, error: `Operator must be one of: ${CUSTOM_ALERT_OPERATORS.join(', ')}` });
  }
  const check = customAlertService.validateQuery(String(sqlQuery ?? ''));
  if (!check.ok) return res.status(400).json({ success: false, error: check.error });

  try {
    const clients = selection.ids.map((id, i) => ({ clientId: id, clientName: selection.names[i] ?? '' }));
    const results = await customAlertService.evaluateMany({
      clients,
      sqlQuery: String(sqlQuery),
      operator: op,
      thresholdValue: String(thresholdValue ?? ''),
    });
    res.json({ success: true, data: results });
  } catch (err: any) {
    logger.error(`Custom alert test error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/custom-alerts/validate — timing check: does the query return within the configured threshold for every selected client?
router.post('/validate', requirePermission('CUSTOM_ALERTS_MANAGE', 'write'), async (req: Request, res: Response) => {
  const { sqlQuery } = req.body ?? {};

  const selection = parseClientSelection(req.body ?? {});
  if (!selection) {
    return res.status(400).json({ success: false, error: 'Please select at least one client to validate against' });
  }
  const check = customAlertService.validateQuery(String(sqlQuery ?? ''));
  if (!check.ok) return res.status(400).json({ success: false, error: check.error });

  const timeoutSec = configService.getInt(CUSTOM_ALERT_QUERY_TIMEOUT_KEY, DEFAULT_QUERY_TIMEOUT_SEC);

  try {
    const clients = selection.ids.map((id, i) => ({ clientId: id, clientName: selection.names[i] ?? '' }));
    const result = await customAlertService.validateTiming({
      clients,
      sqlQuery: String(sqlQuery),
      timeoutSec,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error(`Custom alert validate error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
