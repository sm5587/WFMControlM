import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ChevronDown, ChevronRight, X } from 'lucide-react';
import { adminApi, AdminProfile, AdminAppFunction } from '../../services/api';
import { usePermission } from '../../context/AuthContext';

// Helper to group functions by module
function groupByModule(fns: AdminAppFunction[]): Record<string, AdminAppFunction[]> {
  const groups: Record<string, AdminAppFunction[]> = {};
  for (const fn of fns) {
    if (!groups[fn.module]) groups[fn.module] = [];
    groups[fn.module].push(fn);
  }
  // Sort within each module by sortOrder
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return groups;
}

export default function AdminProfiles() {
  const canManage = usePermission('PROFILES_MANAGE', 'write');
  const canEditPerms = usePermission('PERMISSIONS_EDIT', 'write');
  const qc = useQueryClient();

  const { data: profilesData, isLoading: loadingProfiles } = useQuery({
    queryKey: ['admin-profiles'],
    queryFn: adminApi.getProfiles,
  });
  const { data: functionsData } = useQuery({
    queryKey: ['admin-functions'],
    queryFn: adminApi.getFunctions,
  });

  const profiles: AdminProfile[] = profilesData?.data ?? [];
  const functions: AdminAppFunction[] = functionsData?.data ?? [];
  const moduleGroups = useMemo(() => groupByModule(functions), [functions]);
  const modules = useMemo(() => Object.keys(moduleGroups).sort(), [moduleGroups]);

  // ── Selected profile for permission editing ──
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const selectedProfile = profiles.find(p => p.id === selectedProfileId) ?? null;

  // Local permissions state (functionId → { r, w })
  const [localPerms, setLocalPerms] = useState<Record<string, { r: boolean; w: boolean }>>({});
  const [dirty, setDirty] = useState(false);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set(modules));

  // When a profile is selected, initialise localPerms from its permissions
  const selectProfile = (p: AdminProfile) => {
    const map: Record<string, { r: boolean; w: boolean }> = {};
    for (const perm of p.permissions) {
      map[perm.functionId] = { r: perm.canRead, w: perm.canWrite };
    }
    setLocalPerms(map);
    setDirty(false);
    setSelectedProfileId(p.id);
    setExpandedModules(new Set(modules));
  };

  const toggle = (fnId: string, mode: 'r' | 'w') => {
    setLocalPerms(prev => {
      const cur = prev[fnId] ?? { r: false, w: false };
      const next = { ...cur, [mode]: !cur[mode] };
      // If write is set, read must also be set
      if (mode === 'w' && next.w) next.r = true;
      // If read is unset, write must also unset
      if (mode === 'r' && !next.r) next.w = false;
      return { ...prev, [fnId]: next };
    });
    setDirty(true);
  };

  const savePermsMut = useMutation({
    mutationFn: () => {
      const perms = Object.entries(localPerms).map(([functionId, { r, w }]) => ({
        functionId,
        canRead: r,
        canWrite: w,
      }));
      return adminApi.updatePermissions(selectedProfileId!, perms);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-profiles'] });
      setDirty(false);
    },
  });

  // ── New profile dialog ──
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const createMut = useMutation({
    mutationFn: () => adminApi.createProfile({ name: newName, description: newDesc || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-profiles'] });
      setShowNew(false);
      setNewName('');
      setNewDesc('');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => adminApi.deleteProfile(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['admin-profiles'] });
      if (selectedProfileId === id) {
        setSelectedProfileId(null);
        setLocalPerms({});
      }
    },
  });

  const toggleModule = (mod: string) => {
    setExpandedModules(prev => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod); else next.add(mod);
      return next;
    });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Profiles & Permissions</h1>
          <p className="text-sm text-gray-500 mt-1">
            {profiles.length} profiles · select a profile to edit its permissions
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            New Profile
          </button>
        )}
      </div>

      <div className="flex gap-6">
        {/* Profile list */}
        <div className="w-64 flex-shrink-0 space-y-2">
          {loadingProfiles ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : (
            profiles.map(p => (
              <div
                key={p.id}
                onClick={() => selectProfile(p)}
                className={`flex items-start justify-between px-4 py-3 rounded-xl border cursor-pointer transition-colors ${
                  selectedProfileId === p.id
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-gray-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/30'
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{p.name}</p>
                  {p.description && <p className="text-xs text-gray-400 mt-0.5">{p.description}</p>}
                  <p className="text-xs text-gray-400 mt-1">{p._count.users} user{p._count.users !== 1 ? 's' : ''}</p>
                </div>
                {canManage && !p.isSystem && (
                  <button
                    onClick={e => { e.stopPropagation(); deleteMut.mutate(p.id); }}
                    className="text-gray-300 hover:text-red-500 ml-2 mt-0.5 flex-shrink-0"
                    title="Delete profile"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
          {!loadingProfiles && profiles.length === 0 && (
            <p className="text-sm text-gray-400 italic">No profiles yet</p>
          )}
        </div>

        {/* Permission matrix */}
        <div className="flex-1 min-w-0">
          {!selectedProfile ? (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm border border-dashed border-gray-200 rounded-xl">
              Select a profile to view or edit permissions
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Matrix header */}
              <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">{selectedProfile.name}</h2>
                  {selectedProfile.isSystem && (
                    <span className="text-xs text-amber-600">System profile — changes apply immediately</span>
                  )}
                </div>
                {canEditPerms && (
                  <button
                    onClick={() => savePermsMut.mutate()}
                    disabled={!dirty || savePermsMut.isPending}
                    className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
                  >
                    {savePermsMut.isPending ? 'Saving…' : dirty ? 'Save Changes' : 'Saved'}
                  </button>
                )}
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-5 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <span>Function</span>
                <span className="w-10 text-center">Read</span>
                <span className="w-10 text-center">Write</span>
              </div>

              {/* Rows grouped by module */}
              {modules.map(mod => {
                const fns = moduleGroups[mod] ?? [];
                const expanded = expandedModules.has(mod);
                return (
                  <div key={mod} className="border-b border-gray-100 last:border-0">
                    {/* Module heading */}
                    <button
                      className="w-full flex items-center gap-2 px-5 py-2 bg-gray-50 hover:bg-gray-100 text-xs font-bold text-gray-600 uppercase tracking-widest transition-colors"
                      onClick={() => toggleModule(mod)}
                    >
                      {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      {mod}
                    </button>
                    {expanded && fns.map(fn => {
                      const perm = localPerms[fn.id] ?? { r: false, w: false };
                      return (
                        <div
                          key={fn.id}
                          className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center px-5 py-2.5 hover:bg-gray-50 border-t border-gray-50"
                        >
                          <div>
                            <p className="text-sm text-gray-800">{fn.name}</p>
                            {fn.description && (
                              <p className="text-xs text-gray-400">{fn.description}</p>
                            )}
                          </div>
                          <div className="w-10 flex justify-center">
                            <input
                              type="checkbox"
                              checked={perm.r}
                              disabled={!canEditPerms}
                              onChange={() => toggle(fn.id, 'r')}
                              className="w-4 h-4 rounded accent-indigo-600 cursor-pointer disabled:cursor-default"
                            />
                          </div>
                          <div className="w-10 flex justify-center">
                            <input
                              type="checkbox"
                              checked={perm.w}
                              disabled={!canEditPerms}
                              onChange={() => toggle(fn.id, 'w')}
                              className="w-4 h-4 rounded accent-indigo-600 cursor-pointer disabled:cursor-default"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* New Profile Dialog */}
      {showNew && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Create Profile</h2>
              <button onClick={() => setShowNew(false)}>
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="e.g. Operations"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
              <input
                type="text"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="Short description…"
              />
            </div>
            {createMut.isError && (
              <p className="text-sm text-red-600">{(createMut.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowNew(false)}
                className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => createMut.mutate()}
                disabled={!newName.trim() || createMut.isPending}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {createMut.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
