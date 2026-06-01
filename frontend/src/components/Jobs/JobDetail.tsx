import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Clock, Server,
  CheckCircle, XCircle, AlertTriangle, Loader, FileText, RefreshCw,
} from 'lucide-react';
import { jobsApi } from '../../services/api';
import { useTimezone } from '../../hooks/useTimezone';

function stripClientPrefix(name: string, clientId?: string): string {
  if (!clientId) return name;
  const prefixes = [`${clientId} - `, `${clientId}_`, `${clientId}-`];
  for (const p of prefixes) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  return name;
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const { fmt } = useTimezone();

  // Log tail state
  const [logTailLines, setLogTailLines] = useState<string[] | null>(null);
  const [logTailMeta, setLogTailMeta] = useState<{ logPath: string; hostname: string; fetchedAt: string } | null>(null);
  const [logTailLoading, setLogTailLoading] = useState(false);
  const [logTailError, setLogTailError] = useState<string | null>(null);
  const [tailCount, setTailCount] = useState(30);

  async function fetchLogTail(n: number = tailCount) {
    setLogTailLoading(true);
    setLogTailError(null);
    try {
      const resp = await jobsApi.getLogTail(id!, n);
      const d = (resp as any)?.data;
      setLogTailLines(d?.lines ?? []);
      setLogTailMeta({ logPath: d?.logPath, hostname: d?.hostname, fetchedAt: d?.fetchedAt });
    } catch (err: any) {
      setLogTailError(err?.response?.data?.error ?? err.message ?? 'Failed to fetch log');
    } finally {
      setLogTailLoading(false);
    }
  }

  const { data: jobData, isLoading } = useQuery({
    queryKey: ['job', id],
    queryFn: () => jobsApi.get(id!),
  });

  // Auto-fetch log on load if job has a logPath
  const job = jobData?.data;
  useEffect(() => {
    if (job?.logPath) fetchLogTail(tailCount);
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return <div className="p-6 text-gray-400">Loading job details...</div>;
  }

  if (!job) {
    return <div className="p-6 text-gray-500">Job not found</div>;
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/jobs" className="p-2 hover:bg-gray-100 rounded-lg">
          <ArrowLeft className="w-5 h-5 text-gray-500" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{stripClientPrefix(job.name, job.client?.clientId)}</h1>
            <span className={`px-2 py-1 rounded-full text-xs font-medium flex-shrink-0 ${
              job.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
            }`}>
              {job.isActive ? 'Active' : 'Inactive'}
            </span>
            {job.client?.clientId && (
              <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 flex-shrink-0">
                {job.client.clientId}
              </span>
            )}
          </div>
          {job.description && <p className="text-sm text-gray-500 mt-1">{job.description}</p>}
        </div>
      </div>

      {/* Two-column layout: Config + Status | Log Tail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left: Job Config */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Job Configuration</h3>
          <dl className="space-y-3">
            <InfoRow label="Type" value={job.jobType} />
            <InfoRow label="Category" value={job.category} />
            <InfoRow label="Schedule" value={job.cronExpression || 'Manual'} mono />
            <InfoRow label="Timezone" value={job.timezone} />
            <InfoRow label="Priority" value={`P${job.priority}`} />
            {job.command && <InfoRow label="Command" value={job.command} mono />}
            {job.owner && <InfoRow label="Owner" value={job.owner} />}
            {job.team && <InfoRow label="Team" value={job.team} />}
            {job.logPath && (
              <div className="flex items-start justify-between">
                <dt className="text-xs text-gray-400">Log Path</dt>
                <dd className="text-xs font-mono text-gray-600 text-right max-w-[60%] break-all" title={job.logPath}>{job.logPath}</dd>
              </div>
            )}
          </dl>

          {/* Last Run Status */}
          {job.lastRunStatus && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <h4 className="text-xs font-semibold text-gray-500 mb-2">Last Run</h4>
              <div className="flex items-center gap-2">
                <LastRunStatusIcon status={job.lastRunStatus} />
                <span className={`text-sm font-medium ${
                  job.lastRunStatus === 'SUCCESS' ? 'text-green-700' :
                  job.lastRunStatus === 'FAILED' ? 'text-red-700' :
                  job.lastRunStatus === 'STALE' ? 'text-yellow-700' :
                  'text-gray-600'
                }`}>
                  {job.lastRunStatus}
                </span>
              </div>
              {job.lastRunAt && (
                <div className="text-xs text-gray-400 mt-1">{fmt(job.lastRunAt)}</div>
              )}
              {job.lastLogCheckAt && (
                <div className="text-xs text-gray-400">Checked: {fmt(job.lastLogCheckAt)}</div>
              )}
            </div>
          )}

          {job.tags?.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1">
              {job.tags.map((tag: string) => (
                <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">{tag}</span>
              ))}
            </div>
          )}
        </div>

        {/* Right: Live Log Tail (spans 2 cols on lg) */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-700">Live Log Tail</h3>
              {logTailMeta && (
                <span className="text-[10px] text-gray-400 font-mono ml-2 hidden sm:inline" title={logTailMeta.logPath}>
                  <Server className="w-3 h-3 inline mr-0.5" />{logTailMeta.hostname}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={tailCount}
                onChange={e => { setTailCount(parseInt(e.target.value, 10)); fetchLogTail(parseInt(e.target.value, 10)); }}
                className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-zebra-300"
              >
                <option value={10}>Last 10 lines</option>
                <option value={30}>Last 30 lines</option>
                <option value={50}>Last 50 lines</option>
                <option value={100}>Last 100 lines</option>
              </select>
              <button
                onClick={() => fetchLogTail(tailCount)}
                disabled={logTailLoading}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-500 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${logTailLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="flex-1 p-4 min-h-[300px]">
            {!job.logPath ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <FileText className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-sm">No log path configured for this job</p>
              </div>
            ) : logTailLoading && !logTailLines ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                <Loader className="w-5 h-5 animate-spin mr-2" />
                Connecting via SSH and tailing log...
              </div>
            ) : logTailError ? (
              <div className="flex flex-col items-center justify-center h-full">
                <AlertTriangle className="w-8 h-8 mb-2 text-amber-400" />
                <p className="text-sm text-red-600">{logTailError}</p>
                <p className="text-xs text-gray-400 mt-1">Ensure the client has an active Prod server</p>
              </div>
            ) : logTailLines && logTailLines.length > 0 ? (
              <pre className="text-xs bg-gray-900 text-green-400 rounded-lg p-4 font-mono whitespace-pre-wrap break-words overflow-auto leading-relaxed h-full max-h-[calc(100vh-380px)]">
                {logTailLines.join('\n')}
              </pre>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <FileText className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-sm">Log file is empty</p>
              </div>
            )}
          </div>

          {logTailMeta && (
            <div className="px-5 py-2 border-t border-gray-100 flex items-center justify-between text-[10px] text-gray-400">
              <span className="font-mono truncate max-w-[60%]" title={logTailMeta.logPath}>{logTailMeta.logPath}</span>
              <span>Fetched {fmt(logTailMeta.fetchedAt, 'time')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between">
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd className={`text-sm text-gray-700 text-right max-w-[60%] truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function LastRunStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'SUCCESS':  return <CheckCircle className="w-4 h-4 text-green-600" />;
    case 'FAILED':   return <XCircle className="w-4 h-4 text-red-600" />;
    case 'STALE':    return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    case 'NOT_RUN':  return <Clock className="w-4 h-4 text-gray-400" />;
    default:         return <AlertTriangle className="w-4 h-4 text-gray-400" />;
  }
}
