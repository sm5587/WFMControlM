import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing, Plus, Pencil, Trash2, Play, Loader2, AlertTriangle,
  CheckCircle, XCircle, Clock, X, Power, ChevronDown, ChevronRight, Check, Users, Mail,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customAlertsApi } from '../../services/api';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { usePermission } from '../../context/AuthContext';
import CustomAlertDetailModal from './CustomAlertDetailModal';
import type {
  CustomAlert, CustomAlertClientResult, CustomAlertInput, CustomAlertOperator,
  CustomAlertValidateResult, CustomAlertScheduleType, CustomAlertScheduleConfig,
} from '../../types';

interface ClientOption { id: string; clientId: string; name: string }

// ============================================================
// Custom Alerts Page
// User-defined SQL threshold watchers. Each rule runs a SELECT
// against one client's DB2 on its own interval, reads a named
// column, and compares it to a threshold using an operator.
// ============================================================

const OPERATORS: { value: CustomAlertOperator; label: string; symbol: string }[] = [
  { value: 'GT',  label: 'Greater than',             symbol: '>' },
  { value: 'GTE', label: 'Greater than or equal to', symbol: '>=' },
  { value: 'LT',  label: 'Less than',                symbol: '<' },
  { value: 'LTE', label: 'Less than or equal to',    symbol: '<=' },
  { value: 'EQ',  label: 'Equal to',                 symbol: '=' },
];

const OP_SYMBOL: Record<CustomAlertOperator, string> = {
  GT: '>', GTE: '>=', LT: '<', LTE: '<=', EQ: '=',
};

// Only aggregate SELECTs are allowed — the query must return a single number
// (a count/sum/etc.), never individual rows/columns of personal data. Keep this
// list in sync with the backend (CUSTOM_ALERT_AGGREGATE_FUNCTIONS).
const ALLOWED_AGGREGATE_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const;

// True if the string contains a comma outside of any parentheses/quotes.
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

// Extract the outermost SELECT projection (between SELECT and its top-level
// FROM), respecting nesting/quotes. Returns null if it doesn't start with SELECT.
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

// Human-readable label for what a query measures, derived from its aggregate
// projection (e.g. "COUNT(*)"). Falls back to "value".
function aggregateLabel(sql: string): string {
  const cleaned = (sql ?? '').trim().replace(/;\s*$/, '');
  const list = extractTopLevelSelectList(cleaned);
  return list?.trim() || 'value';
}

// Client-side mirror of the backend aggregate-only rule, for instant feedback.
function validateAggregateQuery(sql: string): string | null {
  const trimmed = (sql ?? '').trim();
  if (!trimmed) return 'SQL query is required';
  const withoutTrailing = trimmed.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) return 'Only a single SQL statement is allowed (no ";")';
  if ((withoutTrailing.split(/\s+/)[0] ?? '').toUpperCase() !== 'SELECT') {
    return 'Query must be a single aggregate SELECT, e.g. SELECT COUNT(*) FROM ...';
  }
  const selectList = extractTopLevelSelectList(withoutTrailing);
  if (selectList === null || !selectList.trim()) {
    return 'Could not read the SELECT clause. Use a single aggregate, e.g. SELECT COUNT(*) FROM ...';
  }
  const projection = selectList.trim();
  if (hasTopLevelComma(projection)) return 'Only a single aggregate value may be selected (no multiple columns).';
  const aggRe = new RegExp(`^(${ALLOWED_AGGREGATE_FUNCTIONS.join('|')})\\s*\\(`, 'i');
  if (!aggRe.test(projection)) {
    return `Query must select a single aggregate value (${ALLOWED_AGGREGATE_FUNCTIONS.join(', ')}). `
      + 'Selecting columns or "*" is not allowed — e.g. SELECT COUNT(*) FROM ...';
  }
  return null;
}

function StatusBadge({ status }: { status: CustomAlert['lastStatus'] }) {
  switch (status) {
    case 'TRIGGERED':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
          <AlertTriangle className="w-3 h-3" /> Triggered
        </span>
      );
    case 'OK':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
          <CheckCircle className="w-3 h-3" /> OK
        </span>
      );
    case 'ERROR':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
          <XCircle className="w-3 h-3" /> Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">
          <Clock className="w-3 h-3" /> Pending
        </span>
      );
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

const EMPTY_FORM: CustomAlertInput = {
  name: '',
  clientIds: [],
  clientNames: [],
  sqlQuery: '',
  operator: 'GT',
  thresholdValue: '',
  intervalMinutes: 15,
  scheduleType: 'INTERVAL',
  scheduleConfig: { times: [], daysOfWeek: [], daysOfMonth: [] },
  isActive: true,
  notifyEmails: [],
  startAt: '',
  endAt: '',
};

const MIN_INTERVAL_MINUTES = 15;

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FREQUENCY_OPTIONS: { value: CustomAlertScheduleType; label: string }[] = [
  { value: 'INTERVAL', label: 'Every N minutes' },
  { value: 'DAILY', label: 'Every day (at set times)' },
  { value: 'WEEKLY', label: 'Specific days of week' },
  { value: 'MONTHLY', label: 'Specific days of month' },
];

// Human-readable summary of the configured frequency (times shown in IST).
function describeSchedule(
  type: CustomAlertScheduleType,
  cfg: CustomAlertScheduleConfig,
  intervalMinutes: number,
): string {
  if (type === 'INTERVAL') return `Every ${intervalMinutes} minute${intervalMinutes === 1 ? '' : 's'}`;
  const times = cfg.times.length ? [...cfg.times].sort().join(', ') : '(no time set)';
  if (type === 'DAILY') return `Daily at ${times} IST`;
  if (type === 'WEEKLY') {
    const days = cfg.daysOfWeek.length ? [...cfg.daysOfWeek].sort((a, b) => a - b).map(d => DOW_LABELS[d]).join(', ') : '(no day set)';
    return `${days} at ${times} IST`;
  }
  const doms = cfg.daysOfMonth.length ? [...cfg.daysOfMonth].sort((a, b) => a - b).join(', ') : '(no day set)';
  return `Day ${doms} of month at ${times} IST`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// datetime-local <-> ISO helpers. The <input type="datetime-local"> works in
// the browser's local timezone (IST here); we store/transmit UTC ISO strings.
const pad2 = (n: number) => String(n).padStart(2, '0');
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : toLocalInput(d);
}
function localInputToIso(local: string | null): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Small status pill used inside the per-client breakdown.
function MiniStatus({ status }: { status: CustomAlertClientResult['status'] }) {
  const map = {
    TRIGGERED: 'bg-red-100 text-red-700',
    OK: 'bg-green-100 text-green-700',
    ERROR: 'bg-amber-100 text-amber-700',
  } as const;
  const label = status === 'TRIGGERED' ? 'Triggered' : status === 'OK' ? 'OK' : 'Error';
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${map[status]}`}>{label}</span>;
}

export default function CustomAlerts() {
  const canManage = usePermission('CUSTOM_ALERTS_MANAGE', 'write');
  const { clients } = useGlobalFilter();
  const queryClient = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomAlert | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomAlert | null>(null);
  const [detailAlert, setDetailAlert] = useState<CustomAlert | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: alerts = [], isLoading } = useQuery<CustomAlert[]>({
    queryKey: ['custom-alerts'],
    queryFn: async () => {
      const res = await customAlertsApi.list();
      return (res.data ?? []) as CustomAlert[];
    },
    refetchInterval: 30000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['custom-alerts'] });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => customAlertsApi.remove(id),
    onSuccess: () => { invalidate(); setDeleteTarget(null); },
  });

  const toggleMutation = useMutation({
    mutationFn: (alert: CustomAlert) => customAlertsApi.update(alert.id, { isActive: !alert.isActive }),
    onSuccess: invalidate,
  });

  const openCreate = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (alert: CustomAlert) => { setEditing(alert); setModalOpen(true); };

  const triggeredCount = useMemo(() => alerts.filter(a => a.lastStatus === 'TRIGGERED').length, [alerts]);

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <BellRing className="w-6 h-6 text-zebra-500 flex-shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Custom Alerts</h1>
            <p className="text-xs text-gray-400">
              User-defined SQL threshold watchers — run a query per client and alert when a column crosses a value
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {triggeredCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
              <AlertTriangle className="w-3.5 h-3.5" /> {triggeredCount} triggered
            </span>
          )}
          {canManage && (
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-3 py-2 bg-zebra-600 text-white text-sm font-medium rounded-lg hover:bg-zebra-700 transition-colors"
            >
              <Plus className="w-4 h-4" /> New Alert
            </button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <BellRing className="w-12 h-12 text-gray-300 mb-3" />
            <p className="text-gray-500 font-medium">No custom alerts yet</p>
            <p className="text-gray-400 text-sm mt-1">
              Create a watcher to track any SQL column value against a threshold.
            </p>
            {canManage && (
              <button
                onClick={openCreate}
                className="mt-4 inline-flex items-center gap-2 px-3 py-2 bg-zebra-600 text-white text-sm font-medium rounded-lg hover:bg-zebra-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> New Alert
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Clients</th>
                  <th className="px-4 py-3">Condition</th>
                  <th className="px-4 py-3">Frequency</th>
                  <th className="px-4 py-3">Result</th>
                  <th className="px-4 py-3">Last Checked</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {alerts.map(alert => {
                  const clientCount = alert.clientIds?.length || (alert.clientId ? 1 : 0);
                  const clientLabel = (alert.clientIds && alert.clientIds.length > 0)
                    ? alert.clientIds.join(', ')
                    : (alert.clientId ?? '');
                  const results = alert.results ?? [];
                  const triggered = results.filter(r => r.status === 'TRIGGERED').length;
                  const errored = results.filter(r => r.status === 'ERROR').length;
                  const okCount = results.filter(r => r.status === 'OK').length;
                  const isExpanded = expandedId === alert.id;

                  const nowMs = Date.now();
                  const startMs = alert.startAt ? new Date(alert.startAt).getTime() : null;
                  const endMs = alert.endAt ? new Date(alert.endAt).getTime() : null;
                  const scheduleState: 'scheduled' | 'ended' | 'running' =
                    endMs !== null && nowMs >= endMs ? 'ended'
                      : startMs !== null && nowMs < startMs ? 'scheduled'
                      : 'running';

                  return (
                    <React.Fragment key={alert.id}>
                      <tr className={`hover:bg-gray-50 ${!alert.isActive ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-3">
                          <StatusBadge status={alert.lastStatus} />
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          <span className="inline-flex items-center gap-1.5">
                            {alert.name}
                            {alert.notifyEmails && alert.notifyEmails.length > 0 && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[11px] text-sky-600"
                                title={`Emails: ${alert.notifyEmails.join(', ')}`}
                              >
                                <Mail className="w-3 h-3" />{alert.notifyEmails.length}
                              </span>
                            )}
                          </span>
                          {scheduleState === 'ended' ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 text-[11px] font-medium text-gray-500"
                              title={alert.endAt ? `Ended ${new Date(alert.endAt).toLocaleString()}` : 'Ended'}
                            >
                              <Clock className="w-3 h-3" />Ended
                            </span>
                          ) : scheduleState === 'scheduled' ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-500"
                              title={alert.startAt ? `Starts ${new Date(alert.startAt).toLocaleString()}` : 'Scheduled'}
                            >
                              <Clock className="w-3 h-3" />Scheduled
                            </span>
                          ) : !alert.isActive ? (
                            <span className="ml-2 text-xs text-gray-400">(paused)</span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : alert.id)}
                            className="inline-flex items-center gap-1.5 max-w-[240px] text-left hover:text-zebra-600"
                            title="Show per-client results"
                          >
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
                            <Users className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
                            <span className="inline-flex items-center gap-1">
                              <span className="font-semibold">{clientCount}</span>
                              <span className="text-gray-400">·</span>
                              <span className="font-mono text-xs truncate">{clientLabel}</span>
                            </span>
                          </button>
                        </td>
                        <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                          <span className="font-mono text-xs">{aggregateLabel(alert.sqlQuery)}</span>{' '}
                          <span className="font-semibold">{OP_SYMBOL[alert.operator]}</span>{' '}
                          <span className="font-mono text-xs">{alert.thresholdValue}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">
                          {describeSchedule(
                            alert.scheduleType ?? 'INTERVAL',
                            alert.scheduleConfig ?? { times: [], daysOfWeek: [], daysOfMonth: [] },
                            alert.intervalMinutes,
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {results.length === 0 ? (
                            <span className="text-gray-400 text-xs">-</span>
                          ) : (
                            <div className="flex items-center gap-1.5 text-xs">
                              {triggered > 0 && <span className="text-red-600 font-semibold">▲ {triggered}</span>}
                              {okCount > 0 && <span className="text-green-600">✓ {okCount}</span>}
                              {errored > 0 && <span className="text-amber-600">✕ {errored}</span>}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{timeAgo(alert.lastCheckedAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {canManage && (
                              <>
                                <button
                                  onClick={() => toggleMutation.mutate(alert)}
                                  title={alert.isActive ? 'Pause' : 'Resume'}
                                  className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-gray-100 rounded transition-colors"
                                >
                                  <Power className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => openEdit(alert)}
                                  title="Edit"
                                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-gray-100 rounded transition-colors"
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => setDeleteTarget(alert)}
                                  title="Delete"
                                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-gray-100 rounded transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-gray-50/60">
                          <td colSpan={8} className="px-6 py-3">
                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                              Per-client results
                            </div>
                            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-gray-50 text-left text-[11px] font-semibold text-gray-500 uppercase">
                                    <th className="px-3 py-2">Client</th>
                                    <th className="px-3 py-2">Status</th>
                                    <th className="px-3 py-2">Value</th>
                                    <th className="px-3 py-2">Detail</th>
                                    <th className="px-3 py-2">Checked</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {(alert.clientIds && alert.clientIds.length > 0
                                    ? alert.clientIds
                                    : alert.clientId ? [alert.clientId] : []
                                  ).map((cid, i) => {
                                    const r = results.find(x => x.clientId === cid);
                                    const nm = alert.clientNames?.[i] ?? '';
                                    return (
                                      <tr
                                        key={cid}
                                        onClick={() => setDetailAlert(alert)}
                                        title="View alert details"
                                        className="cursor-pointer hover:bg-zebra-50/60 transition-colors"
                                      >
                                        <td className="px-3 py-2 text-gray-700">
                                          <span className="font-mono text-xs">{cid}</span>
                                          {nm && <span className="text-gray-400"> — {nm}</span>}
                                        </td>
                                        <td className="px-3 py-2">
                                          {r ? <MiniStatus status={r.status} /> : <span className="text-gray-400 text-xs">Pending</span>}
                                        </td>
                                        <td className="px-3 py-2 font-mono text-xs text-gray-700">{r?.value ?? '-'}</td>
                                        <td className="px-3 py-2 text-xs text-amber-600 max-w-[320px] truncate" title={r?.error ?? ''}>{r?.error ?? ''}</td>
                                        <td className="px-3 py-2 text-gray-400 text-xs">{r ? timeAgo(r.checkedAt) : '-'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <AlertModal
          editing={editing}
          clients={clients}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); invalidate(); }}
        />
      )}

      {deleteTarget && (
        <DeleteConfirm
          alert={deleteTarget}
          busy={deleteMutation.isPending}
          error={deleteMutation.error instanceof Error ? deleteMutation.error.message : null}
          onCancel={() => { deleteMutation.reset(); setDeleteTarget(null); }}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      )}

      {detailAlert && (
        <CustomAlertDetailModal alert={detailAlert} onClose={() => setDetailAlert(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Create / Edit modal
// ─────────────────────────────────────────────────────────────
function AlertModal({
  editing, clients, onClose, onSaved,
}: {
  editing: CustomAlert | null;
  clients: ClientOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CustomAlertInput>(() =>
    editing
      ? {
          name: editing.name,
          clientIds: editing.clientIds && editing.clientIds.length > 0
            ? editing.clientIds
            : editing.clientId ? [editing.clientId] : [],
          clientNames: editing.clientNames && editing.clientNames.length > 0
            ? editing.clientNames
            : editing.clientName ? [editing.clientName] : [],
          sqlQuery: editing.sqlQuery,
          operator: editing.operator,
          thresholdValue: editing.thresholdValue,
          intervalMinutes: editing.intervalMinutes,
          scheduleType: editing.scheduleType ?? 'INTERVAL',
          scheduleConfig: {
            times: editing.scheduleConfig?.times ?? [],
            daysOfWeek: editing.scheduleConfig?.daysOfWeek ?? [],
            daysOfMonth: editing.scheduleConfig?.daysOfMonth ?? [],
          },
          isActive: editing.isActive,
          notifyEmails: editing.notifyEmails ?? [],
          startAt: isoToLocalInput(editing.startAt),
          endAt: isoToLocalInput(editing.endAt),
        }
      : (() => {
          // Sensible defaults for a new alert: start now, end in 24 hours.
          const now = new Date();
          const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          return { ...EMPTY_FORM, startAt: toLocalInput(now), endAt: toLocalInput(end) };
        })(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<CustomAlertClientResult[] | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<CustomAlertValidateResult | null>(null);

  const isValidated = validation?.validated === true;
  const slowClients = validation?.clients.filter(c => c.status === 'SLOW') ?? [];
  const erroredClients = validation?.clients.filter(c => c.status === 'ERROR') ?? [];
  const maxElapsedMs = validation && validation.clients.length > 0
    ? Math.max(...validation.clients.map(c => c.elapsedMs))
    : 0;

  // Any change to the query or client selection invalidates a prior validation.
  useEffect(() => {
    setValidation(null);
  }, [form.sqlQuery, form.clientIds]);

  const addEmail = (raw: string) => {
    const candidates = raw.split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
    if (candidates.length === 0) return;
    setForm(prev => {
      const next = [...prev.notifyEmails];
      for (const c of candidates) {
        if (EMAIL_RE.test(c) && !next.includes(c)) next.push(c);
      }
      return { ...prev, notifyEmails: next };
    });
    setEmailInput('');
  };

  const removeEmail = (email: string) =>
    setForm(prev => ({ ...prev, notifyEmails: prev.notifyEmails.filter(e => e !== email) }));

  const emailInvalid = emailInput.trim().length > 0 && !EMAIL_RE.test(emailInput.trim());

  const set = <K extends keyof CustomAlertInput>(key: K, value: CustomAlertInput[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  // Toggle a client in/out of the selection, keeping the parallel names array in sync.
  const toggleClient = (code: string) => {
    setForm(prev => {
      const idx = prev.clientIds.indexOf(code);
      if (idx >= 0) {
        return {
          ...prev,
          clientIds: prev.clientIds.filter(c => c !== code),
          clientNames: prev.clientNames.filter((_, i) => i !== idx),
        };
      }
      const c = clients.find(cl => cl.clientId === code);
      return {
        ...prev,
        clientIds: [...prev.clientIds, code],
        clientNames: [...prev.clientNames, c?.name ?? ''],
      };
    });
  };

  const setAllClients = (select: boolean) => {
    setForm(prev => select
      ? { ...prev, clientIds: clients.map(c => c.clientId), clientNames: clients.map(c => c.name) }
      : { ...prev, clientIds: [], clientNames: [] });
  };

  // ---- Schedule frequency builder helpers ----
  const cfg = form.scheduleConfig;

  const setScheduleType = (t: CustomAlertScheduleType) => {
    setForm(prev => {
      const c = prev.scheduleConfig;
      if (t === 'INTERVAL') return { ...prev, scheduleType: t };
      // Seed sensible defaults when entering a time-based mode.
      const times = c.times.length ? c.times : ['09:00'];
      const daysOfWeek = t === 'WEEKLY' && c.daysOfWeek.length === 0 ? [1] : c.daysOfWeek;
      const daysOfMonth = t === 'MONTHLY' && c.daysOfMonth.length === 0 ? [1] : c.daysOfMonth;
      return { ...prev, scheduleType: t, scheduleConfig: { times, daysOfWeek, daysOfMonth } };
    });
  };

  const updateCfg = (patch: Partial<CustomAlertScheduleConfig>) =>
    setForm(prev => ({ ...prev, scheduleConfig: { ...prev.scheduleConfig, ...patch } }));

  const addTime = () => updateCfg({ times: [...cfg.times, '09:00'] });
  const updateTime = (i: number, v: string) => updateCfg({ times: cfg.times.map((t, idx) => (idx === i ? v : t)) });
  const removeTime = (i: number) => updateCfg({ times: cfg.times.filter((_, idx) => idx !== i) });
  const toggleDow = (d: number) =>
    updateCfg({ daysOfWeek: cfg.daysOfWeek.includes(d) ? cfg.daysOfWeek.filter(x => x !== d) : [...cfg.daysOfWeek, d] });
  const toggleDom = (d: number) =>
    updateCfg({ daysOfMonth: cfg.daysOfMonth.includes(d) ? cfg.daysOfMonth.filter(x => x !== d) : [...cfg.daysOfMonth, d] });

  const validate = (): string | null => {
    if (!form.name.trim()) return 'Name is required';
    if (!form.clientIds || form.clientIds.length === 0) return 'Please select at least one client';
    if (!form.sqlQuery.trim()) return 'SQL query is required';
    const aggErr = validateAggregateQuery(form.sqlQuery);
    if (aggErr) return aggErr;
    if (!String(form.thresholdValue).trim()) return 'Threshold value is required';
    if (form.scheduleType === 'INTERVAL') {
      if (form.intervalMinutes < MIN_INTERVAL_MINUTES || form.intervalMinutes > 1440) {
        return `Interval must be between ${MIN_INTERVAL_MINUTES} and 1440 minutes`;
      }
    } else {
      if (cfg.times.length === 0) return 'Please add at least one check time';
      if (form.scheduleType === 'WEEKLY' && cfg.daysOfWeek.length === 0) return 'Please select at least one day of the week';
      if (form.scheduleType === 'MONTHLY' && cfg.daysOfMonth.length === 0) return 'Please select at least one day of the month';
    }
    if (!form.startAt) return 'Start date & time is required';
    if (!form.endAt) return 'End date & time is required';
    const start = new Date(form.startAt).getTime();
    const end = new Date(form.endAt).getTime();
    if (Number.isNaN(start)) return 'Start date & time is invalid';
    if (Number.isNaN(end)) return 'End date & time is invalid';
    // Only enforce "not in the past" for new alerts (an existing alert may have
    // already started). Small 60s grace for the clock.
    if (!editing && start < Date.now() - 60 * 1000) return 'Start date & time cannot be before the current time';
    if (end <= start) return 'End date & time must be after the start date & time';
    return null;
  };

  // Run the timing validation. Returns the result (or null on request error).
  const performValidation = async (): Promise<CustomAlertValidateResult | null> => {
    if (!form.clientIds || form.clientIds.length === 0) { setError('Please select at least one client'); return null; }
    if (!form.sqlQuery.trim()) { setError('SQL query is required'); return null; }
    setError(null);
    setValidating(true);
    try {
      const res = await customAlertsApi.validate({
        clientIds: form.clientIds,
        clientNames: form.clientNames,
        sqlQuery: form.sqlQuery,
      });
      const result = (res.data ?? null) as CustomAlertValidateResult | null;
      setValidation(result);
      return result;
    } catch (err: any) {
      setError(err.message || 'Validation failed');
      setValidation(null);
      return null;
    } finally {
      setValidating(false);
    }
  };

  const runTest = async () => {
    setError(null);
    setTestResults(null);
    const v = validate();
    if (v) { setError(v); return; }
    setTesting(true);
    try {
      const res = await customAlertsApi.test({
        clientIds: form.clientIds,
        clientNames: form.clientNames,
        sqlQuery: form.sqlQuery,
        operator: form.operator,
        thresholdValue: String(form.thresholdValue),
      });
      setTestResults((res.data ?? []) as CustomAlertClientResult[]);
    } catch (err: any) {
      setError(err.message || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    const v = validate();
    if (v) { setError(v); return; }
    // Fold any email still sitting in the input box into the list.
    const pending = emailInput.trim();
    if (pending && !EMAIL_RE.test(pending)) { setError(`Invalid email address: ${pending}`); return; }
    const finalEmails = pending && !form.notifyEmails.includes(pending)
      ? [...form.notifyEmails, pending]
      : form.notifyEmails;

    // Enforce query timing: if not already validated, validate now and block on slow queries.
    if (!isValidated) {
      const result = await performValidation();
      if (!result) return;                 // request failed — message already shown
      if (!result.validated) return;       // slow/errored — the inline message explains why
    }

    const payload: CustomAlertInput = {
      ...form,
      notifyEmails: finalEmails,
      startAt: localInputToIso(form.startAt),
      endAt: localInputToIso(form.endAt),
    };
    setSaving(true);
    try {
      if (editing) {
        await customAlertsApi.update(editing.id, payload);
      } else {
        await customAlertsApi.create(payload);
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        {/* Modal header — z-30 keeps it above the scrolling body and the
            client dropdown panel (z-20) when content scrolls underneath. */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 z-30 bg-white">
          <h2 className="text-lg font-bold text-gray-900">
            {editing ? 'Edit Custom Alert' : 'New Custom Alert'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Alert Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. High pending queue for WAWA"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zebra-500"
            />
          </div>

          {/* Clients (multi-select) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">
                Clients {form.clientIds.length > 0 && (
                  <span className="ml-1 text-xs font-normal text-gray-400">({form.clientIds.length} selected)</span>
                )}
              </label>
              <div className="flex items-center gap-3 text-xs">
                <button type="button" onClick={() => setAllClients(true)} className="text-zebra-600 hover:underline">Select all</button>
                <button type="button" onClick={() => setAllClients(false)} className="text-gray-500 hover:underline">Clear</button>
              </div>
            </div>
            <MultiClientSelect
              clients={clients}
              selectedIds={form.clientIds}
              onToggle={toggleClient}
            />
            <p className="text-xs text-gray-400 mt-1">
              The query runs against each selected client on the configured interval.
            </p>
          </div>

          {/* SQL query */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SQL Query</label>
            <textarea
              value={form.sqlQuery}
              onChange={e => set('sqlQuery', e.target.value)}
              rows={4}
              placeholder="SELECT COUNT(*) FROM RWSUSER.BATCH_STATUS WHERE STATUS = 'N'"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zebra-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Aggregate SELECT only ({ALLOWED_AGGREGATE_FUNCTIONS.join(', ')}) returning a single number.
              Selecting individual columns or <span className="font-mono">*</span> is not allowed.
            </p>

            {/* Validation message (left) + Validate button (right) */}
            <div className="flex items-center justify-end gap-3 mt-2">
              <div className="flex-1 text-xs">
                {validating ? (
                  <span className="inline-flex items-center gap-1 text-gray-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Validating query…
                  </span>
                ) : isValidated ? (
                  <span className="inline-flex items-center gap-1 text-green-600 font-medium">
                    <CheckCircle className="w-3.5 h-3.5" /> Validated ({(maxElapsedMs / 1000).toFixed(1)}s
                    {validation && validation.clients.length > 1 ? ' max' : ''})
                  </span>
                ) : validation && slowClients.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-red-600 font-medium" title={slowClients.map(c => c.clientId).join(', ')}>
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Query is taking longer than {validation.timeoutSec}s
                    {slowClients.length > 1 || (validation.clients.length > 1)
                      ? ` (${slowClients.length}/${validation.clients.length} client${slowClients.length > 1 ? 's' : ''})`
                      : ''}
                  </span>
                ) : validation && erroredClients.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-red-600 font-medium" title={erroredClients[0].error ?? ''}>
                    <XCircle className="w-3.5 h-3.5" />
                    Query error{erroredClients.length > 1 ? ` (${erroredClients.length} clients)` : ''}: {erroredClients[0].error}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={performValidation}
                disabled={validating || saving}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                Validate
              </button>
            </div>
          </div>

          {/* Operator + threshold (the query returns a single aggregate value) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Operator</label>
              <select
                value={form.operator}
                onChange={e => set('operator', e.target.value as CustomAlertOperator)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zebra-500"
              >
                {OPERATORS.map(op => (
                  <option key={op.value} value={op.value}>{op.symbol}  {op.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Threshold</label>
              <input
                type="text"
                value={form.thresholdValue}
                onChange={e => set('thresholdValue', e.target.value)}
                placeholder="100"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zebra-500"
              />
            </div>
          </div>

          {/* Frequency + active */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Check Frequency</label>
                <select
                  value={form.scheduleType}
                  onChange={e => setScheduleType(e.target.value as CustomAlertScheduleType)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zebra-500"
                >
                  {FREQUENCY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 pb-2">
                  <input
                    type="checkbox"
                    checked={!!form.isActive}
                    onChange={e => set('isActive', e.target.checked)}
                    className="rounded border-gray-300 text-zebra-600 focus:ring-zebra-500"
                  />
                  Active
                </label>
              </div>
            </div>

            {form.scheduleType === 'INTERVAL' ? (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Check every (minutes)</label>
                <input
                  type="number"
                  min={MIN_INTERVAL_MINUTES}
                  max={1440}
                  value={form.intervalMinutes}
                  onChange={e => set('intervalMinutes', Number(e.target.value))}
                  onBlur={e => {
                    const n = Number(e.target.value);
                    const clamped = !Number.isFinite(n)
                      ? MIN_INTERVAL_MINUTES
                      : Math.min(1440, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)));
                    set('intervalMinutes', clamped);
                  }}
                  className="w-full sm:w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zebra-500"
                />
                <p className="text-xs text-gray-400 mt-1">Minimum {MIN_INTERVAL_MINUTES} minutes.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 p-3 space-y-3 bg-gray-50/50">
                {form.scheduleType === 'WEEKLY' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Days of week</label>
                    <div className="flex flex-wrap gap-1.5">
                      {DOW_LABELS.map((lbl, d) => {
                        const on = cfg.daysOfWeek.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => toggleDow(d)}
                            className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${on ? 'bg-zebra-600 text-white border-zebra-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'}`}
                          >
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {form.scheduleType === 'MONTHLY' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Days of month</label>
                    <div className="flex flex-wrap gap-1">
                      {Array.from({ length: 31 }, (_, i) => i + 1).map(d => {
                        const on = cfg.daysOfMonth.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => toggleDom(d)}
                            className={`w-7 h-7 rounded text-xs font-medium border transition-colors ${on ? 'bg-zebra-600 text-white border-zebra-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'}`}
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">Check time(s) — IST</label>
                  <div className="space-y-1.5">
                    {cfg.times.map((t, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="time"
                          value={t}
                          onChange={e => updateTime(i, e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-zebra-500"
                        />
                        <button
                          type="button"
                          onClick={() => removeTime(i)}
                          disabled={cfg.times.length <= 1}
                          className="p-1 text-gray-400 hover:text-red-600 disabled:opacity-30"
                          title="Remove time"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={addTime}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-zebra-600 hover:text-zebra-700"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add time
                  </button>
                </div>

                <p className="text-xs text-gray-500">
                  <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />
                  {describeSchedule(form.scheduleType, cfg, form.intervalMinutes)}
                </p>
              </div>
            )}
          </div>

          {/* Schedule window */}
          <div className="rounded-lg border border-gray-200 p-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <Clock className="w-4 h-4 text-gray-400" />
              Schedule
              <span className="text-xs font-normal text-gray-400">
                — first check fires at the start time, then repeats until the end time
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Start date &amp; time</label>
                <input
                  type="datetime-local"
                  value={form.startAt ?? ''}
                  min={editing ? undefined : toLocalInput(new Date())}
                  onChange={e => set('startAt', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zebra-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">End date &amp; time</label>
                <input
                  type="datetime-local"
                  value={form.endAt ?? ''}
                  min={form.startAt || (editing ? undefined : toLocalInput(new Date()))}
                  onChange={e => set('endAt', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zebra-500"
                />
              </div>
            </div>
          </div>

          {/* Email recipients (bottom) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Recipients <span className="text-xs font-normal text-gray-400">(optional — leave empty for in-app only)</span>
            </label>
            <div className="flex flex-wrap items-center gap-1.5 border border-gray-300 rounded-lg px-2 py-1.5 focus-within:ring-2 focus-within:ring-zebra-500">
              {form.notifyEmails.map(email => (
                <span key={email} className="inline-flex items-center gap-1 bg-sky-100 text-sky-800 text-xs font-medium px-2 py-1 rounded">
                  {email}
                  <button type="button" onClick={() => removeEmail(email)} className="hover:text-sky-950" title="Remove">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); addEmail(emailInput); }
                  else if (e.key === 'Backspace' && !emailInput && form.notifyEmails.length > 0) {
                    removeEmail(form.notifyEmails[form.notifyEmails.length - 1]);
                  }
                }}
                onBlur={() => { if (emailInput.trim()) addEmail(emailInput); }}
                placeholder={form.notifyEmails.length === 0 ? 'name@zebra.com, another@zebra.com' : 'Add another…'}
                className="flex-1 min-w-[160px] px-1 py-1 text-sm focus:outline-none"
              />
            </div>
            <p className={`text-xs mt-1 ${emailInvalid ? 'text-red-500' : 'text-gray-400'}`}>
              {emailInvalid
                ? 'That does not look like a valid email address.'
                : 'Press Enter or comma to add. Recipients are emailed when the threshold is crossed (requires SMTP configured).'}
            </p>
          </div>

          {/* Test results (one row per selected client) */}
          {testResults && testResults.length > 0 && (
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Test results — {testResults.length} client(s)
              </div>
              <div className="divide-y divide-gray-100 max-h-56 overflow-auto">
                {testResults.map(r => (
                  <div
                    key={r.clientId}
                    className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${
                      r.status === 'ERROR' ? 'bg-amber-50' : r.status === 'TRIGGERED' ? 'bg-red-50' : 'bg-green-50/60'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <MiniStatus status={r.status} />
                      <span className="font-mono text-xs text-gray-700">{r.clientId}</span>
                      {r.clientName && <span className="text-gray-400 text-xs truncate">— {r.clientName}</span>}
                    </div>
                    <div className="text-xs text-gray-600 text-right flex-shrink-0">
                      {r.error
                        ? <span className="text-amber-700" title={r.error}>{r.error.length > 60 ? r.error.slice(0, 60) + '…' : r.error}</span>
                        : <>value <span className="font-mono font-semibold">{r.value ?? 'null'}</span> — {r.triggered ? 'would trigger' : 'ok'} ({r.executionMs}ms)</>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200">
              {error}
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 sticky bottom-0 bg-white">
          <button
            onClick={runTest}
            disabled={testing || saving}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Test Query
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zebra-600 rounded-lg hover:bg-zebra-700 transition-colors disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {editing ? 'Save Changes' : 'Create Alert'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Multi-client selector
// A custom dropdown with per-client checkboxes. Selected rows get a
// light-blue background; the closed box shows the selected client
// names comma-separated.
// ─────────────────────────────────────────────────────────────
function MultiClientSelect({
  clients, selectedIds, onToggle,
}: {
  clients: ClientOption[];
  selectedIds: string[];
  onToggle: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedNames = clients
    .filter(c => selectedIds.includes(c.clientId))
    .map(c => c.name || c.clientId);
  // Include any selected codes not present in the current client list (edge case).
  const extra = selectedIds.filter(id => !clients.some(c => c.clientId === id));
  const displayText = [...selectedNames, ...extra].join(', ');

  const q = search.trim().toLowerCase();
  const filtered = q
    ? clients.filter(c => c.clientId.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    : clients;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white text-left focus:outline-none focus:ring-2 focus:ring-zebra-500"
      >
        <span className={`truncate ${displayText ? 'text-gray-800' : 'text-gray-400'}`}>
          {displayText || 'Select one or more clients…'}
        </span>
        <ChevronDown className={`w-4 h-4 flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-zebra-500"
            />
          </div>
          <div className="max-h-60 overflow-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-gray-400">No clients match “{search}”</div>
            ) : (
              filtered.map(c => {
                const checked = selectedIds.includes(c.clientId);
                return (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => onToggle(c.clientId)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                      checked ? 'bg-sky-100 hover:bg-sky-200' : 'bg-white hover:bg-gray-50'
                    }`}
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      checked ? 'bg-sky-600 border-sky-600' : 'bg-white border-gray-300'
                    }`}>
                      {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                    </span>
                    <span className="font-mono text-xs text-gray-500 w-16 flex-shrink-0">{c.clientId}</span>
                    <span className="truncate text-gray-800">{c.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Delete confirmation
// ─────────────────────────────────────────────────────────────
function DeleteConfirm({
  alert, busy, error, onCancel, onConfirm,
}: {
  alert: CustomAlert;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-6 py-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">Delete this alert?</h2>
          </div>
          <p className="text-sm text-gray-600">
            Do you really want to delete <span className="font-semibold">{alert.name}</span>? This
            watcher will stop running and cannot be recovered.
          </p>
          {error && (
            <div className="mt-3 rounded-lg px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
