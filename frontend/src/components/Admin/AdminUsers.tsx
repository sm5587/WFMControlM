import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Shield, UserX, UserCheck, X, Pencil } from 'lucide-react';
import { adminApi, authApi, AdminUser } from '../../services/api';
import { usePermission } from '../../context/AuthContext';

export default function AdminUsers() {
  const canManage = usePermission('USERS_MANAGE', 'write');
  const canAssign = usePermission('USER_PROFILE_ASSIGN', 'write');
  const qc = useQueryClient();

  const { data: usersData, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: adminApi.getUsers,
  });
  const { data: profilesData } = useQuery({
    queryKey: ['admin-profiles'],
    queryFn: adminApi.getProfiles,
  });

  const users: AdminUser[] = usersData?.data ?? [];
  const profiles = profilesData?.data ?? [];

  // ── New User dialog ──
  const [showNewUser, setShowNewUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', email: '', displayName: '', password: '' });

  const createMut = useMutation({
    mutationFn: authApi.register,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setShowNewUser(false);
      setNewUser({ username: '', email: '', displayName: '', password: '' });
    },
  });

  // ── Assign Profile dialog ──
  const [assignTarget, setAssignTarget] = useState<{ userId: string; username: string } | null>(null);
  const [assignProfileId, setAssignProfileId] = useState('');

  const assignMut = useMutation({
    mutationFn: ({ userId, profileId }: { userId: string; profileId: string }) =>
      adminApi.assignProfile(userId, profileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setAssignTarget(null);
      setAssignProfileId('');
    },
  });

  const removeProfMut = useMutation({
    mutationFn: ({ userId, profileId }: { userId: string; profileId: string }) =>
      adminApi.removeProfile(userId, profileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const toggleActiveMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      adminApi.updateUser(id, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  // ── Edit User dialog ──
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState({ displayName: '', email: '', timezone: '', password: '' });

  const openEdit = (u: AdminUser) => {
    setEditTarget(u);
    setEditForm({ displayName: u.displayName, email: u.email, timezone: u.timezone || 'Asia/Kolkata', password: '' });
  };

  const editMut = useMutation({
    mutationFn: () => {
      const payload: any = {};
      if (editForm.displayName !== editTarget!.displayName) payload.displayName = editForm.displayName;
      if (editForm.email !== editTarget!.email) payload.email = editForm.email;
      if (editForm.timezone !== (editTarget!.timezone || 'Asia/Kolkata')) payload.timezone = editForm.timezone;
      if (editForm.password) payload.password = editForm.password;
      return adminApi.updateUser(editTarget!.id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setEditTarget(null);
    },
  });

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500 mt-1">{users.length} registered users</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowNewUser(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
          >
            <UserPlus className="w-4 h-4" />
            New User
          </button>
        )}
      </div>

      {/* Users Table */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm resizable-cols">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timezone</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Profiles</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                {(canManage || canAssign) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map(u => (
                <tr key={u.id} className={`hover:bg-gray-50 ${!u.isActive ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{u.displayName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">@{u.username}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.email}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">{u.timezone || 'Asia/Kolkata'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.profiles.length === 0 && (
                        <span className="text-xs text-gray-400 italic">No profiles</span>
                      )}
                      {u.profiles.map(up => (
                        <span
                          key={up.profileId}
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 text-xs rounded-full"
                        >
                          {up.profile.name}
                          {canAssign && (
                            <button
                              onClick={() => removeProfMut.mutate({ userId: u.id, profileId: up.profileId })}
                              className="hover:text-red-500 ml-0.5"
                              title="Remove profile"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full font-medium ${
                      u.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {(canManage || canAssign) && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {canManage && (
                          <button
                            onClick={() => openEdit(u)}
                            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg"
                            title="Edit user"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                        {canAssign && (
                          <button
                            onClick={() => { setAssignTarget({ userId: u.id, username: u.username }); setAssignProfileId(''); }}
                            className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded-lg"
                            title="Assign profile"
                          >
                            <Shield className="w-4 h-4" />
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={() => toggleActiveMut.mutate({ id: u.id, isActive: !u.isActive })}
                            className={`p-1.5 rounded-lg ${u.isActive ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}
                            title={u.isActive ? 'Deactivate user' : 'Reactivate user'}
                          >
                            {u.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <div className="text-center py-10 text-gray-400">No users found</div>
          )}
        </div>
      )}

      {/* New User Dialog */}
      {showNewUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Create User</h2>
              <button onClick={() => setShowNewUser(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            {(
              [
                { key: 'username',    label: 'Username',      type: 'text' },
                { key: 'displayName', label: 'Display Name',  type: 'text' },
                { key: 'email',       label: 'Email',         type: 'email' },
                { key: 'password',    label: 'Password',      type: 'password' },
              ] as const
            ).map(({ key, label, type }) => (
              <div key={key}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
                <input
                  type={type}
                  value={newUser[key]}
                  onChange={e => setNewUser(p => ({ ...p, [key]: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>
            ))}
            {createMut.isError && (
              <p className="text-sm text-red-600">{(createMut.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowNewUser(false)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => createMut.mutate(newUser)}
                disabled={createMut.isPending || !newUser.username || !newUser.email || !newUser.password}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {createMut.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Profile Dialog */}
      {assignTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">
                Assign Profile to{' '}
                <span className="text-indigo-600">@{assignTarget.username}</span>
              </h2>
              <button onClick={() => setAssignTarget(null)}>
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <select
              value={assignProfileId}
              onChange={e => setAssignProfileId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            >
              <option value="">Select profile…</option>
              {profiles.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {assignMut.isError && (
              <p className="text-sm text-red-600">{(assignMut.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAssignTarget(null)}
                className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => assignMut.mutate({ userId: assignTarget.userId, profileId: assignProfileId })}
                disabled={!assignProfileId || assignMut.isPending}
                className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Dialog */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Edit User — <span className="text-indigo-600">@{editTarget.username}</span>
              </h2>
              <button onClick={() => setEditTarget(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Display Name</label>
              <input
                type="text"
                value={editForm.displayName}
                onChange={e => setEditForm(p => ({ ...p, displayName: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={editForm.email}
                onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Timezone</label>
              <select
                value={editForm.timezone}
                onChange={e => setEditForm(p => ({ ...p, timezone: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                {[
                  'Asia/Kolkata', 'America/New_York', 'America/Chicago', 'America/Denver',
                  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC',
                  'Australia/Sydney', 'Pacific/Auckland',
                ].map(tz => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">New Password <span className="text-gray-400 font-normal">(leave blank to keep current)</span></label>
              <input
                type="password"
                value={editForm.password}
                onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))}
                placeholder="••••••••"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
            {editMut.isError && (
              <p className="text-sm text-red-600">{(editMut.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditTarget(null)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => editMut.mutate()}
                disabled={editMut.isPending || !editForm.displayName || !editForm.email}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {editMut.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
