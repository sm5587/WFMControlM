// ============================================================
// Upload File Monitor API
// ============================================================

import { Client as SSH2Client } from 'ssh2';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission, JwtUser } from '../middleware';
import { createServiceLogger } from '../utils/logger';
import {
  fetchUploadFileMonitor,
  getFileMonitorPaths,
  FileMonitorStreamEvent,
  resolveFileMonitorClients,
  validateFileMonitorScanType,
} from '../services/file-monitor-service';
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
  /** Client IDs currently being scanned — at most one active scan per client box. */
  clientIds: Set<string>;
  startedBy: string;
}

let activeScan: ActiveScan | null = null;

function scanOwnerLabel(user: JwtUser | undefined): string {
  if (!user) return 'another user';
  return user.displayName?.trim() || user.username || 'another user';
}

function scanInProgressError(overlap?: string[]): string {
  const owner = activeScan?.startedBy ?? 'another user';
  if (overlap && overlap.length > 0) {
    const label = overlap.length === 1 ? overlap[0] : `${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? '…' : ''}`;
    return `A scan is already in progress for client box${overlap.length > 1 ? 'es' : ''}: ${label} (started by ${owner})`;
  }
  return `Scan already in progress (started by ${owner})`;
}

function activeScanClientOverlap(clientIds: string[]): string[] {
  if (!activeScan) return [];
  return clientIds.filter(id => activeScan!.clientIds.has(id));
}

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
  const parsed = FetchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid scan request' });
  }

  const scanTypeError = validateFileMonitorScanType(parsed.data);
  if (scanTypeError) {
    return res.status(400).json({ success: false, error: scanTypeError });
  }

  let plannedClientIds: string[] = [];
  try {
    const resolved = await resolveFileMonitorClients(parsed.data);
    plannedClientIds = resolved.map(c => c.clientId);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message ?? 'Failed to resolve scan scope' });
  }

  if (plannedClientIds.length === 0) {
    return res.status(400).json({ success: false, error: 'No active clients match the selected scope' });
  }

  if (activeScan) {
    const overlap = activeScanClientOverlap(plannedClientIds);
    return res.status(409).json({
      success: false,
      error: scanInProgressError(overlap.length > 0 ? overlap : undefined),
    });
  }

  const user = (req as Request & { user?: JwtUser }).user;
  const startedBy = scanOwnerLabel(user);
  activeScan = { cancelled: false, conn: null, clientIds: new Set(plannedClientIds), startedBy };
  logger.info(`File monitor: scan started by ${startedBy} (${plannedClientIds.length} client(s))`);
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
