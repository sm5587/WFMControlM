// ============================================================
// Outage Impact API — ad-hoc cron impact calculator
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware';
import { createServiceLogger } from '../utils/logger';
import { computeOutageImpact, OutageImpactStreamEvent } from '../services/outage-impact-service';

const router = Router();
const logger = createServiceLogger('OutageAPI');

const ImpactSchema = z.object({
  clusters:      z.array(z.string()).optional(),
  clientIds:       z.array(z.string()).optional(),
  clientDbIds:     z.array(z.string()).optional(),
  startLocal:      z.string().min(1),
  endLocal:        z.string().min(1),
  inputTimezone:   z.string().default('IST'),
  noRetryToday:    z.boolean().default(true),
});

interface ActiveCalculation {
  cancelled: boolean;
  startedAt: number;
}

const CALC_STALE_MS = 30 * 60 * 1000;

let activeCalculation: ActiveCalculation | null = null;

function requestCalculationCancel(): boolean {
  if (!activeCalculation) return false;
  activeCalculation.cancelled = true;
  return true;
}

function clearStaleCalculation(): void {
  if (activeCalculation && Date.now() - activeCalculation.startedAt > CALC_STALE_MS) {
    activeCalculation = null;
  }
}

router.post('/cancel', requirePermission('OUTAGE_VIEW', 'read'), (_req: Request, res: Response) => {
  if (!requestCalculationCancel()) {
    return res.status(404).json({ success: false, error: 'No calculation in progress' });
  }
  logger.info('Outage impact: cancel requested by client');
  res.json({ success: true });
});

router.post('/impact', requirePermission('OUTAGE_VIEW', 'read'), async (req: Request, res: Response) => {
  clearStaleCalculation();
  if (activeCalculation) {
    return res.status(409).json({ success: false, error: 'Calculation already in progress' });
  }

  activeCalculation = { cancelled: false, startedAt: Date.now() };
  const onClientDisconnect = () => {
    if (!res.writableFinished) {
      logger.info('Outage impact: client disconnected during calculation');
      requestCalculationCancel();
    }
  };
  res.on('close', onClientDisconnect);

  let streamStarted = false;
  const writeEvent = (event: OutageImpactStreamEvent) => {
    if (res.writableFinished) return;
    if (!streamStarted) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      streamStarted = true;
    }
    res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const parsed = ImpactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid outage impact request' });
    }

    const result = await computeOutageImpact(parsed.data, {
      onProgress: writeEvent,
      isCancelled: () => activeCalculation!.cancelled,
    });

    if (result.cancelled) {
      logger.info(
        `Outage impact: cancelled — ${result.summary.uniqueJobs} jobs, ` +
        `${result.summary.totalFireTimes} fires (${result.plannedTotal ?? 0} clients)`,
      );
    } else {
      logger.info(
        `Outage impact: ${result.summary.uniqueJobs} jobs, ${result.summary.totalFireTimes} fires, ` +
        `excluded retry=${result.summary.excludedRetryToday} (${result.plannedTotal ?? 0} clients)`,
      );
    }

    if (!res.writableFinished) {
      if (streamStarted) {
        res.end();
      } else {
        res.json({ success: true, data: result });
      }
    }
  } catch (err: any) {
    logger.error(`POST /outage/impact: ${err.message}`);
    if (!res.writableFinished) {
      if (streamStarted) {
        res.end();
      } else {
        res.status(400).json({ success: false, error: err.message });
      }
    }
  } finally {
    res.off('close', onClientDisconnect);
    activeCalculation = null;
  }
});

export default router;
