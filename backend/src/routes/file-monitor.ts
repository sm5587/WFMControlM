// ============================================================
// Upload File Monitor API
// ============================================================

import { Client as SSH2Client } from 'ssh2';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware';
import { createServiceLogger } from '../utils/logger';
import { fetchUploadFileMonitor, getFileMonitorPaths, FileMonitorStreamEvent } from '../services/file-monitor-service';
import { sshCredentialsUseTotp } from '../services/sync-service';

const router = Router();
const logger = createServiceLogger('FileMonitorAPI');

const FetchSchema = z.object({
  clusters:        z.array(z.string()).optional(),
  clientIds:       z.array(z.string()).optional(),
  checkPending:    z.boolean().optional(),
  checkRejected:   z.boolean().optional(),
  pendingPath:     z.string().optional(),
  rejectedRoot:    z.string().optional(),
});

interface ActiveScan {
  cancelled: boolean;
  conn: SSH2Client | null;
}

let activeScan: ActiveScan | null = null;

function requestScanCancel(): boolean {
  if (!activeScan) return false;
  activeScan.cancelled = true;
  if (activeScan.conn) {
    try { activeScan.conn.destroy(); } catch { /* ignore */ }
  }
  return true;
}

router.get('/auth-info', requirePermission('FILE_MONITOR_VIEW', 'read'), (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: { usesTotpAuth: sshCredentialsUseTotp(), paths: getFileMonitorPaths() },
  });
});

router.post('/cancel', requirePermission('FILE_MONITOR_VIEW', 'read'), (_req: Request, res: Response) => {
  if (!requestScanCancel()) {
    return res.status(404).json({ success: false, error: 'No scan in progress' });
  }
  logger.info('File monitor: cancel requested by client');
  res.json({ success: true });
});

router.post('/fetch', requirePermission('FILE_MONITOR_VIEW', 'read'), async (req: Request, res: Response) => {
  if (activeScan) {
    return res.status(409).json({ success: false, error: 'Scan already in progress' });
  }

  activeScan = { cancelled: false, conn: null };
  // Use res 'close' — req 'close' fires when the POST body is fully read, not on client disconnect.
  const onClientDisconnect = () => {
    if (!res.writableFinished) {
      logger.info('File monitor: client disconnected during scan');
      requestScanCancel();
    }
  };
  res.on('close', onClientDisconnect);

  let streamStarted = false;
  const writeEvent = (event: FileMonitorStreamEvent) => {
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
    const parsed = FetchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid scan request' });
    }

    const result = await fetchUploadFileMonitor(parsed.data, {
      isCancelled: () => activeScan!.cancelled,
      onConnection: (conn) => { activeScan!.conn = conn; },
      onConnectionClosed: () => { if (activeScan) activeScan.conn = null; },
      onProgress: writeEvent,
    });

    if (result.scanError) {
      logger.error(
        `File monitor: failed — ${result.scanError} (${result.summary.total}/${result.plannedTotal} clients collected)`,
      );
    } else if (result.cancelled) {
      logger.info(
        `File monitor: cancelled — ${result.summary.total}/${result.plannedTotal} clients, ` +
        `${result.summary.alert} alerts, ${result.summary.totalPending} pending`,
      );
    } else {
      logger.info(
        `File monitor: ${result.summary.alert} alerts, ${result.summary.totalPending} pending, ` +
        `${result.summary.totalRejected} rejected (${result.summary.total} clients)`,
      );
    }

    if (!res.writableFinished) {
      if (streamStarted) {
        res.end();
      } else {
        res.json({ success: !result.scanError, data: result, error: result.scanError });
      }
    }
  } catch (err: any) {
    logger.error(`POST /file-monitor/fetch: ${err.message}`);
    if (!res.writableFinished) {
      if (streamStarted) {
        writeEvent({
          type: 'complete',
          data: {
            rows: [],
            summary: {
              total: 0, alert: 0, clean: 0, errors: 0, skipped: 0, totalPending: 0, totalRejected: 0,
            },
            scannedAt: new Date().toISOString(),
            paths: getFileMonitorPaths(),
            usesTotpAuth: sshCredentialsUseTotp(),
            plannedTotal: 0,
            scanError: err.message ?? 'Scan failed',
          },
        });
        res.end();
      } else {
        res.status(500).json({ success: false, error: err.message ?? 'Scan failed' });
      }
    }
  } finally {
    res.off('close', onClientDisconnect);
    activeScan = null;
  }
});

export default router;
