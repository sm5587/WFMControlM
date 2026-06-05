// ============================================================
// Job Sync Service - Discovers WFM crons from appservers via SSH
// Uses keyboard-interactive auth with TOTP for 2FA
// Reads cron entries from /mount/backup/cronEntry
// Filters /mount/RWS4 paths as WFM jobs
// Monitors log paths as checkpoint (no failures + triggered)
// ============================================================

import { EventEmitter } from 'events';
import { Client as SSH2Client } from 'ssh2';
import { generateSync } from 'otplib';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import cronParser from 'cron-parser';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { prisma } from '../database/prisma';
import { config } from '../config';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

dayjs.extend(utc);
dayjs.extend(timezone);

const logger = createServiceLogger('SyncService');

// ------------------------------------------------------------------ Types

interface CronEntry {
  schedule: string;      // Cron expression (5 fields)
  command: string;       // Full command string
  logPath: string | null; // Extracted log redirect path
  rawLine: string;       // Original unmodified crontab line
  user?: string;
}

interface LogCheckResult {
  jobName: string;
  logPath: string;
  status: 'SUCCESS' | 'FAILED' | 'NOT_RUN' | 'STALE' | 'UNKNOWN';
  exists: boolean;
  hasFailure: boolean;
  hasSuccess: boolean;
  triggered: boolean;
  isRunning: boolean;
  lastModified: Date | null;
  expectedLastRun: Date | null;
  logFresh: boolean;         // true if log was modified around expected last run time
  failureLines: string[];
  successLines: string[];
  cronExitCode: number | null; // Exit code from syslog/cron.log (if available)
  sizeBytes: number;
  summary: string;           // Human-readable summary
}

interface SyncResult {
  clientId: string;
  syncType: string;
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  jobsDiscovered: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsRemoved: number;
  errors: string[];
  duration: number;
}

// ------------------------------------------------------------------ Credentials

interface SSHCredentials {
  username: string;
  password: string;
  totpSecret: string;
}

/**
 * Decrypt a password from the credentials file.
 * Supports two formats:
 *   dpapi  — Windows DPAPI (ConvertFrom-SecureString), only decryptable by same user/machine
 *   base64 — legacy plain base64 encoding (default if no password_format field)
 */
function decryptPassword(raw: Record<string, any>): string {
  if (!raw.password) return '';
  if (raw.password_format === 'dpapi') {
    try {
      const escaped = (raw.password as string).replace(/"/g, '`"');
      const cmd = `powershell -NoProfile -NonInteractive -Command "$ss = ConvertTo-SecureString '${escaped}'; [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))"`;
      return execSync(cmd, { timeout: 8000 }).toString().trim();
    } catch (err: any) {
      throw new Error(`Failed to DPAPI-decrypt password: ${err.message}`);
    }
  }
  // Default: base64
  return Buffer.from(raw.password, 'base64').toString();
}

/**
 * Walk up from `startDir` until `.saved_credentials.json` is found or root is reached.
 */
function findCredentialsFile(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, '.saved_credentials.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Load SSH credentials. Priority:
 * 1. Environment variables (SSH_USERNAME, SSH_PASSWORD, SSH_TOTP_SECRET)
 * 2. .saved_credentials.json file — searched upward from __dirname and cwd
 */
function loadCredentials(): SSHCredentials {
  // Try env vars first
  if (config.ssh.username && config.ssh.password) {
    logger.info('[Creds] Using SSH credentials from environment variables');
    return {
      username: config.ssh.username,
      password: config.ssh.password,
      totpSecret: config.ssh.totpSecret || '',
    };
  }

  // Build candidate list: explicit config + upward search from __dirname + upward search from cwd
  const explicit = config.ssh.credentialsFile ? [config.ssh.credentialsFile] : [];
  const fromDir  = findCredentialsFile(__dirname);
  const fromCwd  = findCredentialsFile(process.cwd());

  const candidates = [...explicit, ...(fromDir ? [fromDir] : []), ...(fromCwd ? [fromCwd] : [])];

  logger.info(`[Creds] __dirname=${__dirname}  cwd=${process.cwd()}`);
  logger.info(`[Creds] Credential candidates: ${candidates.join(' | ') || '(none)'}`);

  for (const credPath of candidates) {
    try {
      let text = fs.readFileSync(credPath, 'utf-8');
      // Strip UTF-8 BOM if present (editors on Windows may add it)
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const raw = JSON.parse(text);
      const mode = (raw.credential_mode || 'service').toLowerCase();

      let creds: SSHCredentials;
      if (mode === 'personal' && raw.personal_username) {
        creds = {
          username: raw.personal_username,
          password: raw.personal_password ? Buffer.from(raw.personal_password, 'base64').toString() : '',
          totpSecret: raw.personal_totp_secret ? Buffer.from(raw.personal_totp_secret, 'base64').toString() : '',
        };
      } else {
        creds = {
          username: raw.username || '',
          password: decryptPassword(raw),
          totpSecret: raw.totp_secret ? Buffer.from(raw.totp_secret, 'base64').toString() : '',
        };
      }
      logger.info(`[Creds] ✓ Loaded from ${credPath} (mode: ${mode}, user: ${creds.username})`);
      return creds;
    } catch (err: any) {
      logger.warn(`[Creds] Failed to load from ${credPath}: ${err.message}`);
    }
  }

  throw new Error('No SSH credentials configured. Set SSH_USERNAME/SSH_PASSWORD/SSH_TOTP_SECRET env vars or provide .saved_credentials.json');
}

// ------------------------------------------------------------------ SSH Helper

/**
 * Connect to a remote server via SSH using keyboard-interactive auth with TOTP.
 * Matches the auth flow from AppServerTools:
 *   Prompt 1 ("First factor" / "Password") -> password
 *   Prompt 2 ("Second factor" / "Token")   -> TOTP code
 */
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
    // Service accounts (no TOTP) use password auth; personal accounts use keyboard-interactive for TOTP
    if (!creds.totpSecret) {
      connectOpts.password = creds.password;
      connectOpts.authHandler = ['password', 'keyboard-interactive'];
    }
    conn.connect(connectOpts);
  });
}

/**
 * Execute a command on a remote SSH session and return stdout.
 */
function sshExec(conn: SSH2Client, command: string, timeoutSec = configService.getInt('infra.sshTimeout') / 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Command timed out after ${timeoutSec}s: ${command}`));
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

// ------------------------------------------------------------------ Cron Parsing

const CRON_ENTRY_PATH = config.ssh.cronEntryPath;
const WFM_PATH_PREFIX = config.ssh.wfmPathPrefix;

// Failure patterns to look for in log files
const FAILURE_PATTERNS = [
  /\bERROR\b/i,
  /\bFAILED\b/i,
  /\bFAILURE\b/i,
  /\bEXCEPTION\b/i,
  /\bABORT(?:ED)?\b/i,
  /\bSEGFAULT\b/i,
  /\bSIGKILL\b/i,
  /\bSIGSEGV\b/i,
  /\bcore\s+dump/i,
  /\bpermission\s+denied\b/i,
  /\bno\s+such\s+file\b/i,
  /\bFATAL\b/i,
  /\bCRITICAL\b/i,
  /exit\s*code\s*[1-9]/i,
  /\brc=[1-9]/i,
];

// Success patterns — positive confirmation that a job completed OK
const SUCCESS_PATTERNS = [
  /\bcompleted\s+successfully\b/i,
  /\bSUCCESS\b/i,
  /\bjob\s+(?:completed|finished|done)\b/i,
  /\bexit\s*code\s*0\b/i,
  /\brc=0\b/i,
  /\bfinished\s+(?:with|in)\s+\d/i,
  /\bend\s+of\s+(?:processing|job|run)\b/i,
  /\b0\s+errors?\b/i,
];

/**
 * Compute the most recent past run time for a cron expression in a given TZ.
 * Returns null if the expression can't be parsed.
 */
function computeLastRunTime(cronExpr: string, serverTz: string): Date | null {
  try {
    const interval = cronParser.parseExpression(cronExpr, {
      tz: serverTz,
      currentDate: new Date(),
    });
    return interval.prev().toDate();
  } catch (err: any) {
    logger.warn(`Failed to compute last run for cron "${cronExpr}": ${err.message}`);
    return null;
  }
}

/**
 * Parse the cron entries file content.
 * Each line: MIN HOUR DOM MON DOW COMMAND
 * Filters for lines containing /mount/RWS4
 * Extracts log path from output redirection (>> or > or 2>&1)
 */
function parseCronEntries(raw: string): CronEntry[] {
  const entries: CronEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines, comments (#), and disabled crons (leading #)
    if (!trimmed || /^#/.test(trimmed)) continue;

    // Standard cron: 5 fields + command
    const match = trimmed.match(/^([\d\*][\d,\-\*\/]*\s+[\d\*][\d,\-\*\/]*\s+[\d\*,\-\/]+\s+[\d\*,\-\/]+\s+[\d\*,\-\/]+)\s+(.+)$/);
    if (!match) {
      // Also try matching cron lines starting with * or @reboot etc.
      const altMatch = trimmed.match(/^([\*@]\S*\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (!altMatch) continue;
      const schedule = altMatch[1];
      const command = altMatch[2];
      if (!command.includes(WFM_PATH_PREFIX)) continue;
      if (/\bfind\b/.test(command)) continue;
      const logPath = extractLogPath(command);
      entries.push({ schedule, command, logPath, rawLine: trimmed });
      continue;
    }
    if (!match) continue;

    const schedule = match[1];
    const command = match[2];

    // Only keep WFM jobs (path contains /mount/RWS4)
    if (!command.includes(WFM_PATH_PREFIX)) continue;
    // Skip cron entries that use the find command
    if (/\bfind\b/.test(command)) continue;

    // Extract log path from output redirection
    const logPath = extractLogPath(command);

    entries.push({ schedule, command, logPath, rawLine: trimmed });
  }
  return entries;
}

/**
 * Extract the log/output file path from a cron command.
 * Handles patterns like:
 *   >> /mount/RWS4/logs/job.log 2>&1
 *   > /path/to/output.log
 *   2>&1 | tee /path/to/log.txt
 */
function extractLogPath(command: string): string | null {
  // Match >> path or > path (stdout redirect)
  const redirectMatch = command.match(/>>?\s+(\S+\.(?:log|txt|out))/);
  if (redirectMatch) return redirectMatch[1];

  // Match tee output
  const teeMatch = command.match(/tee\s+(?:-a\s+)?(\S+)/);
  if (teeMatch) return teeMatch[1];

  // Match any path after >> or >
  const genericRedirect = command.match(/>>?\s+(\/\S+)/);
  if (genericRedirect) return genericRedirect[1];

  return null;
}

/**
 * Extract a human-readable job name from a cron command.
 * Prefers the script name from the /mount/RWS4 path.
 */
function extractJobName(command: string): string {
  // Look for script file in /mount/RWS4 path
  const rws4Match = command.match(/\/mount\/RWS4\/[^^\s>|]*\/([^/\s>|]+)/);
  if (rws4Match) {
    return rws4Match[1]
      .replace(/\.\w+$/, '')   // strip extension
      .replace(/[_-]/g, ' ')   // humanize
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Fallback: last path segment
  const scriptMatch = command.match(/\/([^/\s>|]+?)(?:\.\w+)?(?:\s|$|>)/);
  if (scriptMatch) return scriptMatch[1].replace(/[_-]/g, ' ');
  return command.substring(0, 50);
}

// Extract meaningful parameters after the script name to differentiate jobs.
// Returns a compact string of key arguments (flag values, positional args).
function extractFirstParam(command: string): string | null {
  // Find the script path (the /mount/RWS4/.../script.sh portion)
  const rws4Match = command.match(/\/mount\/RWS4\/[^^\s>|]*\/[^/\s>|]+/);
  const scriptPattern = rws4Match
    ? rws4Match[0]
    : command.match(/\/([^/\s>|]+?)(?:\.\w+)?(?:\s|$|>)/)?.[0];
  if (!scriptPattern) return null;

  const idx = command.indexOf(scriptPattern);
  if (idx === -1) return null;
  const after = command.slice(idx + scriptPattern.length).trim();
  if (!after) return null;

  // Remove output redirections and everything after (>>, >, 2>&1)
  const argsStr = after.replace(/\s*[12]?>>?\s*.*$/, '').replace(/\s*2>&1.*$/, '').trim();
  if (!argsStr) return null;

  // Parse meaningful args: collect flag values (e.g. -t payroll -> payroll)
  // and positional args, skipping bare flags without values
  const tokens = argsStr.split(/\s+/);
  const meaningful: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      // Flag — grab its value if next token exists and isn't another flag or redirect
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-') && !tokens[i + 1].startsWith('>')) {
        meaningful.push(tokens[i + 1]);
        i++; // skip the value token
      }
    } else if (!t.startsWith('>')) {
      // Positional arg
      meaningful.push(t);
    }
  }
  return meaningful.length > 0 ? meaningful.join(' ') : null;
}

/** Infer job type from command string */
function inferJobType(command: string): string {
  if (/python|\.py/i.test(command)) return 'SCRIPT';
  if (/node|\.js/i.test(command)) return 'SCRIPT';
  if (/\.sh\b/i.test(command)) return 'COMMAND';
  if (/curl|wget|http/i.test(command)) return 'HTTP';
  if (/sql|db2|jdbc/i.test(command)) return 'SQL';
  if (/sftp|scp|ftp/i.test(command)) return 'FILE_TRANSFER';
  if (/forecast/i.test(command)) return 'FORECAST';
  if (/schedule/i.test(command)) return 'SCHEDULE_GEN';
  if (/etl|pipeline|import|export/i.test(command)) return 'DATA_PIPELINE';
  return 'COMMAND';
}

// ------------------------------------------------------------------ Timezone Helpers

/**
 * Detect the server's timezone via SSH.
 * Tries timedatectl, /etc/timezone, then date +%Z as fallback.
 */
async function detectServerTimezone(conn: SSH2Client): Promise<string> {
  try {
    // Method 1: timedatectl (most reliable on systemd systems)
    const tdOut = await sshExec(conn, 'timedatectl show --property=Timezone --value 2>/dev/null || true', 10);
    const tz1 = tdOut.trim();
    if (tz1 && tz1.includes('/')) return tz1;

    // Method 2: /etc/timezone (Debian/Ubuntu)
    const tzFile = await sshExec(conn, 'cat /etc/timezone 2>/dev/null || true', 10);
    const tz2 = tzFile.trim();
    if (tz2 && tz2.includes('/')) return tz2;

    // Method 3: readlink /etc/localtime
    const link = await sshExec(conn, 'readlink -f /etc/localtime 2>/dev/null || true', 10);
    const linkMatch = link.trim().match(/zoneinfo\/(.+)$/);
    if (linkMatch) return linkMatch[1];

    // Method 4: date +%Z (abbreviation only — less precise)
    const abbr = await sshExec(conn, 'date +%Z 2>/dev/null || true', 10);
    const abbrMap: Record<string, string> = {
      EST: 'America/New_York', EDT: 'America/New_York',
      CST: 'America/Chicago', CDT: 'America/Chicago',
      MST: 'America/Denver', MDT: 'America/Denver',
      PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
      UTC: 'UTC', GMT: 'UTC',
    };
    const mapped = abbrMap[abbr.trim()];
    if (mapped) return mapped;
  } catch (err: any) {
    logger.warn(`Failed to detect server timezone: ${err.message}`);
  }
  return 'UTC';
}

/**
 * Compute the next run time for a cron expression in a given server timezone.
 * Returns { utc: Date, localDisplay: string } where localDisplay is in clientTimezone.
 */
function computeNextRun(cronExpr: string, serverTz: string, clientTz: string): { utc: Date; localDisplay: string } | null {
  try {
    // cron-parser interprets the expression in the given timezone
    const interval = cronParser.parseExpression(cronExpr, {
      tz: serverTz,
      currentDate: new Date(),
    });
    const nextServerTime = interval.next().toDate(); // This is already a UTC Date

    // Format for local display in client timezone
    const localDt = dayjs(nextServerTime).tz(clientTz);
    // Get timezone abbreviation from the Intl formatter
    const tzAbbr = new Intl.DateTimeFormat('en-US', { timeZone: clientTz, timeZoneName: 'short' })
      .formatToParts(nextServerTime)
      .find(p => p.type === 'timeZoneName')?.value || clientTz;
    const localDisplay = localDt.format('YYYY-MM-DD HH:mm') + ` ${tzAbbr}`;

    return { utc: nextServerTime, localDisplay };
  } catch (err: any) {
    logger.warn(`Failed to parse cron "${cronExpr}" with tz ${serverTz}: ${err.message}`);
    return null;
  }
}

// ------------------------------------------------------------------ SyncService

class SyncService extends EventEmitter {
  private isSyncing = false;
  private credentials: SSHCredentials | null = null;

  private getCredentials(): SSHCredentials {
    if (!this.credentials) {
      this.credentials = loadCredentials();
    }
    return this.credentials;
  }

  /**
   * Sync cron jobs from a client's Prod appserver.
   * 1. SSH to server using keyboard-interactive + TOTP
   * 2. Read /mount/backup/cronEntry
   * 3. Filter for /mount/RWS4 WFM jobs
   * 4. Upsert into database with log paths
   */
  async syncClientCrons(clientDbId: string, force = false): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let discovered = 0, created = 0, updated = 0;

    const client = await prisma.client.findUnique({
      where: { id: clientDbId },
      include: { appServers: { where: { environment: 'Prod', isActive: true } } },
    });

    if (!client) throw new Error(`Client not found: ${clientDbId}`);

    // 24h cooldown guard — skip unless forced
    if (!force && client.lastCronSyncAt) {
      const hoursSinceSync = (Date.now() - client.lastCronSyncAt.getTime()) / (1000 * 60 * 60);
      const cooldownHrs = configService.getInt('polling.cronSyncCooldownHrs');
      if (hoursSinceSync < cooldownHrs) {
        logger.info(`[CronSync] Skipping ${client.clientId} — synced ${hoursSinceSync.toFixed(1)}h ago (< ${cooldownHrs}h cooldown)`);
        return {
          clientId: client.clientId,
          syncType: 'CRON_SYNC',
          status: 'SUCCESS',
          jobsDiscovered: 0,
          jobsCreated: 0,
          jobsUpdated: 0,
          jobsRemoved: 0,
          errors: [],
          duration: 0,
          skipped: true,
        } as any;
      }
    }

    // Stamp the attempt time immediately — visible even if SSH fails
    await prisma.client.update({
      where: { id: clientDbId },
      data: { lastCronAttemptAt: new Date() },
    });

    const syncRecord = await prisma.syncHistory.create({
      data: {
        id: uuidv4(),
        clientId: clientDbId,
        syncType: 'CRON_SYNC',
        status: 'RUNNING',
        source: client.appServers[0]?.dns || 'unknown',
      },
    });

    let conn: SSH2Client | null = null;

    try {
      const server = client.appServers[0];
      if (!server) throw new Error(`No active Prod servers for client ${client.clientId}`);

      logger.info(`Syncing crons from ${server.dns} for client ${client.clientId}`);

      // SSH connect with TOTP
      const creds = this.getCredentials();
      conn = await sshConnect(server.dns, creds);
      logger.info(`SSH connected to ${server.dns}`);

      // Detect server timezone
      const serverTz = await detectServerTimezone(conn);
      logger.info(`Server ${server.dns} timezone: ${serverTz}`);

      // Store detected timezone on the AppServer record
      await prisma.appServer.update({
        where: { id: server.id },
        data: { timezone: serverTz },
      });

      // Use server timezone as the authoritative source; update client record if it was stale
      const clientTz = serverTz;
      if (client.timezone !== serverTz) {
        await prisma.client.update({
          where: { id: client.id },
          data: { timezone: serverTz },
        });
      }

      // Read cron entries file
      const cronRaw = await sshExec(conn, `cat ${CRON_ENTRY_PATH}`);
      const cronEntries = parseCronEntries(cronRaw);
      discovered = cronEntries.length;

      logger.info(`Discovered ${discovered} WFM cron jobs on ${server.dns}`);

      // ── Cache write: wipe old entries for this server, insert fresh ones ──
      // Done before the Job processing loop so cache survives partial failures.
      const cacheNow = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.cachedCronJob.deleteMany({ where: { clientId: clientDbId, appServerId: server.id } });
        if (cronEntries.length > 0) {
          await tx.cachedCronJob.createMany({
            data: cronEntries.map(entry => ({
              clientId: clientDbId,
              appServerId: server.id,
              environment: 'Prod',
              serverDns: server.dns,
              cronExpression: entry.schedule,
              command: entry.command,
              owner: entry.user ?? null,
              rawLine: entry.rawLine,
              logPath: entry.logPath ?? null,
              fetchedAt: cacheNow,
            })),
          });
        }
      });
      logger.info(`[CronCache] Cached ${cronEntries.length} entries for ${client.clientId}`);


      // Track all discovered job names for this sync
      const discoveredJobNames = new Set<string>();
      const processedJobIds = new Set<string>();

      for (const entry of cronEntries) {
        try {
          let jobName = `${client.clientId} - ${extractJobName(entry.command)}`;
          const firstParam = extractFirstParam(entry.command);
          if (firstParam) {
            jobName += ` [${firstParam}]`;
          }
          // Deduplicate: if this name already exists in the set, append the schedule
          if (discoveredJobNames.has(jobName)) {
            jobName += ` (${entry.schedule})`;
          }
          // If still duplicate (same script, same params, same schedule — extremely rare), add index
          if (discoveredJobNames.has(jobName)) {
            let suffix = 2;
            while (discoveredJobNames.has(`${jobName} #${suffix}`)) suffix++;
            jobName = `${jobName} #${suffix}`;
          }
          discoveredJobNames.add(jobName);

          // Compute next run time: cron runs in server TZ, convert to UTC + local display
          const nextRun = computeNextRun(entry.schedule, serverTz, clientTz);

          const existing = await prisma.job.findFirst({
            where: {
              clientId: clientDbId,
              sourceSystem: 'appserver_cron',
              sourceIdentifier: entry.command,
              deleteStatus: null,
            },
          });

          if (existing) {
            // Update if schedule, log path, or name changed
            const updates: any = {};
            if (existing.name !== jobName) {
              // Only rename if the new name isn't taken by another record
              const nameTaken = await prisma.job.findFirst({ where: { name: jobName, id: { not: existing.id } } });
              if (!nameTaken) updates.name = jobName;
            }
            if (existing.cronExpression !== entry.schedule) updates.cronExpression = entry.schedule;
            if (entry.logPath && existing.logPath !== entry.logPath) {
              updates.logPath = entry.logPath;
              updates.logCheckEnabled = true;
            }
            // Always refresh timezone and next run
            updates.serverTimezone = serverTz;
            updates.timezone = clientTz;
            if (nextRun) {
              updates.nextRunTime = nextRun.utc;
              updates.nextRunLocal = nextRun.localDisplay;
            }
            await prisma.job.update({ where: { id: existing.id }, data: updates });
            processedJobIds.add(existing.id);
            updated++;
          } else {
            // Use upsert by name to handle duplicates gracefully
            const upserted = await prisma.job.upsert({
              where: { name: jobName },
              update: {
                clientId: clientDbId,
                cronExpression: entry.schedule,
                command: entry.command,
                logPath: entry.logPath,
                logCheckEnabled: !!entry.logPath,
                sourceIdentifier: entry.command,
                serverTimezone: serverTz,
                timezone: clientTz,
                nextRunTime: nextRun?.utc,
                nextRunLocal: nextRun?.localDisplay,
              },
              create: {
                id: uuidv4(),
                name: jobName,
                description: `Auto-discovered WFM cron from ${server.dns}`,
                jobType: inferJobType(entry.command),
                category: 'client-cron',
                clientId: clientDbId,
                sourceSystem: 'appserver_cron',
                sourceIdentifier: entry.command,
                cronExpression: entry.schedule,
                command: entry.command,
                logPath: entry.logPath,
                logCheckEnabled: !!entry.logPath,
                serverTimezone: serverTz,
                timezone: clientTz,
                nextRunTime: nextRun?.utc,
                nextRunLocal: nextRun?.localDisplay,
                tags: JSON.stringify([client.clientId.toLowerCase(), 'auto-sync', 'cron', 'wfm']),
                isActive: true,
              },
            });
            processedJobIds.add(upserted.id);
            created++;
          }
        } catch (err: any) {
          errors.push(`Failed to process cron: ${err.message}`);
        }
      }

      // Delete jobs for this client/sourceSystem that are not in the discovered set
      const deleted = await prisma.job.deleteMany({
        where: {
          clientId: clientDbId,
          sourceSystem: 'appserver_cron',
          id: { notIn: Array.from(processedJobIds) },
          deleteStatus: null,
        },
      });
      if (deleted.count > 0) {
        logger.info(`[Sync] Deleted ${deleted.count} stale jobs for client ${client.clientId}`);
      }

      const duration = Math.floor((Date.now() - startTime) / 1000);
      await prisma.syncHistory.update({
        where: { id: syncRecord.id },
        data: {
          status: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
          jobsDiscovered: discovered,
          jobsCreated: created,
          jobsUpdated: updated,
          errors: errors.length > 0 ? JSON.stringify(errors) : null,
          completedAt: new Date(),
          duration,
        },
      });

      // Update lastCronSyncAt + cache freshness on Client and AppServer
      await Promise.all([
        prisma.client.update({
          where: { id: clientDbId },
          data: { lastCronSyncAt: new Date(), lastCronCacheAt: new Date() },
        }),
        prisma.appServer.update({
          where: { id: server.id },
          data: {
            lastCronFetchAt: new Date(),
            lastCronFetchStatus: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
            cronJobCount: discovered,
          },
        }),
      ]);

      const result: SyncResult = {
        clientId: client.clientId,
        syncType: 'CRON_SYNC',
        status: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
        jobsDiscovered: discovered,
        jobsCreated: created,
        jobsUpdated: updated,
        jobsRemoved: 0,
        errors,
        duration,
      };

      this.emit('sync:completed', result);
      return result;

    } catch (err: any) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const failedServerId = client.appServers[0]?.id;
      await Promise.all([
        prisma.syncHistory.update({
          where: { id: syncRecord.id },
          data: {
            status: 'FAILED',
            errors: JSON.stringify([err.message]),
            completedAt: new Date(),
            duration,
          },
        }),
        // Mark cron fetch as FAILED — cache rows are kept so UI still has data
        failedServerId ? prisma.appServer.update({
          where: { id: failedServerId },
          data: { lastCronFetchStatus: 'FAILED' },
        }) : Promise.resolve(),
      ]);
      this.emit('sync:failed', { clientId: client.clientId, error: err.message });
      throw err;
    } finally {
      if (conn) conn.end();
    }
  }

  /**
   * Check log files for WFM jobs on a client's Prod server.
   * For each job with logCheckEnabled:
   *   1. Compute expected last run time from cron expression
   *   2. Check that the log file exists and was modified around that time
   *   3. Check if the cron process is currently running (via pgrep)
   *   4. Scan the log for both failure AND success patterns
   *   5. Check system cron log (syslog) for exit code
   * Returns per-job results with a deterministic status.
   */
  async checkClientLogs(clientDbId: string): Promise<LogCheckResult[]> {
    const client = await prisma.client.findUnique({
      where: { id: clientDbId },
      include: { appServers: { where: { environment: 'Prod', isActive: true } } },
    });

    if (!client) throw new Error(`Client not found: ${clientDbId}`);

    const server = client.appServers[0];
    if (!server) throw new Error(`No active Prod servers for client ${client.clientId}`);

    // Get all active, non-deleted jobs with log monitoring enabled
    const jobs = await prisma.job.findMany({
      where: { clientId: clientDbId, logCheckEnabled: true, logPath: { not: null }, isActive: true, deleteStatus: null },
    });

    if (jobs.length === 0) {
      logger.info(`No log-monitored jobs for client ${client.clientId}`);
      return [];
    }

    const creds = this.getCredentials();
    const conn = await sshConnect(server.dns, creds);
    const results: LogCheckResult[] = [];
    const serverTz = server.timezone || 'UTC';

    try {
      for (const job of jobs) {
        const logPath = job.logPath!;
        try {
          const result = await this.checkSingleJobLog(conn, job, logPath, serverTz, server.dns);
          results.push(result);

          // Persist status back to the Job record
          await prisma.job.update({
            where: { id: job.id },
            data: {
              lastRunStatus: result.status,
              lastRunAt: result.lastModified,
              lastLogCheckAt: new Date(),
            },
          });

          // Record as a JobExecution entry for history
          await this.recordLogCheckExecution(
            job.id,
            result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
            result.summary,
            result.cronExitCode,
            result.lastModified,
          );

        } catch (err: any) {
          logger.error(`Log check failed for ${job.name} (${logPath}): ${err.message}`);
          results.push({
            jobName: job.name,
            logPath,
            status: 'UNKNOWN',
            exists: false,
            hasFailure: false,
            hasSuccess: false,
            triggered: false,
            isRunning: false,
            lastModified: null,
            expectedLastRun: null,
            logFresh: false,
            failureLines: [],
            successLines: [],
            cronExitCode: null,
            sizeBytes: 0,
            summary: `Log check error: ${err.message}`,
          });
        }
      }
    } finally {
      conn.end();
    }

    const failures = results.filter(r => r.status === 'FAILED' || r.status === 'NOT_RUN');
    const successes = results.filter(r => r.status === 'SUCCESS');
    logger.info(`Log check complete for ${client.clientId}: ${results.length} checked — ${successes.length} success, ${failures.length} failed/not-run`);
    return results;
  }

  /**
   * Full log analysis for a single job.
   * Checks: log existence → freshness → process running → content patterns → syslog exit code
   */
  private async checkSingleJobLog(
    conn: SSH2Client,
    job: any,
    logPath: string,
    serverTz: string,
    serverDns: string,
  ): Promise<LogCheckResult> {
    // 1. Compute expected last run time from the cron expression
    const expectedLastRun = job.cronExpression
      ? computeLastRunTime(job.cronExpression, serverTz)
      : null;

    // 2. Check log file existence + metadata
    const statOutput = await sshExec(conn, `stat --format='%s %Y' '${logPath}' 2>/dev/null || echo 'NOTFOUND'`);

    if (statOutput.trim() === 'NOTFOUND') {
      return {
        jobName: job.name,
        logPath,
        status: 'NOT_RUN',
        exists: false,
        hasFailure: false,
        hasSuccess: false,
        triggered: false,
        isRunning: false,
        lastModified: null,
        expectedLastRun,
        logFresh: false,
        failureLines: [],
        successLines: [],
        cronExitCode: null,
        sizeBytes: 0,
        summary: 'Log file not found — job may not have triggered',
      };
    }

    const [sizeStr, mtimeStr] = statOutput.trim().split(' ');
    const sizeBytes = parseInt(sizeStr, 10) || 0;
    const lastModified = new Date(parseInt(mtimeStr, 10) * 1000);

    // 3. Check if log was modified around the expected last run time
    //    "Fresh" = modified within 2× the cron interval or within the past 24h
    let logFresh = false;
    if (expectedLastRun) {
      const timeSinceExpected = Date.now() - expectedLastRun.getTime();
      const timeSinceModified = Date.now() - lastModified.getTime();
      // Consider the log fresh if it was modified after expectedLastRun minus 5-minute grace
      const graceMs = 5 * 60 * 1000;
      logFresh = lastModified.getTime() >= (expectedLastRun.getTime() - graceMs);
      // Also mark fresh if modified within the last hour as a fallback
      if (timeSinceModified < 60 * 60 * 1000) logFresh = true;
    } else {
      // No cron expression — consider fresh if modified in last 24 hours
      logFresh = (Date.now() - lastModified.getTime()) < 24 * 60 * 60 * 1000;
    }

    // 4. Read the last N lines and scan for failure + success patterns
    const tailOutput = await sshExec(conn, `tail -300 '${logPath}'`);

    const failureLines: string[] = [];
    const successLines: string[] = [];
    for (const line of tailOutput.split('\n')) {
      for (const pattern of FAILURE_PATTERNS) {
        if (pattern.test(line)) {
          failureLines.push(line.trim());
          break;
        }
      }
      for (const pattern of SUCCESS_PATTERNS) {
        if (pattern.test(line)) {
          successLines.push(line.trim());
          break;
        }
      }
    }

    const hasFailure = failureLines.length > 0;
    const hasSuccess = successLines.length > 0;

    // 5. Check syslog / cron.log for exit code (best effort)
    const cronExitCode = await this.checkCronExitCode(conn, job.command);

    // 6. Determine overall status using a priority cascade:
    //    ExitCode > LogPatterns > Freshness > Unknown
    let status: LogCheckResult['status'];
    let summary: string;

    if (cronExitCode !== null) {
      // Syslog gave us a definitive exit code
      if (cronExitCode === 0) {
        status = 'SUCCESS';
        summary = `Cron exited with code 0 (success) — last log update ${dayjs(lastModified).format('YYYY-MM-DD HH:mm:ss')}`;
      } else {
        status = 'FAILED';
        summary = `Cron exited with code ${cronExitCode}`;
        if (failureLines.length > 0) summary += ` — ${failureLines.length} error(s) in log`;
      }
    } else if (!logFresh) {
      // Log exists but is stale — job didn't run at its expected time
      status = 'STALE';
      summary = `Log exists but is stale (last modified ${dayjs(lastModified).format('YYYY-MM-DD HH:mm:ss')})`;
      if (expectedLastRun) summary += ` — expected run at ${dayjs(expectedLastRun).format('YYYY-MM-DD HH:mm:ss')}`;
    } else if (hasFailure && !hasSuccess) {
      // Failures found, no success markers
      status = 'FAILED';
      summary = `${failureLines.length} failure pattern(s) found in log, no success markers`;
    } else if (hasSuccess && !hasFailure) {
      // Only success markers
      status = 'SUCCESS';
      summary = 'Log contains success patterns, no failures detected';
    } else if (hasSuccess && hasFailure) {
      // Both present — check which appeared last (later lines = more recent)
      const lastFailIdx = this.findLastPatternIndex(tailOutput, FAILURE_PATTERNS);
      const lastSuccIdx = this.findLastPatternIndex(tailOutput, SUCCESS_PATTERNS);
      if (lastSuccIdx > lastFailIdx) {
        status = 'SUCCESS';
        summary = `Errors were logged but final status is success (success at line ${lastSuccIdx}, last error at line ${lastFailIdx})`;
      } else {
        status = 'FAILED';
        summary = `${failureLines.length} failure(s) detected after success markers`;
      }
    } else {
      // No patterns matched — log is fresh, assume OK
      status = logFresh ? 'SUCCESS' : 'UNKNOWN';
      summary = logFresh
        ? 'Log is fresh with no errors (no explicit success marker found)'
        : 'Unable to determine job status from log content';
    }

    return {
      jobName: job.name,
      logPath,
      status,
      exists: true,
      hasFailure,
      hasSuccess,
      triggered: logFresh,
      isRunning: false,
      lastModified,
      expectedLastRun,
      logFresh,
      failureLines: failureLines.slice(0, 10),
      successLines: successLines.slice(0, 5),
      cronExitCode,
      sizeBytes,
      summary,
    };
  }

  /**
   * Check if a cron job process is currently running on the server.
   * Uses pgrep to search for the command's key script/binary.
   */
  private async checkProcessRunning(conn: SSH2Client, command: string | null): Promise<boolean> {
    if (!command) return false;
    try {
      // Extract the main script/binary from the command for matching
      const scriptMatch = command.match(/\/([^/\s>|]+\.\w+)/);
      const searchTerm = scriptMatch ? scriptMatch[1] : null;
      if (!searchTerm) return false;

      const pgrepOut = await sshExec(conn, `pgrep -f '${searchTerm}' 2>/dev/null | head -5 || true`, 10);
      return pgrepOut.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Query the system cron log (syslog or /var/log/cron) for the exit code
   * of the most recent execution of a given command.
   *
   * Cron daemons typically log lines like:
   *   CROND[12345]: (user) CMD (/path/to/script.sh)
   *   CROND[12345]: (user) CMDEND (/path/to/script.sh) exit status 0
   * or via journalctl:
   *   crond[pid]: ... exit status=0
   */
  private async checkCronExitCode(conn: SSH2Client, command: string | null): Promise<number | null> {
    if (!command) return null;

    // Extract a unique substring from the command to grep for
    const scriptMatch = command.match(/(\/mount\/RWS4\/[^\s>|]+)/);
    const grepKey = scriptMatch ? scriptMatch[1] : null;
    if (!grepKey) return null;

    try {
      // Try journalctl first (systemd systems) — last 1h of cron entries
      const journalOut = await sshExec(
        conn,
        `journalctl -u crond -u cron --since '1 hour ago' --no-pager 2>/dev/null | grep -i '${grepKey}' | tail -5 || true`,
        15,
      );

      let exitCode = this.parseExitCodeFromLog(journalOut);
      if (exitCode !== null) return exitCode;

      // Fallback: grep /var/log/cron or /var/log/syslog
      const cronLogOut = await sshExec(
        conn,
        `(grep -i '${grepKey}' /var/log/cron 2>/dev/null || grep -i '${grepKey}' /var/log/syslog 2>/dev/null || true) | tail -5`,
        15,
      );

      exitCode = this.parseExitCodeFromLog(cronLogOut);
      return exitCode;
    } catch {
      return null;
    }
  }

  /**
   * Parse an exit code from cron/syslog log lines.
   * Looks for patterns like "exit status 0", "exit status=1", "CMDEND ... exit 0"
   */
  private parseExitCodeFromLog(logText: string): number | null {
    const lines = logText.split('\n').reverse(); // newest first
    for (const line of lines) {
      const match = line.match(/exit\s*(?:status|code)?[=:\s]+(\d+)/i);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  /**
   * Find the line index of the last occurrence of any pattern in the text.
   * Used to determine whether success or failure appeared last in the log.
   */
  private findLastPatternIndex(text: string, patterns: RegExp[]): number {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      for (const p of patterns) {
        if (p.test(lines[i])) return i;
      }
    }
    return -1;
  }

  /** Record a log-check result as a JobExecution entry */
  private async recordLogCheckExecution(
    jobId: string,
    status: string,
    message: string,
    exitCode: number | null = null,
    lastRunAt: Date | null = null,
  ) {
    const scheduledAt = lastRunAt || new Date();
    await prisma.jobExecution.create({
      data: {
        id: uuidv4(),
        jobId,
        status,
        scheduledAt,
        startedAt: lastRunAt || new Date(),
        completedAt: new Date(),
        duration: 0,
        exitCode,
        output: message,
        triggeredBy: 'log_monitor',
      },
    });
  }

  /**
   * Full sync for one client: discover crons + check logs
   */
  async syncClient(clientDbId: string, force = false): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    try {
      results.push(await this.syncClientCrons(clientDbId, force));
    } catch (err: any) {
      logger.error(`Cron sync failed for ${clientDbId}: ${err.message}`);
    }

    // After sync, check logs for any discovered jobs
    try {
      const logResults = await this.checkClientLogs(clientDbId);
      const failures = logResults.filter(r => r.hasFailure || !r.triggered);
      if (failures.length > 0) {
        logger.warn(`Log check: ${failures.length} issue(s) for client`);
      }
    } catch (err: any) {
      logger.error(`Log check failed for ${clientDbId}: ${err.message}`);
    }

    return results;
  }

  /**
   * Sync cron jobs for ALL active clients sequentially.
   * Waits 30s between each client for TOTP cooldown (only when using personal/TOTP auth).
   */
  async syncAllCrons(force = false): Promise<{ total: number; succeeded: number; failed: number; skipped: number; results: SyncResult[] }> {
    if (this.isSyncing) {
      throw new Error('A sync operation is already in progress');
    }

    this.isSyncing = true;
    const allResults: SyncResult[] = [];
    let succeeded = 0, failed = 0, skipped = 0;

    try {
      const clients = await prisma.client.findMany({ where: { isActive: true } });
      const creds = this.getCredentials();
      const usesTotp = !!creds.totpSecret;
      logger.info(`Starting cron sync for ${clients.length} active clients (${usesTotp ? '30s TOTP cooldown' : 'no TOTP — no cooldown'}, force=${force})`);

      for (let i = 0; i < clients.length; i++) {
        const client = clients[i];
        try {
          logger.info(`[${i + 1}/${clients.length}] Syncing crons for ${client.clientId}...`);
          const result = await this.syncClientCrons(client.id, force);
          allResults.push(result);
          if ((result as any).skipped) {
            skipped++;
            logger.info(`[${i + 1}/${clients.length}] ${client.clientId} — skipped (24h cooldown)`);
          } else {
            succeeded++;
          }
        } catch (err: any) {
          logger.error(`Cron sync failed for ${client.clientId}: ${err.message}`);
          allResults.push({
            clientId: client.id, syncType: 'CRON_SYNC', status: 'FAILED',
            jobsDiscovered: 0, jobsCreated: 0, jobsUpdated: 0, jobsRemoved: 0,
            errors: [err.message], duration: 0,
          });
          failed++;
        }
        // Wait 30s for TOTP cooldown only if using TOTP and we actually connected (not skipped)
        const lastResult = allResults[allResults.length - 1];
        if (usesTotp && i < clients.length - 1 && !(lastResult as any)?.skipped) {
          logger.info(`Waiting 30s for TOTP cooldown...`);
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }

      logger.info(`Cron sync complete: ${succeeded} synced, ${skipped} skipped (24h cooldown), ${failed} failed out of ${clients.length}`);
      return { total: clients.length, succeeded, skipped, failed, results: allResults };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync all active clients (batch — sequential to avoid TOTP collisions)
   */
  async syncAllClients(force = false): Promise<{ total: number; succeeded: number; failed: number; skipped: number; results: SyncResult[] }> {
    if (this.isSyncing) {
      throw new Error('A sync operation is already in progress');
    }

    this.isSyncing = true;
    const allResults: SyncResult[] = [];
    let succeeded = 0, failed = 0, skipped = 0;

    try {
      const clients = await prisma.client.findMany({ where: { isActive: true } });
      const creds = this.getCredentials();
      const usesTotp = !!creds.totpSecret;
      logger.info(`Starting full sync for ${clients.length} active clients (force=${force})`);

      for (const client of clients) {
        try {
          const results = await this.syncClient(client.id, force);
          allResults.push(...results);
          // A result with skipped=true means the 24h cooldown was hit
          const wasSkipped = results.some((r: any) => r.skipped);
          if (wasSkipped) skipped++; else succeeded++;
          // Small delay between clients to avoid TOTP time-window collisions (only when using TOTP)
          if (usesTotp) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch (err: any) {
          logger.error(`Sync failed for client ${client.clientId}: ${err.message}`);
          failed++;
        }
      }

      logger.info(`Full sync complete: ${succeeded} synced, ${skipped} skipped (24h cooldown), ${failed} failed`);
      this.emit('sync:allCompleted', { total: clients.length, succeeded, skipped, failed });
      return { total: clients.length, succeeded, skipped, failed, results: allResults };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Check logs for a specific set of job IDs.
   * Groups jobs by client, opens one SSH connection per client,
   * and checks only the requested jobs. Used by the periodic scheduler.
   */
  async checkSpecificJobs(jobIds: string[]): Promise<LogCheckResult[]> {
    if (jobIds.length === 0) return [];

    const jobs = await prisma.job.findMany({
      where: {
        id: { in: jobIds },
        isActive: true,
        deleteStatus: null,
        logCheckEnabled: true,
        logPath: { not: null },
      },
      include: {
        client: {
          include: { appServers: { where: { environment: 'Prod', isActive: true } } },
        },
      },
    });

    if (jobs.length === 0) {
      logger.info(`[AutoCheck] No eligible jobs to check from ${jobIds.length} IDs`);
      return [];
    }

    // Group by client
    const byClient = new Map<string, typeof jobs>();
    for (const job of jobs) {
      if (!job.client || !job.client.appServers[0]) continue;
      const clientId = job.client.id;
      if (!byClient.has(clientId)) byClient.set(clientId, []);
      byClient.get(clientId)!.push(job);
    }

    const allResults: LogCheckResult[] = [];
    const creds = this.getCredentials();

    for (const [clientId, clientJobs] of byClient) {
      const server = clientJobs[0].client!.appServers[0];
      const serverTz = server.timezone || 'UTC';
      let conn: SSH2Client | null = null;

      try {
        conn = await sshConnect(server.dns, creds);

        for (const job of clientJobs) {
          try {
            const result = await this.checkSingleJobLog(conn, job, job.logPath!, serverTz, server.dns);
            allResults.push(result);

            // Persist status
            await prisma.job.update({
              where: { id: job.id },
              data: {
                lastRunStatus: result.status,
                lastRunAt: result.lastModified,
                lastLogCheckAt: new Date(),
              },
            });

            await this.recordLogCheckExecution(
              job.id,
              result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
              `[Auto] ${result.summary}`,
              result.cronExitCode,
              result.lastModified,
            );
          } catch (err: any) {
            logger.error(`[AutoCheck] Log check failed for ${job.name}: ${err.message}`);
            allResults.push({
              jobName: job.name, logPath: job.logPath!, status: 'UNKNOWN',
              exists: false, hasFailure: false, hasSuccess: false, triggered: false,
              isRunning: false, lastModified: null, expectedLastRun: null, logFresh: false,
              failureLines: [], successLines: [], cronExitCode: null, sizeBytes: 0,
              summary: `Auto-check error: ${err.message}`,
            });
          }
        }
      } catch (err: any) {
        logger.error(`[AutoCheck] SSH failed for client ${clientId}: ${err.message}`);
      } finally {
        if (conn) conn.end();
      }

      // Delay between clients to avoid TOTP collisions
      if (byClient.size > 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    logger.info(`[AutoCheck] Checked ${allResults.length} jobs — ${allResults.filter(r => r.status === 'SUCCESS').length} success, ${allResults.filter(r => r.status === 'FAILED').length} failed`);
    return allResults;
  }

  /**
   * Get sync status for a client
   */
  async getSyncHistory(clientDbId: string, limit = 10) {
    return prisma.syncHistory.findMany({
      where: { clientId: clientDbId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { client: { select: { clientId: true, name: true } } },
    });
  }

  /**
   * One-time utility: SSH into every active client's Prod server,
   * detect the OS timezone, and persist it on AppServer + Client records.
   * Processes clients sequentially to avoid TOTP collisions.
   */
  async detectAllTimezones(filter?: { cluster?: string; clientIds?: string[]; force?: boolean }): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cooldown: number;
    results: { clientId: string; server: string; timezone: string | null; error?: string; priority: string }[];
  }> {
    const where: any = { isActive: true };
    if (filter?.cluster) where.cluster = filter.cluster;
    if (filter?.clientIds?.length) where.id = { in: filter.clientIds };
    const label = filter?.cluster ? `cluster ${filter.cluster}` : filter?.clientIds?.length ? `${filter.clientIds.length} specific clients` : 'all';
    const force = filter?.force ?? false;
    logger.info(`[TZ] Loading active clients (${label})...`);
    const clients = await prisma.client.findMany({
      where,
      include: { appServers: { where: { environment: 'Prod', isActive: true } } },
    });
    logger.info(`[TZ] Found ${clients.length} active clients`);

    // Sort into priority groups:
    // 1. PENDING  — server.timezone is null AND never attempted
    // 2. FAILED   — server.timezone is null AND previously attempted
    // 3. DETECTED — server.timezone is already set
    // 4. RECENT   — attempted within 24h (skip unless forced)
    const pending: typeof clients = [];
    const failed: typeof clients = [];
    const detected: typeof clients = [];
    const recentlyAttempted: typeof clients = [];

    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const client of clients) {
      const server = client.appServers[0];
      if (!server) {
        pending.push(client);
      } else if (!force && server.tzLastAttemptAt && server.tzLastAttemptAt > cutoff24h) {
        recentlyAttempted.push(client); // within 24h — skip
      } else if (server.timezone) {
        detected.push(client);
      } else if (server.tzLastAttemptAt) {
        failed.push(client);
      } else {
        pending.push(client);
      }
    }

    logger.info(`[TZ] Priority: ${pending.length} pending, ${failed.length} previously failed, ${detected.length} already detected, ${recentlyAttempted.length} skipped (< 24h)`);

    // Combine in priority order — already-detected go last; recently-attempted are excluded
    const ordered = [...pending, ...failed, ...detected];

    logger.info('[TZ] Loading SSH credentials...');
    let creds: SSHCredentials;
    try {
      creds = this.getCredentials();
      logger.info(`[TZ] Credentials loaded for user: ${creds.username}`);
    } catch (err: any) {
      logger.error(`[TZ] Failed to load SSH credentials: ${err.message}`);
      throw err;
    }

    const results: { clientId: string; server: string; timezone: string | null; error?: string; priority: string }[] = [];
    let succeededCount = 0, failedCount = 0, skippedCount = 0;

    for (let i = 0; i < ordered.length; i++) {
      const client = ordered[i];
      const server = client.appServers[0];
      const progress = `[${i + 1}/${ordered.length}]`;
      const priority = pending.includes(client) ? 'PENDING' : failed.includes(client) ? 'RETRY' : 'DETECTED';

      if (!server) {
        logger.warn(`[TZ] ${progress} ${client.clientId} (${priority}) — SKIP: No active Prod server`);
        results.push({ clientId: client.clientId, server: '—', timezone: null, error: 'No active Prod server', priority });
        failedCount++;
        continue;
      }

      // Skip already-detected clients (they go at end but we can skip them entirely)
      if (priority === 'DETECTED') {
        logger.info(`[TZ] ${progress} ${client.clientId} (${priority}) — SKIP: Already ${server.timezone}`);
        results.push({ clientId: client.clientId, server: server.dns, timezone: server.timezone, priority });
        skippedCount++;
        continue;
      }

      logger.info(`[TZ] ${progress} ${client.clientId} (${priority}) — Connecting to ${server.dns}...`);

      let conn: SSH2Client | null = null;
      try {
        conn = await sshConnect(server.dns, creds);
        logger.info(`[TZ] ${progress} ${client.clientId} (${priority}) — SSH connected, detecting timezone...`);

        const detectedTz = await detectServerTimezone(conn);
        logger.info(`[TZ] ${progress} ${client.clientId} (${priority}) — Detected: ${detectedTz}`);

        // Persist on AppServer (also record attempt time)
        await prisma.appServer.update({
          where: { id: server.id },
          data: { timezone: detectedTz, tzLastAttemptAt: new Date() },
        });

        // Also update the Client record so display TZ is accurate
        await prisma.client.update({
          where: { id: client.id },
          data: { timezone: detectedTz },
        });

        // Update all jobs for this client so serverTimezone is correct
        await prisma.job.updateMany({
          where: { clientId: client.id, deleteStatus: null },
          data: { serverTimezone: detectedTz, timezone: detectedTz },
        });

        logger.info(`[TZ] ${progress} ${client.clientId} @ ${server.dns} → ${detectedTz} ✓`);
        results.push({ clientId: client.clientId, server: server.dns, timezone: detectedTz, priority });
        succeededCount++;
      } catch (err: any) {
        logger.error(`[TZ] ${progress} ${client.clientId} (${priority}) @ ${server.dns} — FAILED: ${err.message}`);
        // Record the attempt time even on failure so next run knows it was tried
        await prisma.appServer.update({
          where: { id: server.id },
          data: { tzLastAttemptAt: new Date() },
        }).catch(() => {}); // best-effort
        results.push({ clientId: client.clientId, server: server.dns, timezone: null, error: err.message, priority });
        failedCount++;
      } finally {
        if (conn) conn.end();
      }

      // Delay between servers to avoid TOTP collisions
      if (i < ordered.length - 1) {
        logger.info(`[TZ] Waiting 2s before next client...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Add cooldown-skipped clients to results so callers know their status
    const cooldownCount = recentlyAttempted.length;
    for (const client of recentlyAttempted) {
      const server = client.appServers[0];
      const hoursSince = server?.tzLastAttemptAt
        ? ((Date.now() - server.tzLastAttemptAt.getTime()) / (1000 * 60 * 60)).toFixed(1)
        : '?';
      logger.info(`[TZ] ${client.clientId} — COOLDOWN: Last attempted ${hoursSince}h ago (< 24h, use force=true to override)`);
      results.push({ clientId: client.clientId, server: server?.dns ?? '—', timezone: server?.timezone ?? null, priority: 'COOLDOWN' });
    }

    const total = ordered.length + cooldownCount;
    logger.info(`[TZ] === COMPLETE: ${succeededCount} succeeded, ${failedCount} failed, ${skippedCount} skipped (already detected), ${cooldownCount} skipped (24h cooldown) out of ${total} clients ===`);
    return { total, succeeded: succeededCount, failed: failedCount, skipped: skippedCount + cooldownCount, cooldown: cooldownCount, results };
  }
}

export const syncService = new SyncService();
