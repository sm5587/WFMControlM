import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Plus, Trash2, Save, Server, Database, Settings, Eye, EyeOff } from 'lucide-react';
import { clientsApi } from '../../services/api';
import { Client, AppServer } from '../../types';

interface Props {
  clientId: string;
  onClose: () => void;
}

type Tab = 'details' | 'db2' | 'servers';

export default function EditClientDialog({ clientId, onClose }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('details');
  const [saved, setSaved] = useState<Tab | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => clientsApi.get(clientId),
  });

  const client = data?.data as (Client & { appServers: AppServer[] }) | undefined;

  // ── Details form state ──────────────────────────────────────
  const [details, setDetails] = useState({
    name: '', timezone: '', clientType: 'BAU' as 'BAU' | 'IMPL', cluster: '',
  });
  const [isActive, setIsActive] = useState(true);
  useEffect(() => {
    if (client) {
      setDetails({
        name: client.name ?? '',
        timezone: client.timezone ?? '',
        clientType: (client.clientType as 'BAU' | 'IMPL') ?? 'BAU',
        cluster: client.cluster ?? '',
      });
      setIsActive(client.isActive ?? true);
    }
  }, [client?.id]);

  const detailsMut = useMutation({
    mutationFn: () => clientsApi.update(clientId, { ...details, isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      flash('details');
    },
  });

  // ── DB2 form state ──────────────────────────────────────────
  const [db2, setDb2] = useState({
    db2Host: '', db2Port: '50000', db2Database: '', db2Schema: '',
    db2Username: '', db2Password: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    if (client) {
      setDb2({
        db2Host: client.db2Host ?? '',
        db2Port: String(client.db2Port ?? 50000),
        db2Database: client.db2Database ?? '',
        db2Schema: client.db2Schema ?? '',
        db2Username: client.db2Username ?? '',
        db2Password: '', // never pre-filled; leave blank = keep existing
      });
    }
  }, [client?.id]);

  const db2Mut = useMutation({
    mutationFn: () => clientsApi.update(clientId, {
      db2Host: db2.db2Host || undefined,
      db2Port: db2.db2Port ? Number(db2.db2Port) : undefined,
      db2Database: db2.db2Database || undefined,
      db2Schema: db2.db2Schema || undefined,
      db2Username: db2.db2Username || undefined,
      db2Password: db2.db2Password || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      flash('db2');
    },
  });

  // ── Server state ────────────────────────────────────────────
  // Track edits per server: serverId → pending changes
  const [serverEdits, setServerEdits] = useState<Record<string, { dns: string; sshPort: string; environment: string; serverNum: string }>>({});
  const [newServer, setNewServer] = useState<{ environment: string; serverNum: string; dns: string; sshPort: string } | null>(null);

  useEffect(() => {
    if (client?.appServers) {
      setServerEdits(prev => {
        const next: typeof prev = {};
        for (const s of client.appServers!) {
          // Preserve any unsaved edits for existing servers; initialise new ones from DB
          next[s.id] = prev[s.id] ?? {
            dns: s.dns,
            sshPort: String(s.sshPort),
            environment: s.environment,
            serverNum: s.serverNum,
          };
        }
        return next;
      });
    }
  }, [client?.appServers?.length]);

  const updateServerMut = useMutation({
    mutationFn: ({ serverId, data }: { serverId: string; data: any }) =>
      clientsApi.updateServer(clientId, serverId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      flash('servers');
    },
  });

  const removeServerMut = useMutation({
    mutationFn: (serverId: string) => clientsApi.removeServer(clientId, serverId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['client', clientId] }),
  });

  const addServerMut = useMutation({
    mutationFn: () => clientsApi.addServer(clientId, {
      environment: newServer!.environment || 'Prod',
      serverNum: newServer!.serverNum || '01',
      dns: newServer!.dns,
      sshPort: newServer!.sshPort ? Number(newServer!.sshPort) : 22,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      setNewServer(null);
      flash('servers');
    },
  });

  const flash = (t: Tab) => {
    setSaved(t);
    setTimeout(() => setSaved(null), 2000);
  };

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'details', label: 'Details', icon: <Settings className="w-4 h-4" /> },
    { key: 'db2',     label: 'DB2 Connection', icon: <Database className="w-4 h-4" /> },
    { key: 'servers', label: `App Servers (${client?.appServers?.length ?? 0})`, icon: <Server className="w-4 h-4" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Edit Client</h2>
            {client && (
              <p className="text-sm text-gray-500 mt-0.5">
                <span className="font-mono font-bold text-gray-700">{client.clientId}</span> — {client.name}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
                tab === t.key
                  ? 'border-zebra-500 text-zebra-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.icon}
              {t.label}
              {saved === t.key && (
                <span className="ml-1 text-xs text-green-600 font-normal">✓ Saved</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="text-center py-8 text-gray-400">Loading…</div>
          ) : (
            <>
              {/* DETAILS TAB */}
              {tab === 'details' && (
                <div className="space-y-4">
                  {(
                    [
                      { key: 'name',      label: 'Name' },
                      { key: 'timezone',  label: 'Timezone', placeholder: 'e.g. America/New_York' },
                      { key: 'cluster',   label: 'Cluster', placeholder: 'e.g. CL01' },
                    ] as { key: keyof typeof details; label: string; placeholder?: string }[]
                  ).map(({ key, label, placeholder }) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                      <input
                        type="text"
                        value={details[key]}
                        placeholder={placeholder}
                        onChange={e => setDetails(p => ({ ...p, [key]: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
                      />
                    </div>
                  ))}

                  {/* Client Type */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Client Type</label>
                    <select
                      value={details.clientType}
                      onChange={e => setDetails(p => ({ ...p, clientType: e.target.value as 'BAU' | 'IMPL' }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
                    >
                      <option value="BAU">BAU — Business as Usual</option>
                      <option value="IMPL">IMPL — Implementation</option>
                    </select>
                  </div>

                  {/* Active / Inactive toggle */}
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600">Status</label>
                      <p className="text-xs text-gray-400 mt-0.5">Inactive clients are hidden from Jobs and Monitor menus</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsActive(v => !v)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        isActive ? 'bg-green-500' : 'bg-gray-300'
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                        isActive ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  {detailsMut.isError && (
                    <p className="text-sm text-red-600">{(detailsMut.error as Error).message}</p>
                  )}
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => detailsMut.mutate()}
                      disabled={detailsMut.isPending}
                      className="flex items-center gap-2 px-4 py-2 bg-zebra-600 text-white rounded-lg hover:bg-zebra-700 text-sm font-medium disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      {detailsMut.isPending ? 'Saving…' : 'Save Details'}
                    </button>
                  </div>
                </div>
              )}

              {/* DB2 TAB */}
              {tab === 'db2' && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Connection details used to query DB2. Stored securely; password will be replaced by Keeper when integrated.
                  </p>
                  {(
                    [
                      { key: 'db2Host',     label: 'Host',     placeholder: 'e.g. z182sp-aaprwsprdbs04.rfx.zebra.com' },
                      { key: 'db2Port',     label: 'Port',     placeholder: '50000', type: 'number' },
                      { key: 'db2Database', label: 'Database', placeholder: 'e.g. RWS4' },
                      { key: 'db2Schema',   label: 'Schema',   placeholder: 'e.g. RWSUSER' },
                      { key: 'db2Username', label: 'Username', placeholder: 'e.g. datareader' },
                    ] as { key: keyof typeof db2; label: string; placeholder: string; type?: string }[]
                  ).map(({ key, label, placeholder, type }) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                      <input
                        type={(type as string | undefined) ?? 'text'}
                        value={db2[key]}
                        placeholder={placeholder}
                        onChange={e => setDb2(p => ({ ...p, [key]: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
                      />
                    </div>
                  ))}

                  {/* Password field with eye toggle */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={db2.db2Password}
                        placeholder={client?.db2PasswordSet ? '••••••••  (already set — leave blank to keep)' : 'Enter password'}
                        onChange={e => setDb2(p => ({ ...p, db2Password: e.target.value }))}
                        className="w-full px-3 py-2 pr-10 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(v => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Will be replaced by Keeper when integrated. Leave blank to clear.</p>
                  </div>

                  {db2Mut.isError && (
                    <p className="text-sm text-red-600">{(db2Mut.error as Error).message}</p>
                  )}
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => db2Mut.mutate()}
                      disabled={db2Mut.isPending}
                      className="flex items-center gap-2 px-4 py-2 bg-zebra-600 text-white rounded-lg hover:bg-zebra-700 text-sm font-medium disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      {db2Mut.isPending ? 'Saving…' : 'Save DB2 Config'}
                    </button>
                  </div>
                </div>
              )}

              {/* SERVERS TAB */}
              {tab === 'servers' && (
                <div className="space-y-3">
                  {(client?.appServers ?? []).map(s => {
                    const edit = serverEdits[s.id] ?? { dns: s.dns, sshPort: String(s.sshPort), environment: s.environment, serverNum: s.serverNum };
                    return (
                      <div key={s.id} className="flex items-center gap-2 p-3 border border-gray-200 rounded-xl bg-gray-50">
                        {/* Environment badge */}
                        <select
                          value={edit.environment}
                          onChange={e => setServerEdits(p => ({ ...p, [s.id]: { ...(p[s.id] ?? edit), environment: e.target.value } }))}
                          className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                        >
                          <option value="Prod">Prod</option>
                          <option value="PP">PP</option>
                        </select>
                        {/* Server num */}
                        <input
                          type="text"
                          value={edit.serverNum}
                          onChange={e => setServerEdits(p => ({ ...p, [s.id]: { ...(p[s.id] ?? edit), serverNum: e.target.value } }))}
                          className="w-14 px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono"
                          placeholder="01"
                          title="Server #"
                        />
                        {/* DNS */}
                        <input
                          type="text"
                          value={edit.dns}
                          onChange={e => setServerEdits(p => ({ ...p, [s.id]: { ...(p[s.id] ?? edit), dns: e.target.value } }))}
                          className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-mono"
                          placeholder="hostname.company.com"
                        />
                        {/* SSH Port */}
                        <input
                          type="number"
                          value={edit.sshPort}
                          onChange={e => setServerEdits(p => ({ ...p, [s.id]: { ...(p[s.id] ?? edit), sshPort: e.target.value } }))}
                          className="w-16 px-2 py-1.5 border border-gray-200 rounded-lg text-xs text-center"
                          placeholder="22"
                          title="SSH Port"
                        />
                        {/* Save server */}
                        <button
                          onClick={() => updateServerMut.mutate({ serverId: s.id, data: {
                            dns: edit.dns, sshPort: Number(edit.sshPort),
                            environment: edit.environment, serverNum: edit.serverNum,
                          }})}
                          disabled={updateServerMut.isPending}
                          className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg"
                          title="Save changes"
                        >
                          <Save className="w-3.5 h-3.5" />
                        </button>
                        {/* Delete server */}
                        <button
                          onClick={() => {
                            if (window.confirm(`Remove server "${edit.dns}"? This cannot be undone.`)) {
                              removeServerMut.mutate(s.id);
                            }
                          }}
                          disabled={removeServerMut.isPending}
                          className="p-1.5 text-red-400 hover:bg-red-50 rounded-lg"
                          title="Remove server"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}

                  {/* Add new server row */}
                  {newServer ? (
                    <div className="flex items-center gap-2 p-3 border-2 border-dashed border-indigo-300 rounded-xl bg-indigo-50">
                      <select
                        value={newServer.environment}
                        onChange={e => setNewServer(p => ({ ...p!, environment: e.target.value }))}
                        className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                      >
                        <option value="Prod">Prod</option>
                        <option value="PP">PP</option>
                      </select>
                      <input
                        type="text"
                        value={newServer.serverNum}
                        onChange={e => setNewServer(p => ({ ...p!, serverNum: e.target.value }))}
                        className="w-14 px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono"
                        placeholder="01"
                        title="Server #"
                      />
                      <input
                        type="text"
                        value={newServer.dns}
                        onChange={e => setNewServer(p => ({ ...p!, dns: e.target.value }))}
                        className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-mono"
                        placeholder="hostname.company.com"
                        autoFocus
                      />
                      <input
                        type="number"
                        value={newServer.sshPort}
                        onChange={e => setNewServer(p => ({ ...p!, sshPort: e.target.value }))}
                        className="w-16 px-2 py-1.5 border border-gray-200 rounded-lg text-xs text-center"
                        placeholder="22"
                      />
                      <button
                        onClick={() => addServerMut.mutate()}
                        disabled={!newServer.dns || addServerMut.isPending}
                        className="p-1.5 text-indigo-600 hover:bg-indigo-100 rounded-lg disabled:opacity-50"
                        title="Add server"
                      >
                        <Save className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setNewServer(null)}
                        className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg"
                        title="Cancel"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewServer({ environment: 'Prod', serverNum: '01', dns: '', sshPort: '22' })}
                      className="flex items-center gap-2 w-full px-4 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Add App Server
                    </button>
                  )}

                  {updateServerMut.isError && (
                    <p className="text-sm text-red-600">{(updateServerMut.error as Error).message}</p>
                  )}
                  {addServerMut.isError && (
                    <p className="text-sm text-red-600">{(addServerMut.error as Error).message}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
