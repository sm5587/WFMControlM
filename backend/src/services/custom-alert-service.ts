// ============================================================
// Custom Alert Service
// User-defined SQL threshold watchers.
// Each CustomAlert runs a SELECT against one client's DB2 on its
// own interval, reads a named column from the first result row,
// and compares it against a threshold using the configured operator.
// Results (value + status) are persisted back to the CustomAlert row.
// ============================================================

import { createServiceLogger } from '../utils/logger';
import { db2DirectService } from './db2-direct-service';
import { prisma } from '../database/prisma';

const logger = createServiceLogger('CustomAlert');

export const CUSTOM_ALERT_OPERATORS = ['GT', 'GTE', 'LT', 'LTE', 'EQ'] as const;
export type CustomAlertOperator = (typeof CUSTOM_ALERT_OPERATORS)[number];

export const OPERATOR_SYMBOLS: Record<CustomAlertOperator, string> = {
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  EQ: '=',
};

export interface CustomAlertEvaluation {
  value: string | null;      // Raw column value observed
  triggered: boolean;        // True when the threshold was crossed
  error: string | null;      // Non-null when the check could not complete
  executionMs: number;
}

// Concurrency cap for the scheduled sweep so we never spawn too many
// JVM connector processes at once.
const SWEEP_CONCURRENCY = 3;

class CustomAlertService {
  /**
   * Validate a user-supplied SQL statement. We only allow read-only
   * SELECT / WITH queries and reject anything that could mutate data or
   * stack multiple statements.
   */
  validateQuery(sql: string): { ok: boolean; error?: string } {
    const trimmed = (sql ?? '').trim();
    if (!trimmed) return { ok: false, error: 'SQL query is required' };

    // Strip a single trailing semicolon, then disallow any remaining ones
    // (prevents statement stacking like "SELECT ...; DELETE ...").
    const withoutTrailing = trimmed.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
      return { ok: false, error: 'Only a single SQL statement is allowed (no ";")' };
    }

    const firstWord = withoutTrailing.split(/\s+/)[0]?.toUpperCase() ?? '';
    if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
      return { ok: false, error: 'Only read-only SELECT (or WITH ... SELECT) queries are allowed' };
    }

    const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|GRANT|REVOKE|CALL|EXEC|EXECUTE)\b/i;
    if (forbidden.test(withoutTrailing)) {
      return { ok: false, error: 'Query contains a forbidden keyword. Only SELECT statements are permitted.' };
    }

    return { ok: true };
  }

  isValidOperator(op: string): op is CustomAlertOperator {
    return (CUSTOM_ALERT_OPERATORS as readonly string[]).includes(op);
  }

  /**
   * Compare an observed value against a threshold with the given operator.
   * Numeric comparison is used when both sides parse as numbers; otherwise
   * only equality (EQ) is meaningful and falls back to string comparison.
   */
  compare(value: string | null, operator: CustomAlertOperator, threshold: string): boolean {
    if (value === null || value === undefined) return false;

    const numValue = Number(String(value).trim());
    const numThreshold = Number(String(threshold).trim());
    const bothNumeric = !Number.isNaN(numValue) && !Number.isNaN(numThreshold);

    if (bothNumeric) {
      switch (operator) {
        case 'GT':  return numValue > numThreshold;
        case 'GTE': return numValue >= numThreshold;
        case 'LT':  return numValue < numThreshold;
        case 'LTE': return numValue <= numThreshold;
        case 'EQ':  return numValue === numThreshold;
      }
    }

    // Non-numeric: only equality is well-defined.
    if (operator === 'EQ') {
      return String(value).trim() === String(threshold).trim();
    }

    return false;
  }

  /**
   * Run the SQL for a rule and evaluate the threshold. Does NOT persist —
   * used both by the scheduled sweep and by the "test" endpoint.
   */
  async evaluate(params: {
    clientId: string;
    sqlQuery: string;
    columnName: string;
    operator: CustomAlertOperator;
    thresholdValue: string;
  }): Promise<CustomAlertEvaluation> {
    const startMs = Date.now();
    const { clientId, sqlQuery, columnName, operator, thresholdValue } = params;

    const validation = this.validateQuery(sqlQuery);
    if (!validation.ok) {
      return { value: null, triggered: false, error: validation.error!, executionMs: Date.now() - startMs };
    }

    const sql = sqlQuery.trim().replace(/;\s*$/, '');
    const result = await db2DirectService.queryClient(clientId, sql, 'CustomAlert');

    if (!result.success) {
      return { value: null, triggered: false, error: result.error || 'Query failed', executionMs: Date.now() - startMs };
    }

    const rows = result.rows ?? [];
    if (rows.length === 0) {
      return { value: null, triggered: false, error: 'Query returned no rows', executionMs: Date.now() - startMs };
    }

    const row = rows[0];
    // Case-insensitive column match against the returned keys.
    const wanted = columnName.trim().toUpperCase();
    const matchKey = Object.keys(row).find(k => k.trim().toUpperCase() === wanted);
    if (!matchKey) {
      const available = Object.keys(row).join(', ');
      return {
        value: null,
        triggered: false,
        error: `Column "${columnName}" not found in result. Available columns: ${available}`,
        executionMs: Date.now() - startMs,
      };
    }

    const rawValue = row[matchKey];
    const value = rawValue === null || rawValue === undefined ? null : String(rawValue).trim();
    const triggered = this.compare(value, operator, thresholdValue);

    return { value, triggered, error: null, executionMs: Date.now() - startMs };
  }

  /**
   * Evaluate a single stored rule by id and persist the outcome.
   */
  async runCheck(id: string): Promise<CustomAlertEvaluation | null> {
    const rule = await prisma.customAlert.findUnique({ where: { id } });
    if (!rule) return null;

    const operator = this.isValidOperator(rule.operator) ? rule.operator : 'GT';
    const evaluation = await this.evaluate({
      clientId: rule.clientId,
      sqlQuery: rule.sqlQuery,
      columnName: rule.columnName,
      operator,
      thresholdValue: rule.thresholdValue,
    });

    const now = new Date();
    const lastStatus = evaluation.error ? 'ERROR' : evaluation.triggered ? 'TRIGGERED' : 'OK';

    await prisma.customAlert.update({
      where: { id },
      data: {
        lastStatus,
        lastValue: evaluation.value,
        lastError: evaluation.error,
        lastCheckedAt: now,
        ...(evaluation.triggered ? { lastTriggeredAt: now } : {}),
      },
    });

    if (evaluation.error) {
      logger.warn(`Custom alert "${rule.name}" (${rule.clientId}) check error: ${evaluation.error}`);
    } else {
      logger.info(
        `Custom alert "${rule.name}" (${rule.clientId}): ${rule.columnName}=${evaluation.value} ` +
        `${OPERATOR_SYMBOLS[operator]} ${rule.thresholdValue} → ${lastStatus} (${evaluation.executionMs}ms)`,
      );
    }

    return evaluation;
  }

  /**
   * Scheduled sweep: run every active rule whose interval has elapsed
   * since its last check. Called from the interval tick in index.ts.
   */
  async runDue(): Promise<{ checked: number; skipped: number }> {
    const active = await prisma.customAlert.findMany({ where: { isActive: true } });
    const now = Date.now();

    const due = active.filter(rule => {
      if (!rule.lastCheckedAt) return true;
      const elapsedMin = (now - new Date(rule.lastCheckedAt).getTime()) / 60000;
      return elapsedMin >= rule.intervalMinutes;
    });

    if (due.length === 0) {
      return { checked: 0, skipped: active.length };
    }

    let idx = 0;
    const worker = async () => {
      while (idx < due.length) {
        const rule = due[idx++];
        try {
          await this.runCheck(rule.id);
        } catch (err: any) {
          logger.error(`Custom alert sweep failed for ${rule.id}: ${err?.message || err}`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, () => worker()),
    );

    return { checked: due.length, skipped: active.length - due.length };
  }
}

export const customAlertService = new CustomAlertService();
