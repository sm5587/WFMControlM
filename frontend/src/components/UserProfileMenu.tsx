import React, { useMemo } from 'react';
import { LogOut, Shield, Eye } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export default function UserProfileMenu() {
  const { user, logout, canWrite } = useAuth();

  const isAdminUser = canWrite('PERMISSIONS_EDIT') || canWrite('USERS_MANAGE');
  const initials = useMemo(
    () => initialsFromName(user?.displayName || user?.username || ''),
    [user?.displayName, user?.username],
  );

  if (!user) return null;

  const profileLabel = user.profileNames?.length
    ? user.profileNames.join(', ')
    : null;

  return (
    <div className="ml-auto flex items-center gap-3 pl-3 border-l border-gray-200">
      <div
        className="w-8 h-8 rounded-full bg-zebra-600 text-white text-xs font-semibold flex items-center justify-center flex-shrink-0"
        title={user.displayName}
      >
        {initials}
      </div>

      <div className="min-w-0 hidden sm:block">
        <p className="text-sm font-medium text-gray-900 truncate">
          Welcome, {user.displayName}
        </p>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 min-w-0">
          <span className="truncate">{user.username}</span>
          {user.email && (
            <>
              <span className="text-gray-300">·</span>
              <span className="truncate">{user.email}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${
            isAdminUser ? 'bg-zebra-50 text-zebra-700' : 'bg-gray-100 text-gray-600'
          }`}>
            {isAdminUser
              ? <Shield className="w-2.5 h-2.5" />
              : <Eye className="w-2.5 h-2.5" />
            }
            {isAdminUser ? 'Admin' : 'Monitor'}
          </span>
          {profileLabel && (
            <span className="text-[10px] text-gray-400 truncate" title={profileLabel}>
              {profileLabel}
            </span>
          )}
        </div>
      </div>

      <button
        onClick={logout}
        title="Sign out"
        className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  );
}
