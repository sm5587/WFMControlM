import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Download, FileDown, Timer,
} from 'lucide-react';
import { escalationsApi } from '../../services/api';
import { useTimezone } from '../../hooks/useTimezone';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { exportReportPdf, reportDownloadStem, type DateFmt } from '../../utils/exportEscalationReportPdf';
import { formatDurationMins } from '../../utils/formatDuration';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const QUARTERS = [
  { value: 1, label: 'Q1 (Jan–Mar)' },
  { value: 2, label: 'Q2 (Apr–Jun)' },
  { value: 3, label: 'Q3 (Jul–Sep)' },
  { value: 4, label: 'Q4 (Oct–Dec)' },
] as const;

type PeriodType = 'monthly' | 'quarterly';

const selectCls =
  'text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

function currentQuarter(month: number): number {
  return Math.ceil(month / 3);
}

function defaultReportPeriod(): { year: number; month: number; quarter: number } {
  const d = new Date();
  const month = d.getMonth() + 1;
  return { year: d.getFullYear(), month, quarter: currentQuarter(month) };
}

function csvEscape(v: string | number | boolean | null | undefined): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function exportReportCsv(report: any, fmt: DateFmt) {
  const header = [
    'Alert Type', 'Client', 'Cluster', 'Server Code', 'Severity', 'Status',
    'Stale Pending', 'Total Pending', 'Punch Count', 'Stale Age', 'First Seen', 'Resolved', 'Duration',
    'Acknowledged By', 'Acknowledged At', 'Suppressed By', 'Suppress Until',
    'Email Sent At', 'Activities',
  ];
  const lines: string[] = [];

  for (const r of report.queueBuildup.rows) {
    lines.push([
      'Queue Buildup',
      r.clientName,
      r.cluster,
      r.serverCode,
      r.severity,
      r.status,
      r.stalePendingCount,
      r.totalPending,
      '',
      '',
      fmt(r.firstSeenAt, 'full'),
      r.resolvedAt ? fmt(r.resolvedAt, 'full') : '',
      formatDurationMins(r.durationMins) || '',
      r.acknowledgedBy ?? '',
      r.acknowledgedAt ? fmt(r.acknowledgedAt, 'full') : '',
      r.suppressedBy ?? '',
      r.suppressUntil ? fmt(r.suppressUntil, 'full') : '',
      r.emailSentAt ? fmt(r.emailSentAt, 'full') : '',
      '',
    ].map(csvEscape).join(','));
  }

  for (const r of report.punchAlerts.rows) {
    lines.push([
      'Punch Alert',
      r.clientName,
      r.cluster,
      r.clientId,
      '',
      r.status,
      '',
      '',
      r.punchCount ?? '',
      formatDurationMins(r.staleAgeMins) || '',
      '',
      '',
      '',
      r.acknowledgedBy ?? '',
      r.acknowledgedAt ? fmt(r.acknowledgedAt, 'full') : '',
      r.suppressedBy ?? '',
      r.suppressUntil ? fmt(r.suppressUntil, 'full') : '',
      r.emailSentAt ? fmt(r.emailSentAt, 'full') : '',
      r.activities.join('; '),
    ].map(csvEscape).join(','));
  }

  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${reportDownloadStem(report)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function EscalationMonthlyReport() {
  const { fmt } = useTimezone();
  const { selectedCluster, selectedClientId, clients: globalClients } = useGlobalFilter();

  const initial = defaultReportPeriod();
  const [periodType, setPeriodType] = useState<PeriodType>('monthly');
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [quarter, setQuarter] = useState(initial.quarter);

  const selectedClientCode = useMemo(() => {
    if (!selectedClientId) return undefined;
    return globalClients.find(c => c.id === selectedClientId)?.clientId;
  }, [selectedClientId, globalClients]);

  const isCurrentPeriod = useMemo(() => {
    const now = new Date();
    if (periodType === 'monthly') {
      return year === now.getFullYear() && month === now.getMonth() + 1;
    }
    return year === now.getFullYear() && quarter === currentQuarter(now.getMonth() + 1);
  }, [periodType, year, month, quarter]);

  const { data: report, isLoading, isFetching } = useQuery({
    queryKey: ['escalation-report', periodType, year, month, quarter, selectedCluster, selectedClientCode],
    queryFn: async () => {
      const res = await escalationsApi.getReport({
        year,
        ...(periodType === 'monthly' ? { month } : { quarter }),
        cluster: selectedCluster || undefined,
        clientId: selectedClientCode || undefined,
      });
      return res.data;
    },
  });

  function setType(next: PeriodType) {
    setPeriodType(next);
    if (next === 'quarterly') {
      setQuarter(currentQuarter(month));
    }
  }

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m);
    setYear(y);
  }

  function shiftQuarter(delta: number) {
    let q = quarter + delta;
    let y = year;
    if (q < 1) { q = 4; y -= 1; }
    if (q > 4) { q = 1; y += 1; }
    setQuarter(q);
    setYear(y);
  }

  const qs = report?.queueBuildup?.summary;
  const ps = report?.punchAlerts?.summary;

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <select
            value={periodType}
            onChange={e => setType(e.target.value as PeriodType)}
            className={selectCls}
            aria-label="Report period type"
          >
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>

          {periodType === 'monthly' ? (
            <>
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                title="Previous month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="px-4 py-2 bg-white border border-gray-200 rounded-lg min-w-[180px] text-center">
                <p className="text-sm font-semibold text-gray-900">{MONTHS[month - 1]} {year}</p>
                {report?.period && (
                  <p className="text-xs text-gray-500">{report.period.startDate} — {report.period.endDate}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                title="Next month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => shiftQuarter(-1)}
                className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                title="Previous quarter"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <select
                value={quarter}
                onChange={e => setQuarter(Number(e.target.value))}
                className={selectCls}
                aria-label="Report quarter"
              >
                {QUARTERS.map(q => (
                  <option key={q.value} value={q.value}>{q.label}</option>
                ))}
              </select>
              <div className="px-4 py-2 bg-white border border-gray-200 rounded-lg min-w-[120px] text-center">
                <p className="text-sm font-semibold text-gray-900">{year}</p>
                {report?.period && (
                  <p className="text-xs text-gray-500">{report.period.startDate} — {report.period.endDate}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => shiftQuarter(1)}
                className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                title="Next quarter"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          )}
          {(selectedCluster || selectedClientCode) && (
            <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full">
              Filtered{selectedCluster ? ` · ${selectedCluster}` : ''}{selectedClientCode ? ` · ${selectedClientCode}` : ''}
            </span>
          )}
        </div>

        {report && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => exportReportPdf(report, fmt, {
                filterLabel: [selectedCluster, selectedClientCode].filter(Boolean).join(' · ') || undefined,
                generatedAt: fmt(new Date().toISOString(), 'full'),
              })}
              className="flex items-center gap-2 px-3 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              <FileDown className="w-4 h-4" /> Export PDF
            </button>
            <button
              type="button"
              onClick={() => exportReportCsv(report, fmt)}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              <Download className="w-4 h-4" /> CSV
            </button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
          <BarChart3 className="w-10 h-10 mx-auto mb-3 text-gray-300 animate-pulse" />
          <p>Loading report...</p>
        </div>
      ) : !report ? (
        <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-400">
          <p>No report data</p>
        </div>
      ) : (
        <>
          {/* Queue buildup summary */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              Critical Queue Buildup
              {isFetching && <span className="text-xs font-normal text-gray-400">Refreshing...</span>}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <SummaryCard label="Total Escalations" value={qs.total} />
              <SummaryCard label="Critical (>=10 stale)" value={qs.critical} accent="text-red-600" />
              <SummaryCard label="Clients Affected" value={qs.clientsAffected} />
              <SummaryCard label="Resolved" value={qs.resolved} accent="text-green-600" />
              <SummaryCard label="Avg Duration" value={formatDurationMins(qs.avgDurationMins) || '—'} />
              <SummaryCard label="Still Open" value={qs.open} accent="text-amber-600" />
            </div>

            {Object.keys(qs.byCluster).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {Object.entries(qs.byCluster as Record<string, number>)
                  .sort((a, b) => b[1] - a[1])
                  .map(([cluster, count]) => (
                    <span key={cluster} className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
                      {cluster}: {count}
                    </span>
                  ))}
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              {report.queueBuildup.rows.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No queue-buildup escalations in this period</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b text-xs uppercase text-gray-500">
                        <th className="px-4 py-3 text-left">Client</th>
                        <th className="px-4 py-3 text-left">Cluster</th>
                        <th className="px-4 py-3 text-right">Stale</th>
                        <th className="px-4 py-3 text-left">Severity</th>
                        <th className="px-4 py-3 text-left">Status</th>
                        <th className="px-4 py-3 text-left">First Seen</th>
                        <th className="px-4 py-3 text-left">Resolved</th>
                        <th className="px-4 py-3 text-right">Duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {report.queueBuildup.rows.map((r: any) => (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-gray-900">{r.clientName}</div>
                            <div className="text-xs text-gray-400 font-mono">{r.serverCode}</div>
                          </td>
                          <td className="px-4 py-2.5 text-gray-600">{r.cluster || '—'}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-red-600">{r.stalePendingCount}</td>
                          <td className="px-4 py-2.5">
                            <SeverityBadge severity={r.severity} />
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{fmt(r.firstSeenAt, 'full')}</td>
                          <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                            {r.resolvedAt ? fmt(r.resolvedAt, 'full') : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-600">{formatDurationMins(r.durationMins) || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* Punch alerts summary */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Timer className="w-4 h-4 text-amber-500" />
              Unprocessed Punch Alerts
            </h2>
            {isCurrentPeriod && !report.punchAlerts.liveDataAvailable && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                No punch sync cache yet for the current period. Open the Alerts page (Escalated tab) to refresh punch data, then reload this report.
              </p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <SummaryCard label="Total Rows" value={ps.total} />
              <SummaryCard label="Active Stale" value={ps.activeStale} accent="text-amber-600" />
              <SummaryCard label="Acknowledged" value={ps.acknowledged} />
              <SummaryCard label="Suppressed" value={ps.suppressed} />
              <SummaryCard label="Notified" value={ps.notified} accent="text-indigo-600" />
            </div>

            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              {report.punchAlerts.rows.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No punch alert rows for this period</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b text-xs uppercase text-gray-500">
                        <th className="px-4 py-3 text-left">Client</th>
                        <th className="px-4 py-3 text-left">Cluster</th>
                        <th className="px-4 py-3 text-right">Punch Count</th>
                        <th className="px-4 py-3 text-right">Stale Age</th>
                        <th className="px-4 py-3 text-left">Activity</th>
                        <th className="px-4 py-3 text-left">Current Status</th>
                        <th className="px-4 py-3 text-left">Acknowledged</th>
                        <th className="px-4 py-3 text-left">Suppressed Until</th>
                        <th className="px-4 py-3 text-left">Email Sent</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {report.punchAlerts.rows.map((r: any) => (
                        <tr key={r.clientId} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-gray-900">{r.clientName}</div>
                            <div className="text-xs text-gray-400 font-mono">{r.clientId}</div>
                          </td>
                          <td className="px-4 py-2.5 text-gray-600">{r.cluster || '—'}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-amber-700">
                            {r.punchCount != null ? r.punchCount.toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-600">
                            {formatDurationMins(r.staleAgeMins) || '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {r.activities.map((a: string) => (
                                <span key={a} className="text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded">
                                  {a}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                          <td className="px-4 py-2.5 text-xs text-gray-600">
                            {r.acknowledgedAt ? (
                              <>{r.acknowledgedBy}<br />{fmt(r.acknowledgedAt, 'full')}</>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                            {r.suppressUntil ? fmt(r.suppressUntil, 'full') : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                            {r.emailSentAt ? fmt(r.emailSentAt, 'full') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? 'text-gray-800'}`}>{value}</p>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls = severity === 'CRITICAL'
    ? 'bg-red-100 text-red-700'
    : 'bg-amber-100 text-amber-700';
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'OPEN' ? 'bg-red-50 text-red-700'
    : status === 'ACKNOWLEDGED' ? 'bg-blue-50 text-blue-700'
    : status === 'SUPPRESSED' ? 'bg-gray-100 text-gray-600'
    : 'bg-gray-50 text-gray-600';
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>{status}</span>;
}
