import { BellRing, X, Database, Clock, Bell } from 'lucide-react';
import type { CustomAlert } from '../../types';

const OP_SYMBOL: Record<string, string> = {
  GT: '>', GTE: '≥', LT: '<', LTE: '≤', EQ: '=',
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Extract the outermost SELECT projection (between SELECT and its top-level
// FROM), respecting nesting/quotes. Used to label what the alert measures.
function extractTopLevelSelectList(sql: string): string | null {
  const upper = sql.toUpperCase();
  if (!upper.startsWith('SELECT')) return null;
  const startIdx = 6;
  let depth = 0;
  let inSingle = false;
  for (let i = startIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
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
  return sql.slice(startIdx);
}

// Human-readable label for what the query measures (e.g. "COUNT(*)").
function aggregateLabel(sql: string): string {
  const cleaned = (sql ?? '').trim().replace(/;\s*$/, '');
  const list = extractTopLevelSelectList(cleaned);
  return list?.trim() || 'value';
}

// Human-readable frequency (times shown in IST).
function describeSchedule(a: CustomAlert): string {
  const type = a.scheduleType || 'INTERVAL';
  if (type === 'INTERVAL') {
    const m = a.intervalMinutes;
    return `Every ${m} minute${m === 1 ? '' : 's'}`;
  }
  const cfg = a.scheduleConfig || { times: [], daysOfWeek: [], daysOfMonth: [] };
  const times = cfg.times?.length ? [...cfg.times].sort().join(', ') : '(no time set)';
  if (type === 'DAILY') return `Daily at ${times} IST`;
  if (type === 'WEEKLY') {
    const days = cfg.daysOfWeek?.length
      ? [...cfg.daysOfWeek].sort((x, y) => x - y).map(d => DOW[d]).join(', ')
      : '(no day set)';
    return `Weekly — ${days} at ${times} IST`;
  }
  if (type === 'MONTHLY') {
    const doms = cfg.daysOfMonth?.length
      ? [...cfg.daysOfMonth].sort((x, y) => x - y).join(', ')
      : '(no day set)';
    return `Monthly — day ${doms} at ${times} IST`;
  }
  return type;
}

// Format an ISO timestamp in the browser's local time (IST here).
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * Read-only detail popup for a Custom Alert. Shows condition, schedule,
 * SQL query, per-client values (why it triggered), and email recipients.
 * Shared by the Dashboard widget and the Custom Alerts page.
 */
export default function CustomAlertDetailModal({ alert, onClose }: { alert: CustomAlert; onClose: () => void }) {
  const results = alert.results ?? [];
  const emails = alert.notifyEmails ?? [];
  const clientNames = alert.clientNames ?? [];
  const clientIds = alert.clientIds ?? [];
  const opSymbol = OP_SYMBOL[alert.operator] || alert.operator;
  const isTriggered = alert.lastStatus === 'TRIGGERED';

  const labelFor = (clientId: string, clientName?: string) => {
    if (clientName) return clientName;
    const idx = clientIds.indexOf(clientId);
    return idx >= 0 && clientNames[idx] ? clientNames[idx] : clientId;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 z-10 bg-white">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <BellRing className={`w-5 h-5 ${isTriggered ? 'text-red-500' : 'text-gray-400'}`} />
            {alert.name}
            {isTriggered ? (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-semibold">Triggered</span>
            ) : alert.lastStatus ? (
              <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-semibold">{alert.lastStatus}</span>
            ) : null}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Per-client results (clients on top) */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Clients &amp; Values{results.length > 0 ? ` (${results.length})` : ''}
            </div>
            {results.length === 0 ? (
              <p className="text-sm text-gray-400">No per-client results recorded yet.</p>
            ) : (
              <div className="rounded-lg border border-gray-200 overflow-hidden divide-y divide-gray-100">
                {results.map(r => (
                  <div
                    key={r.clientId}
                    className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${
                      r.status === 'ERROR' ? 'bg-amber-50' : r.status === 'TRIGGERED' ? 'bg-red-50' : 'bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Database className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-gray-800 truncate">{labelFor(r.clientId, r.clientName)}</div>
                        <div className="text-[10px] text-gray-400 font-mono">{r.clientId}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {r.status === 'ERROR' ? (
                        <span className="text-xs text-amber-700 max-w-[220px] truncate" title={r.error || ''}>{r.error || 'Error'}</span>
                      ) : (
                        <span className="text-xs text-gray-600">
                          Value: <span className="font-mono font-semibold text-gray-900">{r.value ?? '—'}</span>
                        </span>
                      )}
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        r.status === 'TRIGGERED' ? 'bg-red-100 text-red-700'
                          : r.status === 'ERROR' ? 'bg-amber-100 text-amber-700'
                          : 'bg-green-100 text-green-700'
                      }`}>
                        {r.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SQL Query */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">SQL Query</div>
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-800 whitespace-pre-wrap break-words">{alert.sqlQuery}</pre>
          </div>

          {/* Condition */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Condition</div>
            <div className="text-sm text-gray-800">
              <span className="font-mono">{aggregateLabel(alert.sqlQuery)}</span>{' '}
              <span className="font-semibold">{opSymbol}</span>{' '}
              <span className="font-mono">{alert.thresholdValue}</span>
            </div>
          </div>

          {/* Schedule / cron details */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Schedule</div>
            <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
              <div className="flex items-center gap-2 px-3 py-2">
                <Clock className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span className="text-gray-500 w-28 flex-shrink-0">Frequency</span>
                <span className="text-gray-800 font-medium">{describeSchedule(alert)}</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="w-3.5 flex-shrink-0" />
                <span className="text-gray-500 w-28 flex-shrink-0">Starts</span>
                <span className="text-gray-800">{fmtDateTime(alert.startAt)}</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="w-3.5 flex-shrink-0" />
                <span className="text-gray-500 w-28 flex-shrink-0">Ends</span>
                <span className="text-gray-800">{fmtDateTime(alert.endAt)}</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="w-3.5 flex-shrink-0" />
                <span className="text-gray-500 w-28 flex-shrink-0">Last checked</span>
                <span className="text-gray-800">{fmtDateTime(alert.lastCheckedAt)}</span>
              </div>
            </div>
          </div>

          {/* Notification recipients */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Email Notifications</div>
            {emails.length === 0 ? (
              <p className="text-sm text-gray-400">In-app only — no email recipients configured.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {emails.map(email => (
                  <span key={email} className="inline-flex items-center gap-1 bg-sky-100 text-sky-800 text-xs font-medium px-2 py-1 rounded">
                    <Bell className="w-3 h-3" />{email}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
