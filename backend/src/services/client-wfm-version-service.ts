// ============================================================
// Client WFM app version — cached APPURL + /reflexisversion.txt
// ============================================================
// APPURL is stored on Client.wfmAppUrl after first DB2 lookup (RFX_CONFIG).
// Daily / normal refreshes only HTTP-fetch {wfmAppUrl}/reflexisversion.txt.
// Re-query DB2 for APPURL only when missing or refreshAppUrl=true (manual).

import http from 'http';
import https from 'https';
import { Agent as HttpsAgent } from 'https';
import { prisma } from '../database/prisma';
import { db2DirectService } from './db2-direct-service';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('WfmVersionSync');

const APPURL_SQL =
  `SELECT PARAM_VALUE FROM RWSUSER.RFX_CONFIG WHERE PARAM_NAME = 'APPURL' FETCH FIRST 1 ROW ONLY`;

const VERSION_PATH = '/reflexisversion.txt';
const HTTP_TIMEOUT_MS = 15_000;
const insecureHttpsAgent = new HttpsAgent({ rejectUnauthorized: false });

export interface WfmVersionSyncOptions {
  /** Bypass 20h cooldown (daily schedule and manual refresh use true). */
  force?: boolean;
  /** Re-query RFX_CONFIG for APPURL even when Client.wfmAppUrl is already set. */
  refreshAppUrl?: boolean;
}

export interface WfmVersionSyncResult {
  clientId: string;
  success: boolean;
  appUrl?: string | null;
  version?: string | null;
  error?: string;
  skipped?: boolean;
  appUrlFromDb2?: boolean;
}

function cell(row: Record<string, string | null> | undefined, key: string): string {
  if (!row) return '';
  const direct = row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
  return (direct || '').trim();
}

function normalizeAppUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  // APPURL sometimes stored without scheme
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

function parseVersionText(body: string): string | null {
  const firstLine = body.split(/\r?\n/)[0]?.trim() || '';
  if (!firstLine) return null;
  // Support labels like 1.0.0+build or "Version: 8.12.3"
  const labeled = firstLine.match(/version\s*[:=]\s*(.+)$/i);
  const raw = (labeled?.[1] || firstLine).trim();
  const base = raw.split(/\s+/)[0];
  return base || null;
}

function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid APPURL: ${url}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: HTTP_TIMEOUT_MS,
        headers: { Accept: 'text/plain,*/*' },
        // Client WFM apps often use internal / corporate certs
        ...(isHttps ? { agent: insecureHttpsAgent } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );

    req.on('error', (err: Error) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP request timed out'));
    });
    req.end();
  });
}

class ClientWfmVersionService {
  async fetchAppUrlFromDb2(clientId: string): Promise<string | null> {
    const result = await db2DirectService.queryClient(clientId, APPURL_SQL, 'WfmVersion/APPURL');
    if (!result.success) {
      throw new Error(result.error || 'DB2 APPURL query failed');
    }
    const row = result.rows?.[0] as Record<string, string | null> | undefined;
    const value = cell(row, 'PARAM_VALUE');
    return value ? normalizeAppUrl(value) : null;
  }

  async fetchVersionFromUrl(appUrl: string): Promise<string> {
    const versionUrl = `${normalizeAppUrl(appUrl)}${VERSION_PATH}`;
    const { status, body } = await fetchText(versionUrl);
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status} from ${versionUrl}`);
    }
    const version = parseVersionText(body);
    if (!version) {
      throw new Error(`Empty version at ${versionUrl}`);
    }
    return version;
  }

  /**
   * Sync one client's WFM version using cached APPURL when available.
   * DB2 is queried only when APPURL is missing or refreshAppUrl is true.
   */
  async syncClient(
    clientId: string,
    opts: { refreshAppUrl?: boolean; storedAppUrl?: string | null } = {},
  ): Promise<WfmVersionSyncResult> {
    const refreshAppUrl = !!opts.refreshAppUrl;
    let appUrl = opts.storedAppUrl?.trim() ? normalizeAppUrl(opts.storedAppUrl) : null;
    let appUrlFromDb2 = false;

    try {
      if (!appUrl || refreshAppUrl) {
        appUrl = await this.fetchAppUrlFromDb2(clientId);
        appUrlFromDb2 = true;
        // Persist APPURL immediately so later version-only runs can reuse it
        await prisma.client.update({
          where: { clientId },
          data: { wfmAppUrl: appUrl },
        });
      }

      if (!appUrl) {
        await prisma.client.update({
          where: { clientId },
          data: {
            wfmAppUrl: null,
            wfmAppVersionSyncedAt: new Date(),
          },
        });
        return {
          clientId,
          success: false,
          appUrl: null,
          version: null,
          error: 'APPURL not found in RFX_CONFIG',
          appUrlFromDb2,
        };
      }

      const version = await this.fetchVersionFromUrl(appUrl);
      await prisma.client.update({
        where: { clientId },
        data: {
          wfmAppUrl: appUrl,
          wfmAppVersion: version,
          wfmAppVersionSyncedAt: new Date(),
        },
      });
      return { clientId, success: true, appUrl, version, appUrlFromDb2 };
    } catch (err: any) {
      const message = err?.message || String(err);
      try {
        await prisma.client.update({
          where: { clientId },
          data: { wfmAppVersionSyncedAt: new Date() },
        });
      } catch {
        // ignore secondary update errors
      }
      return { clientId, success: false, appUrl, error: message, appUrlFromDb2 };
    }
  }

  /**
   * Refresh WFM versions for all active clients with DB2 configured.
   * Reuses Client.wfmAppUrl unless missing or refreshAppUrl=true.
   */
  async syncAll(options: WfmVersionSyncOptions = {}): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    appUrlRefreshed: number;
    results: WfmVersionSyncResult[];
  }> {
    const force = !!options.force;
    const refreshAppUrl = !!options.refreshAppUrl;
    const clients = await db2DirectService.getAvailableClients();
    const concurrency = Math.max(1, configService.getInt('engine.db2QueryConcurrency', 5));
    const cooldownMs = 20 * 60 * 60 * 1000; // slightly under 24h so daily cron always re-runs
    const results: WfmVersionSyncResult[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let appUrlRefreshed = 0;
    let idx = 0;

    const existing = await prisma.client.findMany({
      where: { clientId: { in: clients.map(c => c.clientId) } },
      select: { clientId: true, wfmAppUrl: true, wfmAppVersionSyncedAt: true },
    });
    const byId = new Map(
      existing.map(c => [c.clientId.toUpperCase(), c]),
    );

    logger.info(
      `WFM version sync: ${clients.length} clients ` +
      `(concurrency=${concurrency}, force=${force}, refreshAppUrl=${refreshAppUrl})`,
    );

    const processNext = async (): Promise<void> => {
      if (idx >= clients.length) return;
      const c = clients[idx++];
      const row = byId.get(c.clientId.toUpperCase());
      if (!force && row?.wfmAppVersionSyncedAt
        && Date.now() - row.wfmAppVersionSyncedAt.getTime() < cooldownMs) {
        skipped++;
        results.push({ clientId: c.clientId, success: true, skipped: true });
        await processNext();
        return;
      }

      const result = await this.syncClient(c.clientId, {
        refreshAppUrl,
        storedAppUrl: row?.wfmAppUrl,
      });
      results.push(result);
      if (result.appUrlFromDb2) appUrlRefreshed++;
      if (result.success) {
        succeeded++;
        logger.info(
          `WFM version: ${c.clientId} → ${result.version} (${result.appUrl}` +
          `${result.appUrlFromDb2 ? ', APPURL from DB2' : ', cached APPURL'})`,
        );
      } else {
        failed++;
        logger.warn(`WFM version: ${c.clientId} → ${result.error}`);
      }
      await processNext();
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, clients.length) }, () => processNext()),
    );

    logger.info(
      `WFM version sync complete: ${succeeded} ok, ${failed} failed, ${skipped} skipped, ` +
      `${appUrlRefreshed} APPURL lookups (${clients.length} total)`,
    );

    return { total: clients.length, succeeded, failed, skipped, appUrlRefreshed, results };
  }
}

export const clientWfmVersionService = new ClientWfmVersionService();
