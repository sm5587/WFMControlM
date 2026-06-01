// ============================================================
// Jobs API Routes
// ============================================================

import { Router, Request, Response } from 'express';
import { prisma } from '../database/prisma';
import { scheduler } from '../engine/scheduler';
import { jobExecutor } from '../engine/executor';
import { createServiceLogger } from '../utils/logger';
import { requirePermission } from '../middleware';
import { z } from 'zod';
import { Client as SSH2Client } from 'ssh2';
import { generateSync } from 'otplib';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

import cronParser from 'cron-parser';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);

function computeNextRunLocal(cronExpr: string, serverTz: string, clientTz: string): string | null {
  try {
    const interval = cronParser.parseExpression(cronExpr, { tz: serverTz, currentDate: new Date() });
    const nextUtc = interval.next().toDate();
    const localDt = dayjs(nextUtc).tz(clientTz);
    const tzAbbr = new Intl.DateTimeFormat('en-US', { timeZone: clientTz, timeZoneName: 'short' })
      .formatToParts(nextUtc)
      .find(p => p.type === 'timeZoneName')?.value || clientTz;
    return localDt.format('YYYY-MM-DD HH:mm') + ` ${tzAbbr}`;
  } catch {
    return null;
  }
}

const router = Router();
const logger = createServiceLogger('JobsAPI');

// Validation schemas
const createJobSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  jobType: z.enum(['COMMAND', 'SCRIPT', 'HTTP', 'SQL', 'DATA_PIPELINE', 'FORECAST', 'SCHEDULE_GEN', 'FILE_TRANSFER', 'CUSTOM']),
  category: z.string().default('general'),
  cronExpression: z.string().optional(),
  timezone: z.string().default('UTC'),
  command: z.string().optional(),
  scriptPath: z.string().optional(),
  httpConfig: z.any().optional(),
  retryPolicy: z.object({
    maxRetries: z.number().min(0).max(10),
    retryDelay: z.number().min(1),
    backoffMultiplier: z.number().min(1).max(10),
  }).optional(),
  timeout: z.number().min(1).default(3600),
  priority: z.number().min(1).max(10).default(5),
  maxConcurrency: z.number().min(1).default(1),
  resourcePool: z.string().default('default'),
  tags: z.array(z.string()).default([]),
  parameters: z.any().optional(),
  environment: z.any().optional(),
  owner: z.string().optional(),
  team: z.string().optional(),
});

// GET /api/jobs/upcoming - Jobs scheduled to run in the next N hours
router.get('/upcoming', async (req: Request, res: Response) => {
  try {
    const hours = Math.min(parseInt(req.query.hours as string) || 2, 24);
    const now = Date.now();
    const windowEnd = now + hours * 60 * 60 * 1000;

    const jobs = await prisma.job.findMany({
      where: {
        isActive: true,
        deleteStatus: null,
        cronExpression: { not: null },
      },
      include: {
        client: { select: { id: true, clientId: true, name: true, cluster: true } },
      },
    });

    const upcoming: Array<{
      id: string;
      name: string;
      cronExpression: string;
      nextRunTime: string;
      nextRunLocal: string | null;
      client: any;
      lastRunStatus: string | null;
      lastRunAt: string | null;
      logCheckEnabled: boolean;
      autoCheckScheduled: boolean;
      minutesUntilRun: number;
    }> = [];

    const pendingChecks = scheduler.getUpcomingChecks();
    const pendingJobIds = new Set(pendingChecks.map(c => c.jobId));

    for (const job of jobs) {
      if (!job.cronExpression) continue;
      try {
        const tz = job.serverTimezone || job.timezone || 'UTC';
        const interval = cronParser.parseExpression(job.cronExpression, { tz, currentDate: new Date() });
        const nextRun = interval.next().toDate();

        if (nextRun.getTime() > now && nextRun.getTime() <= windowEnd) {
          upcoming.push({
            id: job.id,
            name: job.name,
            cronExpression: job.cronExpression,
            nextRunTime: nextRun.toISOString(),
            nextRunLocal: job.nextRunLocal,
            client: job.client,
            lastRunStatus: job.lastRunStatus,
            lastRunAt: job.lastRunAt?.toISOString() || null,
            logCheckEnabled: job.logCheckEnabled,
            autoCheckScheduled: pendingJobIds.has(job.id),
            minutesUntilRun: Math.round((nextRun.getTime() - now) / 60000),
          });
        }
      } catch {
        // skip unparseable cron
      }
    }

    upcoming.sort((a, b) => a.minutesUntilRun - b.minutesUntilRun);

    res.json({
      success: true,
      data: {
        windowHours: hours,
        totalUpcoming: upcoming.length,
        jobs: upcoming,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/jobs - List all jobs
router.get('/', async (req: Request, res: Response) => {
  try {
    const { page = '1', pageSize = '50', category, jobType, search, isActive, clientId } = req.query;
    logger.info(`[JobsList] GET /api/jobs — page=${page} pageSize=${pageSize} category=${category} isActive=${isActive} clientId=${clientId}`);
    
    const where: any = { deleteStatus: null };
    if (category) where.category = category;
    if (jobType) where.jobType = jobType;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (clientId) where.clientId = clientId === 'none' ? null : clientId;
    if (search) {
      where.OR = [
        { name: { contains: search as string } },
        { description: { contains: search as string } },
      ];
    }

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: {
          _count: { select: { executions: true } },
          client: { select: { id: true, clientId: true, name: true, cluster: true } },
        },
        orderBy: { name: 'asc' },
        skip: (parseInt(page as string) - 1) * parseInt(pageSize as string),
        take: parseInt(pageSize as string),
      }),
      prisma.job.count({ where }),
    ]);
    logger.info(`[JobsList] Query returned ${jobs.length} jobs (total=${total})`);

    // Enrich with next run time — prefer stored nextRunTime (server-TZ-aware), fallback to scheduler
    // Enrich with next run time — skip interval.prev() as it can hang on certain cron patterns
    const enrichedJobs = jobs.map(job => {
      return {
        ...job,
        nextRunTime: job.cronExpression
          ? (scheduler.getNextRunTime(job.cronExpression, job.serverTimezone || job.timezone || 'UTC')?.toISOString() ?? job.nextRunTime)
          : job.nextRunTime,
        nextRunLocal: job.cronExpression && (job.serverTimezone || job.timezone)
          ? (computeNextRunLocal(
              job.cronExpression,
              job.serverTimezone || job.timezone || 'UTC',
              job.timezone || job.serverTimezone || 'UTC'
            ) ?? job.nextRunLocal ?? null)
          : job.nextRunLocal ?? null,
        lastRunAt: job.lastRunAt ?? null,
      };
    });

    res.json({
      success: true,
      data: enrichedJobs,
      pagination: {
        page: parseInt(page as string),
        pageSize: parseInt(pageSize as string),
        total,
        totalPages: Math.ceil(total / parseInt(pageSize as string)),
      },
    });
  } catch (error: any) {
    logger.error(`Error listing jobs: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/jobs/:id - Get job detail
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: {
        executions: {
          orderBy: { scheduledAt: 'desc' },
          take: 10,
        },
        alerts: true,
      },
    });

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({
      success: true,
      data: {
        ...job,
        nextRunTime: job.cronExpression
          ? scheduler.getNextRunTime(job.cronExpression, job.timezone)
          : null,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/jobs - Create a new job
router.post('/', requirePermission('JOBS_CREATE', 'write'), async (req: Request, res: Response) => {
  try {
    const validated = createJobSchema.parse(req.body);
    
    const job = await prisma.job.create({
      data: {
        ...validated,
        tags: JSON.stringify(validated.tags),
        httpConfig: validated.httpConfig ? JSON.stringify(validated.httpConfig) : null,
        retryPolicy: validated.retryPolicy ? JSON.stringify(validated.retryPolicy) : null,
        parameters: validated.parameters ? JSON.stringify(validated.parameters) : null,
        environment: validated.environment ? JSON.stringify(validated.environment) : null,
      },
    });

    // Schedule if cron expression provided
    if (job.cronExpression && job.isActive) {
      scheduler.scheduleJob(job.id, job.name, job.cronExpression, job.timezone);
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        entityType: 'Job',
        entityId: job.id,
        action: 'CREATE',
        newValue: JSON.stringify(job),
      },
    });

    logger.info(`Job created: ${job.name} (${job.id})`);;
    res.status(201).json({ success: true, data: job });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    logger.error(`Error creating job: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/jobs/:id - Update a job
router.put('/:id', requirePermission('JOBS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const job = await prisma.job.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        tags: req.body.tags ? JSON.stringify(req.body.tags) : undefined,
        httpConfig: req.body.httpConfig ? JSON.stringify(req.body.httpConfig) : undefined,
        retryPolicy: req.body.retryPolicy ? JSON.stringify(req.body.retryPolicy) : undefined,
        parameters: req.body.parameters ? JSON.stringify(req.body.parameters) : undefined,
        environment: req.body.environment ? JSON.stringify(req.body.environment) : undefined,
      },
    });

    // Reschedule if cron changed
    if (job.cronExpression !== existing.cronExpression || job.isActive !== existing.isActive) {
      scheduler.unscheduleJob(job.id);
      if (job.cronExpression && job.isActive) {
        scheduler.scheduleJob(job.id, job.name, job.cronExpression, job.timezone);
      }
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        entityType: 'Job',
        entityId: job.id,
        action: 'UPDATE',
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(job),
      },
    });

    res.json({ success: true, data: job });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/jobs/:id - Delete a job
router.delete('/:id', requirePermission('JOBS_DELETE', 'write'), async (req: Request, res: Response) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    scheduler.unscheduleJob(job.id);
    await prisma.job.update({
      where: { id: req.params.id },
      data: { deleteStatus: 'D', isActive: false },
    });

    await prisma.auditLog.create({
      data: {
        entityType: 'Job',
        entityId: job.id,
        action: 'DELETE',
        oldValue: JSON.stringify(job),
      },
    });

    res.json({ success: true, message: 'Job deleted' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/jobs/:id/trigger - Manually trigger a job (admin only)
router.post('/:id/trigger', requirePermission('JOBS_TRIGGER', 'write'), async (req: Request, res: Response) => {
  try {
    const executionId = await scheduler.triggerJobExecution(req.params.id, 'manual');
    res.json({ success: true, data: { executionId } });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/jobs/:id/toggle - Enable/disable a job (admin only)
router.post('/:id/toggle', requirePermission('JOBS_TOGGLE', 'write'), async (req: Request, res: Response) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    const updated = await prisma.job.update({
      where: { id: req.params.id },
      data: { isActive: !job.isActive },
    });

    if (updated.isActive && updated.cronExpression) {
      scheduler.scheduleJob(updated.id, updated.name, updated.cronExpression, updated.timezone);
    } else {
      scheduler.unscheduleJob(updated.id);
    }

    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/jobs/:id/executions - Get execution history for a job
router.get('/:id/executions', async (req: Request, res: Response) => {
  try {
    const { page = '1', pageSize = '20' } = req.query;
    
    const [executions, total] = await Promise.all([
      prisma.jobExecution.findMany({
        where: { jobId: req.params.id },
        orderBy: { scheduledAt: 'desc' },
        skip: (parseInt(page as string) - 1) * parseInt(pageSize as string),
        take: parseInt(pageSize as string),
      }),
      prisma.jobExecution.count({ where: { jobId: req.params.id } }),
    ]);

    res.json({
      success: true,
      data: executions,
      pagination: {
        page: parseInt(page as string),
        pageSize: parseInt(pageSize as string),
        total,
        totalPages: Math.ceil(total / parseInt(pageSize as string)),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/executions/:id/cancel - Cancel a running execution
router.post('/executions/:id/cancel', async (req: Request, res: Response) => {
  try {
    const cancelled = await jobExecutor.cancel(req.params.id);
    if (cancelled) {
      res.json({ success: true, message: 'Execution cancelled' });
    } else {
      res.status(404).json({ success: false, error: 'Execution not found or not running' });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/executions/:id/logs - Get execution logs
router.get('/executions/:id/logs', async (req: Request, res: Response) => {
  try {
    const execution = await prisma.jobExecution.findUnique({
      where: { id: req.params.id },
      select: { output: true, errorMessage: true, logs: true },
    });

    if (!execution) {
      return res.status(404).json({ success: false, error: 'Execution not found' });
    }

    res.json({ success: true, data: execution });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------------------------------ SSH helpers for log tail

interface _SSHCreds { username: string; password: string; totpSecret: string; }

function _loadSSHCreds(): _SSHCreds {
  if (config.ssh.username && config.ssh.password) {
    return { username: config.ssh.username, password: config.ssh.password, totpSecret: config.ssh.totpSecret || '' };
  }
  // Walk up from __dirname and cwd to find the credentials file
  const findUp = (startDir: string): string | null => {
    let dir = startDir;
    while (true) {
      const c = path.join(dir, '.saved_credentials.json');
      if (fs.existsSync(c)) return c;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  const credPaths = [
    config.ssh.credentialsFile,
    findUp(__dirname),
    findUp(process.cwd()),
  ].filter(Boolean) as string[];
  for (const p of credPaths) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const mode = (raw.credential_mode || 'service').toLowerCase();
      if (mode === 'personal' && raw.personal_username) {
        return {
          username: raw.personal_username,
          password: raw.personal_password ? Buffer.from(raw.personal_password, 'base64').toString() : '',
          totpSecret: raw.personal_totp_secret ? Buffer.from(raw.personal_totp_secret, 'base64').toString() : '',
        };
      }
      return {
        username: raw.username || '',
        password: raw.password ? Buffer.from(raw.password, 'base64').toString() : '',
        totpSecret: raw.totp_secret ? Buffer.from(raw.totp_secret, 'base64').toString() : '',
      };
    } catch { /* skip */ }
  }
  throw new Error('No SSH credentials configured');
}

function _sshConnect(hostname: string, creds: _SSHCreds): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    const ms = config.ssh.timeout || 15000;
    const timer = setTimeout(() => { conn.end(); reject(new Error(`SSH timeout: ${hostname}`)); }, ms);
    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      const responses = prompts.map((pr: any) => {
        const p = pr.prompt.toLowerCase();
        if (p.includes('second') || p.includes('token') || p.includes('factor')) {
          return creds.totpSecret ? generateSync({ secret: creds.totpSecret }) : '';
        }
        return creds.password;
      });
      finish(responses);
    });
    const opts: any = { host: hostname, port: config.ssh.port || 22, username: creds.username, tryKeyboard: true, readyTimeout: ms };
    if (!creds.totpSecret) {
      opts.password = creds.password;
      opts.authHandler = ['password', 'keyboard-interactive'];
    }
    conn.connect(opts);
  });
}

function _sshExec(conn: SSH2Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d: Buffer) => { out += d.toString(); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => resolve(out));
    });
  });
}

// GET /api/jobs/:id/log-tail — fetch last N lines of the job's remote log via SSH
router.get('/:id/log-tail', async (req: Request, res: Response) => {
  try {
    const lines = Math.min(Math.max(parseInt(req.query.lines as string) || 10, 1), 100);
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, name: true, logPath: true,
        client: { select: { clientId: true, appServers: { where: { environment: 'Prod', isActive: true }, select: { dns: true }, take: 1 } } },
      },
    });
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!job.logPath) return res.status(400).json({ success: false, error: 'No log path configured for this job' });
    if (!job.client?.appServers?.length) return res.status(400).json({ success: false, error: 'No active Prod app server found for this client' });

    const hostname = job.client.appServers[0].dns;
    const creds = _loadSSHCreds();
    const conn = await _sshConnect(hostname, creds);
    let output = '';
    try {
      output = await _sshExec(conn, `tail -n ${lines} "${job.logPath}" 2>&1`);
    } finally {
      conn.end();
    }
    const logLines = output.split('\n');
    res.json({
      success: true,
      data: { lines: logLines, logPath: job.logPath, hostname, fetchedAt: new Date().toISOString() },
    });
  } catch (error: any) {
    logger.error(`Log tail error for job ${req.params.id}: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
