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
import { alertService } from './alert-service';

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

// Per-client outcome persisted on the rule (results JSON) and returned by the
// test endpoint so the UI can show a breakdown across all selected clients.
export interface CustomAlertClientResult {
  clientId: string;
  clientName: string;
  status: 'OK' | 'TRIGGERED' | 'ERROR';
  value: string | null;
  triggered: boolean;
  error: string | null;
  executionMs: number;
  checkedAt: string;         // ISO timestamp of this client's check
}

export interface RuleClient {
  clientId: string;
  clientName: string;
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
   * Resolve the list of clients a rule targets. clientIds/clientNames (JSON
   * arrays) are the source of truth; falls back to the legacy single
   * clientId/clientName for older rows.
   */
  getRuleClients(rule: { clientId: string | null; clientName: string; clientIds: string; clientNames: string }): RuleClient[] {
    let ids: unknown = [];
    let names: unknown = [];
    try { ids = JSON.parse(rule.clientIds || '[]'); } catch { ids = []; }
    try { names = JSON.parse(rule.clientNames || '[]'); } catch { names = []; }

    const idArr = Array.isArray(ids) ? ids.map(v => String(v)) : [];
    const nameArr = Array.isArray(names) ? names.map(v => String(v)) : [];

    if (idArr.length === 0) {
      if (rule.clientId) return [{ clientId: rule.clientId, clientName: rule.clientName || '' }];
      return [];
    }

    return idArr.map((cid, i) => ({ clientId: cid, clientName: nameArr[i] ?? '' }));
  }

  /**
   * Evaluate a draft rule against multiple clients (no persistence). Used by
   * the "test" endpoint. Runs with bounded concurrency.
   */
  async evaluateMany(params: {
    clients: RuleClient[];
    sqlQuery: string;
    columnName: string;
    operator: CustomAlertOperator;
    thresholdValue: string;
  }): Promise<CustomAlertClientResult[]> {
    const { clients, sqlQuery, columnName, operator, thresholdValue } = params;
    const results: CustomAlertClientResult[] = new Array(clients.length);

    let idx = 0;
    const worker = async () => {
      while (idx < clients.length) {
        const myIdx = idx++;
        const client = clients[myIdx];
        const evaluation = await this.evaluate({
          clientId: client.clientId, sqlQuery, columnName, operator, thresholdValue,
        });
        results[myIdx] = {
          clientId: client.clientId,
          clientName: client.clientName,
          status: evaluation.error ? 'ERROR' : evaluation.triggered ? 'TRIGGERED' : 'OK',
          value: evaluation.value,
          triggered: evaluation.triggered,
          error: evaluation.error,
          executionMs: evaluation.executionMs,
          checkedAt: new Date().toISOString(),
        };
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SWEEP_CONCURRENCY, Math.max(clients.length, 1)) }, () => worker()),
    );

    return results;
  }

  /**
   * Evaluate a single stored rule by id (across all its clients) and persist
   * the per-client results plus an aggregate status.
   */
  async runCheck(id: string): Promise<{ lastStatus: string; results: CustomAlertClientResult[] } | null> {
    const rule = await prisma.customAlert.findUnique({ where: { id } });
    if (!rule) return null;

    const operator = this.isValidOperator(rule.operator) ? rule.operator : 'GT';
    const clients = this.getRuleClients(rule);
    const now = new Date();
    const prevStatus = rule.lastStatus; // used for edge-triggered email notifications

    if (clients.length === 0) {
      await prisma.customAlert.update({
        where: { id },
        data: { lastStatus: 'ERROR', lastError: 'No clients configured', lastCheckedAt: now, results: '[]' },
      });
      return { lastStatus: 'ERROR', results: [] };
    }

    const results = await this.evaluateMany({
      clients,
      sqlQuery: rule.sqlQuery,
      columnName: rule.columnName,
      operator,
      thresholdValue: rule.thresholdValue,
    });

    // Aggregate: TRIGGERED wins, then ERROR, else OK.
    const anyTriggered = results.some(r => r.status === 'TRIGGERED');
    const anyError = results.some(r => r.status === 'ERROR');
    const lastStatus = anyTriggered ? 'TRIGGERED' : anyError ? 'ERROR' : 'OK';

    const firstError = results.find(r => r.error)?.error ?? null;
    const errorSummary = anyError
      ? `${results.filter(r => r.status === 'ERROR').length}/${results.length} client(s) errored — ${firstError}`
      : null;

    await prisma.customAlert.update({
      where: { id },
      data: {
        lastStatus,
        lastValue: results[0]?.value ?? null,
        lastError: errorSummary,
        lastCheckedAt: now,
        results: JSON.stringify(results),
        ...(anyTriggered ? { lastTriggeredAt: now } : {}),
      },
    });

    const triggeredList = results.filter(r => r.status === 'TRIGGERED').map(r => r.clientId).join(', ');
    logger.info(
      `Custom alert "${rule.name}" [${clients.length} client(s)]: ${rule.columnName} ` +
      `${OPERATOR_SYMBOLS[operator]} ${rule.thresholdValue} → ${lastStatus}` +
      (triggeredList ? ` (triggered: ${triggeredList})` : '') +
      (errorSummary ? ` (${errorSummary})` : ''),
    );

    // Edge-triggered email: notify only when the alert transitions INTO the
    // TRIGGERED state (avoids re-emailing every interval while it stays over).
    if (anyTriggered && prevStatus !== 'TRIGGERED') {
      const emails = this.parseEmails(rule.notifyEmails);
      if (emails.length > 0) {
        await this.sendTriggerEmail(rule, operator, results, emails);
      }
    }

    return { lastStatus, results };
  }

  /** Parse the notifyEmails JSON array; tolerant of bad data. */
  parseEmails(raw: string | null | undefined): string[] {
    try {
      const arr = JSON.parse(raw || '[]');
      return Array.isArray(arr) ? arr.map(v => String(v).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** Compose and send the "threshold crossed" email. Never throws. */
  private async sendTriggerEmail(
    rule: { name: string; columnName: string; thresholdValue: string },
    operator: CustomAlertOperator,
    results: CustomAlertClientResult[],
    emails: string[],
  ): Promise<void> {
    const triggered = results.filter(r => r.status === 'TRIGGERED');
    const symbol = OPERATOR_SYMBOLS[operator];
    const condition = `${rule.columnName} ${symbol} ${rule.thresholdValue}`;
    const subject = `[WFM Watch] Custom Alert triggered: ${rule.name}`;

    const rows = triggered.map(r => `
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#1f2937;">${r.clientId}${r.clientName ? ` — ${r.clientName}` : ''}</td>
        <td style="padding:6px 12px;font-size:13px;color:#b91c1c;font-weight:600;">${r.value ?? 'null'}</td>
      </tr>`).join('');

    const html = `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;">
        <div style="background:#ef4444;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;">
          <div style="font-size:16px;font-weight:700;">⚠️ Custom Alert Triggered</div>
          <div style="font-size:13px;opacity:.9;">${rule.name}</div>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px 18px;">
          <p style="margin:0 0 10px;font-size:14px;color:#374151;">
            The condition <b>${condition}</b> was crossed for the following client(s):
          </p>
          <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:6px;overflow:hidden;">
            <tr style="background:#f3f4f6;">
              <td style="padding:6px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;">Client</td>
              <td style="padding:6px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;">Value</td>
            </tr>
            ${rows}
          </table>
          <p style="margin:12px 0 0;font-size:12px;color:#9ca3af;">Sent by WFM Watch Custom Alerts.</p>
        </div>
      </div>`;

    try {
      const { accepted } = await alertService.sendDirectEmail(emails, subject, html);
      logger.info(`Custom alert "${rule.name}" email sent to ${accepted.join(', ') || emails.join(', ')}`);
    } catch (err: any) {
      logger.warn(`Custom alert "${rule.name}" email NOT sent: ${err?.message || err}`);
    }
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
