import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Database, Clock, AlertTriangle, CheckCircle, BellOff,
  Send, UserPlus, Trash2, X, Mail, Timer,
} from 'lucide-react';
import { useAllClientsBatchData } from '../../hooks/useAllClientsBatchData';
import { escalationsApi, unprocessedPunchApi } from '../../services/api';
import { usePermission } from '../../context/AuthContext';
import { useTimezone } from '../../hooks/useTimezone';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { useConfig } from '../../contexts/ConfigContext';
import { isNotifyEligible, minutesUntilNotifyEligible } from '../../utils/notify';

// ---- Types ----
interface EscalatedAlert {
  id: string;
  clientId: string;
  serverCode: string;
  clientName: string;
  cluster: string;
  stalePendingCount: number;
  totalPending: number;
  status: string; // OPEN | ACKNOWLEDGED | SUPPRESSED
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  suppressedBy: string | null;
  suppressUntil: string | null;
  suppressReason: string | null;
  emailSentAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Recipient {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
}

// ---- Hook for escalated alerts ----
export function useEscalatedAlerts() {
  const { getInt } = useConfig();
  return useQuery<EscalatedAlert[]>({
    queryKey: ['escalated-alerts'],
    queryFn: async () => {
      const res = await escalationsApi.getAll();
      return (res.data ?? []) as EscalatedAlert[];
    },
    staleTime: 30 * 60 * 1000,
    refetchInterval: getInt('polling.escalatedRefreshSecs', 1800) * 1000,
    refetchOnWindowFocus: false,
  });
}

// ============================================================
// Main AlertCenter Component
// ============================================================
export default function AlertCenter() {
  const queryClient = useQueryClient();
  const { fmt } = useTimezone();
  const { getInt } = useConfig();
  const canAck         = usePermission('ALERTS_ACK',          'write');
  const canSuppress    = usePermission('ALERTS_SUPPRESS',     'write');
  const canNotify      = usePermission('ALERTS_NOTIFY',       'write');
  const canManageRecip = usePermission('RECIPIENTS_MANAGE',   'write');
  const showUnprocPunchTab = getInt('ui.showUnprocPunchTab', 0) === 1;
  const notifyCooldownMins = getInt('threshold.notifyCooldownMins', 60);
  const [activeTab, setActiveTab] = useState<'pending' | 'escalated' | 'unproc-punch'>('pending');
  const [notifyTick, setNotifyTick] = useState(0);

  // Re-check notify eligibility when cooldown expires (without waiting for refetch)
  useEffect(() => {
    const id = setInterval(() => setNotifyTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ---- Unproc punch stale data (from cache) ----
  const { data: punchRes } = useQuery({
    queryKey: ['unprocessed-punch-all'],
    queryFn: () => unprocessedPunchApi.getAll(),
    staleTime: getInt('polling.punchRefreshMins', 30) * 60 * 1000,
    refetchInterval: getInt('polling.punchRefreshMins', 30) * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const allPunchRows: any[] = (punchRes as any)?.data ?? [];

  // Parse DB2 timestamp: "YYYY-MM-DD-HH.MM.SS.ffffff" or ISO
  function parseDb2Ts(s: string | null): Date | null {
    if (!s) return null;
    // DB2 format: 2026-04-24-10.30.00.000000
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    return new Date(s);
  }

  // Track previous punch snapshot to detect movement (count decreasing or lastUpdateTime changing)
  const prevPunchSnapshot = useRef<Map<string, { punchCount: number; lastUpdateTime: string | null }>>(new Map());

  const stalePunchRows = useMemo(() => {
    const prev = prevPunchSnapshot.current;
    return allPunchRows
      .filter(r => {
        if (!r.punchCount || r.punchCount <= getInt('threshold.punchCountMin', 100) || r.error) return false;
        const dbNow = parseDb2Ts(r.dbCurrentTime);
        const last  = parseDb2Ts(r.lastUpdateTime);
        if (!dbNow || !last) return false;
        if ((dbNow.getTime() - last.getTime()) <= getInt('threshold.staleHoursMins', 60) * 60 * 1000) return false; // not stale

        // If we have a previous snapshot, check whether the process is actively moving
        const prevData = prev.get(r.clientId);
        if (prevData) {
          // Count is decreasing → process is actively draining
          if (r.punchCount < prevData.punchCount) return false;
          // lastUpdateTime changed → process is actively updating
          if (r.lastUpdateTime !== prevData.lastUpdateTime) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const ageA = parseDb2Ts(a.dbCurrentTime)!.getTime() - parseDb2Ts(a.lastUpdateTime)!.getTime();
        const ageB = parseDb2Ts(b.dbCurrentTime)!.getTime() - parseDb2Ts(b.lastUpdateTime)!.getTime();
        return ageB - ageA; // oldest first
      });
  }, [allPunchRows]);

  // Update the previous snapshot after each data refresh
  useEffect(() => {
    if (allPunchRows.length > 0) {
      const snapshot = new Map<string, { punchCount: number; lastUpdateTime: string | null }>();
      for (const r of allPunchRows) {
        if (r.clientId && r.punchCount != null) {
          snapshot.set(r.clientId, { punchCount: r.punchCount, lastUpdateTime: r.lastUpdateTime ?? null });
        }
      }
      prevPunchSnapshot.current = snapshot;
    }
  }, [allPunchRows]);

  // ---- Punch alert statuses (Ack / Suppress) ----
  const { data: punchAlertStatuses = {} } = useQuery<Record<string, any>>({
    queryKey: ['punch-alert-statuses'],
    queryFn: async () => {
      const res = await escalationsApi.getPunchAlertStatuses();
      return (res as any)?.data ?? {};
    },
    refetchInterval: getInt('polling.punchStatusRefreshSecs', 60) * 1000,
    refetchOnWindowFocus: true,
  });

  // Derive punch alert status counts from merged live + persisted data
  const punchStatusCounts = useMemo(() => {
    let open = 0, acked = 0, suppressed = 0;
    for (const r of stalePunchRows) {
      const st = punchAlertStatuses[r.clientId];
      if (st?.status === 'ACKNOWLEDGED') acked++;
      else if (st?.status === 'SUPPRESSED') suppressed++;
      else open++;
    }
    return { open, acked, suppressed };
  }, [stalePunchRows, punchAlertStatuses]);

  function punchAgeLabel(r: any): string {
    const dbNow = parseDb2Ts(r.dbCurrentTime);
    const last  = parseDb2Ts(r.lastUpdateTime);
    if (!dbNow || !last) return '?';
    const mins = Math.floor((dbNow.getTime() - last.getTime()) / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  }

  // ---- Suppress modal state ----
  const [suppressTarget, setSuppressTarget] = useState<EscalatedAlert | null>(null);
  const [suppressMinutes, setSuppressMinutes] = useState(getInt('threshold.defaultSuppressMins', 60));
  const [suppressReason, setSuppressReason] = useState('');

  // ---- Punch suppress modal state ----
  const [punchSuppressTarget, setPunchSuppressTarget] = useState<{ clientId: string; name: string } | null>(null);
  const [punchSuppressMinutes, setPunchSuppressMinutes] = useState(getInt('threshold.defaultSuppressMins', 60));
  const [punchSuppressReason, setPunchSuppressReason] = useState('');

  // ---- Recipients modal ----
  const [showRecipients, setShowRecipients] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  // ---- Notify result banner ----
  const [notifyResult, setNotifyResult] = useState<{
    type: 'success' | 'error' | 'warning';
    message: string;
    details?: string[];
  } | null>(null);

  // ---- Data ----
  const { data: allBatchData, isLoading: batchLoading, dataUpdatedAt: batchUpdatedAt } = useAllClientsBatchData();
  const { data: escalated = [], isLoading: escLoading } = useEscalatedAlerts();

  const { data: recipients = [] } = useQuery<Recipient[]>({
    queryKey: ['escalation-recipients'],
    queryFn: async () => { const r = await escalationsApi.getRecipients(); return (r.data ?? []) as Recipient[]; },
    enabled: showRecipients,
  });

  // ---- Global filter ----
  const { selectedCluster, selectedClientId, clients: globalClients } = useGlobalFilter();
  const selectedClientCode = useMemo(() => {
    if (!selectedClientId) return '';
    return globalClients.find(c => c.id === selectedClientId)?.clientId ?? '';
  }, [selectedClientId, globalClients]);

  // ---- Derived ----
  const pendingAlerts = useMemo(() => {
    const all = allBatchData?.pendingAlerts ?? [];
    if (selectedClientCode) return all.filter(a => a.clientId === selectedClientCode);
    if (selectedCluster) return all.filter(a => a.cluster === selectedCluster);
    return all;
  }, [allBatchData, selectedCluster, selectedClientCode]);

  const filteredEscalated = useMemo(() => {
    if (selectedClientCode) return escalated.filter(a => a.clientId === selectedClientCode);
    if (selectedCluster) return escalated.filter(a => a.cluster === selectedCluster);
    return escalated;
  }, [escalated, selectedCluster, selectedClientCode]);

  const openAlerts = filteredEscalated.filter(a => a.status === 'OPEN');
  const ackedAlerts = filteredEscalated.filter(a => a.status === 'ACKNOWLEDGED');
  const suppressedAlerts = filteredEscalated.filter(a => a.status === 'SUPPRESSED');

  const notifiableOpenAlerts = useMemo(
    () => openAlerts.filter(a => isNotifyEligible(a.emailSentAt, notifyCooldownMins)),
    [openAlerts, notifyCooldownMins, notifyTick]
  );

  const notifiablePunchRows = useMemo(
    () => stalePunchRows.filter(r => {
      const sentAt = punchAlertStatuses[r.clientId]?.emailSentAt;
      return isNotifyEligible(sentAt, notifyCooldownMins);
    }),
    [stalePunchRows, punchAlertStatuses, notifyCooldownMins, notifyTick]
  );

  // ---- Mutations ----
  const invalidateEsc = () => queryClient.invalidateQueries({ queryKey: ['escalated-alerts'] });
  const invalidatePunchStatuses = () => queryClient.invalidateQueries({ queryKey: ['punch-alert-statuses'] });

  const ackMut = useMutation({
    mutationFn: (id: string) => escalationsApi.acknowledge(id),
    onSuccess: invalidateEsc,
  });

  const suppressMut = useMutation({
    mutationFn: ({ id, mins, reason }: { id: string; mins: number; reason: string }) =>
      escalationsApi.suppress(id, mins, undefined, reason),
    onSuccess: () => { invalidateEsc(); setSuppressTarget(null); setSuppressMinutes(60); setSuppressReason(''); },
  });

  const notifyPunchMut = useMutation({
    mutationFn: (rows: any[]) => escalationsApi.notifyPunch(rows),
    onSuccess: (res: any) => {
      invalidatePunchStatuses();
      const d = res?.data;
      if (!d) return;
      if (d.error) {
        setNotifyResult({ type: 'error', message: d.error });
      } else if (d.sent > 0) {
        setNotifyResult({
          type: 'success',
          message: `Unproc punch alert email sent to ${d.recipients?.length ?? 0} recipient(s) for ${d.sent} client(s).`,
          details: d.details,
        });
      } else {
        setNotifyResult({
          type: 'warning',
          message: d.details?.[0] ?? 'No recipients or rows to notify.',
        });
      }
    },
    onError: (err: any) => {
      setNotifyResult({ type: 'error', message: err?.response?.data?.error ?? err.message ?? 'Failed to send notification' });
    },
  });

  const punchAckMut = useMutation({
    mutationFn: (clientId: string) => escalationsApi.acknowledgePunch(clientId),
    onSuccess: invalidatePunchStatuses,
  });

  const punchSuppressMut = useMutation({
    mutationFn: ({ clientId, mins, reason }: { clientId: string; mins: number; reason: string }) =>
      escalationsApi.suppressPunch(clientId, mins, undefined, reason),
    onSuccess: () => { invalidatePunchStatuses(); setPunchSuppressTarget(null); setPunchSuppressMinutes(60); setPunchSuppressReason(''); },
  });

  const notifyMut = useMutation({
    mutationFn: (ids?: string[]) => escalationsApi.notify(ids),
    onSuccess: (res: any) => {
      invalidateEsc();
      const d = res?.data;
      if (!d) return;
      if (d.error) {
        setNotifyResult({ type: 'error', message: d.error, details: d.details });
      } else if (d.sent > 0) {
        setNotifyResult({
          type: 'success',
          message: `Email sent to ${d.recipients?.length ?? d.sent} recipient(s) for ${d.sent} alert(s).`,
          details: d.details,
        });
      } else if (d.skipped > 0) {
        setNotifyResult({
          type: 'warning',
          message: d.details?.[0] ?? 'No alerts required notification at this time.',
          details: d.details,
        });
      }
    },
    onError: (err: any) => {
      setNotifyResult({
        type: 'error',
        message: err?.response?.data?.error ?? err.message ?? 'Failed to send notification',
      });
    },
  });

  const addRecipMut = useMutation({
    mutationFn: ({ name, email }: { name: string; email: string }) => escalationsApi.addRecipient(name, email),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['escalation-recipients'] }); setNewName(''); setNewEmail(''); },
  });

  const removeRecipMut = useMutation({
    mutationFn: (id: string) => escalationsApi.removeRecipient(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['escalation-recipients'] }),
  });

  const toggleRecipMut = useMutation({
    mutationFn: (id: string) => escalationsApi.toggleRecipient(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['escalation-recipients'] }),
  });

  const testEmailMut = useMutation({
    mutationFn: () => escalationsApi.testEmail(),
    onSuccess: (res: any) => {
      const d = res?.data;
      if (d?.error && !d?.sent) {
        setNotifyResult({ type: 'error', message: d.error, details: d.details });
      } else if (d?.sent) {
        setNotifyResult({
          type: 'success',
          message: `Test email sent to ${d.recipients?.length ?? 0} recipient(s). Check Mailpit at http://localhost:8025`,
          details: d.details,
        });
      }
    },
    onError: (err: any) => {
      setNotifyResult({
        type: 'error',
        message: err?.response?.data?.error ?? err.message ?? 'Test email failed',
      });
    },
  });

  // ============================================================
  return (
    <div className="p-6 space-y-6">

      {/* ---- Header ---- */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Alert Center</h1>
          <p className="text-sm text-gray-500 mt-1">Monitor pending jobs and escalated alerts</p>
        </div>
        {(canManageRecip || canNotify) && (
          <button
            onClick={() => setShowRecipients(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            <Mail className="w-4 h-4" /> {canManageRecip ? 'Manage Recipients' : 'Recipients'}
          </button>
        )}
      </div>

      {/* ---- Tabs ---- */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab('pending')}
          className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'pending' ? 'border-amber-500 text-amber-700' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <Clock className="w-4 h-4" />
          Pending Jobs
          {pendingAlerts.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-bold rounded-full bg-amber-100 text-amber-700">
              {pendingAlerts.reduce((s: number, a: any) => s + a.stalePendingCount, 0)}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('escalated')}
          className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'escalated' ? 'border-amber-500 text-amber-700' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          Escalated (&gt;{getInt('threshold.escalationMins', 60)} min)
          {(openAlerts.length + punchStatusCounts.open + punchStatusCounts.acked) > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-medium rounded-full bg-amber-50 text-amber-600">
              {openAlerts.length + punchStatusCounts.open + punchStatusCounts.acked}
            </span>
          )}
        </button>

        {showUnprocPunchTab && (
          <button
            onClick={() => setActiveTab('unproc-punch')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'unproc-punch' ? 'border-amber-500 text-amber-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Timer className="w-4 h-4" />
            Unproc Punch
            {stalePunchRows.length > 0 && (
              <span className="px-1.5 py-0.5 text-xs font-bold rounded-full bg-amber-100 text-amber-700">
                {stalePunchRows.length}
              </span>
            )}
          </button>
        )}
      </div>

      {/* ================ PENDING TAB ================ */}
      {activeTab === 'pending' && (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-3">
            <Clock className="w-5 h-5 text-amber-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800">Jobs pending for more than 30 minutes across all clients</p>
              <p className="text-xs text-amber-600 mt-0.5">
                {batchUpdatedAt > 0
                  ? `Data as of ${fmt(new Date(batchUpdatedAt).toISOString(), 'time')} · Auto-refreshes every 30 min`
                  : 'Loading batch data...'}
              </p>
            </div>
          </div>

          {batchLoading && !allBatchData ? (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <Database className="w-10 h-10 mx-auto mb-3 text-gray-300 animate-pulse" />
              <p>Loading batch data from all clients...</p>
            </div>
          ) : !pendingAlerts.length ? (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <Bell className="w-10 h-10 mx-auto mb-3 text-gray-300" />
              <p className="text-lg font-medium text-gray-500">No pending job alerts</p>
              <p className="text-sm mt-1">All batch jobs are running on schedule</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1">Affected Clients</p>
                  <p className="text-2xl font-bold text-amber-600">{pendingAlerts.length}</p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-400" />Stale Pending (&gt;30min)</p>
                  <p className="text-2xl font-semibold text-amber-600">
                    {pendingAlerts.reduce((s: number, a: any) => s + a.stalePendingCount, 0)}
                  </p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1">Total Pending</p>
                  <p className="text-2xl font-bold text-gray-700">
                    {pendingAlerts.reduce((s: number, a: any) => s + a.totalPending, 0)}
                  </p>
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <table className="w-full resizable-cols" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '22%' }}>Client</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '35%' }}>Pending Job Types</th>
                      <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '15%' }}>Pending &gt;30min</th>
                      <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '13%' }}>Total Pending</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '15%' }}>Severity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {pendingAlerts.map((a: any) => {
                      const clientGroups = allBatchData?.clients?.[a.clientId]?.groups ?? [];
                      const pendingTypes = clientGroups
                        .filter(g => g.pending > 0 || g.stalePending > 0)
                        .map(g => ({ type: g.jobType, pending: g.pending, stale: g.stalePending }));
                      return (
                      <tr key={a.clientId} className="hover:bg-gray-50">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <Database className="w-4 h-4 text-indigo-400" />
                            <span className="text-sm font-medium text-gray-800">{a.clientName || a.clientId}</span>
                            {a.clientName && a.clientName !== a.clientId && (
                              <span className="text-xs text-gray-400">{a.clientId}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {pendingTypes.length > 0 ? pendingTypes.map(t => (
                              <span key={t.type} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                                {t.type}
                                {t.stale > 0
                                  ? <span className="text-red-500 font-bold">{t.stale}</span>
                                  : <span className="text-amber-500 font-bold">{t.pending}</span>
                                }
                              </span>
                            )) : (
                              <span className="text-xs text-gray-300">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-sm font-bold">{a.stalePendingCount}</span>
                        </td>
                        <td className="px-5 py-3 text-right text-sm text-gray-600">{a.totalPending}</td>
                        <td className="px-5 py-3">
                          {a.stalePendingCount >= getInt('threshold.stalePendingCritical', 10) ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">CRITICAL</span>
                          ) : a.stalePendingCount >= getInt('threshold.stalePendingWarning', 5) ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">WARNING</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">INFO</span>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================ ESCALATED TAB (RED) ================ */}
      {activeTab === 'escalated' && (
        <div className="space-y-4">
          {/* Banner */}
          <div className="bg-amber-50/60 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-700">Alerts pending for more than {getInt('threshold.escalationMins', 60)} minutes — requires attention</p>
                <p className="text-xs text-gray-500 mt-0.5">Acknowledge, suppress, or notify your team via email.</p>
              </div>
            </div>
            {canNotify && notifiableOpenAlerts.length > 0 && (
              <button
                onClick={() => { setNotifyResult(null); notifyMut.mutate(notifiableOpenAlerts.map(a => a.id)); }}
                disabled={notifyMut.isPending}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-amber-700 bg-amber-100 rounded-lg hover:bg-amber-200 disabled:opacity-50 flex-shrink-0"
              >
                <Send className="w-4 h-4" />
                {notifyMut.isPending ? 'Sending...' : 'Notify Team'}
              </button>
            )}
          </div>

          {/* Notify result banner */}
          {notifyResult && (
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
              notifyResult.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
              notifyResult.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' :
              'bg-red-50 border-red-200 text-red-800'
            }`}>
              {notifyResult.type === 'success'
                ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-green-600" />
                : notifyResult.type === 'warning'
                ? <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
                : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
              }
              <div className="flex-1 min-w-0">
                <p className="font-medium">{notifyResult.message}</p>
                {notifyResult.details && notifyResult.details.length > 1 && (
                  <ul className="mt-1 space-y-0.5 text-xs opacity-80">
                    {notifyResult.details.map((d, i) => <li key={i}>• {d}</li>)}
                  </ul>
                )}
              </div>
              <button onClick={() => setNotifyResult(null)} className="p-1 hover:opacity-70 flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {escLoading ? (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-gray-300 animate-pulse" />
              <p>Checking for escalated alerts...</p>
            </div>
          ) : escalated.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-300" />
              <p className="text-lg font-medium text-gray-500">No escalated alerts</p>
              <p className="text-sm mt-1">No alerts have been pending for more than 1 hour</p>
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-amber-200 p-4">
                  <p className="text-sm text-gray-500 mb-1 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-400" />Open (Needs Action)</p>
                  <p className="text-2xl font-semibold text-amber-600">{openAlerts.length}</p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1">Acknowledged</p>
                  <p className="text-2xl font-bold text-blue-600">{ackedAlerts.length}</p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1">Suppressed</p>
                  <p className="text-2xl font-bold text-gray-500">{suppressedAlerts.length}</p>
                </div>
              </div>

              {/* Escalated alerts table */}
              <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <table className="w-full resizable-cols" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '15%' }}>Client</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '8%' }}>Cluster</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '22%' }}>Pending Job Types</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '8%' }}>Stale</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '7%' }}>Total</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '13%' }}>Status</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '11%' }}>Since</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase" style={{ width: '6%' }}>Email</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '10%' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {escalated.map(a => {
                      const clientGroups = allBatchData?.clients?.[a.clientId]?.groups ?? [];
                      const pendingTypes = clientGroups
                        .filter(g => g.stalePending > 0)
                        .map(g => ({ type: g.jobType, pending: g.pending, stale: g.stalePending }));
                      return (
                      <tr
                        key={a.id}
                        className={
                          a.status === 'OPEN' ? 'bg-red-50/50 hover:bg-red-50' :
                          a.status === 'SUPPRESSED' ? 'bg-gray-50/60 opacity-60 hover:opacity-80' :
                          'hover:bg-gray-50'
                        }
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Database className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-800 truncate block">{a.clientName}</span>
                              {a.clientName !== a.clientId && (
                                <span className="text-xs text-gray-400">{a.clientId}</span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">{a.cluster || '–'}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {pendingTypes.length > 0 ? pendingTypes.map(t => (
                              <span key={t.type} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                                {t.type}
                                {t.stale > 0
                                  ? <span className="text-red-500 font-bold">{t.stale}</span>
                                  : <span className="text-amber-500 font-bold">{t.pending}</span>
                                }
                              </span>
                            )) : (
                              <span className="text-xs text-gray-300">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 text-sm font-medium"><AlertTriangle className="w-3 h-3" />{a.stalePendingCount}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-600">{a.totalPending}</td>
                        <td className="px-4 py-3">
                          {a.status === 'OPEN' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600"><Clock className="w-3 h-3" />OPEN</span>}
                          {a.status === 'ACKNOWLEDGED' && (
                            <div>
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">ACK</span>
                              {a.acknowledgedBy && <p className="text-xs text-gray-400 mt-0.5">by {a.acknowledgedBy}</p>}
                            </div>
                          )}
                          {a.status === 'SUPPRESSED' && (
                            <div>
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">SUPPRESSED</span>
                              {a.suppressUntil && <p className="text-xs text-gray-400 mt-0.5">until {fmt(a.suppressUntil)}</p>}
                              {a.suppressReason && <p className="text-xs text-gray-400">{a.suppressReason}</p>}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{fmt(a.firstSeenAt)}</td>
                        <td className="px-4 py-3 text-center text-xs">
                          {a.emailSentAt
                            ? (() => {
                                const minsLeft = minutesUntilNotifyEligible(a.emailSentAt, notifyCooldownMins);
                                const inCooldown = minsLeft > 0;
                                return (
                                  <span
                                    className={`inline-flex items-center gap-1 ${inCooldown ? 'text-green-500' : 'text-gray-400'}`}
                                    title={inCooldown
                                      ? `Sent ${fmt(a.emailSentAt)} — notify again in ${minsLeft} min`
                                      : `Sent ${fmt(a.emailSentAt)} — notify available`}
                                  >
                                    <CheckCircle className="w-3 h-3" />Sent
                                  </span>
                                );
                              })()
                            : <span className="text-gray-300">–</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {(a.status === 'OPEN' || a.status === 'ACKNOWLEDGED') && (
                              <>
                                {canAck && a.status === 'OPEN' && (
                                  <button onClick={() => ackMut.mutate(a.id)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg" title="Acknowledge">
                                    <CheckCircle className="w-4 h-4" />
                                  </button>
                                )}
                                {canSuppress && (
                                  <button onClick={() => setSuppressTarget(a)} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded-lg" title="Suppress">
                                    <BellOff className="w-4 h-4" />
                                  </button>
                                )}
                                {canNotify && a.status === 'OPEN' && isNotifyEligible(a.emailSentAt, notifyCooldownMins) && (
                                  <button onClick={() => { setNotifyResult(null); notifyMut.mutate([a.id]); }} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg" title="Send email">
                                    <Send className="w-4 h-4" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ---- UNPROC PUNCH ALERTS SECTION (in Escalated tab) ---- */}
          {stalePunchRows.length > 0 && (
            <>
              <div className="border-t pt-6 mt-6">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
                  <Timer className="w-5 h-5 text-amber-500" />
                  Unproc Punch Alerts
                  <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-amber-100 text-amber-700">{stalePunchRows.length}</span>
                </h3>
                
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Timer className="w-5 h-5 text-amber-500 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-amber-800">Clients with &gt;{getInt('threshold.punchCountMin', 100)} unprocessed punches stale for &gt;{getInt('threshold.staleHoursMins', 60)} minutes</p>
                      <p className="text-xs text-amber-600 mt-0.5">Acknowledge, suppress, or notify your team.</p>
                    </div>
                  </div>
                  {canNotify && notifiablePunchRows.length > 0 && (
                    <button
                      onClick={() => { setNotifyResult(null); notifyPunchMut.mutate(notifiablePunchRows); }}
                      disabled={notifyPunchMut.isPending}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white transition-colors flex-shrink-0"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {notifyPunchMut.isPending ? 'Sending…' : 'Notify Team'}
                    </button>
                  )}
                </div>

                {/* Summary cards for punch alerts */}
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="bg-white rounded-xl border border-amber-200 p-4">
                    <p className="text-sm text-gray-500 mb-1 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-400" />Open (Needs Action)</p>
                    <p className="text-2xl font-semibold text-amber-600">{punchStatusCounts.open}</p>
                  </div>
                  <div className="bg-white rounded-xl border p-4">
                    <p className="text-sm text-gray-500 mb-1">Acknowledged</p>
                    <p className="text-2xl font-bold text-blue-600">{punchStatusCounts.acked}</p>
                  </div>
                  <div className="bg-white rounded-xl border p-4">
                    <p className="text-sm text-gray-500 mb-1">Suppressed</p>
                    <p className="text-2xl font-bold text-gray-500">{punchStatusCounts.suppressed}</p>
                  </div>
                </div>

                {/* Punch alerts table */}
                <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                  <table className="w-full text-sm resizable-cols" style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '20%' }}>Client</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '12%' }}>Cluster</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '12%' }}>Pending</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '20%' }}>Last Update</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '12%' }}>Stale For</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '18%' }}>Status</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '6%' }}></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {stalePunchRows.map((r: any) => {
                        const st = punchAlertStatuses[r.clientId];
                        const status = st?.status || 'OPEN';
                        return (
                        <tr
                          key={r.clientId}
                          className={
                            status === 'OPEN' ? 'bg-red-50/50 hover:bg-red-50' :
                            status === 'SUPPRESSED' ? 'bg-gray-50/60 opacity-60 hover:opacity-80' :
                            'hover:bg-gray-50'
                          }
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <Database className="w-4 h-4 text-indigo-400" />
                              <div className="min-w-0">
                                <span className="text-sm font-medium text-gray-800 truncate block">{r.name && r.name !== r.clientId ? r.name : r.clientId}</span>
                                {r.name && r.name !== r.clientId && <span className="text-xs text-gray-400">{r.clientId}</span>}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-500">{r.cluster || '–'}</td>
                          <td className="px-4 py-3 text-right">
                            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold">{r.punchCount.toLocaleString()}</span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.lastUpdateTime ?? '–'}</td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                              <Clock className="w-3 h-3" />{punchAgeLabel(r)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {status === 'OPEN' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600"><Clock className="w-3 h-3" />OPEN</span>}
                            {status === 'ACKNOWLEDGED' && (
                              <div>
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">ACK</span>
                                {st?.acknowledgedBy && <p className="text-xs text-gray-400 mt-0.5">by {st.acknowledgedBy}</p>}
                              </div>
                            )}
                            {status === 'SUPPRESSED' && (
                              <div>
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">SUPPRESSED</span>
                                {st?.suppressUntil && <p className="text-xs text-gray-400 mt-0.5">until {fmt(st.suppressUntil)}</p>}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              {(status === 'OPEN' || status === 'ACKNOWLEDGED') && (
                                <>
                                  {canAck && status === 'OPEN' && (
                                    <button onClick={() => punchAckMut.mutate(r.clientId)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg" title="Acknowledge">
                                      <CheckCircle className="w-4 h-4" />
                                    </button>
                                  )}
                                  {canSuppress && (
                                    <button onClick={() => setPunchSuppressTarget({ clientId: r.clientId, name: r.name || r.clientId })} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded-lg" title="Suppress">
                                      <BellOff className="w-4 h-4" />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================ UNPROC PUNCH TAB ================ */}
      {showUnprocPunchTab && activeTab === 'unproc-punch' && (
        <div className="space-y-4">
          {/* Banner */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-3">
            <Timer className="w-5 h-5 text-amber-500 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">Clients with &gt;{getInt('threshold.punchCountMin', 100)} unprocessed punches stale for more than {getInt('threshold.staleHoursMins', 60)} minutes</p>
              <p className="text-xs text-amber-600 mt-0.5">Acknowledge, suppress, or notify your team via email.</p>
            </div>
            {canNotify && notifiablePunchRows.length > 0 && (
              <button
                onClick={() => notifyPunchMut.mutate(notifiablePunchRows)}
                disabled={notifyPunchMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                {notifyPunchMut.isPending ? 'Sending…' : 'Notify Team'}
              </button>
            )}
          </div>

          {/* Notify result banner */}
          {activeTab === 'unproc-punch' && notifyResult && (
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
              notifyResult.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
              notifyResult.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' :
              'bg-red-50 border-red-200 text-red-800'
            }`}>
              {notifyResult.type === 'success'
                ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-green-600" />
                : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              }
              <div className="flex-1 min-w-0">
                <p className="font-medium">{notifyResult.message}</p>
                {notifyResult.details && notifyResult.details.length > 1 && (
                  <ul className="mt-1 space-y-0.5 text-xs opacity-80">
                    {notifyResult.details.map((d, i) => <li key={i}>• {d}</li>)}
                  </ul>
                )}
              </div>
              <button onClick={() => setNotifyResult(null)} className="p-1 hover:opacity-70 flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {allPunchRows.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <Timer className="w-10 h-10 mx-auto mb-3 text-gray-300 animate-pulse" />
              <p>Punch data not loaded yet — visit the Unprocessed Punch page to fetch.</p>
            </div>
          ) : stalePunchRows.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
              <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-300" />
              <p className="text-lg font-medium text-gray-500">No stale unprocessed punches</p>
              <p className="text-sm mt-1">All pending punches have been updated within the last hour</p>
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-amber-200 p-4">
                  <p className="text-sm text-gray-500 mb-1 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-400" />Open (Needs Action)</p>
                  <p className="text-2xl font-semibold text-amber-600">{punchStatusCounts.open}</p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1">Acknowledged</p>
                  <p className="text-2xl font-bold text-blue-600">{punchStatusCounts.acked}</p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                  <p className="text-sm text-gray-500 mb-1">Suppressed</p>
                  <p className="text-2xl font-bold text-gray-500">{punchStatusCounts.suppressed}</p>
                </div>
              </div>

              {/* Punch alerts table */}
              <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <table className="w-full text-sm resizable-cols" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '18%' }}>Client</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '10%' }}>Cluster</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '10%' }}>Pending</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '18%' }}>Last Update Time</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '10%' }}>Stale For</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" style={{ width: '20%' }}>Status</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase" style={{ width: '14%' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {stalePunchRows.map((r: any) => {
                      const st = punchAlertStatuses[r.clientId];
                      const status = st?.status || 'OPEN';
                      return (
                      <tr
                        key={r.clientId}
                        className={
                          status === 'OPEN' ? 'bg-red-50/50 hover:bg-red-50' :
                          status === 'SUPPRESSED' ? 'bg-gray-50/60 opacity-60 hover:opacity-80' :
                          'hover:bg-gray-50'
                        }
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Database className="w-4 h-4 text-indigo-400" />
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-800 truncate block">{r.name && r.name !== r.clientId ? r.name : r.clientId}</span>
                              {r.name && r.name !== r.clientId && <span className="text-xs text-gray-400">{r.clientId}</span>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-500">{r.cluster || '–'}</td>
                        <td className="px-4 py-3 text-right">
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold">{r.punchCount.toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.lastUpdateTime ?? '–'}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                            <Clock className="w-3 h-3" />{punchAgeLabel(r)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {status === 'OPEN' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600"><Clock className="w-3 h-3" />OPEN</span>}
                          {status === 'ACKNOWLEDGED' && (
                            <div>
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">ACK</span>
                              {st?.acknowledgedBy && <p className="text-xs text-gray-400 mt-0.5">by {st.acknowledgedBy}</p>}
                            </div>
                          )}
                          {status === 'SUPPRESSED' && (
                            <div>
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">SUPPRESSED</span>
                              {st?.suppressUntil && <p className="text-xs text-gray-400 mt-0.5">until {fmt(st.suppressUntil)}</p>}
                              {st?.suppressReason && <p className="text-xs text-gray-400">{st.suppressReason}</p>}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {(status === 'OPEN' || status === 'ACKNOWLEDGED') && (
                              <>
                                {canAck && status === 'OPEN' && (
                                  <button onClick={() => punchAckMut.mutate(r.clientId)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg" title="Acknowledge">
                                    <CheckCircle className="w-4 h-4" />
                                  </button>
                                )}
                                {canSuppress && (
                                  <button onClick={() => setPunchSuppressTarget({ clientId: r.clientId, name: r.name && r.name !== r.clientId ? r.name : r.clientId })} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded-lg" title="Suppress">
                                    <BellOff className="w-4 h-4" />
                                  </button>
                                )}
                                {canNotify && status === 'OPEN' && isNotifyEligible(st?.emailSentAt, notifyCooldownMins) && (
                                  <button onClick={() => { setNotifyResult(null); notifyPunchMut.mutate([r]); }} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg" title="Send email for this client">
                                    <Send className="w-4 h-4" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================ SUPPRESS MODAL ================ */}
      {suppressTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Suppress Alert</h3>
              <button onClick={() => setSuppressTarget(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600">
              Suppress alerts for <strong>{suppressTarget.clientName}</strong> ({suppressTarget.clientId})
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Duration</label>
              <select
                value={suppressMinutes}
                onChange={e => setSuppressMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              >
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
                <option value={240}>4 hours</option>
                <option value={480}>8 hours</option>
                <option value={1440}>24 hours</option>
                <option value={4320}>3 days</option>
                <option value={10080}>7 days</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason (optional)</label>
              <input
                type="text"
                value={suppressReason}
                onChange={e => setSuppressReason(e.target.value)}
                placeholder="e.g. Planned maintenance, Known issue..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setSuppressTarget(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button
                onClick={() => suppressMut.mutate({ id: suppressTarget.id, mins: suppressMinutes, reason: suppressReason })}
                disabled={suppressMut.isPending}
                className="px-4 py-2 text-sm text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                {suppressMut.isPending ? 'Suppressing...' : 'Suppress'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================ PUNCH SUPPRESS MODAL ================ */}
      {punchSuppressTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Suppress Punch Alert</h3>
              <button onClick={() => setPunchSuppressTarget(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600">
              Suppress punch alerts for <strong>{punchSuppressTarget.name}</strong> ({punchSuppressTarget.clientId})
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Duration</label>
              <select
                value={punchSuppressMinutes}
                onChange={e => setPunchSuppressMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              >
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
                <option value={240}>4 hours</option>
                <option value={480}>8 hours</option>
                <option value={1440}>24 hours</option>
                <option value={4320}>3 days</option>
                <option value={10080}>7 days</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason (optional)</label>
              <input
                type="text"
                value={punchSuppressReason}
                onChange={e => setPunchSuppressReason(e.target.value)}
                placeholder="e.g. Planned maintenance, Known issue..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPunchSuppressTarget(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button
                onClick={() => punchSuppressMut.mutate({ clientId: punchSuppressTarget.clientId, mins: punchSuppressMinutes, reason: punchSuppressReason })}
                disabled={punchSuppressMut.isPending}
                className="px-4 py-2 text-sm text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                {punchSuppressMut.isPending ? 'Suppressing...' : 'Suppress'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================ RECIPIENTS MODAL ================ */}
      {showRecipients && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Notification Recipients</h3>
              <button onClick={() => setShowRecipients(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-500">Team members who receive email when alerts are escalated.</p>

            {canNotify && (
              <button
                type="button"
                onClick={() => { setNotifyResult(null); testEmailMut.mutate(); }}
                disabled={testEmailMut.isPending}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                {testEmailMut.isPending ? 'Sending test…' : 'Send test email (Mailpit)'}
              </button>
            )}

            {canManageRecip && (
              <div className="flex gap-2">
                <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="email@zebra.com"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <button
                  onClick={() => { if (newName && newEmail) addRecipMut.mutate({ name: newName, email: newEmail }); }}
                  disabled={!newName || !newEmail || addRecipMut.isPending}
                  className="px-3 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* List */}
            <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
              {recipients.map(r => (
                <div key={r.id} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-3">
                    {canManageRecip ? (
                      <button onClick={() => toggleRecipMut.mutate(r.id)} className="text-gray-400 hover:text-gray-600"
                        title={r.isActive ? 'Active — click to disable' : 'Inactive — click to enable'}>
                        <div className={`w-8 h-5 rounded-full flex items-center transition-colors ${r.isActive ? 'bg-green-500 justify-end' : 'bg-gray-300 justify-start'}`}>
                          <div className="w-4 h-4 m-0.5 bg-white rounded-full shadow" />
                        </div>
                      </button>
                    ) : (
                      <div className={`w-8 h-5 rounded-full flex items-center ${r.isActive ? 'bg-green-500 justify-end' : 'bg-gray-300 justify-start'}`}>
                        <div className="w-4 h-4 m-0.5 bg-white rounded-full shadow" />
                      </div>
                    )}
                    <div>
                      <p className={`text-sm font-medium ${r.isActive ? 'text-gray-800' : 'text-gray-400'}`}>{r.name}</p>
                      <p className={`text-xs ${r.isActive ? 'text-gray-500' : 'text-gray-300'}`}>{r.email}</p>
                    </div>
                  </div>
                  {canManageRecip && (
                    <button onClick={() => removeRecipMut.mutate(r.id)} className="text-gray-300 hover:text-red-500">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              {recipients.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No recipients configured yet</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
