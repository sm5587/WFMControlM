// ============================================================
// Unprocessed Punch Service
// Queries TA_UNPROC_PUNCH from client DB2 databases
// Returns count of records with PROCESS_FLAG = 'N' for the past 2 days
// ============================================================

import { logger } from '../utils/logger';
import { db2DirectService } from './db2-direct-service';
import { configService } from './config-service';

export interface UnprocessedPunchResult {
  clientId: string;
  punchCount: number;
  lastUpdateTime: string | null;
  dbCurrentTime: string | null;
  executionTimeMs: number;
  queriedAt: string;
  error?: string;
}

class UnprocessedPunchService {

  /**
   * Fetch count of unprocessed punches (PROCESS_FLAG = 'N') for the past 2 days.
   */
  async getPunchCount(clientId: string): Promise<UnprocessedPunchResult> {
    const startMs = Date.now();
    const lookbackDays = configService.getInt('engine.punchLookbackDays');

    // Use integer comparison on PUNCH_DATE (yyyyMMdd format) to avoid to_DATE()
    // conversion errors from corrupt data (e.g. invalid month/day values)
    const sql =
      `SELECT COUNT(1) AS PUNCH_COUNT, MIN(LAST_UPDATE_TIME) AS LAST_UPDATE_TIME, CURRENT TIMESTAMP AS DB_CURRENT_TS ` +
      `FROM RWSUSER.TA_UNPROC_PUNCH ` +
      `WHERE PROCESS_FLAG = 'N' ` +
      `AND INTEGER(PUNCH_DATE) >= INTEGER(VARCHAR_FORMAT(CURRENT DATE - ${lookbackDays} DAYS, 'yyyyMMdd'))`;

    const result = await db2DirectService.queryClient(clientId, sql, 'UnprocessedPunch');

    if (!result.success || !result.rows) {
      throw new Error(result.error || `Failed to query TA_UNPROC_PUNCH for ${clientId}`);
    }

    const row = result.rows[0] ?? {};
    const punchCount = parseInt(String(row.PUNCH_COUNT ?? '0'), 10) || 0;
    const lastUpdateTime = (row.LAST_UPDATE_TIME ?? null) as string | null;
    const dbCurrentTime = (row.DB_CURRENT_TS ?? null) as string | null;

    logger.info(`UnprocessedPunch: ${clientId} → ${punchCount} unprocessed punches (${Date.now() - startMs}ms)`);

    return {
      clientId,
      punchCount,
      lastUpdateTime,
      dbCurrentTime,
      executionTimeMs: Date.now() - startMs,
      queriedAt: new Date().toISOString(),
    };
  }
}

export const unprocessedPunchService = new UnprocessedPunchService();
