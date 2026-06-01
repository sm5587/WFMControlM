// ============================================================
// DB2 Connection Pool
// Manages SSH + DB2 connections across 75 clients with:
//   - Configurable max concurrent connections (default 10)
//   - Per-client connection caching & reuse
//   - Idle eviction after timeout
//   - Queued acquisition when pool is full
// ============================================================

import { Client as SSH2Client } from 'ssh2';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import { generateSync } from 'otplib';

const logger = createServiceLogger('DB2Pool');

// ============================================================
// Types
// ============================================================

export interface DB2PooledConnection {
  clientId: string;
  ssh: SSH2Client;
  db2Connected: boolean;
  createdAt: number;
  lastUsedAt: number;
  inUse: boolean;
}

interface QueuedRequest {
  clientId: string;
  params: DB2ConnectParams;
  resolve: (conn: DB2PooledConnection) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface DB2ConnectParams {
  hostname: string;
  database: string;
  schema: string | null;
  db2Username: string;
  db2Password: string;
}

interface SSHCredentials {
  username: string;
  password: string;
  totpSecret: string;
}

// ============================================================
// SSH Helper (shared)
// ============================================================

function sshConnect(hostname: string, creds: SSHCredentials): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    const timeoutMs = config.ssh.timeout || 15000;

    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH connection to ${hostname} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn.on('ready', () => {
      clearTimeout(timer);
      resolve(conn);
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH error connecting to ${hostname}: ${err.message}`));
    });

    conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
      const responses: string[] = [];
      for (const prompt of prompts) {
        const p = prompt.prompt.toLowerCase();
        if (p.includes('first') || p.includes('password')) {
          responses.push(creds.password);
        } else if (p.includes('second') || p.includes('token') || p.includes('factor')) {
          if (creds.totpSecret) {
            const token = generateSync({ secret: creds.totpSecret });
            responses.push(token);
          } else {
            responses.push('');
          }
        } else {
          responses.push(creds.password);
        }
      }
      finish(responses);
    });

    const connectOpts: any = {
      host: hostname,
      port: config.ssh.port,
      username: creds.username,
      tryKeyboard: true,
      readyTimeout: timeoutMs,
    };
    if (!creds.totpSecret) {
      connectOpts.password = creds.password;
      connectOpts.authHandler = ['password', 'keyboard-interactive'];
    }
    conn.connect(connectOpts);
  });
}

export function sshExec(conn: SSH2Client, command: string, timeoutSec = 60): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Command timed out after ${timeoutSec}s`));
      }, timeoutSec * 1000);

      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(stdout);
      });
    });
  });
}

// ============================================================
// Connection Pool
// ============================================================

class DB2ConnectionPool {
  // Active connections keyed by clientId
  private connections = new Map<string, DB2PooledConnection>();
  // Queue of requests waiting for a connection slot
  private waitQueue: QueuedRequest[] = [];
  // Idle eviction timer
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  get maxConnections(): number {
    return config.db2Pool.maxConnections;
  }

  get idleTimeoutMs(): number {
    return config.db2Pool.idleTimeoutMs;
  }

  get acquireTimeoutMs(): number {
    return config.db2Pool.acquireTimeoutMs;
  }

  get activeCount(): number {
    return this.connections.size;
  }

  get inUseCount(): number {
    let count = 0;
    this.connections.forEach(c => { if (c.inUse) count++; });
    return count;
  }

  get queueLength(): number {
    return this.waitQueue.length;
  }

  constructor() {
    // Start idle eviction sweep every 30s
    this.evictionTimer = setInterval(() => this.evictIdle(), 30_000);
  }

  /**
   * Acquire a pooled DB2 connection for a client.
   * If a cached idle connection exists, reuse it.
   * If pool is under max, create a new one.
   * Otherwise, queue the request until a slot opens.
   */
  async acquire(clientId: string, params: DB2ConnectParams): Promise<DB2PooledConnection> {
    // 1. Try to reuse existing idle connection for this client
    const existing = this.connections.get(clientId);
    if (existing && !existing.inUse) {
      existing.inUse = true;
      existing.lastUsedAt = Date.now();
      logger.debug(`Reusing pooled connection for ${clientId} (${this.activeCount}/${this.maxConnections})`);
      return existing;
    }

    // 2. If under limit, create new
    if (this.activeCount < this.maxConnections) {
      return this.createConnection(clientId, params);
    }

    // 3. Evict the oldest idle connection to make room
    const evicted = this.evictOldestIdle();
    if (evicted) {
      return this.createConnection(clientId, params);
    }

    // 4. Pool is full & all in use — wait in queue
    logger.info(`Pool full (${this.activeCount}/${this.maxConnections}), queuing ${clientId} (queue: ${this.waitQueue.length + 1})`);
    return this.enqueue(clientId, params);
  }

  /**
   * Release a connection back to the pool for reuse.
   * Call this after your DB2 queries are done.
   */
  release(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (conn) {
      conn.inUse = false;
      conn.lastUsedAt = Date.now();
      logger.debug(`Released connection for ${clientId} back to pool`);
    }

    // Serve next queued request if any
    this.drainQueue();
  }

  /**
   * Destroy a specific client connection (e.g. on error).
   */
  async destroy(clientId: string): Promise<void> {
    const conn = this.connections.get(clientId);
    if (conn) {
      this.connections.delete(clientId);
      try {
        await sshExec(conn.ssh, 'db2 connect reset', 5).catch(() => {});
        conn.ssh.end();
      } catch { /* ignore */ }
      logger.debug(`Destroyed connection for ${clientId} (${this.activeCount}/${this.maxConnections})`);
    }

    // Serve queued requests
    this.drainQueue();
  }

  /**
   * Shut down the entire pool (for graceful server shutdown).
   */
  async shutdown(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }

    // Reject all queued requests
    for (const req of this.waitQueue) {
      clearTimeout(req.timeoutHandle);
      req.reject(new Error('Connection pool is shutting down'));
    }
    this.waitQueue = [];

    // Close all connections
    const closePromises: Promise<void>[] = [];
    this.connections.forEach((conn, clientId) => {
      closePromises.push(
        (async () => {
          try {
            await sshExec(conn.ssh, 'db2 connect reset', 5).catch(() => {});
            conn.ssh.end();
          } catch { /* ignore */ }
        })()
      );
    });
    await Promise.all(closePromises);
    this.connections.clear();
    logger.info('DB2 connection pool shut down');
  }

  /**
   * Get pool statistics for monitoring.
   */
  getStats(): {
    maxConnections: number;
    activeConnections: number;
    inUseConnections: number;
    idleConnections: number;
    queuedRequests: number;
    clients: string[];
  } {
    return {
      maxConnections: this.maxConnections,
      activeConnections: this.activeCount,
      inUseConnections: this.inUseCount,
      idleConnections: this.activeCount - this.inUseCount,
      queuedRequests: this.waitQueue.length,
      clients: Array.from(this.connections.keys()),
    };
  }

  // ============================================================
  // Private
  // ============================================================

  private async createConnection(clientId: string, params: DB2ConnectParams): Promise<DB2PooledConnection> {
    const sshCreds: SSHCredentials = {
      username: config.ssh.username,
      password: config.ssh.password,
      totpSecret: config.ssh.totpSecret,
    };

    logger.info(`Opening new DB2 connection for ${clientId} via ${params.hostname} (${this.activeCount + 1}/${this.maxConnections})`);

    const ssh = await sshConnect(params.hostname, sshCreds);

    // DB2 connect
    const connectCmd = `db2 connect to ${params.database} user ${params.db2Username} using '${params.db2Password.replace(/'/g, "'\\''")}'`;
    const connectOut = await sshExec(ssh, connectCmd, 30);

    if (connectOut.toLowerCase().includes('sql') && connectOut.toLowerCase().includes('error')) {
      ssh.end();
      throw new Error(`DB2 connect failed for ${clientId}: ${connectOut.trim().split('\n')[0]}`);
    }

    // Set schema if provided
    if (params.schema) {
      await sshExec(ssh, `db2 "SET SCHEMA ${params.schema}"`, 10);
    }

    const pooled: DB2PooledConnection = {
      clientId,
      ssh,
      db2Connected: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inUse: true,
    };

    // Handle SSH disconnect
    ssh.on('end', () => {
      logger.warn(`SSH connection ended unexpectedly for ${clientId}`);
      this.connections.delete(clientId);
      this.drainQueue();
    });
    ssh.on('error', (err) => {
      logger.warn(`SSH error for ${clientId}: ${err.message}`);
      this.connections.delete(clientId);
      this.drainQueue();
    });

    this.connections.set(clientId, pooled);
    return pooled;
  }

  private enqueue(clientId: string, params: DB2ConnectParams): Promise<DB2PooledConnection> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.waitQueue = this.waitQueue.filter(r => r.resolve !== resolve);
        reject(new Error(`Timed out waiting for DB2 connection slot for ${clientId} (waited ${this.acquireTimeoutMs}ms, pool: ${this.activeCount}/${this.maxConnections})`));
      }, this.acquireTimeoutMs);

      this.waitQueue.push({ clientId, params, resolve, reject, timeoutHandle });
    });
  }

  /**
   * Try to serve queued requests when a connection slot opens.
   */
  private async drainQueue(): Promise<void> {
    while (this.waitQueue.length > 0 && this.activeCount < this.maxConnections) {
      const next = this.waitQueue.shift();
      if (!next) break;
      clearTimeout(next.timeoutHandle);

      try {
        const conn = await this.createConnection(next.clientId, next.params);
        next.resolve(conn);
      } catch (err: any) {
        next.reject(err);
      }
    }
  }

  /**
   * Evict idle connections that have exceeded the idle timeout.
   */
  private evictIdle(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    this.connections.forEach((conn, clientId) => {
      if (!conn.inUse && (now - conn.lastUsedAt) > this.idleTimeoutMs) {
        toEvict.push(clientId);
      }
    });

    for (const clientId of toEvict) {
      const conn = this.connections.get(clientId);
      if (conn) {
        this.connections.delete(clientId);
        sshExec(conn.ssh, 'db2 connect reset', 5).catch(() => {});
        conn.ssh.end();
        logger.info(`Evicted idle connection for ${clientId} (idle ${Math.round((now - conn.lastUsedAt) / 1000)}s)`);
      }
    }

    if (toEvict.length > 0) {
      logger.info(`Evicted ${toEvict.length} idle connections (${this.activeCount}/${this.maxConnections} active)`);
    }
  }

  /**
   * Evict the single oldest idle connection to make room.
   */
  private evictOldestIdle(): boolean {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    this.connections.forEach((conn, clientId) => {
      if (!conn.inUse && conn.lastUsedAt < oldestTime) {
        oldestTime = conn.lastUsedAt;
        oldestKey = clientId;
      }
    });

    if (oldestKey) {
      const conn = this.connections.get(oldestKey)!;
      this.connections.delete(oldestKey);
      sshExec(conn.ssh, 'db2 connect reset', 5).catch(() => {});
      conn.ssh.end();
      logger.info(`Evicted oldest idle connection (${oldestKey}) to make room`);
      return true;
    }

    return false;
  }
}

// Singleton
export const db2Pool = new DB2ConnectionPool();
