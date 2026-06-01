import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Server, Database, RefreshCw, ChevronDown, ChevronRight,
  Globe, Activity, Clock, Building2, Layers, Pencil, Check, X, AlertTriangle, Crown, Plus, KeyRound
} from 'lucide-react';
import { clientsApi } from '../../services/api';
import { Client, AppServer, SyncHistory as SyncHistoryType } from '../../types';
import NewClientDialog from './NewClientDialog';
import EditClientDialog from './EditClientDialog';
import { usePermission } from '../../context/AuthContext';
import { useTimezone } from '../../hooks/useTimezone';

const ENV_COLORS: Record<string, string> = {
  Prod: 'bg-green-100 text-green-700',
};

/** Return a short human-readable relative time string, e.g. "2h ago" or "3d ago" */
function formatAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Never';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** True if the date is older than 24h or absent (sync is due) */
function isSyncDue(dateStr: string | null | undefined): boolean {
  if (!dateStr) return true;
  return Date.now() - new Date(dateStr).getTime() > 24 * 60 * 60 * 1000;
}

export default function ClientsList() {
  const [search, setSearch] = useState('');
  const { fmt } = useTimezone();
  const [clusterFilter, setClusterFilter] = useState('');
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [showNewClient, setShowNewClient] = useState(false);
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [bulkPassword, setBulkPassword] = useState('');

  const queryClient = useQueryClient();
  const canCreateClient  = usePermission('CLIENTS_CREATE',    'write');
  const canEditClients   = usePermission('CLIENTS_EDIT',      'write');
  const canSyncClients   = usePermission('CLIENTS_SYNC',       'write');
  const canDetectTz      = usePermission('CLIENTS_DETECT_TZ',  'write');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['clients', search],
    queryFn: () => clientsApi.list({ search: search || undefined }),
  });

  const syncAllMutation = useMutation({
    mutationFn: () => clientsApi.syncAll(),
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ['jobs-all'] });
    },
  });

  const detectTzMutation = useMutation({
    mutationFn: () => clientsApi.detectTimezones(
      clusterFilter ? { cluster: clusterFilter } : undefined
    ),
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ['jobs-all'] });
    },
  });

  const bulkPwdMutation = useMutation({
    mutationFn: (password: string) => clientsApi.bulkUpdatePasswords(password),
    onSuccess: () => {
      refetch();
      setShowPwdModal(false);
      setBulkPassword('');
    },
  });

  const clients = (data?.data || []) as (Client & { db2Connection?: { host: string; port: string; database: string } | null })[];

  // Build cluster groups
  const { clusterGroups, clusterList } = useMemo(() => {
    const filtered = clusterFilter
      ? clients.filter(c => c.cluster === clusterFilter)
      : clients;

    const groups: Record<string, Client[]> = {};
    for (const c of filtered) {
      const cl = c.cluster || 'Unassigned';
      if (!groups[cl]) groups[cl] = [];
      groups[cl].push(c);
    }

    // Sort cluster keys naturally (CL01, CL03, ... CL78)
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB;
    });

    return { clusterGroups: groups, clusterList: sortedKeys };
  }, [clients, clusterFilter]);

  // All unique clusters for filter dropdown
  const allClusters = useMemo(() => {
    const set = new Set(clients.map(c => c.cluster || 'Unassigned'));
    return [...set].sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB;
    });
  }, [clients]);

  const toggleCluster = (cl: string) => {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      if (next.has(cl)) next.delete(cl); else next.add(cl);
      return next;
    });
  };

  const totalFiltered = clusterList.reduce((sum, cl) => sum + clusterGroups[cl].length, 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-1">
            {totalFiltered} clients in {clusterList.length} clusters
          </p>
        </div>
        <div className="flex items-center gap-3">
          {canCreateClient && (
            <button
              onClick={() => setShowNewClient(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              New Client
            </button>
          )}
          {canDetectTz && (
            <button
              onClick={() => detectTzMutation.mutate()}
              disabled={detectTzMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 text-sm"
            >
              <Globe className={`w-4 h-4 ${detectTzMutation.isPending ? 'animate-spin' : ''}`} />
              {detectTzMutation.isPending ? 'Detecting...' : clusterFilter ? `Detect TZ (${clusterFilter})` : 'Detect Timezones'}
            </button>
          )}
          {canDetectTz && detectTzMutation.isSuccess && (
            <span className="text-xs text-green-600">
              TZ: {detectTzMutation.data?.data?.succeeded} synced
              {(detectTzMutation.data?.data?.cooldown ?? 0) > 0 && `, ${detectTzMutation.data?.data?.cooldown} skipped`}
            </span>
          )}
          {canDetectTz && detectTzMutation.isError && (
            <span className="text-xs text-red-600">Detection failed</span>
          )}
          {canEditClients && (
            <button
              onClick={() => setShowPwdModal(true)}
              disabled={bulkPwdMutation.isPending}
              title="Bulk update DB password for all active clients"
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 text-sm"
            >
              <KeyRound className={`w-4 h-4 ${bulkPwdMutation.isPending ? 'animate-spin' : ''}`} />
              {bulkPwdMutation.isPending ? 'Updating...' : 'Update DB Passwords'}
            </button>
          )}
          {bulkPwdMutation.isSuccess && (
            <span className="text-xs text-green-600">
              Passwords: {bulkPwdMutation.data?.data?.updated}/{bulkPwdMutation.data?.data?.total} updated
            </span>
          )}
          {bulkPwdMutation.isError && (
            <span className="text-xs text-red-600">Password update failed</span>
          )}
        </div>
      </div>

      {/* Search & Cluster Filter */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search clients by ID or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
          />
        </div>
        <select
          value={clusterFilter}
          onChange={(e) => setClusterFilter(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
        >
          <option value="">All Clusters</option>
          {allClusters.map(cl => (
            <option key={cl} value={cl}>{cl} ({clients.filter(c => (c.cluster || 'Unassigned') === cl).length})</option>
          ))}
        </select>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-6 gap-4">
        <StatCard icon={Building2} label="Total Clients" value={clients.length} color="blue" />
        <StatCard icon={Layers} label="Clusters" value={allClusters.length} color="indigo" />
        <StatCard
          icon={Activity}
          label="Active Clients"
          value={clients.filter(c => c.isActive).length}
          color="green"
        />
        <StatCard
          icon={Crown}
          label="White Glove"
          value={clients.filter(c => c.whiteGlove).length}
          color="amber"
        />
        <StatCard
          icon={Server}
          label="Total Servers"
          value={clients.reduce((sum, c) => sum + (c.serverCounts?.total || 0), 0)}
          color="purple"
        />
      </div>

      {/* Cluster-grouped Client Tables */}
      {isLoading ? (
        <div className="p-12 text-center text-gray-400">Loading clients...</div>
      ) : clusterList.length === 0 ? (
        <div className="p-12 text-center text-gray-400">No clients found</div>
      ) : (
        <div className="space-y-4">
          {clusterList.map(clusterName => {
            const clusterClients = clusterGroups[clusterName];
            const isCollapsed = collapsedClusters.has(clusterName);

            return (
              <div key={clusterName} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                {/* Cluster header */}
                <button
                  onClick={() => toggleCluster(clusterName)}
                  className="w-full flex items-center justify-between px-5 py-3 bg-gradient-to-r from-slate-50 to-white hover:from-slate-100 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isCollapsed ? <ChevronRight className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    <Layers className="w-4 h-4 text-indigo-500" />
                    <span className="text-sm font-bold text-gray-800">{clusterName}</span>
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-600">
                      {clusterClients.length} client{clusterClients.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </button>

                {!isCollapsed && (
                  <table className="w-full resizable-cols">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100 border-t border-gray-100">
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase w-8"></th>
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Client ID</th>
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Name</th>
                        <th className="px-5 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Prod Server</th>
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase">DB2</th>
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Timezone</th>
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Last Synced</th>
                        <th className="px-5 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Status</th>
                        <th className="px-5 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {clusterClients.map((client) => (
                        <ClientRow
                          key={client.id}
                          client={client}
                          isExpanded={expandedClient === client.id}
                          onToggle={() => setExpandedClient(expandedClient === client.id ? null : client.id)}
                          onRefresh={refetch}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Unmatched DB Connection Files section removed — all credentials now in DB */}

      {canCreateClient && showNewClient && <NewClientDialog onClose={() => setShowNewClient(false)} />}

      {/* Bulk Password Update Modal */}
      {showPwdModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-indigo-600" />
              Bulk Update DB Password
            </h3>
            <p className="text-sm text-gray-600">
              This will update the DB2 password for all active clients that have DB2 connection details configured.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
              <input
                type="password"
                value={bulkPassword}
                onChange={e => setBulkPassword(e.target.value)}
                placeholder="Enter new DB2 password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                autoFocus
              />
            </div>
            {bulkPwdMutation.isError && (
              <p className="text-xs text-red-600">Update failed. Please try again.</p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setShowPwdModal(false); setBulkPassword(''); }}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => bulkPwdMutation.mutate(bulkPassword)}
                disabled={!bulkPassword.trim() || bulkPwdMutation.isPending}
                className="px-4 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {bulkPwdMutation.isPending ? 'Updating...' : 'Update All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ClientRow({
  client,
  isExpanded,
  onToggle,
  onRefresh,
}: {
  client: Client & { db2Connection?: { host: string; port: string; database: string } | null };
  isExpanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const canEditClients = usePermission('CLIENTS_EDIT', 'write');
  const { fmt } = useTimezone();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(client.name);

  const syncMutation = useMutation({
    mutationFn: () => clientsApi.sync(client.id),
    onSuccess: () => onRefresh(),
  });

  const whiteGloveMutation = useMutation({
    mutationFn: () => clientsApi.update(client.id, { whiteGlove: !client.whiteGlove }),
    onSuccess: () => onRefresh(),
  });

  const updateMutation = useMutation({
    mutationFn: (name: string) => clientsApi.update(client.id, { name }),
    onSuccess: () => {
      setIsEditing(false);
      onRefresh();
    },
  });

  const handleSave = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== client.name) {
      updateMutation.mutate(trimmed);
    } else {
      setIsEditing(false);
      setEditName(client.name);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditName(client.name);
  };

  return (
    <>
      <tr className="hover:bg-gray-50 transition-colors">
        <td className="px-5 py-3">
          <button onClick={onToggle} className="p-1 text-gray-400 hover:text-gray-600">
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </td>
        <td className="px-5 py-3">
          <span className="text-sm font-bold text-gray-900 inline-flex items-center gap-1.5">
            {client.whiteGlove && (
              <span title="White Glove Client"><Crown className="w-3.5 h-3.5 text-amber-500" /></span>
            )}
            {client.clientId}
          </span>
        </td>
        <td className="px-5 py-3">
          {isEditing ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') handleCancel();
                }}
                autoFocus
                className="px-2 py-1 text-sm border border-zebra-300 rounded focus:outline-none focus:ring-2 focus:ring-zebra-300 w-48"
              />
              <button onClick={handleSave} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Save">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleCancel} className="p-1 text-gray-400 hover:bg-gray-100 rounded" title="Cancel">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : canEditClients ? (
            <span
              className="text-sm text-gray-600 cursor-pointer hover:text-zebra-600 inline-flex items-center gap-1 group"
              onClick={() => { setEditName(client.name); setIsEditing(true); }}
              title="Click to edit name"
            >
              {client.name}
              <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
            </span>
          ) : (
            <span className="text-sm text-gray-600">{client.name}</span>
          )}
        </td>
        <td className="px-5 py-3 text-center">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <Server className="w-3 h-3" />
            {client.serverCounts?.Prod || 0}
          </span>
        </td>
        <td className="px-5 py-3">
          {client.db2Connection?.host ? (
            <div title={`${client.db2Connection.host}:${client.db2Connection.port}/${client.db2Connection.database}`}>
              <span className="text-xs font-medium text-gray-700">{client.db2Connection.database}</span>
              <span className="text-xs text-gray-400 block truncate max-w-[180px]">{client.db2Connection.host}:{client.db2Connection.port}</span>
              {(!client.db2Username || !client.db2PasswordSet) && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 mt-0.5">
                  <AlertTriangle className="w-3 h-3" />
                  {!client.db2Username && !client.db2PasswordSet ? 'No credentials' : !client.db2Username ? 'No username' : 'No password'}
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </td>
        <td className="px-5 py-3">
          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <Globe className="w-3 h-3" />
            {client.timezone}
          </span>
        </td>
        <td className="px-5 py-3">
          <div className="flex flex-col gap-0.5">
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                isSyncDue(client.lastCronSyncAt) ? 'text-amber-600' : 'text-green-600'
              }`}
              title={`Last successful sync: ${client.lastCronSyncAt ? fmt(client.lastCronSyncAt) : 'Never'}${
                client.lastCronAttemptAt ? ` | Last attempt: ${fmt(client.lastCronAttemptAt)}` : ''
              }`}
            >
              <Clock className="w-3 h-3" />
              {formatAgo(client.lastCronSyncAt)}
            </span>
            {client.lastCronAttemptAt && client.lastCronAttemptAt !== client.lastCronSyncAt && (
              <span
                className="inline-flex items-center gap-1 text-xs text-gray-400"
                title={`Last attempt: ${fmt(client.lastCronAttemptAt)}`}
              >
                <RefreshCw className="w-3 h-3" />
                {formatAgo(client.lastCronAttemptAt)}
              </span>
            )}
            {client.lastTzAttemptAt && (
              <span
                className="inline-flex items-center gap-1 text-xs text-gray-400"
                title={`TZ detection: ${fmt(client.lastTzAttemptAt)}`}
              >
                <Globe className="w-3 h-3" />
                {formatAgo(client.lastTzAttemptAt)}
              </span>
            )}
          </div>
        </td>
        <td className="px-5 py-3">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
            client.isActive ? 'text-green-600' : 'text-gray-400'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${client.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
            {client.isActive ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td className="px-5 py-3">
          <div className="flex items-center justify-end gap-1">
            {canEditClients && (
              <button
                onClick={() => whiteGloveMutation.mutate()}
                disabled={whiteGloveMutation.isPending}
                className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50 ${
                  client.whiteGlove
                    ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                    : 'text-gray-400 bg-gray-50 hover:bg-gray-100'
                }`}
                title={client.whiteGlove ? 'Remove White Glove' : 'Mark as White Glove'}
              >
                <Crown className="w-3 h-3" />
              </button>
            )}
          </div>
        </td>
      </tr>
      {isExpanded && <ClientDetail clientId={client.id} db2Connection={client.db2Connection} colSpan={10} />}
    </>
  );
}

function ClientDetail({ clientId, db2Connection, colSpan = 10 }: { clientId: string; db2Connection?: { host: string; port: string; database: string } | null; colSpan?: number }) {
  const canEditClients = usePermission('CLIENTS_EDIT', 'write');
  const { fmt } = useTimezone();
  const [showEdit, setShowEdit] = useState(false);
  const qc = useQueryClient();

  const { data: clientData } = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => clientsApi.get(clientId),
  });

  const { data: historyData } = useQuery({
    queryKey: ['client-sync-history', clientId],
    queryFn: () => clientsApi.getSyncHistory(clientId, 5),
  });

  const client = clientData?.data;
  const servers = client?.appServers || [];
  const history = (historyData?.data || []) as SyncHistoryType[];
  const prodServers = servers.filter(s => s.environment === 'Prod');

  return (
    <>
    {showEdit && <EditClientDialog clientId={clientId} onClose={() => setShowEdit(false)} />}
    <tr>
      <td colSpan={colSpan} className="px-5 py-4 bg-gray-50">
        <div className="grid grid-cols-2 gap-6">
          {/* Servers */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <Server className="w-4 h-4" />
              App Servers
              {canEditClients && (
                <button
                  onClick={() => setShowEdit(true)}
                  className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
                >
                  Edit Details
                </button>
              )}
            </h4>
            <div className="space-y-2">
              {prodServers.map(s => (
                <div key={s.id} className="flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-green-50 text-green-700 rounded text-xs font-medium">Prod</span>
                  <span className="text-xs text-gray-600 font-mono">{s.dns}</span>
                </div>
              ))}
              {prodServers.length === 0 && <p className="text-xs text-gray-400">No servers configured</p>}
            </div>
            {db2Connection?.host ? (
              <div className="mt-3">
                <h4 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
                  <Database className="w-4 h-4" />
                  DB2 Connection
                </h4>
                <p className="text-xs text-gray-600 font-mono">{db2Connection.host}:{db2Connection.port}/{db2Connection.database}</p>
              </div>
            ) : (
              <div className="mt-3">
                <h4 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
                  <Database className="w-4 h-4" />
                  DB2 Connection
                </h4>
                <p className="text-xs text-gray-400">No connection file found</p>
              </div>
            )}
          </div>

          {/* Sync History */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Recent Sync History
            </h4>
            {history.length === 0 ? (
              <p className="text-xs text-gray-400">No sync history yet</p>
            ) : (
              <div className="space-y-1.5">
                {history.map(h => (
                  <div key={h.id} className="flex items-center justify-between text-xs bg-white rounded px-3 py-2 border border-gray-100">
                    <div className="flex items-center gap-2">
                      <SyncStatusBadge status={h.status} />
                      <span className="text-gray-600">{h.syncType}</span>
                    </div>
                    <div className="flex items-center gap-3 text-gray-400">
                      <span>+{h.jobsCreated} / ~{h.jobsUpdated}</span>
                      {h.duration != null && <span>{h.duration}s</span>}
                      <span>{fmt(h.startedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
    </>
  );
}

function SyncStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    SUCCESS: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    PARTIAL: 'bg-yellow-100 text-yellow-700',
    RUNNING: 'bg-blue-100 text-blue-700',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  const bgColors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    purple: 'bg-purple-50 text-purple-600',
    orange: 'bg-orange-50 text-orange-600',
    indigo: 'bg-indigo-50 text-indigo-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
      <div className={`p-2.5 rounded-lg ${bgColors[color]}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}
