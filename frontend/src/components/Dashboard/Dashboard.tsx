import React, { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Server, Database, CheckCircle, Clock, AlertTriangle,
  Activity, Briefcase, ArrowRight, Loader2, Timer, Bell,
  Settings, Eye, EyeOff, X,
} from 'lucide-react';
import { jobsApi, unprocessedPunchApi, escalationsApi } from '../../services/api';
import { useAllClientsBatchData } from '../../hooks/useAllClientsBatchData';
import { useTimezone } from '../../hooks/useTimezone';

// ---- Widget registry ----
type WidgetId =
  | 'escalated-alerts'
  | 'unproc-punch'
  | 'db2-stats'
  | 'batch-summary'
  | 'pending-jobs'
  | 'cron-stats'
  | 'upcoming-jobs';

const WIDGET_LABELS: Record<WidgetId, string> = {
  'escalated-alerts': 'Escalated Alerts',
  'unproc-punch':     'Unprocessed Punches',
  'db2-stats':        'DB2 Stat Cards',
  'batch-summary':    'Batch Summary',
  'pending-jobs':     'Pending Jobs >30min',
  'cron-stats':       'Cron Job Stat Cards',
  'upcoming-jobs':    'Upcoming Jobs',
};

const LS_KEY = 'dashboard_hidden_widgets';

function loadHidden(): Set<WidgetId> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? new Set(JSON.parse(raw) as WidgetId[]) : new Set();
  } catch { return new Set(); }
}

export default function Dashboard() {
  const { data: allBatchData, isLoading: batchLoading, dataUpdatedAt: batchUpdatedAt } = useAllClientsBatchData();

  const { data: jobsData } = useQuery({
    queryKey: ['jobs-all'],
    queryFn: () => jobsApi.list({ pageSize: 10000 }),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const { data: upcomingData } = useQuery({
    queryKey: ['upcoming-jobs'],
    queryFn: () => jobsApi.getUpcoming(2),
    staleTime: 30 * 60 * 1000,
  });

  const { data: punchRes, isLoading: punchLoading, error: punchError } = useQuery({
    queryKey: ['unprocessed-punch-all'],
    queryFn: () => unprocessedPunchApi.getAll(),
    staleTime: Infinity,          // Never auto-refetch — background polling coordinator owns the schedule
    refetchOnMount: false,        // Don't re-fetch on navigation; use whatever is in cache
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const { data: escalatedData } = useQuery({
    queryKey: ['escalated-alerts'],
    queryFn: async () => { const r = await escalationsApi.getAll(); return r.data ?? []; },
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const cronJobs     = (jobsData?.data || []) as any[];
  const upcomingJobs = (upcomingData?.data?.jobs || []) as any[];
  const { fmt } = useTimezone();

  // ---- Batch stats ----
  const totalBatchRuns = useMemo(() =>
    !allBatchData?.clients ? 0 :
    Object.values(allBatchData.clients).reduce((s, c) => s + (c.groups?.reduce((g, gr) => g + gr.totalRuns, 0) || 0), 0),
  [allBatchData]);
  const totalStalePending = allBatchData?.pendingAlerts?.reduce((s, a) => s + a.stalePendingCount, 0) || 0;
  const affectedClients   = allBatchData?.pendingAlerts?.length || 0;
  const clientErrorCount  = allBatchData ? Object.values(allBatchData.clients).filter(c => c.error).length : 0;
  const activeJobs   = cronJobs.filter((j: any) => j.isActive).length;
  const inactiveJobs = cronJobs.length - activeJobs;

  // ---- Punch stats ----
  const allPunchRows: any[]    = (punchRes as any)?.data ?? [];
  const totalUnprocPunches     = allPunchRows.reduce((s, r) => s + (r.punchCount ?? 0), 0);
  const clientsOver100         = allPunchRows.filter(r => (r.punchCount ?? 0) > 100).length;
  function parseDb2Ts(s: string | null): Date | null {
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    return new Date(s);
  }
  const stalePunchClients = useMemo(() => allPunchRows.filter(r => {
    if (!r.punchCount || r.punchCount <= 100 || r.error) return false;
    const dbNow = parseDb2Ts(r.dbCurrentTime);
    const last  = parseDb2Ts(r.lastUpdateTime);
    return dbNow && last && (dbNow.getTime() - last.getTime()) > 60 * 60 * 1000;
  }), [allPunchRows]);

  // ---- Alert stats ----
  const escalatedAlerts: any[] = (escalatedData as any) ?? [];
  const openAlerts     = escalatedAlerts.filter(a => a.status === 'OPEN');
  const criticalAlerts = openAlerts.filter(a => a.stalePendingCount >= 10);

  // ---- Widget visibility ----
  const [hidden, setHidden] = useState<Set<WidgetId>>(loadHidden);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const show = (id: WidgetId) => !hidden.has(id);

  const toggleWidget = (id: WidgetId) => {
    setHidden(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(LS_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  };

  return (
    <div className="p-6 space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            WFM Watch Overview
            {batchUpdatedAt > 0 && (
              <span className="ml-2 text-gray-400">. Data as of {fmt(new Date(batchUpdatedAt).toISOString(), 'time')}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <Activity className="w-4 h-4 text-green-500 animate-pulse" /> Live
          </div>
          <button
            onClick={() => setCustomizeOpen(o => !o)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              customizeOpen
                ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-800'
            }`}
          >
            <Settings className="w-3.5 h-3.5" /> Customize
          </button>
        </div>
      </div>

      {/* ---- Customize panel ---- */}
      {customizeOpen && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Show / Hide Widgets</p>
            <button onClick={() => setCustomizeOpen(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(WIDGET_LABELS) as WidgetId[]).map(id => {
              const visible = !hidden.has(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleWidget(id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    visible
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100'
                      : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'
                  }`}
                >
                  {visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {WIDGET_LABELS[id]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== ROW 1: Alerts ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Escalated Alerts */}
        {show('escalated-alerts') && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <Bell className="w-4 h-4 text-red-500" />
                Escalated Alerts
                {openAlerts.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{openAlerts.length}</span>
                )}
              </h3>
              <Link to="/alerts" className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1">
                View Alerts <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className={`rounded-lg p-3 text-center ${openAlerts.length > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                  <div className={`text-2xl font-bold ${openAlerts.length > 0 ? 'text-red-600' : 'text-green-600'}`}>{openAlerts.length}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">Open</div>
                </div>
                <div className={`rounded-lg p-3 text-center ${criticalAlerts.length > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <div className={`text-2xl font-bold ${criticalAlerts.length > 0 ? 'text-red-700' : 'text-gray-400'}`}>{criticalAlerts.length}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">Critical (&ge;10)</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-gray-500">{escalatedAlerts.filter(a => a.status === 'ACKNOWLEDGED').length}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">Acknowledged</div>
                </div>
              </div>
              {openAlerts.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-green-600 bg-green-50 rounded-lg px-3 py-2">
                  <CheckCircle className="w-3.5 h-3.5" /> No open escalated alerts
                </div>
              ) : (
                <div className="divide-y divide-gray-50 max-h-48 overflow-auto rounded-lg border border-red-100">
                  {openAlerts.slice(0, 6).map((a: any) => (
                    <div key={a.id} className="px-4 py-2 flex items-center justify-between hover:bg-red-50/30">
                      <div className="flex items-center gap-2">
                        <Database className="w-3.5 h-3.5 text-indigo-400" />
                        <div>
                          <div className="text-xs font-medium text-gray-800">{a.clientName || a.clientId}</div>
                          {a.clientName && a.clientName !== a.clientId && <div className="text-[10px] text-gray-400">{a.clientId}</div>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-bold">{a.stalePendingCount}</span>
                        {a.stalePendingCount >= 10 && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-200 text-red-800">CRITICAL</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {openAlerts.length > 6 && (
                    <div className="px-4 py-2 text-center text-xs text-gray-400">+{openAlerts.length - 6} more</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Unprocessed Punches */}
        {show('unproc-punch') && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <Timer className="w-4 h-4 text-amber-500" />
                Unprocessed Punches
              </h3>
              <Link to="/unprocessed-punch" className="text-xs text-amber-600 hover:text-amber-800 flex items-center gap-1">
                View All <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            {punchLoading && allPunchRows.length === 0 ? (
              <div className="flex items-center gap-3 text-sm text-gray-400 py-4 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading...
              </div>
            ) : allPunchRows.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">
                <Timer className="w-7 h-7 mx-auto mb-2 text-gray-300 animate-pulse" />
                Visit the Unprocessed Punch page to load data
              </div>
            ) : (
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-gray-800">{totalUnprocPunches.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-400 mt-0.5">Total Pending</div>
                  </div>
                  <div className={`rounded-lg p-3 text-center ${clientsOver100 > 0 ? 'bg-amber-50' : 'bg-green-50'}`}>
                    <div className={`text-2xl font-bold ${clientsOver100 > 0 ? 'text-amber-700' : 'text-green-600'}`}>{clientsOver100}</div>
                    <div className="text-[10px] text-gray-400 mt-0.5">Clients &gt;100</div>
                  </div>
                  <div className={`rounded-lg p-3 text-center ${stalePunchClients.length > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                    <div className={`text-2xl font-bold ${stalePunchClients.length > 0 ? 'text-red-600' : 'text-green-600'}`}>{stalePunchClients.length}</div>
                    <div className="text-[10px] text-gray-400 mt-0.5">Stale &gt;1h</div>
                  </div>
                </div>
                {stalePunchClients.length > 0 ? (
                  <div className="divide-y divide-gray-50 max-h-48 overflow-auto rounded-lg border border-amber-100">
                    {stalePunchClients.slice(0, 5).map((r: any) => (
                      <div key={r.clientId} className="px-4 py-2 flex items-center justify-between hover:bg-amber-50/40">
                        <div className="flex items-center gap-2">
                          <Database className="w-3.5 h-3.5 text-indigo-400" />
                          <span className="text-xs font-medium text-gray-800">{r.name && r.name !== r.clientId ? r.name : r.clientId}</span>
                          {r.name && r.name !== r.clientId && <span className="text-[10px] text-gray-400">{r.clientId}</span>}
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">{r.punchCount?.toLocaleString()}</span>
                      </div>
                    ))}
                    {stalePunchClients.length > 5 && (
                      <div className="px-4 py-2 text-center text-xs text-gray-400">+{stalePunchClients.length - 5} more</div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-green-600 bg-green-50 rounded-lg px-3 py-2">
                    <CheckCircle className="w-3.5 h-3.5" /> No stale unprocessed punches
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== ROW 2: DB2 + Cron Jobs ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* LEFT: DB2 */}
        {(show('db2-stats') || show('batch-summary') || show('pending-jobs')) && (
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Database className="w-3.5 h-3.5" /> DB2 Monitoring
            </h2>

            {show('db2-stats') && (
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  title="Total Clients"
                  value={allBatchData ? Object.keys(allBatchData.clients).length : 0}
                  icon={<Server className="w-5 h-5" />}
                  color="blue"
                  subtitle={clientErrorCount > 0 ? `${clientErrorCount} with errors` : 'All responding'}
                />
                <StatCard
                  title="Pending > 30min"
                  value={totalStalePending}
                  icon={<AlertTriangle className="w-5 h-5" />}
                  color={totalStalePending > 0 ? 'amber' : 'green'}
                  subtitle={totalStalePending > 0 ? `${affectedClients} clients affected` : 'All on schedule'}
                />
              </div>
            )}

            {show('batch-summary') && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100">
                <div className="px-5 py-3 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-indigo-500" /> Batch Summary (Today)
                  </h3>
                </div>
                <div className="p-4 space-y-3">
                  {batchLoading && !allBatchData ? (
                    <div className="flex items-center gap-3 text-sm text-gray-400 py-4 justify-center">
                      <Loader2 className="w-5 h-5 animate-spin" /> Loading...
                    </div>
                  ) : allBatchData ? (
                    <>
                      <div>
                        <div className="text-3xl font-bold text-gray-800">{totalBatchRuns.toLocaleString()}</div>
                        <div className="text-xs text-gray-400 mt-0.5">Total batch runs across all clients</div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <MiniStat label="Clients Queried"  value={Object.keys(allBatchData.clients).length} color="text-gray-800" />
                        <MiniStat label="Errors"           value={clientErrorCount}   color={clientErrorCount > 0   ? 'text-red-600'   : 'text-green-600'} />
                        <MiniStat label="Stale Pending"    value={totalStalePending}  color={totalStalePending > 0  ? 'text-amber-600' : 'text-green-600'} />
                        <MiniStat label="Affected Clients" value={affectedClients}    color={affectedClients > 0    ? 'text-amber-600' : 'text-green-600'} />
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-gray-400 text-center py-4">No batch data</div>
                  )}
                </div>
              </div>
            )}

            {show('pending-jobs') && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100">
                <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" /> Pending Jobs &gt; 30min
                  </h3>
                  <Link to="/alerts" className="text-xs text-amber-600 hover:text-amber-800 flex items-center gap-1">
                    View Alerts <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="divide-y divide-gray-50 max-h-64 overflow-auto">
                  {!allBatchData?.pendingAlerts?.length ? (
                    <div className="p-6 text-center text-gray-400 text-sm">
                      <CheckCircle className="w-7 h-7 mx-auto mb-2 text-green-400" /> No stale pending jobs
                    </div>
                  ) : allBatchData.pendingAlerts.slice(0, 10).map(alert => (
                    <div key={alert.clientId} className="px-5 py-2.5 flex items-center justify-between hover:bg-gray-50">
                      <div className="flex items-center gap-3">
                        <Database className="w-4 h-4 text-indigo-400" />
                        <div>
                          <div className="text-sm font-medium text-gray-800">{alert.clientName || alert.clientId}</div>
                          {alert.clientName && alert.clientName !== alert.clientId && (
                            <div className="text-xs text-gray-400">{alert.clientId}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">{alert.stalePendingCount}</span>
                        {alert.stalePendingCount >= 10 ? (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700">CRITICAL</span>
                        ) : alert.stalePendingCount >= 5 ? (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700">WARNING</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* RIGHT: Cron Jobs */}
        {(show('cron-stats') || show('upcoming-jobs')) && (
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Briefcase className="w-3.5 h-3.5" /> Cron Jobs
            </h2>

            {show('cron-stats') && (
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  title="Total Jobs"
                  value={cronJobs.length}
                  icon={<Briefcase className="w-5 h-5" />}
                  color="indigo"
                  subtitle={`${activeJobs} active . ${inactiveJobs} inactive`}
                />
                <StatCard
                  title="Upcoming (2h)"
                  value={upcomingJobs.length}
                  icon={<Clock className="w-5 h-5" />}
                  color="blue"
                  subtitle={upcomingJobs.length > 0 ? 'Jobs scheduled soon' : 'None upcoming'}
                />
              </div>
            )}

            {show('upcoming-jobs') && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100">
                <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-indigo-500" /> Upcoming Jobs (Next 2 hours)
                  </h3>
                  <Link to="/jobs" className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                    View Cron Jobs <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="divide-y divide-gray-50 max-h-64 overflow-auto">
                  {upcomingJobs.length === 0 ? (
                    <div className="p-6 text-center text-gray-400 text-sm">No upcoming jobs in the next 2 hours</div>
                  ) : upcomingJobs.slice(0, 10).map((job: any) => (
                    <div key={job.id} className="px-5 py-2.5 flex items-center justify-between hover:bg-gray-50">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex-shrink-0 w-12 text-center">
                          <div className="text-xs font-bold text-indigo-600">
                            {job.minutesUntilRun < 60
                              ? `${job.minutesUntilRun}m`
                              : `${Math.floor(job.minutesUntilRun / 60)}h${job.minutesUntilRun % 60}m`}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-gray-800 truncate max-w-[220px]" title={job.name}>{job.name}</div>
                          {job.client && <span className="text-[10px] text-gray-400">{job.client.clientId}</span>}
                        </div>
                      </div>
                      <span className="text-[10px] text-gray-400">{fmt(job.nextRunTime, 'time')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Sub-components ----

function StatCard({ title, value, icon, color, subtitle }: {
  title: string; value: number; icon: React.ReactNode; color: string; subtitle?: string;
}) {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600',
    red: 'bg-red-50 text-red-600',    amber: 'bg-amber-50 text-amber-600',
    indigo: 'bg-indigo-50 text-indigo-600',
  };
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-500">{title}</span>
        <span className={`p-2 rounded-lg ${colorClasses[color] || 'bg-gray-50 text-gray-600'}`}>{icon}</span>
      </div>
      <div className="text-3xl font-bold text-gray-800">{value}</div>
      {subtitle && <div className="text-xs text-gray-400 mt-1">{subtitle}</div>}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-2.5">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-gray-400">{label}</div>
    </div>
  );
}
