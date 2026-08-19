// ============================================================
// Upload File Monitor — SSH scan of IN (pending) & Rejected folders
// Ported from AppServerTools/daily_file_monitor.py
// ============================================================

import { Client as SSH2Client } from 'ssh2';
import { prisma } from '../database/prisma';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';
import { loadCredentials, sshConnect, sshCredentialsUseTotp } from './sync-service';

const logger = createServiceLogger('FileMonitor');
const SCAN_CANCELLED = 'Scan cancelled';

const DEFAULT_PENDING_PATH = '/mount/RWS4/batch_jobs/in';
const DEFAULT_REJECTED_ROOT = '/mount/RWS4/appuploads/upload';

export interface FileMonitorFile {
  name: string;
  size: number;
  mtime: string;
  path?: string;
}

export interface FileMonitorRejectedFolder {
  folder: string;
  files: FileMonitorFile[];
}

export interface ClientFileMonitorResult {
  clientId: string;
  clientName?: string;
  cluster?: string;
  server: string;
  pendingCount: number;
  rejectedCount: number;
  pendingFiles: FileMonitorFile[];
  rejectedFolders: FileMonitorRejectedFolder[];
  error?: string;
  status: 'CLEAN' | 'ALERT' | 'ERROR' | 'SKIPPED';
}

export interface FileMonitorFetchRequest {
  clusters?: string[];
  clientIds?: string[];
  checkPending?: boolean;
  checkRejected?: boolean;
  pendingPath?: string;
  rejectedRoot?: string;
}

export interface FileMonitorFetchResult {
  rows: ClientFileMonitorResult[];
  summary: {
    total: number;
    alert: number;
    clean: number;
    errors: number;
    skipped: number;
    totalPending: number;
    totalRejected: number;
  };
  scannedAt: string;
  paths: { pending: string; rejected: string };
  /** False for service-account SSH (password only, no delay between clients). */
  usesTotpAuth: boolean;
  /** True when the scan was stopped before all clients were processed. */
  cancelled?: boolean;
  /** Total clients in scope when the scan started. */
  plannedTotal: number;
  /** Set when the scan aborted before finishing (credentials, DB, unexpected error). */
  scanError?: string;
}

export interface FileMonitorFetchOptions {
  isCancelled?: () => boolean;
  onConnection?: (conn: SSH2Client) => void;
  onConnectionClosed?: () => void;
  onProgress?: (event: FileMonitorStreamEvent) => void;
}

export type FileMonitorStreamEvent =
  | {
      type: 'start';
      plannedTotal: number;
      paths: { pending: string; rejected: string };
      usesTotpAuth: boolean;
    }
  | {
      type: 'progress';
      completed: number;
      plannedTotal: number;
      clientId: string;
      row: ClientFileMonitorResult;
    }
  | {
      type: 'heartbeat';
      completed: number;
      plannedTotal: number;
      phase: 'totp-cooldown';
      clientId: string;
    }
  | {
      type: 'complete';
      data: FileMonitorFetchResult;
    };

async function interruptibleDelay(
  ms: number,
  isCancelled?: () => boolean,
  onHeartbeat?: () => void,
  heartbeatMs = 5000,
): Promise<boolean> {
  const step = 500;
  let elapsed = 0;
  let sinceHeartbeat = 0;
  while (elapsed < ms) {
    if (isCancelled?.()) return false;
    const chunk = Math.min(step, ms - elapsed);
    await new Promise(r => setTimeout(r, chunk));
    elapsed += chunk;
    sinceHeartbeat += chunk;
    if (onHeartbeat && sinceHeartbeat >= heartbeatMs) {
      onHeartbeat();
      sinceHeartbeat = 0;
    }
  }
  return true;
}

function buildFileMonitorResult(
  rows: ClientFileMonitorResult[],
  pendingPath: string,
  rejectedRoot: string,
  usesTotp: boolean,
  plannedTotal: number,
  cancelled: boolean,
  scanError?: string,
): FileMonitorFetchResult {
  let totalPending = 0;
  let totalRejected = 0;
  for (const row of rows) {
    totalPending += row.pendingCount;
    totalRejected += row.rejectedCount;
  }
  return {
    rows,
    summary: {
      total: rows.length,
      alert: rows.filter(r => r.status === 'ALERT').length,
      clean: rows.filter(r => r.status === 'CLEAN').length,
      errors: rows.filter(r => r.status === 'ERROR').length,
      skipped: rows.filter(r => r.status === 'SKIPPED').length,
      totalPending,
      totalRejected,
    },
    scannedAt: new Date().toISOString(),
    paths: { pending: pendingPath, rejected: rejectedRoot },
    usesTotpAuth: usesTotp,
    cancelled: cancelled || undefined,
    plannedTotal,
    scanError,
  };
}

import { validateRemoteCommand } from '../utils/ssh-client';
import { shellQuote } from '../utils/remote-path';
function sshExecCancellable(
  conn: SSH2Client,
  command: string,
  timeoutSec: number,
  isCancelled?: () => boolean,
): Promise<string> {
  validateRemoteCommand(command);
  if (isCancelled?.()) {
    return Promise.reject(new Error(SCAN_CANCELLED));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, stdout = '') => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(stdout);
    };

    const onConnClosed = () => finish(new Error(SCAN_CANCELLED));
    const poll = setInterval(() => {
      if (isCancelled?.()) {
        try { conn.destroy(); } catch { /* ignore */ }
      }
    }, 200);

    const cleanup = () => {
      clearInterval(poll);
      conn.off('close', onConnClosed);
      conn.off('end', onConnClosed);
    };

    conn.on('close', onConnClosed);
    conn.on('end', onConnClosed);

    conn.exec(command, (err, stream) => {
      if (err) return finish(err);
      let stdout = '';
      const timer = setTimeout(() => {
        try { stream.close(); conn.destroy(); } catch { /* ignore */ }
        finish(new Error(`Command timed out after ${timeoutSec}s: ${command}`));
      }, timeoutSec * 1000);

      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', () => { /* ignored */ });
      stream.on('close', () => {
        clearTimeout(timer);
        if (isCancelled?.()) finish(new Error(SCAN_CANCELLED));
        else finish(null, stdout);
      });
    });
  });
}

function parseFindLines(output: string): FileMonitorFile[] {
  const files: FileMonitorFile[] = [];
  for (const line of output.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/, 3);
    if (parts.length < 3) continue;
    const mtimeSec = parseFloat(parts[0]);
    const size = parseInt(parts[1], 10);
    const filepath = parts[2];
    const mtime = new Date(mtimeSec * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const name = filepath.split('/').pop() ?? filepath;
    files.push({ name, size, mtime, path: filepath });
  }
  return files;
}

async function checkPendingFiles(
  conn: SSH2Client,
  folderPath: string,
  timeoutSec: number,
  isCancelled?: () => boolean,
): Promise<FileMonitorFile[]> {
  const cmd = `find ${shellQuote(folderPath)} -maxdepth 1 -type f -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn`;
  const output = await sshExecCancellable(conn, cmd, timeoutSec, isCancelled);
  return parseFindLines(output);
}

async function checkRejectedFiles(
  conn: SSH2Client,
  root: string,
  timeoutSec: number,
  isCancelled?: () => boolean,
): Promise<FileMonitorRejectedFolder[]> {
  // -path is faster than -regex on large upload trees; scans DTS/Rejected for today (server local date)
  const inner =
    `find ${shellQuote(root)} -type f -path '*/DTS/*/Rejected/*' ` +
    `-newermt "$(date +%Y-%m-%d) 00:00:00" -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn`;
  const cmd = `bash -lc ${shellQuote(inner)}`;
  const output = await sshExecCancellable(conn, cmd, timeoutSec, isCancelled);
  const byFolder = new Map<string, FileMonitorFile[]>();
  for (const f of parseFindLines(output)) {
    const folder = f.path ? f.path.replace(/\/[^/]+$/, '') : 'unknown';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push({ name: f.name, size: f.size, mtime: f.mtime });
  }
  return [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, files]) => ({ folder, files }));
}

export function getFileMonitorPaths(input: Pick<FileMonitorFetchRequest, 'pendingPath' | 'rejectedRoot'> = {}) {
  return {
    pending: input.pendingPath
      || configService.getString('infra.sshPendingFolderPath', DEFAULT_PENDING_PATH),
    rejected: input.rejectedRoot
      || configService.getString('infra.sshRejectedUploadRoot', DEFAULT_REJECTED_ROOT),
  };
}

export async function fetchUploadFileMonitor(
  input: FileMonitorFetchRequest = {},
  options: FileMonitorFetchOptions = {},
): Promise<FileMonitorFetchResult> {
  const { isCancelled, onConnection, onConnectionClosed, onProgress } = options;
  const checkPending = input.checkPending !== false;
  const checkRejected = input.checkRejected !== false;
  const { pending: pendingPath, rejected: rejectedRoot } = getFileMonitorPaths(input);
  const cmdTimeout = configService.getInt('infra.sshCommandTimeoutSec', 30);
  const rejectedTimeoutSec = configService.getInt('infra.sshRejectedFindTimeoutSec', 120);

  const rows: ClientFileMonitorResult[] = [];
  let cancelled = false;
  let scanError: string | undefined;
  let plannedTotal = 0;
  let usesTotp = false;

  try {
    const where: any = { isActive: true };
    const clusters = (input.clusters ?? []).filter(Boolean);
    const clientIds = (input.clientIds ?? []).filter(Boolean);
    if (clientIds.length > 0) {
      where.clientId = { in: clientIds };
    } else if (clusters.length > 0) {
      where.cluster = { in: clusters };
    }

    const clients = await prisma.client.findMany({
      where,
      include: { appServers: { where: { environment: 'Prod', isActive: true } } },
      orderBy: [{ cluster: 'asc' }, { clientId: 'asc' }],
    });
    plannedTotal = clients.length;

    let creds;
    try {
      creds = loadCredentials();
    } catch (err: any) {
      throw new Error(`SSH credentials not configured: ${err.message}`);
    }
    usesTotp = sshCredentialsUseTotp();

    onProgress?.({
      type: 'start',
      plannedTotal: clients.length,
      paths: { pending: pendingPath, rejected: rejectedRoot },
      usesTotpAuth: usesTotp,
    });

    logger.info(`File monitor: scanning ${clients.length} clients (pending=${checkPending}, rejected=${checkRejected})`);

    const emitProgress = (row: ClientFileMonitorResult) => {
      onProgress?.({
        type: 'progress',
        completed: rows.length,
        plannedTotal: clients.length,
        clientId: row.clientId,
        row,
      });
    };

    for (let i = 0; i < clients.length; i++) {
      if (isCancelled?.()) {
        cancelled = true;
        logger.info(`File monitor: scan cancelled after ${rows.length}/${clients.length} client(s)`);
        break;
      }

      const client = clients[i];
      const server = client.appServers[0];
      const progress = `[${i + 1}/${clients.length}]`;

      if (!server) {
        const row: ClientFileMonitorResult = {
          clientId: client.clientId,
          clientName: client.name,
          cluster: client.cluster ?? undefined,
          server: '—',
          pendingCount: 0,
          rejectedCount: 0,
          pendingFiles: [],
          rejectedFolders: [],
          error: 'No active Prod app server',
          status: 'SKIPPED',
        };
        rows.push(row);
        emitProgress(row);
        continue;
      }

      let conn: SSH2Client | null = null;
      let connected = false;
      try {
        logger.info(`${progress} ${client.clientId} → ${server.dns}`);
        conn = await sshConnect(server.dns, creds, {
          onClient: (c) => onConnection?.(c),
        });
        connected = true;

        const pendingFiles = checkPending
          ? await checkPendingFiles(conn, pendingPath, cmdTimeout, isCancelled)
          : [];
        if (isCancelled?.()) {
          cancelled = true;
          break;
        }

        const rejectedFolders = checkRejected
          ? await checkRejectedFiles(conn, rejectedRoot, rejectedTimeoutSec, isCancelled)
          : [];
        if (isCancelled?.()) {
          cancelled = true;
          break;
        }

        const rejectedCount = rejectedFolders.reduce((n, f) => n + f.files.length, 0);

        const hasAlert = pendingFiles.length > 0 || rejectedCount > 0;
        const row: ClientFileMonitorResult = {
          clientId: client.clientId,
          clientName: client.name,
          cluster: client.cluster ?? undefined,
          server: server.dns,
          pendingCount: pendingFiles.length,
          rejectedCount,
          pendingFiles,
          rejectedFolders,
          status: hasAlert ? 'ALERT' : 'CLEAN',
        };
        rows.push(row);
        emitProgress(row);
      } catch (err: any) {
        if (isCancelled?.() || err.message === SCAN_CANCELLED) {
          cancelled = true;
          logger.info(`File monitor: scan cancelled during ${client.clientId}`);
          break;
        }
        logger.warn(`${progress} ${client.clientId} failed: ${err.message}`);
        const row: ClientFileMonitorResult = {
          clientId: client.clientId,
          clientName: client.name,
          cluster: client.cluster ?? undefined,
          server: server.dns,
          pendingCount: 0,
          rejectedCount: 0,
          pendingFiles: [],
          rejectedFolders: [],
          error: err.message,
          status: 'ERROR',
        };
        rows.push(row);
        emitProgress(row);
      } finally {
        if (conn) {
          try { conn.destroy(); } catch { /* ignore */ }
        }
        onConnectionClosed?.();
      }

      if (isCancelled?.()) {
        cancelled = true;
        logger.info(`File monitor: scan cancelled after ${rows.length}/${clients.length} client(s)`);
        break;
      }

      if (usesTotp && connected && i < clients.length - 1) {
        logger.info('Waiting 30s for TOTP cooldown...');
        const continued = await interruptibleDelay(
          30000,
          isCancelled,
          () => {
            onProgress?.({
              type: 'heartbeat',
              completed: rows.length,
              plannedTotal: clients.length,
              phase: 'totp-cooldown',
              clientId: client.clientId,
            });
          },
        );
        if (!continued) {
          cancelled = true;
          logger.info(`File monitor: scan cancelled during TOTP cooldown (${rows.length}/${clients.length} client(s))`);
          break;
        }
      }
    }
  } catch (err: any) {
    scanError = err.message ?? String(err);
    logger.error(`File monitor: scan aborted — ${scanError} (${rows.length}/${plannedTotal} client(s) collected)`);
  }

  const result = buildFileMonitorResult(
    rows,
    pendingPath,
    rejectedRoot,
    usesTotp,
    plannedTotal,
    cancelled,
    scanError,
  );
  onProgress?.({ type: 'complete', data: result });
  return result;
}
