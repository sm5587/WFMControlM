import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import path from 'path';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('Database');

export const prisma = new PrismaClient({
  log: config.nodeEnv === 'development'
    ? [{ level: 'query', emit: 'event' }, { level: 'error', emit: 'stdout' }]
    : [{ level: 'error', emit: 'stdout' }],
});

// Log slow queries in development
if (config.nodeEnv === 'development') {
  prisma.$on('query' as any, (e: any) => {
    if (e.duration > 500) {
      logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
    }
  });
}

export async function connectDatabase(): Promise<void> {
  try {
    if (config.nodeEnv === 'development') {
      applyPendingMigrations();
    }
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error('Failed to connect to database', { error });
    throw error;
  }
}

/** Apply SQL migrations so new tables/columns exist before the app uses them. */
function applyPendingMigrations(): void {
  try {
    const backendRoot = path.resolve(__dirname, '../..');
    execSync('npx prisma migrate deploy', {
      cwd: backendRoot,
      stdio: 'pipe',
      env: process.env,
    });
    logger.info('Database migrations up to date');
  } catch (error: any) {
    const msg = error?.stderr?.toString?.() || error?.message || String(error);
    logger.warn(`Migration deploy skipped: ${msg.trim()}`);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
