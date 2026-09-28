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
import { parseExpression } from 'cron-parser';

const logger = createServiceLogger('CustomAlert');

// All schedule times are interpreted in this timezone (IST). Cron occurrences
// are computed against the real server time converted to this zone.
export const CUSTOM_ALERT_TZ = 'Asia/Kolkata';

// Minimum allowed interval for INTERVAL-mode alerts.
export const CUSTOM_ALERT_MIN_INTERVAL = 15;

export const CUSTOM_ALERT_OPERATORS = ['GT', 'GTE', 'LT', 'LTE', 'EQ'] as const;
export type CustomAlertOperator = (typeof CUSTOM_ALERT_OPERATORS)[number];

// Only aggregate SELECTs are allowed for custom alerts. This guarantees a query
// returns a single number (a count/sum/etc.) rather than any individual row or
// column of personal data. Anything selecting columns or "*" is rejected.
// Add/remove functions here to adjust what's permitted.
export const CUSTOM_ALERT_AGGREGATE_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const;

// Extract the outermost SELECT projection (everything between the leading
// SELECT and its matching top-level FROM), respecting nesting and quotes so
// subqueries/parentheses don't confuse the boundary. Returns null if the text
// does not begin with SELECT.
function extractTopLevelSelectList(sql: string): string | null {
  const upper = sql.toUpperCase();
  if (!upper.startsWith('SELECT')) return null;
  const startIdx = 6; // length of "SELECT"
  let depth = 0;
  let inSingle = false;
  for (let i = startIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && (ch === 'F' || ch === 'f') && upper.startsWith('FROM', i)) {
      const before = sql[i - 1];
      const after = sql[i + 4];
      const beforeOk = before === undefined || /[\s),]/.test(before);
      const afterOk = after === undefined || /[\s(]/.test(after);
      if (beforeOk && afterOk) return sql.slice(startIdx, i);
    }
  }
  return sql.slice(startIdx); // no top-level FROM (e.g. SELECT COUNT(*) FROM SYSIBM.SYSDUMMY1 handled above)
}

// Normalize a validated query for storage: uppercase the whole statement EXCEPT
// anything inside quotes. Unquoted identifiers (tables/columns) and keywords are
// uppercased for a clean, consistent look; single-quoted string values (e.g.
// WHERE STATUS = 'n') and double-quoted identifiers are preserved verbatim so
// case-sensitive data comparisons are never altered.
export function normalizeAggregateQuery(sqlQuery: string | null | undefined): string {
  const s = (sqlQuery ?? '').trim();
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inSingle) {
      out += ch;
      // Two single quotes inside a string is an escaped quote — stay in string.
      if (ch === "'") {
        if (s[i + 1] === "'") { out += s[i + 1]; i++; }
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    out += ch.toUpperCase();
  }
  return out;
}

// Human-readable label for what a query measures, derived from its aggregate
// projection (e.g. "COUNT(*)"). Falls back to "value" when it can't be read.
export function aggregateLabel(sqlQuery: string | null | undefined): string {
  const cleaned = (sqlQuery ?? '').trim().replace(/;\s*$/, '');
  const list = extractTopLevelSelectList(cleaned);
  const label = list?.trim();
  return label || 'value';
}

// True if the projection contains a comma outside of any parentheses/quotes,
// i.e. it selects more than one expression.
function hasTopLevelComma(s: string): boolean {
  let depth = 0;
  let inSingle = false;
  for (const ch of s) {
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

export const CUSTOM_ALERT_SCHEDULE_TYPES = ['INTERVAL', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type CustomAlertScheduleType = (typeof CUSTOM_ALERT_SCHEDULE_TYPES)[number];

// Structured schedule definition for the non-interval frequency modes.
export interface CustomAlertScheduleConfig {
  times: string[];        // "HH:mm" clock times (IST). One or more per day.
  daysOfWeek: number[];   // 0-6 (0=Sunday) — used by WEEKLY
  daysOfMonth: number[];  // 1-31 — used by MONTHLY
}

// Safely parse the stored scheduleConfig JSON into a normalized object.
export function parseScheduleConfig(raw: string | null | undefined): CustomAlertScheduleConfig {
  const empty: CustomAlertScheduleConfig = { times: [], daysOfWeek: [], daysOfMonth: [] };
  try {
    const p = JSON.parse(raw || '{}');
    return {
      times: Array.isArray(p.times) ? p.times.filter((t: any) => typeof t === 'string') : [],
      daysOfWeek: Array.isArray(p.daysOfWeek)
        ? p.daysOfWeek.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6)
        : [],
      daysOfMonth: Array.isArray(p.daysOfMonth)
        ? p.daysOfMonth.map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 31)
        : [],
    };
  } catch {
    return empty;
  }
}

// Convert a frequency type + config into one cron expression per clock time.
// Each expression has a single minute/hour to avoid cron's cartesian product
// of minutes×hours when multiple times are configured.
export function buildCronExpressions(type: string, cfg: CustomAlertScheduleConfig): string[] {
  const crons: string[] = [];
  for (const raw of cfg.times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) continue;
    if (type === 'DAILY') {
      crons.push(`${mm} ${hh} * * *`);
    } else if (type === 'WEEKLY') {
      if (cfg.daysOfWeek.length === 0) continue;
      crons.push(`${mm} ${hh} * * ${[...cfg.daysOfWeek].sort((a, b) => a - b).join(',')}`);
    } else if (type === 'MONTHLY') {
      if (cfg.daysOfMonth.length === 0) continue;
      crons.push(`${mm} ${hh} ${[...cfg.daysOfMonth].sort((a, b) => a - b).join(',')} * *`);
    }
  }
  return crons;
}

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

// Result of the timing "Validate" check for a single client.
export interface CustomAlertValidateClient {
  clientId: string;
  clientName: string;
  status: 'OK' | 'SLOW' | 'ERROR';
  elapsedMs: number;
  error: string | null;
}

export interface CustomAlertValidateResult {
  validated: boolean;              // true only if every client returned within the threshold
  timeoutSec: number;              // the threshold that was applied
  clients: CustomAlertValidateClient[];
}

// Concurrency cap for the scheduled sweep so we never spawn too many
// JVM connector processes at once.
const SWEEP_CONCURRENCY = 3;

class CustomAlertService {
  /**
   * Validate a user-supplied SQL statement. Custom alerts may only run a single
   * read-only, aggregate SELECT that returns exactly one number
   * (COUNT/SUM/AVG/MIN/MAX). Selecting individual columns or "*" is rejected so
   * no personal row data is ever fetched — only an aggregate value.
   * On success, `label` is the aggregate projection (e.g. "COUNT(*)") used for
   * display and to describe the condition.
   */
  validateQuery(sql: string): { ok: boolean; error?: string; label?: string } {
    const trimmed = (sql ?? '').trim();
    if (!trimmed) return { ok: false, error: 'SQL query is required' };

    // Strip a single trailing semicolon, then disallow any remaining ones
    // (prevents statement stacking like "SELECT ...; DELETE ...").
    const withoutTrailing = trimmed.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
      return { ok: false, error: 'Only a single SQL statement is allowed (no ";")' };
    }

    const firstWord = withoutTrailing.split(/\s+/)[0]?.toUpperCase() ?? '';
    if (firstWord !== 'SELECT') {
      return { ok: false, error: 'Query must be a single aggregate SELECT, e.g. SELECT COUNT(*) FROM ...' };
    }

    const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|GRANT|REVOKE|CALL|EXEC|EXECUTE)\b/i;
    if (forbidden.test(withoutTrailing)) {
      return { ok: false, error: 'Query contains a forbidden keyword. Only SELECT statements are permitted.' };
    }

    // Enforce aggregate-only projection: the outermost SELECT must return a
    // single aggregate value. Subqueries inside (e.g. SELECT COUNT(*) FROM (...))
    // are fine because only the aggregate result leaves the database.
    const selectList = extractTopLevelSelectList(withoutTrailing);
    if (selectList === null || !selectList.trim()) {
      return { ok: false, error: 'Could not read the SELECT clause. Use a single aggregate, e.g. SELECT COUNT(*) FROM ...' };
    }
    const projection = selectList.trim();
    if (hasTopLevelComma(projection)) {
      return { ok: false, error: 'Only a single aggregate value may be selected (no multiple columns).' };
    }
    const aggRe = new RegExp(`^(${CUSTOM_ALERT_AGGREGATE_FUNCTIONS.join('|')})\\s*\\(`, 'i');
    if (!aggRe.test(projection)) {
      return {
        ok: false,
        error: `Query must select a single aggregate value (${CUSTOM_ALERT_AGGREGATE_FUNCTIONS.join(', ')}). `
          + 'Selecting columns or "*" is not allowed — e.g. SELECT COUNT(*) FROM ...',
      };
    }

    return { ok: true, label: projection };
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
    operator: CustomAlertOperator;
    thresholdValue: string;
  }): Promise<CustomAlertEvaluation> {
    const startMs = Date.now();
    const { clientId, sqlQuery, operator, thresholdValue } = params;

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

    // Aggregate queries return a single column; read the first (only) value.
    const row = rows[0];
    const keys = Object.keys(row);
    if (keys.length === 0) {
      return { value: null, triggered: false, error: 'Query returned no columns', executionMs: Date.now() - startMs };
    }

    const rawValue = row[keys[0]];
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
    operator: CustomAlertOperator;
    thresholdValue: string;
  }): Promise<CustomAlertClientResult[]> {
    const { clients, sqlQuery, operator, thresholdValue } = params;
    const results: CustomAlertClientResult[] = new Array(clients.length);

    let idx = 0;
    const worker = async () => {
      while (idx < clients.length) {
        const myIdx = idx++;
        const client = clients[myIdx];
        const evaluation = await this.evaluate({
          clientId: client.clientId, sqlQuery, operator, thresholdValue,
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
   * Timing validation: run the query against each selected client with a soft
   * timeout (the configured threshold). "validated" is true only when every
   * client returns successfully within the threshold. Does NOT persist.
   * Note: JDBC queries can't always be hard-cancelled, so on timeout we stop
   * waiting and mark the client SLOW (the DB may finish it in the background).
   */
  async validateTiming(params: {
    clients: RuleClient[];
    sqlQuery: string;
    timeoutSec: number;
  }): Promise<CustomAlertValidateResult> {
    const { clients, sqlQuery } = params;
    const timeoutSec = Math.max(1, Math.round(params.timeoutSec || 30));
    const timeoutMs = timeoutSec * 1000;

    const check = this.validateQuery(sqlQuery);
    if (!check.ok) {
      return {
        validated: false,
        timeoutSec,
        clients: clients.map(c => ({
          clientId: c.clientId, clientName: c.clientName, status: 'ERROR', elapsedMs: 0, error: check.error!,
        })),
      };
    }

    const sql = sqlQuery.trim().replace(/;\s*$/, '');
    const out: CustomAlertValidateClient[] = new Array(clients.length);

    let idx = 0;
    const worker = async () => {
      while (idx < clients.length) {
        const myIdx = idx++;
        const c = clients[myIdx];
        const start = Date.now();
        let timer: NodeJS.Timeout | undefined;
        const timeoutP = new Promise<{ __timeout: true }>(resolve => {
          timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
        });
        try {
          const result: any = await Promise.race([
            db2DirectService.queryClient(c.clientId, sql, 'CustomAlertValidate'),
            timeoutP,
          ]);
          if (result && result.__timeout) {
            out[myIdx] = { clientId: c.clientId, clientName: c.clientName, status: 'SLOW', elapsedMs: Date.now() - start, error: null };
          } else if (!result?.success) {
            out[myIdx] = { clientId: c.clientId, clientName: c.clientName, status: 'ERROR', elapsedMs: Date.now() - start, error: result?.error || 'Query failed' };
          } else {
            out[myIdx] = { clientId: c.clientId, clientName: c.clientName, status: 'OK', elapsedMs: Date.now() - start, error: null };
          }
        } catch (err: any) {
          out[myIdx] = { clientId: c.clientId, clientName: c.clientName, status: 'ERROR', elapsedMs: Date.now() - start, error: err?.message || String(err) };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SWEEP_CONCURRENCY, Math.max(clients.length, 1)) }, () => worker()),
    );

    return { validated: out.every(r => r.status === 'OK'), timeoutSec, clients: out };
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
      `Custom alert "${rule.name}" [${clients.length} client(s)]: ${aggregateLabel(rule.sqlQuery)} ` +
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
    rule: { name: string; sqlQuery: string; thresholdValue: string },
    operator: CustomAlertOperator,
    results: CustomAlertClientResult[],
    emails: string[],
  ): Promise<void> {
    const triggered = results.filter(r => r.status === 'TRIGGERED');
    const symbol = OPERATOR_SYMBOLS[operator];
    const condition = `${aggregateLabel(rule.sqlQuery)} ${symbol} ${rule.thresholdValue}`;
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

    // Auto-pause any rule whose schedule window has ended. Once paused it no
    // longer runs and the UI shows it as "Ended".
    const ended = active.filter(rule => rule.endAt && now >= new Date(rule.endAt).getTime());
    if (ended.length > 0) {
      await Promise.all(
        ended.map(rule =>
          prisma.customAlert
            .update({ where: { id: rule.id }, data: { isActive: false } })
            .catch((err: any) =>
              logger.error(`Custom alert auto-pause failed for ${rule.id}: ${err?.message || err}`),
            ),
        ),
      );
      logger.info(`Custom alert schedule ended, auto-paused ${ended.length} rule(s)`);
    }
    const endedIds = new Set(ended.map(r => r.id));

    const due = active.filter(rule => {
      if (endedIds.has(rule.id)) return false; // window ended → paused
      // Not started yet: first check must fire at/after startAt.
      if (rule.startAt && now < new Date(rule.startAt).getTime()) return false;

      // Cron-based frequencies (DAILY/WEEKLY/MONTHLY): due when a scheduled
      // occurrence has passed that we haven't run yet.
      if (rule.scheduleType && rule.scheduleType !== 'INTERVAL') {
        return this.isCronDue(rule, now);
      }

      // INTERVAL mode: run when the interval has elapsed since the last check.
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

  /**
   * True when a cron-scheduled rule has a due occurrence: the most recent
   * scheduled time (in IST) is at/after the schedule start and strictly after
   * the last check. Evaluated across all configured times (each its own cron).
   */
  private isCronDue(rule: any, nowMs: number): boolean {
    const cfg = parseScheduleConfig(rule.scheduleConfig);
    const crons = buildCronExpressions(rule.scheduleType, cfg);
    if (crons.length === 0) return false;

    const startMs = rule.startAt ? new Date(rule.startAt).getTime() : 0;
    const lastMs = rule.lastCheckedAt ? new Date(rule.lastCheckedAt).getTime() : 0;

    for (const expr of crons) {
      try {
        const it = parseExpression(expr, { currentDate: new Date(nowMs), tz: CUSTOM_ALERT_TZ });
        const prevMs = it.prev().toDate().getTime(); // most recent occurrence <= now
        if (prevMs >= startMs && prevMs > lastMs) return true;
      } catch {
        // Invalid expression — ignore this one.
      }
    }
    return false;
  }
}

export const customAlertService = new CustomAlertService();
