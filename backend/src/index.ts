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
import { db2Pool } from './services/db2-connection-pool';
import { db2DirectService } from './services/db2-direct-service';
import { keeperService } from './services/keeper-service';
import { purgeService } from './services/purge-service';
import cron from 'node-cron';
import { initializeWebSocket } from './websocket';
import { errorHandler, requestLogger, authMiddleware, requireAdmin } from './middleware';
import { createServiceLogger } from './utils/logger';
import { APP_FUNCTIONS } from './constants/functions';
import { prisma } from './database/prisma';

// Import routes
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import jobsRouter from './routes/jobs';
import monitoringRouter from './routes/monitoring';
import alertsRouter from './routes/alerts';
import clientsRouter from './routes/clients';
import dbMonitorRouter from './routes/db-monitor';
import payrollRouter from './routes/payroll';
import unprocessedPunchRouter from './routes/unprocessed-punch';
import escalationsRouter from './routes/escalations';
import dbJobsRouter from './routes/db-jobs';
import maintenanceRouter from './routes/maintenance';
import configRouter from './routes/config';

const logger = createServiceLogger('Server');

async function bootstrap() {
  const app = express();
  const httpServer = createServer(app);
  let dbMonitorBatchSyncInterval: NodeJS.Timeout | null = null;

  // ---- Middleware ----
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => {
      const origins = configService.getString('infra.corsOrigins', 'http://localhost:3000,http://localhost:5173')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }));
  app.use(express.json({ limit: configService.getString('infra.bodySizeLimit', '10mb') }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan('short'));
  app.use(requestLogger);

  // ---- Health check (no auth required) ----
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'WFM Control-M',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ---- API Routes ----
  const apiRouter = express.Router();

  // Public: login (no auth needed)
  apiRouter.use('/auth', authRouter);

  // All other API routes require a valid token
  apiRouter.use(authMiddleware);

  // Read-only routes — accessible by both admin and monitor
  apiRouter.use('/jobs', jobsRouter);
  apiRouter.use('/monitoring', monitoringRouter);
  apiRouter.use('/alerts', alertsRouter);
  apiRouter.use('/clients', clientsRouter);
  apiRouter.use('/db-monitor', dbMonitorRouter);
  apiRouter.use('/payroll', payrollRouter);
  apiRouter.use('/unprocessed-punch', unprocessedPunchRouter);
  apiRouter.use('/escalations', escalationsRouter);
  apiRouter.use('/db-jobs', dbJobsRouter);
  apiRouter.use('/maintenance', maintenanceRouter);
  apiRouter.use('/admin', adminRouter);
  apiRouter.use('/config', configRouter);

  app.use('/api', apiRouter);

  // ---- Error handling ----
  app.use(errorHandler);

  // ---- Initialize WebSocket ----
  const io = initializeWebSocket(httpServer);

  // ---- Connect Database ----
  await connectDatabase();

  // ---- Load AppConfig from DB and apply to config object ----
  await configService.load();
  applyDbConfig();
  logger.info('AppConfig loaded from database');

  // ---- Sync AppFunction registry (upserts any new functions added in code) ----
  for (const fn of Object.values(APP_FUNCTIONS)) {
    await prisma.appFunction.upsert({
      where: { id: fn.id },
      update: { module: fn.module, name: fn.name, sortOrder: fn.sortOrder },
      create: { id: fn.id, module: fn.module, name: fn.name, description: fn.description ?? null, sortOrder: fn.sortOrder },
    });
  }
  logger.info(`AppFunction registry synced (${Object.keys(APP_FUNCTIONS).length} functions)`);

  // ---- Initialize Keeper Secrets Manager (non-fatal) ----
  await keeperService.initialize();

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
        const critThreshold = configService.getInt('threshold.jobPriorityCritical', 8);
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
  const purgeSchedule = configService.getString('engine.purgeSchedule', '0 2 * * *');
  cron.schedule(purgeSchedule, async () => {
    logger.info('Running scheduled nightly purge...');
    try {
      await purgeService.runAll();
    } catch (err: any) {
      logger.error(`Nightly purge failed: ${err.message}`);
    }
  });

  // ---- Backend warm sync for DB Monitor batch data ----
  const dbMonitorBatchDays = configService.getInt('engine.dbMonitorBatchDays', 2);
  const dbMonitorSyncMs = configService.getInt('polling.dbMonitorSyncMins', 30) * 60 * 1000;
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

  // ---- Start HTTP Server ----
  httpServer.listen(config.port, () => {
    logger.info(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   🚀 WFM Control-M Server                           ║
║                                                      ║
║   HTTP:      http://localhost:${config.port}                ║
║   WebSocket: ws://localhost:${config.port}                  ║
║   Env:       ${config.nodeEnv.padEnd(38)}║
║                                                      ║
║   API:       http://localhost:${config.port}/api             ║
║   Health:    http://localhost:${config.port}/health           ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
    `);
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
    
    await scheduler.stop();
    await db2DirectService.shutdown();
    await db2Pool.shutdown();
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
