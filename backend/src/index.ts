// ============================================================
// WFM Control-M - Main Server Entry Point
// ============================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { config, applyDbConfig } from './config';
import { connectDatabase, disconnectDatabase } from './database/prisma';
import { configService } from './services/config-service';
import { scheduler } from './engine/scheduler';
import { alertService } from './services/alert-service';
import { db2DirectService } from './services/db2-direct-service';
import { keeperService } from './services/keeper-service';
import { purgeService } from './services/purge-service';
import { syncService } from './services/sync-service';
import { clientWfmVersionService } from './services/client-wfm-version-service';
import cron from 'node-cron';
import { initializeWebSocket } from './websocket';
import { errorHandler, requestLogger, authMiddleware, requireAdmin, csrfMiddleware } from './middleware';
import { createServiceLogger } from './utils/logger';
import { APP_FUNCTIONS } from './constants/functions';
import { prisma } from './database/prisma';
import { hasPreviousEncryptionKey } from './utils/crypto';
import { isLdapDevMockEnabled } from './utils/ldap-dev-mock';
import { buildStartupBanner } from './utils/startup-banner';
import { getAppVersion } from './utils/app-version';

// Import routes
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import jobsRouter from './routes/jobs';
import monitoringRouter from './routes/monitoring';
import alertsRouter from './routes/alerts';
import clientsRouter from './routes/clients';
import dbMonitorRouter from './routes/db-monitor';
import payrollRouter from './routes/payroll';
import wipRouter from './routes/wip';
import unprocessedPunchRouter from './routes/unprocessed-punch';
import escalationsRouter from './routes/escalations';
import dbJobsRouter from './routes/db-jobs';
import maintenanceRouter from './routes/maintenance';
import outageRouter from './routes/outage';
import fileMonitorRouter from './routes/file-monitor';
import configRouter from './routes/config';
import customAlertsRouter from './routes/custom-alerts';
import emailPreviewRouter from './routes/email-preview';
import { customAlertService } from './services/custom-alert-service';

const logger = createServiceLogger('Server');

function validateCriticalConfig(): void {
  const missing: string[] = [];

  if (!config.jwtSecret) missing.push('secrets.jwtSecret');
  if (!config.jwtExpiresIn) missing.push('secrets.jwtExpiresIn');
  if (!configService.getString('infra.corsOrigins')) missing.push('infra.corsOrigins');
  if (!configService.getString('infra.bodySizeLimit')) missing.push('infra.bodySizeLimit');
  if (!configService.getString('engine.purgeSchedule')) missing.push('engine.purgeSchedule');

  if (missing.length > 0) {
    throw new Error(`Missing critical AppConfig values: ${missing.join(', ')}`);
  }
}

async function bootstrap() {
  const app = express();
  const httpServer = createServer(app);
  let dbMonitorBatchSyncInterval: NodeJS.Timeout | null = null;
  let customAlertSweepInterval: NodeJS.Timeout | null = null;

  // ---- Connect Database ----
  await connectDatabase();

  // ---- Load AppConfig from DB and apply to config object ----
  await configService.load();
  applyDbConfig();
  alertService.reloadTransporter();
  validateCriticalConfig();
  logger.info('AppConfig loaded from database');

  if (isLdapDevMockEnabled()) {
    logger.warn(
      'LDAP DEV MOCK is active — all login attempts are treated as successful AD authentication. ' +
      'Disable LDAP_DEV_MOCK or infra.ldapDevMock before production.',
    );
  }

  if (hasPreviousEncryptionKey()) {
    logger.warn(
      'CONFIG_ENCRYPTION_KEY_PREVIOUS is set — encryption key rotation in progress. ' +
      'Run Re-encrypt secrets from Admin → Config, then remove the previous key and restart.'
    );
  }

  const trustProxy = configService.getBool('infra.trustProxy');
  const requireHttps = configService.getBool('infra.requireHttps');
  if (trustProxy) {
    app.set('trust proxy', 1);
    logger.info('Express trust proxy enabled (X-Forwarded-* from reverse proxy)');
  }
  if (requireHttps) {
    logger.info('HTTPS enforcement enabled — HTTP requests will redirect to HTTPS');
  }

  // ---- Middleware ----
  app.use(helmet(requireHttps ? {
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  } : undefined));
  if (requireHttps) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      const proto = req.headers['x-forwarded-proto'];
      if (req.secure || proto === 'https') return next();
      const host = req.headers.host;
      if (!host) return res.status(400).send('HTTPS required');
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    });
  }
  app.use(cors({
    origin: (origin, callback) => {
      const origins = configService.getString('infra.corsOrigins')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  }));
  app.use(express.json({ limit: configService.getString('infra.bodySizeLimit') }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan('short'));
  app.use(requestLogger);

  // ---- Health check (no auth required) ----
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: configService.getAppName(),
      deployment: config.deploymentLabel,
      version: getAppVersion(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Dev-only: live notify email previews (no auth)
  app.use('/dev', emailPreviewRouter);

  // ---- API Routes ----
  const apiRouter = express.Router();

  // CSRF protection for cookie-authenticated state-changing requests
  apiRouter.use(csrfMiddleware);

  // Public: login (no auth needed)
  apiRouter.use('/auth', authRouter);

  // Public: which instance this is (local dev vs Docker) — used on login page before auth
  apiRouter.get('/deployment-info', (_req, res) => {
    res.json({
      success: true,
      data: {
        label: config.deploymentLabel,
        port: config.port,
        version: getAppVersion(),
        displayFlags: configService.getDisplayMenuFlags(),
      },
    });
  });

  // All other API routes require a valid token
  apiRouter.use(authMiddleware);

  // Read-only routes — accessible by both admin and monitor
  apiRouter.use('/jobs', jobsRouter);
  apiRouter.use('/monitoring', monitoringRouter);
  apiRouter.use('/alerts', alertsRouter);
  apiRouter.use('/clients', clientsRouter);
  apiRouter.use('/db-monitor', dbMonitorRouter);
  apiRouter.use('/payroll', payrollRouter);
  apiRouter.use('/wip', wipRouter);
  apiRouter.use('/unprocessed-punch', unprocessedPunchRouter);
  apiRouter.use('/escalations', escalationsRouter);
  apiRouter.use('/db-jobs', dbJobsRouter);
  apiRouter.use('/maintenance', maintenanceRouter);
  apiRouter.use('/outage', outageRouter);
  apiRouter.use('/file-monitor', fileMonitorRouter);
  apiRouter.use('/admin', adminRouter);
  apiRouter.use('/config', configRouter);
  apiRouter.use('/custom-alerts', customAlertsRouter);

  app.use('/api', apiRouter);

  // ---- Error handling ----
  app.use(errorHandler);

  // ---- Initialize WebSocket ----
  const io = initializeWebSocket(httpServer);

  // ---- Sync AppFunction registry (upserts any new functions added in code) ----
  for (const fn of Object.values(APP_FUNCTIONS)) {
    await prisma.appFunction.upsert({
      where: { id: fn.id },
      update: { module: fn.module, name: fn.name, description: fn.description ?? null, sortOrder: fn.sortOrder },
      create: { id: fn.id, module: fn.module, name: fn.name, description: fn.description ?? null, sortOrder: fn.sortOrder },
    });
  }
  logger.info(`AppFunction registry synced (${Object.keys(APP_FUNCTIONS).length} functions)`);

  // ---- Ensure System Admin profiles have full access to every function ----
  // New features add AppFunctions after the initial seed; without this, an
  // existing (non-reseeded) database would leave System Admin unable to see
  // new menus. Only *missing* permission rows are created (never downgraded).
  try {
    const adminProfiles = await prisma.profile.findMany({
      where: { isSystem: true, name: 'System Admin' },
      select: { id: true },
    });
    if (adminProfiles.length > 0) {
      const allFunctionIds = Object.keys(APP_FUNCTIONS);
      let granted = 0;
      for (const profile of adminProfiles) {
        const existing = await prisma.permission.findMany({
          where: { profileId: profile.id },
          select: { functionId: true },
        });
        const existingIds = new Set(existing.map(p => p.functionId));
        const missing = allFunctionIds.filter(id => !existingIds.has(id));
        for (const functionId of missing) {
          await prisma.permission.create({
            data: { profileId: profile.id, functionId, canRead: true, canWrite: true },
          });
          granted++;
        }
      }
      if (granted > 0) {
        logger.info(`Granted ${granted} missing System Admin permission(s) for new functions`);
      }
    }
  } catch (err: any) {
    logger.warn(`System Admin permission backfill skipped: ${err.message}`);
  }

  // ---- Grant Heat Map read to system (+ Payroll Monitor) profiles if missing ----
  const { ensureHeatMapPermissions } = await import('./services/rbac-bootstrap');
  await ensureHeatMapPermissions();

  // ---- Initialize Keeper Secrets Manager (non-fatal) ----
  await keeperService.initialize();

  const { tokenRevocationService } = await import('./services/token-revocation-service');
  try {
    await tokenRevocationService.purgeExpired();
  } catch (err: any) {
    logger.warn(`Revoked-token purge skipped: ${err.message}`);
  }

  // ---- Wire up cross-service events ----
  const { jobExecutor } = require('./engine/executor');

  jobExecutor.on('execution:failed', async ({ executionId, result }: any) => {
    try {
      // Trigger alert
      const execution = await require('./database/prisma').prisma.jobExecution.findUnique({
        where: { id: executionId },
        include: { job: true },
      });
      
      if (execution) {
        const critThreshold = configService.getInt('threshold.jobPriorityCritical');
        await alertService.processAlert({
          triggerType: 'JOB_FAILED',
          severity: execution.job.priority >= critThreshold ? 'CRITICAL' : 'WARNING',
          title: `Job Failed: ${execution.job.name}`,
          message: `Job "${execution.job.name}" failed with exit code ${result?.exitCode || 'unknown'}.\n\nError: ${result?.errorMessage || 'Unknown error'}`,
          metadata: {
            jobId: execution.jobId,
            jobName: execution.job.name,
            executionId,
            exitCode: result?.exitCode,
            duration: result?.duration,
          },
          executionId,
        });
      }
    } catch (error: any) {
      logger.error(`Failed to process failure alert: ${error.message}`);
    }
  });

  // ---- Start Engine Services ----
  await scheduler.start();

  // ---- Nightly data purge ----
  const purgeSchedule = configService.getString('engine.purgeSchedule');
  cron.schedule(purgeSchedule, async () => {
    logger.info('Running scheduled nightly purge...');
    try {
      await purgeService.runAll();
    } catch (err: any) {
      logger.error(`Nightly purge failed: ${err.message}`);
    }
  });

  // ---- Daily automatic cron discovery sync ----
  const cronSyncSchedule = configService.getString('engine.cronSyncSchedule', '0 3 * * *');
  if (cron.validate(cronSyncSchedule)) {
    cron.schedule(cronSyncSchedule, async () => {
      if (!configService.isSyncEnabled()) {
        logger.info('[CronSyncSchedule] Skipped — SSH sync disabled (engine.syncEnabled=false)');
        return;
      }
      logger.info('[CronSyncSchedule] Starting scheduled daily cron sync for all active clients...');
      try {
        const result = await syncService.syncAllCrons(true);
        logger.info(
          `[CronSyncSchedule] Complete: ${result.succeeded} synced, ${result.skipped} skipped, ${result.failed} failed (${result.total} clients)`,
        );
      } catch (err: any) {
        logger.error(`[CronSyncSchedule] Failed: ${err.message}`);
      }
    });
    logger.info(`Daily cron sync scheduled: ${cronSyncSchedule}`);
  } else {
    logger.warn(`Invalid engine.cronSyncSchedule "${cronSyncSchedule}" — daily cron sync not scheduled`);
  }

  // ---- Daily WFM app version refresh (RFX_CONFIG APPURL + reflexisversion.txt) ----
  const wfmVersionSyncSchedule = configService.getString('engine.wfmVersionSyncSchedule', '0 4 * * *');
  if (cron.validate(wfmVersionSyncSchedule)) {
    cron.schedule(wfmVersionSyncSchedule, async () => {
      logger.info('[WfmVersionSync] Starting scheduled daily WFM version sync...');
      try {
        const result = await clientWfmVersionService.syncAll({ force: true, refreshAppUrl: false });
        logger.info(
          `[WfmVersionSync] Complete: ${result.succeeded} ok, ${result.failed} failed, ` +
          `${result.skipped} skipped, ${result.appUrlRefreshed} APPURL lookups (${result.total} clients)`,
        );
      } catch (err: any) {
        logger.error(`[WfmVersionSync] Failed: ${err.message}`);
      }
    });
    logger.info(`Daily WFM version sync scheduled: ${wfmVersionSyncSchedule}`);
  } else {
    logger.warn(`Invalid engine.wfmVersionSyncSchedule "${wfmVersionSyncSchedule}" — WFM version sync not scheduled`);
  }

  // ---- Backend warm sync for DB Monitor batch data ----
  const dbMonitorBatchDays = configService.getInt('engine.dbMonitorBatchDays');
  const dbMonitorSyncMs = configService.getInt('polling.dbMonitorSyncMins') * 60 * 1000;
  const runDbMonitorBatchSync = async () => {
    try {
      await db2DirectService.getAllBatchStatusSummary(dbMonitorBatchDays, { forceRefresh: true });
      logger.info('[DBMonitorSync] Refreshed all-client batch summary (2-day window)');
    } catch (err: any) {
      logger.error(`[DBMonitorSync] Refresh failed: ${err?.message || String(err)}`);
    }
  };

  // Prime once at startup, then keep refreshing on interval.
  runDbMonitorBatchSync();
  dbMonitorBatchSyncInterval = setInterval(runDbMonitorBatchSync, dbMonitorSyncMs);

  // ---- Custom Alerts sweep ----
  // Tick every minute; each rule is re-evaluated only when its own
  // configured interval (minutes) has elapsed since its last check.
  const CUSTOM_ALERT_TICK_MS = 60 * 1000;
  const runCustomAlertSweep = async () => {
    try {
      const { checked } = await customAlertService.runDue();
      if (checked > 0) {
        logger.info(`[CustomAlertSweep] Evaluated ${checked} due custom alert(s)`);
      }
    } catch (err: any) {
      logger.error(`[CustomAlertSweep] Sweep failed: ${err?.message || String(err)}`);
    }
  };
  runCustomAlertSweep();
  customAlertSweepInterval = setInterval(runCustomAlertSweep, CUSTOM_ALERT_TICK_MS);

  // ---- Start HTTP Server ----
  httpServer.listen(config.port, () => {
    logger.info(buildStartupBanner({
      appName: configService.getAppName(),
      port: config.port,
      nodeEnv: config.nodeEnv,
      deploymentLabel: config.deploymentLabel,
      publicApiUrl: config.publicApiUrl,
    }));
    logger.info(`SMTP: host=${config.smtp.host || 'NOT SET'}, port=${config.smtp.port}, user=${config.smtp.user || 'none (relay mode)'}`);
    logger.info(`Logs: ${config.logDir}`);
  });

  // ---- Graceful shutdown ----
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    if (dbMonitorBatchSyncInterval) {
      clearInterval(dbMonitorBatchSyncInterval);
      dbMonitorBatchSyncInterval = null;
    }

    if (customAlertSweepInterval) {
      clearInterval(customAlertSweepInterval);
      customAlertSweepInterval = null;
    }
    
    await scheduler.stop();
    await db2DirectService.shutdown();
    await disconnectDatabase();
    
    httpServer.close(() => {
      logger.info('Server shut down gracefully');
      process.exit(0);
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  });
  process.on('unhandledRejection', (reason: any) => {
    logger.error(`Unhandled rejection: ${reason?.message || reason}`);
  });
}

bootstrap().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
