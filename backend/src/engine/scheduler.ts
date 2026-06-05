// ============================================================
// Job Scheduler - Cron-based scheduling engine
// ============================================================

import cron from 'node-cron';
import cronParser from 'cron-parser';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../database/prisma';
import { jobExecutor } from './executor';
import { createServiceLogger } from '../utils/logger';
import { config } from '../config';
import { configService } from '../services/config-service';
import { EventEmitter } from 'events';

const logger = createServiceLogger('Scheduler');

interface ScheduledTask {
  jobId: string;
  cronTask: cron.ScheduledTask;
  cronExpression: string;
}

interface PendingCheck {
  jobId: string;
  jobName: string;
  clientId: string;
  expectedRunTime: Date;
  scheduledCheckTime: Date;
  timer: NodeJS.Timeout;
}

export class Scheduler extends EventEmitter {
  private scheduledTasks: Map<string, ScheduledTask> = new Map();
  private isRunning: boolean = false;
  private pendingCheckInterval: NodeJS.Timeout | null = null;
  private upcomingScanInterval: NodeJS.Timeout | null = null;
  private pendingStatusChecks: Map<string, PendingCheck> = new Map();

  constructor() {
    super();
  }

  /**
   * Start the scheduler - load all active jobs and schedule them
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    logger.info(`Starting ${configService.getAppName()} Scheduler...`);
    this.isRunning = true;

    // Load and schedule all active cron jobs
    await this.loadScheduledJobs();

    // Start periodic check for pending/queued jobs
    this.pendingCheckInterval = setInterval(
      () => this.processPendingJobs(),
      config.engine.pollIntervalMs
    );

    // Start upcoming job scanner
    await this.scanUpcomingJobs();
    const upcomingScanMs = configService.getInt('engine.upcomingScanIntervalMins') * 60 * 1000;
    this.upcomingScanInterval = setInterval(
      () => this.scanUpcomingJobs(),
      upcomingScanMs
    );

    logger.info(`Scheduler started with ${this.scheduledTasks.size} scheduled tasks`);
    this.emit('scheduler:started');
  }

  /**
   * Stop the scheduler
   */
  async stop(): Promise<void> {
    logger.info('Stopping scheduler...');
    this.isRunning = false;

    // Stop all cron tasks
    for (const [jobId, task] of this.scheduledTasks) {
      task.cronTask.stop();
      logger.debug(`Stopped cron task for job: ${jobId}`);
    }
    this.scheduledTasks.clear();

    // Stop pending check interval
    if (this.pendingCheckInterval) {
      clearInterval(this.pendingCheckInterval);
      this.pendingCheckInterval = null;
    }

    // Stop upcoming scan interval
    if (this.upcomingScanInterval) {
      clearInterval(this.upcomingScanInterval);
      this.upcomingScanInterval = null;
    }

    // Clear all pending status check timers
    for (const [key, check] of this.pendingStatusChecks) {
      clearTimeout(check.timer);
    }
    this.pendingStatusChecks.clear();

    logger.info('Scheduler stopped');
    this.emit('scheduler:stopped');
  }

  /**
   * Load all active jobs with cron expressions and schedule them
   */
  private async loadScheduledJobs(): Promise<void> {
    const jobs = await prisma.job.findMany({
      where: {
        isActive: true,
        cronExpression: { not: null },
      },
    });

    for (const job of jobs) {
      if (job.cronExpression) {
        this.scheduleJob(job.id, job.name, job.cronExpression, job.timezone);
      }
    }

    logger.info(`Loaded ${jobs.length} scheduled jobs`);
  }

  /**
   * Schedule a single job
   */
  scheduleJob(jobId: string, jobName: string, cronExpression: string, timezone: string = 'UTC'): void {
    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      logger.error(`Invalid cron expression for job "${jobName}": ${cronExpression}`);
      return;
    }

    // Remove existing schedule if any
    this.unscheduleJob(jobId);

    const cronTask = cron.schedule(cronExpression, async () => {
    }, {
      timezone,
      scheduled: true,
    });

    this.scheduledTasks.set(jobId, { jobId, cronTask, cronExpression });

    // Calculate next run time
    try {
      const interval = cronParser.parseExpression(cronExpression, { tz: timezone });
      const nextRun = interval.next().toDate();
      logger.info(`Scheduled job "${jobName}" - next run: ${nextRun.toISOString()}`);
    } catch (err) {
      logger.debug(`Could not parse next run for "${jobName}"`);
    }
  }

  /**
   * Remove a job from the schedule
   */
  unscheduleJob(jobId: string): void {
    const task = this.scheduledTasks.get(jobId);
    if (task) {
      task.cronTask.stop();
      this.scheduledTasks.delete(jobId);
      logger.debug(`Unscheduled job: ${jobId}`);
    }
  }

  /**
   * Trigger a job execution (creates an execution record and enqueues it)
   */
  async triggerJobExecution(jobId: string, triggeredBy: string = 'manual'): Promise<string> {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (!job.isActive) {
      throw new Error(`Job is inactive: ${job.name}`);
    }

    // Check concurrency limits
    const runningCount = await prisma.jobExecution.count({
      where: { jobId, status: 'RUNNING' },
    });

    if (runningCount >= job.maxConcurrency) {
      logger.warn(`Job "${job.name}" at max concurrency (${runningCount}/${job.maxConcurrency}), queueing...`);
    }

    // Create execution record
    const execution = await prisma.jobExecution.create({
      data: {
        id: uuidv4(),
        jobId,
        status: runningCount >= job.maxConcurrency ? 'QUEUED' : 'PENDING',
        scheduledAt: new Date(),
        triggeredBy,
        parameters: job.parameters || null,
        maxAttempts: (() => { try { const rp = typeof job.retryPolicy === 'string' ? JSON.parse(job.retryPolicy) : job.retryPolicy; return rp?.maxRetries ? rp.maxRetries + 1 : 1; } catch { return 1; } })(),
      },
    });

    logger.info(`Created execution ${execution.id} for job "${job.name}" (triggered by: ${triggeredBy})`);
    this.emit('execution:created', { executionId: execution.id, jobId, triggeredBy });

    // If not queued, start execution immediately
    if (execution.status === 'PENDING') {
      // Don't await - let it run asynchronously
      this.startExecution(execution.id, job).catch(err => {
        logger.error(`Failed to start execution ${execution.id}: ${err.message}`);
      });
    }

    return execution.id;
  }

  /**
   * Start executing a job
   */
  private async startExecution(executionId: string, job: any): Promise<void> {
    const retryPolicy = typeof job.retryPolicy === 'string' ? JSON.parse(job.retryPolicy) : job.retryPolicy;

    await jobExecutor.executeWithRetry(
      executionId,
      job.jobType,
      {
        command: job.command || undefined,
        scriptPath: job.scriptPath || undefined,
        httpConfig: typeof job.httpConfig === 'string' ? JSON.parse(job.httpConfig) : job.httpConfig,
        parameters: typeof job.parameters === 'string' ? JSON.parse(job.parameters) : job.parameters,
        environment: typeof job.environment === 'string' ? JSON.parse(job.environment) : job.environment,
        timeout: job.timeout,
      },
      retryPolicy
    );
  }

  /**
   * Process pending/queued jobs (called periodically)
   */
  private async processPendingJobs(): Promise<void> {
    // Job execution is disabled — this method intentionally does nothing.
  }

  /**
   * Scan all active jobs and find those scheduled to run in the next 60 minutes.
   * For each upcoming job, schedule a delayed status check 30 minutes after
   * the expected run time (giving the job time to complete).
   */
  private async scanUpcomingJobs(): Promise<void> {
    try {
      const jobs = await prisma.job.findMany({
        where: {
          isActive: true,
          deleteStatus: null,
          cronExpression: { not: null },
          logCheckEnabled: true,
          logPath: { not: null },
        },
        include: {
          client: { select: { id: true, clientId: true } },
        },
      });

      const now = Date.now();
      const upcomingScanMins = configService.getInt('engine.upcomingScanIntervalMins');
      const windowEnd = now + upcomingScanMins * 60 * 1000;
      const checkDelayMs = configService.getInt('engine.postRunCheckDelayMins') * 60 * 1000;
      let scheduled = 0;

      for (const job of jobs) {
        if (!job.cronExpression || !job.clientId) continue;

        try {
          const tz = job.serverTimezone || job.timezone || 'UTC';
          const interval = cronParser.parseExpression(job.cronExpression, {
            tz,
            currentDate: new Date(),
          });
          const nextRun = interval.next().toDate();

          // Is this job running in the next 60 minutes?
          if (nextRun.getTime() > now && nextRun.getTime() <= windowEnd) {
            const checkKey = `${job.id}:${nextRun.getTime()}`;

            // Don't double-schedule
            if (this.pendingStatusChecks.has(checkKey)) continue;

            const checkTime = new Date(nextRun.getTime() + checkDelayMs);
            const delayMs = checkTime.getTime() - now;

            const timer = setTimeout(() => {
              this.executeStatusCheck(checkKey, [job.id], job.name);
            }, delayMs);

            this.pendingStatusChecks.set(checkKey, {
              jobId: job.id,
              jobName: job.name,
              clientId: job.clientId,
              expectedRunTime: nextRun,
              scheduledCheckTime: checkTime,
              timer,
            });

            scheduled++;
            logger.debug(`[AutoCheck] Queued: "${job.name}" runs at ${nextRun.toISOString()}, check at ${checkTime.toISOString()}`);
          }
        } catch (err: any) {
          // Skip jobs with unparseable cron
        }
      }

      // Clean up old entries that have already fired
      for (const [key, check] of this.pendingStatusChecks) {
        if (check.scheduledCheckTime.getTime() < now - 5 * 60 * 1000) {
          this.pendingStatusChecks.delete(key);
        }
      }

      if (scheduled > 0) {
        logger.info(`[AutoCheck] Scan complete: ${scheduled} new job(s) queued for status check. Total pending: ${this.pendingStatusChecks.size}`);
      } else {
        logger.info(`[AutoCheck] Scan complete: No upcoming jobs in next hour. Pending checks: ${this.pendingStatusChecks.size}`);
      }

      this.emit('autocheck:scanned', { scheduled, totalPending: this.pendingStatusChecks.size });
    } catch (err: any) {
      logger.error(`[AutoCheck] Scan failed: ${err.message}`);
    }
  }

  /**
   * Execute a status check for specific jobs by calling syncService.checkSpecificJobs
   */
  private async executeStatusCheck(checkKey: string, jobIds: string[], label: string): Promise<void> {
    try {
      logger.info(`[AutoCheck] Checking status for: ${label} (${jobIds.length} job(s))`);
      const { syncService } = require('../services/sync-service');
      const results = await syncService.checkSpecificJobs(jobIds);

      for (const result of results) {
        const emoji = result.status === 'SUCCESS' ? '✓' : result.status === 'FAILED' ? '✗' : '?';
        logger.info(`[AutoCheck] ${emoji} ${result.jobName}: ${result.status} — ${result.summary}`);
      }

      this.emit('autocheck:completed', { checkKey, results });
    } catch (err: any) {
      logger.error(`[AutoCheck] Check failed for ${label}: ${err.message}`);
    } finally {
      this.pendingStatusChecks.delete(checkKey);
    }
  }

  /**
   * Get the list of upcoming checks (for API/monitoring)
   */
  getUpcomingChecks() {
    const checks: Array<{
      jobId: string;
      jobName: string;
      clientId: string;
      expectedRunTime: string;
      scheduledCheckTime: string;
      minutesUntilCheck: number;
    }> = [];

    const now = Date.now();
    for (const [, check] of this.pendingStatusChecks) {
      checks.push({
        jobId: check.jobId,
        jobName: check.jobName,
        clientId: check.clientId,
        expectedRunTime: check.expectedRunTime.toISOString(),
        scheduledCheckTime: check.scheduledCheckTime.toISOString(),
        minutesUntilCheck: Math.round((check.scheduledCheckTime.getTime() - now) / 60000),
      });
    }

    return checks.sort((a, b) => a.minutesUntilCheck - b.minutesUntilCheck);
  }

  /**
   * Get next run time for a cron expression
   */
  getNextRunTime(cronExpression: string, timezone: string = 'UTC'): Date | null {
    try {
      const interval = cronParser.parseExpression(cronExpression, { tz: timezone });
      return interval.next().toDate();
    } catch {
      return null;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      scheduledTaskCount: this.scheduledTasks.size,
      runningExecutions: jobExecutor.getRunningCount(),
      pendingStatusChecks: this.pendingStatusChecks.size,
      upcomingChecks: this.getUpcomingChecks(),
      tasks: Array.from(this.scheduledTasks.entries()).map(([id, task]) => ({
        id,
        cronExpression: task.cronExpression,
        nextRun: this.getNextRunTime(task.cronExpression),
      })),
    };
  }
}

// Singleton instance
export const scheduler = new Scheduler();
