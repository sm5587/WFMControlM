import { PrismaClient } from '@prisma/client';
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
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error('Failed to connect to database', { error });
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
