// ============================================================
// DB2 Direct Service
// Connects to client DB2 databases.
// Connection details (host, port, database, username, password)
// are fetched from the Prisma Client table and injected into
// the Java DB2Connector via env vars (DB2_URL_OVERRIDE etc.).
// When Keeper is configured, DB2_PASS_OVERRIDE is used instead
// of the stored password.
// ============================================================

import { execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createServiceLogger } from '../utils/logger';
import { keeperService } from './keeper-service';
import { configService } from './config-service';
import { prisma } from '../database/prisma';

const execFileAsync = promisify(execFile);
const logger = createServiceLogger('DB2Direct');

type BatchSummary = {
  clients: Record<string, { groups: BatchJobGroup[]; error?: string }>;
  pendingAlerts: { clientId: string; stalePendingCount: number; totalPending: number }[];
  fetchedAt: string;
};

// ============================================================
// Types
// ============================================================

export interface DB2ClientInfo {
  clientId: string;
  host: string;
  port: string;
  database: string;
  serverCode: string;
}

export interface BatchJobGroup {
  jobType: string;
  planType: string;
  description: string;
  totalRuns: number;
  completed: number;
  failed: number;
  active: number;
  pending: number;
  stalePending: number;
  latestRun: string | null;
}

export interface BatchStatusDetail {
  batchStatusId: string;
  jobType: string;
  status: string;
  statusLabel: string;
  startDateSkey: string;
  timeSubmitted: string | null;
  timeCompleted: string | null;
  description: string;
  totalJobs: number;
  pendingJobs: number;
  durationSec: number | null;
  unitSkey: string;
  successCount: number;
  failCount: number;
  otherCount: number;
}

export interface DB2QueryOutput {
  success: boolean;
  columns?: string[];
  rows?: Record<string, string | null>[];
  rowCount?: number;
  executionMs?: number;
  error?: string;
}

// Status code map: C=Completed, N=New, I=In-progress, A=Active
const STATUS_MAP: Record<string, string> = {
  C: 'Completed',
  N: 'New',
  I: 'In Progress',
  A: 'Active',
  E: 'Error',
  F: 'Failed',
};

// ============================================================
// Service
// ============================================================

class DB2DirectService {
  private readonly jjsPath: string;
  private readonly connectorScript: string;
  private readonly db2Jar: string;
  private readonly activeProcesses = new Set<ChildProcess>();
  private shuttingDown = false;
  private batchSummaryCache = new Map<number, { data: BatchSummary; updatedAtMs: number }>();

  constructor() {
    const root = path.resolve(__dirname, '../../..');
    this.connectorScript = process.env.DB2_LIB_DIR
      ? path.join(process.env.DB2_LIB_DIR, 'DB2Connector.js')
      : path.join(root, 'lib', 'DB2Connector.js');
    this.db2Jar = process.env.DB2_LIB_DIR
      ? path.join(process.env.DB2_LIB_DIR, 'db2jcc4.jar')
      : path.join(root, 'lib', 'db2jcc4.jar');
    this.jjsPath = process.env.JJS_PATH || 'C:\\Program Files\\Java\\jre1.8.0_491\\bin\\jjs.exe';
  }

  /**
   * List all active clients that have DB2 connection details configured in Prisma.
   */
  async getAvailableClients(): Promise<DB2ClientInfo[]> {
    try {
      const clients = await prisma.client.findMany({
        where: {
          isActive: true,
          db2Host: { not: null },
          db2Database: { not: null },
        },
        select: {
          clientId: true,
          db2Host: true,
          db2Port: true,
          db2Database: true,
        },
        orderBy: { clientId: 'asc' },
      });

      return clients.map(c => {
        const codeMatch = (c.db2Host ?? '').match(/z\d+sp-(\w+?)rws/i);
        const serverCode = codeMatch ? codeMatch[1].toUpperCase() : c.clientId;
        return {
          clientId: c.clientId,
          serverCode,
          host: c.db2Host!,
          port: String(c.db2Port ?? configService.getInt('infra.db2DefaultPort', 50000)),
          database: c.db2Database!,
        };
      });
    } catch (err: any) {
      logger.warn(`Failed to load clients from Prisma: ${err.message}`);
      return [];
    }
  }

  /**
   * Test DB2 connectivity for a client.
   */
  async testConnection(clientId: string): Promise<DB2QueryOutput & { client?: string }> {
    return this.runConnector('test', clientId, undefined, 'ConnectionTest');
  }

  /**
   * Run an arbitrary SQL query against a client's DB2 database.
   * @param caller Optional label for log tracing (e.g. 'UnprocessedPunch', 'Payroll')
   */
  async queryClient(clientId: string, sql: string, caller?: string): Promise<DB2QueryOutput> {
    return this.runConnector('query', clientId, sql, caller ?? 'queryClient');
  }

  /**
   * Get batch status grouped by JOB_TYPE for the last N days.
   * Filters on TIME_SUBMITTED for accurate day-range coverage.
   */
  async getBatchStatusGrouped(clientId: string, days: number = configService.getInt('engine.batchQueryDays', 7)): Promise<BatchJobGroup[]> {
    const sql = `SELECT JOB_TYPE, PLAN_TYPE, COUNT(*) AS CNT, ` +
      `SUM(CASE WHEN STATUS='C' THEN 1 ELSE 0 END) AS COMPLETED, ` +
      `SUM(CASE WHEN STATUS IN ('E','F') THEN 1 ELSE 0 END) AS FAILED, ` +
      `SUM(CASE WHEN STATUS='A' THEN 1 ELSE 0 END) AS ACTIVE, ` +
      `SUM(CASE WHEN STATUS='N' THEN 1 ELSE 0 END) AS PENDING, ` +
      `SUM(CASE WHEN STATUS='N' AND TIME_SUBMITTED IS NOT NULL AND TIME_SUBMITTED < CURRENT TIMESTAMP - ${configService.getInt('threshold.stalePendingDbMins', 30)} MINUTES THEN 1 ELSE 0 END) AS STALE_PENDING, ` +
      `MAX(TIME_SUBMITTED) AS LATEST_RUN, ` +
      `MAX(DESCRIPTION) AS DESCR ` +
      `FROM RWSUSER.BATCH_STATUS ` +
      `WHERE TIME_SUBMITTED >= CURRENT TIMESTAMP - ${days} DAYS ` +
      `GROUP BY JOB_TYPE, PLAN_TYPE ORDER BY CNT DESC`;

    const result = await this.runConnector('query', clientId, sql, 'BatchStatusGrouped');

    if (!result.success || !result.rows) {
      throw new Error(result.error || 'Failed to query batch status');
    }

    return result.rows.map(row => ({
      jobType: (row.JOB_TYPE || '').trim(),
      planType: (row.PLAN_TYPE || '').trim(),
      description: (row.DESCR || '').trim(),
      totalRuns: parseInt(row.CNT || '0', 10),
      completed: parseInt(row.COMPLETED || '0', 10),
      failed: parseInt(row.FAILED || '0', 10),
      active: parseInt(row.ACTIVE || '0', 10),
      pending: parseInt(row.PENDING || '0', 10),
      stalePending: parseInt(row.STALE_PENDING || '0', 10),
      latestRun: row.LATEST_RUN ? row.LATEST_RUN.trim() : null,
    }));
  }

  /**
   * Get detailed batch status records for a specific JOB_TYPE.
   */
  async getBatchStatusDetails(clientId: string, jobType: string, planType: string, days: number = configService.getInt('engine.batchQueryDays', 7)): Promise<BatchStatusDetail[]> {
    const safeJobType = jobType.replace(/[^a-zA-Z0-9_]/g, '');
    const safePlanType = planType.replace(/[^a-zA-Z0-9_]/g, '');

    const sql = `SELECT bs.BATCH_STATUS_ID, bs.JOB_TYPE, bs.STATUS, bs.START_DATE_SKEY, ` +
      `bs.TIME_SUBMITTED, bs.TIME_COMPLETED, bs.DESCRIPTION, bs.TOTAL_JOBS, bs.PENDING_JOBS, bs.UNIT_SKEY, ` +
      `(SELECT COUNT(1) FROM RWSUSER.RFX_QUEUE_JOB q WHERE q.BATCH_STATUS_ID = bs.BATCH_STATUS_ID AND q.JOB_ESTATUS='S') AS SUCCESS_COUNT, ` +
      `(SELECT COUNT(1) FROM RWSUSER.RFX_QUEUE_JOB q WHERE q.BATCH_STATUS_ID = bs.BATCH_STATUS_ID AND q.JOB_ESTATUS='F') AS FAIL_COUNT, ` +
      `(SELECT COUNT(1) FROM RWSUSER.RFX_QUEUE_JOB q WHERE q.BATCH_STATUS_ID = bs.BATCH_STATUS_ID AND q.JOB_ESTATUS NOT IN ('S','F')) AS OTHER_COUNT ` +
      `FROM RWSUSER.BATCH_STATUS bs ` +
      `WHERE bs.JOB_TYPE = '${safeJobType}' AND bs.PLAN_TYPE = '${safePlanType}' AND bs.TIME_SUBMITTED >= CURRENT TIMESTAMP - ${days} DAYS ` +
      `ORDER BY bs.TIME_SUBMITTED DESC ` +
      `FETCH FIRST ${configService.getInt('engine.maxBatchDetailRows', 500)} ROWS ONLY`;

    const result = await this.runConnector('query', clientId, sql, 'BatchStatusDetails');

    if (!result.success || !result.rows) {
      throw new Error(result.error || 'Failed to query batch details');
    }

    return result.rows.map(row => {
      const submitted = row.TIME_SUBMITTED ? row.TIME_SUBMITTED.trim() : null;
      const completed = row.TIME_COMPLETED ? row.TIME_COMPLETED.trim() : null;
      let durationSec: number | null = null;
      if (submitted && completed) {
        const d = new Date(completed).getTime() - new Date(submitted).getTime();
        if (!isNaN(d)) durationSec = Math.round(d / 1000);
      }

      const statusCode = (row.STATUS || '').trim();
      return {
        batchStatusId: (row.BATCH_STATUS_ID || '').trim(),
        jobType: (row.JOB_TYPE || '').trim(),
        status: statusCode,
        statusLabel: STATUS_MAP[statusCode] || statusCode,
        startDateSkey: (row.START_DATE_SKEY || '').trim(),
        timeSubmitted: submitted,
        timeCompleted: completed,
        description: (row.DESCRIPTION || '').trim(),
        totalJobs: parseInt(row.TOTAL_JOBS || '0', 10),
        pendingJobs: parseInt(row.PENDING_JOBS || '0', 10),
        durationSec,
        unitSkey: (row.UNIT_SKEY || '').trim(),
        successCount: parseInt(row.SUCCESS_COUNT || '0', 10),
        failCount: parseInt(row.FAIL_COUNT || '0', 10),
        otherCount: parseInt(row.OTHER_COUNT || '0', 10),
      };
    });
  }

  /**
   * Fetch running jobs from RFX_QUEUE joined with STD_QUEUE_JOB for a specific client.
   * QUEUE_STATUS='R' = Running, OWNER_ID <> -1 = owned/active entries.
   */
  async getQueueJobs(clientId: string): Promise<DB2QueryOutput> {
    const sql =
      `SELECT q.JOB_TYPE, COALESCE(EXEC_CRON, CHAR(QUEUE_SLEEP)) JOB_INTERVAL, PARAM_2, LAST_JOB_TIME, JOBS_PENDING ` +
      `FROM RWSUSER.RFX_QUEUE q ` +
      `LEFT JOIN RWSUSER.STD_QUEUE_JOB s ON s.QUEUE_ID = q.QUEUE_ID ` +
      `WHERE q.QUEUE_STATUS = 'R' ORDER BY JOBS_PENDING DESC, LAST_JOB_TIME`;

    return this.runConnector('query', clientId, sql, 'QueueJobs');
  }

  /**
   * Fetch running queue jobs for ALL available clients in parallel.
   */
  async getAllQueueJobs(): Promise<{
    clients: Record<string, { jobs: any[]; error?: string }>;
    fetchedAt: string;
  }> {
    const availableClients = await this.getAvailableClients();
    const results: Record<string, { jobs: any[]; error?: string }> = {};

    const concurrency = configService.getInt('engine.db2QueryConcurrency', 5);
    let idx = 0;

    await new Promise<void>((resolve) => {
      let running = 0;
      const runNext = () => {
        while (running < concurrency && idx < availableClients.length) {
          const client = availableClients[idx++];
          running++;

          this.getQueueJobs(client.clientId)
            .then(result => {
              if (result.success && result.rows) {
                results[client.clientId] = {
                  jobs: result.rows.map(row => this.mapQueueRow(row)),
                };
              } else {
                results[client.clientId] = { jobs: [], error: result.error };
              }
            })
            .catch(err => {
              results[client.clientId] = { jobs: [], error: err.message };
            })
            .finally(() => {
              running--;
              if (idx >= availableClients.length && running === 0) resolve();
              else runNext();
            });
        }
      };
      runNext();
    });

    return { clients: results, fetchedAt: new Date().toISOString() };
  }

  /**
   * Fetch batch status for ALL available clients in parallel.
   * Returns grouped batch data per client plus pending alerts summary.
   */
  async getAllBatchStatusSummary(
    days: number = configService.getInt('engine.dbMonitorBatchDays', 2),
    options: { forceRefresh?: boolean } = {}
  ): Promise<BatchSummary> {
    const cacheKey = Number.isFinite(days) && days > 0 ? days : 2;
    const cached = this.batchSummaryCache.get(cacheKey);
    const isFresh = !!cached && (Date.now() - cached.updatedAtMs) < configService.getInt('polling.batchCacheTtlMins', 30) * 60 * 1000;

    if (!options.forceRefresh && isFresh) {
      return cached!.data;
    }

    const availableClients = await this.getAvailableClients();
    const results: Record<string, { groups: BatchJobGroup[]; error?: string }> = {};
    const pendingAlerts: { clientId: string; stalePendingCount: number; totalPending: number }[] = [];

    const concurrency = configService.getInt('engine.db2QueryConcurrency', 5);
    let idx = 0;

    await new Promise<void>((resolve) => {
      let running = 0;
      const runNext = () => {
        while (running < concurrency && idx < availableClients.length) {
          const client = availableClients[idx++];
          running++;

          this.getBatchStatusGrouped(client.clientId, days)
            .then(groups => {
              results[client.clientId] = { groups };
              const totalPending = groups.reduce((sum, g) => sum + g.pending, 0);
              const stalePendingCount = groups.reduce((sum, g) => sum + g.stalePending, 0);
              if (stalePendingCount > 0) {
                pendingAlerts.push({ clientId: client.clientId, stalePendingCount, totalPending });
              }
            })
            .catch(err => {
              results[client.clientId] = { groups: [], error: err.message };
            })
            .finally(() => {
              running--;
              if (idx >= availableClients.length && running === 0) resolve();
              else runNext();
            });
        }
      };
      runNext();
    });

    const summary: BatchSummary = {
      clients: results,
      pendingAlerts: pendingAlerts.sort((a, b) => b.stalePendingCount - a.stalePendingCount),
      fetchedAt: new Date().toISOString(),
    };

    this.batchSummaryCache.set(cacheKey, {
      data: summary,
      updatedAtMs: Date.now(),
    });

    return summary;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  /**
   * Run the Java/Nashorn DB2Connector script via jjs.
   * Tracks child processes for graceful shutdown.
   * @param caller Optional label identifying the calling feature (for log tracing)
   */
  private async runConnector(action: string, clientId: string, sql?: string, caller?: string): Promise<DB2QueryOutput> {
    if (this.shuttingDown) {
      return { success: false, error: 'Service is shutting down' };
    }

    const safeClient = clientId.replace(/[^a-zA-Z0-9_]/g, '');
    const args = ['-cp', this.db2Jar, this.connectorScript, '--', action, safeClient];
    if (sql) args.push(sql);

    // Build child env: start with Prisma-sourced connection details,
    // then overlay Keeper password if configured.
    const childEnv = await this.buildConnEnv(safeClient, caller);

    return new Promise((resolve) => {
      const child = execFile(this.jjsPath, args, {
        cwd: path.resolve(__dirname, '../../..'),
        timeout: configService.getInt('engine.jjsTimeoutMs', 120000),
        maxBuffer: configService.getInt('engine.jjsMaxBuffer', 10485760),
        env: childEnv,
      }, (err, stdout, stderr) => {
        this.activeProcesses.delete(child);

        if (err) {
          // Try to parse JSON error from stdout
          if (stdout) {
            try {
              resolve(JSON.parse(stdout.trim()));
              return;
            } catch { /* fall through */ }
          }
          logger.error(`DB2 connector error for ${safeClient}: ${err.message}`);
          resolve({ success: false, error: err.message });
          return;
        }

        const output = (stdout || '').trim();
        if (!output) {
          resolve({ success: false, error: stderr || 'No output from DB2 connector' });
          return;
        }

        try {
          resolve(JSON.parse(output));
        } catch {
          resolve({ success: false, error: 'Invalid JSON response from DB2 connector' });
        }
      });

      this.activeProcesses.add(child);
    });
  }

  /**
   * Shutdown: kill all in-flight jjs child processes.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const count = this.activeProcesses.size;
    if (count > 0) {
      logger.info(`Killing ${count} active DB2 connector process(es)...`);
      for (const proc of this.activeProcesses) {
        try { proc.kill(); } catch { /* ignore */ }
      }
      this.activeProcesses.clear();
    }
    logger.info('DB2 Direct Service shut down');
  }

  /**
   * Build the environment variables for the DB2 connector child process.
   * Fetches connection details from Prisma and overlays Keeper password if configured.
   * @param caller Optional label identifying the calling feature (for log tracing)
   */
  private async buildConnEnv(clientId: string, caller?: string): Promise<NodeJS.ProcessEnv> {
    let env = { ...process.env };

    try {
      const rec = await prisma.client.findFirst({
        where: { clientId },
        select: {
          db2Host: true,
          db2Port: true,
          db2Database: true,
          db2Username: true,
          db2Password: true,
        },
      });

      if (rec?.db2Host && rec.db2Database) {
        const jdbcUrl = `jdbc:db2://${rec.db2Host}:${rec.db2Port ?? configService.getInt('infra.db2DefaultPort', 50000)}/${rec.db2Database}`;
        env.DB2_URL_OVERRIDE = jdbcUrl;
        if (rec.db2Username) env.DB2_USER_OVERRIDE = rec.db2Username;
        if (rec.db2Password) env.DB2_PASS_OVERRIDE = rec.db2Password;
        logger.debug(`Using Prisma connection for ${clientId}${caller ? ` [caller: ${caller}]` : ''}: ${jdbcUrl}`);
      } else {
        logger.warn(`No DB2 connection configured in database for ${clientId}`);
      }
    } catch (err: any) {
      logger.warn(`Prisma lookup failed for ${clientId}: ${err.message}`);
    }

    // Keeper password always wins over everything else (when configured)
    if (keeperService.isConfigured()) {
      const keeperPass = await keeperService.getPassword(clientId);
      if (keeperPass) {
        env.DB2_PASS_OVERRIDE = keeperPass;
        logger.debug(`Keeper password applied for ${clientId}`);
      }
    }

    return env;
  }

  /**
   * Map a raw RFX_QUEUE row to a camelCase object.
   * Since we use SELECT *, column names come from the DB — normalize them.
   */
  private mapQueueRow(row: Record<string, string | null>): Record<string, any> {
    const mapped: Record<string, any> = {};
    for (const [key, val] of Object.entries(row)) {
      // Convert UPPER_SNAKE_CASE to camelCase, handling both letters and digits after underscores
      // e.g. JOB_TYPE → jobType, PARAM_2 → param2, LAST_JOB_TIME → lastJobTime
      const camel = key.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      mapped[camel] = typeof val === 'string' ? val.trim() : val;
    }
    return mapped;
  }

  /**
   * Parse jdbc:db2://host:port/database URL — never returns password.
   */
  private parseJdbcUrl(url: string): { host: string; port: string; database: string } {
    const match = url.match(/jdbc:db2:\/\/([^:]+):(\d+)\/(\S+)/);
    if (match) {
      return { host: match[1], port: match[2], database: match[3] };
    }
    return { host: '', port: '', database: '' };
  }

  /**
   * Calculate START_DATE_SKEY for N days ago (YYYYMMDD integer).
   * "Last 1 day" = today only, "Last 7 days" = today minus 6 days.
   */
  private getDateSkey(daysAgo: number): number {
    const d = new Date();
    d.setDate(d.getDate() - (daysAgo - 1));
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return parseInt(`${yyyy}${mm}${dd}`, 10);
  }
}

export const db2DirectService = new DB2DirectService();
