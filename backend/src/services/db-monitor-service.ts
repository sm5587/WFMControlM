// ============================================================
// DB Monitor Service
// Connects to client DB2 databases via SSH tunnel and queries
// WFM job status tables for DB-side monitoring
// Uses DB2 connection pool to manage 75 clients efficiently
// ============================================================

import { Client as SSH2Client } from 'ssh2';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../database/prisma';
import { keeperService, DB2Credentials } from './keeper-service';
import { db2Pool, sshExec } from './db2-connection-pool';

// ============================================================
// Types
// ============================================================

export interface DB2JobStatus {
  jobName: string;
  status: string;
  lastRunTime: string | null;
  nextRunTime: string | null;
  exitCode: number | null;
  duration: number | null;
  message: string | null;
  rowCount: number | null;
  tableName: string;
}

export interface DB2TableInfo {
  tableName: string;
  rowCount: number;
  lastUpdated: string | null;
  sizeKb: number | null;
}

export interface DB2QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  executionTimeMs: number;
  query: string;
}

export interface DB2ConnectionStatus {
  clientId: string;
  connected: boolean;
  host: string;
  database: string;
  schema: string;
  error?: string;
  latencyMs?: number;
}

// ============================================================
// SSH helpers moved to db2-connection-pool.ts
// ============================================================



// ============================================================
// DB Monitor Service
// ============================================================

class DBMonitorService {

  /**
   * Resolve client + server + DB2 credentials (common to all methods).
   */
  private async resolveClient(clientDbId: string) {
    const client = await prisma.client.findUnique({
      where: { id: clientDbId },
      include: { appServers: { where: { environment: 'Prod', isActive: true } } },
    });
    if (!client) throw new Error(`Client not found: ${clientDbId}`);
    const server = client.appServers[0];
    if (!server) throw new Error(`No active Prod server for client ${client.clientId}`);
    if (!client.db2Database) throw new Error(`DB2 database not configured for ${client.clientId}`);

    const db2Creds = await keeperService.getDB2Credentials(client.clientId, {
      db2Host: client.db2Host,
      db2Port: client.db2Port,
      db2Database: client.db2Database,
      db2Schema: client.db2Schema,
    });

    return { client, server, db2Creds };
  }

  /**
   * Test DB2 connectivity for a client.
   * Uses the connection pool — a successful acquire = connected.
   */
  async testConnection(clientDbId: string): Promise<DB2ConnectionStatus> {
    const clientRow = await prisma.client.findUnique({
      where: { id: clientDbId },
      include: { appServers: { where: { environment: 'Prod', isActive: true } } },
    });

    if (!clientRow) throw new Error(`Client not found: ${clientDbId}`);

    const server = clientRow.appServers[0];
    const result: DB2ConnectionStatus = {
      clientId: clientRow.clientId,
      connected: false,
      host: clientRow.db2Host || (server?.dns ?? ''),
      database: clientRow.db2Database || '',
      schema: clientRow.db2Schema || '',
    };

    if (!clientRow.db2Database) {
      result.error = 'DB2 database not configured for this client';
      return result;
    }
    if (!server) {
      result.error = 'No active Prod server for this client';
      return result;
    }

    let db2Creds: DB2Credentials;
    try {
      db2Creds = await keeperService.getDB2Credentials(clientRow.clientId, {
        db2Host: clientRow.db2Host,
        db2Port: clientRow.db2Port,
        db2Database: clientRow.db2Database,
        db2Schema: clientRow.db2Schema,
      });
    } catch (err: any) {
      result.error = `Credentials error: ${err.message}`;
      return result;
    }

    const startMs = Date.now();
    try {
      const pooled = await db2Pool.acquire(clientRow.clientId, {
        hostname: server.dns,
        database: db2Creds.database,
        schema: db2Creds.schema,
        db2Username: db2Creds.username,
        db2Password: db2Creds.password,
      });

      result.connected = true;
      result.latencyMs = Date.now() - startMs;

      // Release back to pool for reuse
      db2Pool.release(clientRow.clientId);
    } catch (err: any) {
      result.error = `SSH/DB2 error: ${err.message}`;
      await db2Pool.destroy(clientRow.clientId);
    }

    return result;
  }

  /**
   * Run a DB2 SQL query on a client's database.
   * Acquires a pooled connection, executes, and releases.
   */
  async executeQuery(clientDbId: string, sql: string): Promise<DB2QueryResult> {
    const startMs = Date.now();
    const { client, server, db2Creds } = await this.resolveClient(clientDbId);

    const pooled = await db2Pool.acquire(client.clientId, {
      hostname: server.dns,
      database: db2Creds.database,
      schema: db2Creds.schema,
      db2Username: db2Creds.username,
      db2Password: db2Creds.password,
    });

    try {
      const queryCmd = `db2 -x -r /tmp/wfm_query_result.txt "${sql}" && cat /tmp/wfm_query_result.txt`;
      const output = await sshExec(pooled.ssh, queryCmd, 120);
      const rows = this.parseDB2Output(output);

      return {
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        rows,
        rowCount: rows.length,
        executionTimeMs: Date.now() - startMs,
        query: sql,
      };
    } catch (err) {
      // Connection may be stale — destroy it so next request gets a fresh one
      await db2Pool.destroy(client.clientId);
      throw err;
    } finally {
      db2Pool.release(client.clientId);
    }
  }

  /**
   * Get WFM job status from the DB2 BATCH_JOB or equivalent status tables.
   * Uses pooled connection.
   */
  async getJobStatuses(clientDbId: string): Promise<DB2JobStatus[]> {
    const { client, server, db2Creds } = await this.resolveClient(clientDbId);

    const pooled = await db2Pool.acquire(client.clientId, {
      hostname: server.dns,
      database: db2Creds.database,
      schema: db2Creds.schema,
      db2Username: db2Creds.username,
      db2Password: db2Creds.password,
    });

    try {
      // Discover available WFM tables
      const tables = await this.discoverWFMTables(pooled.ssh, db2Creds.schema);
      logger.info(`[DBMonitor] ${client.clientId}: Found ${tables.length} WFM tables`);

      const results: DB2JobStatus[] = [];

      for (const table of tables) {
        try {
          const sql = this.buildJobStatusQuery(table, db2Creds.schema);
          if (!sql) continue;

          const output = await sshExec(pooled.ssh, `db2 -t "${sql}"`, 60);
          const rows = this.parseDB2TabularOutput(output);

          for (const row of rows) {
            results.push({
              jobName: row.JOB_NAME || row.JOBNAME || row.NAME || 'unknown',
              status: row.STATUS || row.JOB_STATUS || row.STATE || 'UNKNOWN',
              lastRunTime: row.LAST_RUN_TIME || row.START_TIME || row.STARTED_AT || null,
              nextRunTime: row.NEXT_RUN_TIME || row.SCHEDULED_AT || null,
              exitCode: row.EXIT_CODE != null ? parseInt(row.EXIT_CODE, 10) : null,
              duration: row.DURATION != null ? parseInt(row.DURATION, 10) : null,
              message: row.MESSAGE || row.ERROR_MSG || null,
              rowCount: null,
              tableName: table,
            });
          }
        } catch (err: any) {
          logger.warn(`[DBMonitor] Error querying ${table}: ${err.message}`);
        }
      }

      return results;
    } catch (err) {
      await db2Pool.destroy(client.clientId);
      throw err;
    } finally {
      db2Pool.release(client.clientId);
    }
  }

  /**
   * Get table list and metadata for a client's DB2 database.
   * Uses pooled connection.
   */
  async getTableInfo(clientDbId: string): Promise<DB2TableInfo[]> {
    const { client, server, db2Creds } = await this.resolveClient(clientDbId);

    const pooled = await db2Pool.acquire(client.clientId, {
      hostname: server.dns,
      database: db2Creds.database,
      schema: db2Creds.schema,
      db2Username: db2Creds.username,
      db2Password: db2Creds.password,
    });

    try {
      const schema = db2Creds.schema || 'WFMADM';
      const sql = `SELECT TABNAME, CARD AS ROW_COUNT, STATS_TIME FROM SYSCAT.TABLES WHERE TABSCHEMA = '${schema}' AND TYPE = 'T' ORDER BY TABNAME`;
      const output = await sshExec(pooled.ssh, `db2 -t "${sql}"`, 60);
      const rows = this.parseDB2TabularOutput(output);

      return rows.map(row => ({
        tableName: (row.TABNAME || '').trim(),
        rowCount: parseInt(row.ROW_COUNT || '0', 10),
        lastUpdated: row.STATS_TIME || null,
        sizeKb: null,
      }));
    } catch (err) {
      await db2Pool.destroy(client.clientId);
      throw err;
    } finally {
      db2Pool.release(client.clientId);
    }
  }

  /**
   * Get overview of all clients with their DB2 configuration status.
   */
  async getClientsDBStatus(): Promise<Array<{
    id: string;
    clientId: string;
    name: string;
    cluster: string;
    db2Configured: boolean;
    db2Host: string | null;
    db2Database: string | null;
    db2Schema: string | null;
    hasCredentials: boolean;
    serverCount: number;
  }>> {
    const clients = await prisma.client.findMany({
      where: { isActive: true },
      include: {
        appServers: { where: { environment: 'Prod', isActive: true }, select: { id: true } },
      },
      orderBy: { clientId: 'asc' },
    });

    return clients.map(c => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      cluster: c.cluster,
      db2Configured: !!(c.db2Host && c.db2Database),
      db2Host: c.db2Host,
      db2Database: c.db2Database,
      db2Schema: c.db2Schema,
      hasCredentials: keeperService.isConfigured() || !!(config.keeper.db2Username && config.keeper.db2Password),
      serverCount: c.appServers.length,
    }));
  }

  // ============================================================
  // Private helpers
  // ============================================================

  /**
   * Discover WFM-related tables in the schema
   */
  private async discoverWFMTables(conn: SSH2Client, schema: string | null): Promise<string[]> {
    const s = schema || 'WFMADM';
    const sql = `SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = '${s}' AND TYPE = 'T' AND (TABNAME LIKE '%JOB%' OR TABNAME LIKE '%BATCH%' OR TABNAME LIKE '%SCHEDULE%' OR TABNAME LIKE '%TASK%' OR TABNAME LIKE '%EXEC%') ORDER BY TABNAME`;

    try {
      const output = await sshExec(conn, `db2 -x "${sql}"`, 30);
      return output.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('-'));
    } catch {
      return [];
    }
  }

  /**
   * Build a status query for known WFM table patterns
   */
  private buildJobStatusQuery(tableName: string, schema: string | null): string | null {
    const s = schema ? `${schema}.` : '';
    const upper = tableName.toUpperCase();

    if (upper.includes('BATCH_JOB') && !upper.includes('EXEC')) {
      return `SELECT JOB_NAME, STATUS, LAST_RUN_TIME, NEXT_RUN_TIME, EXIT_CODE FROM ${s}${tableName} FETCH FIRST 100 ROWS ONLY`;
    }
    if (upper.includes('JOB_EXECUTION') || upper.includes('BATCH_JOB_EXEC')) {
      return `SELECT JOB_NAME, STATUS, START_TIME, EXIT_CODE, DURATION FROM ${s}${tableName} ORDER BY START_TIME DESC FETCH FIRST 50 ROWS ONLY`;
    }
    if (upper.includes('JOB_SCHEDULE') || upper.includes('SCHEDULE')) {
      return `SELECT JOB_NAME, STATUS, SCHEDULED_AT, NEXT_RUN_TIME FROM ${s}${tableName} FETCH FIRST 100 ROWS ONLY`;
    }
    return null;
  }

  /**
   * Parse DB2 CLI tabular output into row objects.
   * DB2 outputs column-aligned data with header row + dash separator.
   */
  private parseDB2TabularOutput(output: string): Record<string, string>[] {
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 3) return []; // Need at least header + separator + 1 data row

    // Find header line (first non-empty line that isn't an SQL message)
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^[A-Z_\s]+$/) && !lines[i].includes('SQL')) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) return [];

    const headers = lines[headerIdx].trim().split(/\s{2,}/).map(h => h.trim());
    
    // Skip separator line (dashes)
    const dataStart = headerIdx + 2;
    const rows: Record<string, string>[] = [];

    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('-') || line.includes('record(s) selected') || line.includes('SQL')) continue;
      
      const values = line.trim().split(/\s{2,}/);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
      if (Object.values(row).some(v => v.length > 0)) {
        rows.push(row);
      }
    }

    return rows;
  }

  /**
   * Parse DB2 -x (no header) output into simple arrays
   */
  private parseDB2Output(output: string): Record<string, any>[] {
    const lines = output.split('\n').filter(l => l.trim().length > 0 && !l.includes('record(s) selected'));
    return lines.map((line, idx) => {
      const values = line.trim().split(/\s{2,}/);
      const row: Record<string, any> = {};
      values.forEach((v, i) => { row[`col${i}`] = v.trim(); });
      return row;
    });
  }
}

export const dbMonitorService = new DBMonitorService();
