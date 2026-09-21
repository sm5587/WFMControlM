import React, { useMemo, useState } from 'react';
import {
  BellRing, Plus, Pencil, Trash2, Play, Loader2, AlertTriangle,
  CheckCircle, XCircle, Clock, X, Power,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customAlertsApi } from '../../services/api';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { usePermission } from '../../context/AuthContext';
import type {
  CustomAlert, CustomAlertInput, CustomAlertOperator, CustomAlertTestResult,
} from '../../types';

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
  clientId: '',
  clientName: '',
  sqlQuery: '',
  columnName: '',
  operator: 'GT',
  thresholdValue: '',
  intervalMinutes: 15,
  isActive: true,
};

export default function CustomAlerts() {
  const canManage = usePermission('CUSTOM_ALERTS_MANAGE', 'write');
  const { clients } = useGlobalFilter();
  const queryClient = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomAlert | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomAlert | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

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

  const runNow = async (alert: CustomAlert) => {
    setRunningId(alert.id);
    try {
      await customAlertsApi.run(alert.id);
      invalidate();
    } finally {
      setRunningId(null);
    }
  };

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
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Condition</th>
                  <th className="px-4 py-3">Interval</th>
                  <th className="px-4 py-3">Last Value</th>
                  <th className="px-4 py-3">Last Checked</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {alerts.map(alert => (
                  <tr key={alert.id} className={`hover:bg-gray-50 ${!alert.isActive ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3"><StatusBadge status={alert.lastStatus} /></td>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {alert.name}
                      {!alert.isActive && <span className="ml-2 text-xs text-gray-400">(paused)</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <span className="font-mono text-xs">{alert.clientId}</span>
                      {alert.clientName && <span className="text-gray-400"> — {alert.clientName}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      <span className="font-mono text-xs">{alert.columnName}</span>{' '}
                      <span className="font-semibold">{OP_SYMBOL[alert.operator]}</span>{' '}
                      <span className="font-mono text-xs">{alert.thresholdValue}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{alert.intervalMinutes}m</td>
                    <td className="px-4 py-3">
                      {alert.lastStatus === 'ERROR' ? (
                        <span className="text-amber-600 text-xs" title={alert.lastError ?? ''}>Error</span>
                      ) : (
                        <span className="font-mono text-xs text-gray-700">{alert.lastValue ?? '-'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{timeAgo(alert.lastCheckedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && (
                          <>
                            <button
                              onClick={() => runNow(alert)}
                              disabled={runningId === alert.id}
                              title="Run now"
                              className="p-1.5 text-gray-400 hover:text-zebra-600 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                            >
                              {runningId === alert.id
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <Play className="w-4 h-4" />}
                            </button>
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
                ))}
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
  clients: { id: string; clientId: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CustomAlertInput>(() =>
    editing
      ? {
          name: editing.name,
          clientId: editing.clientId,
          clientName: editing.clientName,
          sqlQuery: editing.sqlQuery,
          columnName: editing.columnName,
          operator: editing.operator,
          thresholdValue: editing.thresholdValue,
          intervalMinutes: editing.intervalMinutes,
          isActive: editing.isActive,
        }
      : { ...EMPTY_FORM },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CustomAlertTestResult | null>(null);

  const set = <K extends keyof CustomAlertInput>(key: K, value: CustomAlertInput[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const onClientChange = (code: string) => {
    const c = clients.find(cl => cl.clientId === code);
    setForm(prev => ({ ...prev, clientId: code, clientName: c?.name ?? '' }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return 'Name is required';
    if (!form.clientId) return 'Please select a client';
    if (!form.sqlQuery.trim()) return 'SQL query is required';
    if (!form.columnName.trim()) return 'Column name is required';
    if (!String(form.thresholdValue).trim()) return 'Threshold value is required';
    if (form.intervalMinutes < 1 || form.intervalMinutes > 1440) return 'Interval must be between 1 and 1440 minutes';
    return null;
  };

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    const v = validate();
    if (v) { setError(v); return; }
    setTesting(true);
    try {
      const res = await customAlertsApi.test({
        clientId: form.clientId,
        sqlQuery: form.sqlQuery,
        columnName: form.columnName,
        operator: form.operator,
        thresholdValue: String(form.thresholdValue),
      });
      setTestResult((res.data ?? null) as CustomAlertTestResult | null);
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
    setSaving(true);
    try {
      if (editing) {
        await customAlertsApi.update(editing.id, form);
      } else {
        await customAlertsApi.create(form);
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
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white">
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

          {/* Client */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
            <select
              value={form.clientId}
              onChange={e => onClientChange(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-zebra-500"
            >
              <option value="">Select a client…</option>
              {clients.map(c => (
                <option key={c.id} value={c.clientId}>{c.clientId} — {c.name}</option>
              ))}
            </select>
          </div>

          {/* SQL query */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SQL Query</label>
            <textarea
              value={form.sqlQuery}
              onChange={e => set('sqlQuery', e.target.value)}
              rows={4}
              placeholder="SELECT COUNT(*) AS PENDING FROM RWSUSER.BATCH_STATUS WHERE STATUS = 'N'"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zebra-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Read-only SELECT only. The first row of the result is evaluated.
            </p>
          </div>

          {/* Column + operator + threshold */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Track Column</label>
              <input
                type="text"
                value={form.columnName}
                onChange={e => set('columnName', e.target.value)}
                placeholder="PENDING"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zebra-500"
              />
            </div>
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

          {/* Interval + active */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Check Every (minutes)</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={form.intervalMinutes}
                onChange={e => set('intervalMinutes', Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zebra-500"
              />
            </div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 pb-2">
                <input
                  type="checkbox"
                  checked={!!form.isActive}
                  onChange={e => set('isActive', e.target.checked)}
                  className="rounded border-gray-300 text-zebra-600 focus:ring-zebra-500"
                />
                Active (start checking immediately)
              </label>
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              testResult.error
                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : testResult.triggered
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-green-50 text-green-700 border border-green-200'
            }`}>
              {testResult.error
                ? <>Test error: {testResult.error}</>
                : <>Result: <span className="font-mono font-semibold">{testResult.value ?? 'null'}</span> — {testResult.triggered ? 'threshold WOULD trigger an alert' : 'threshold not crossed'} ({testResult.executionMs}ms)</>}
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
