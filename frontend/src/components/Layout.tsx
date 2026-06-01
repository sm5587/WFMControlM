import React, { useState, useMemo } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Briefcase, Monitor,
  Bell, ChevronLeft, ChevronRight, Activity, Building2, Database, DollarSign, Play,
  LogOut, Shield, Eye, Users, Settings, CalendarClock, Layers, Filter, X, Trash2, Timer, Wrench,
} from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useBackgroundPolling } from '../hooks/useBackgroundPolling';
import { useEscalatedAlerts } from './Alerts/AlertCenter';
import { useAuth, usePermission } from '../context/AuthContext';
import { useGlobalFilter } from '../context/GlobalFilterContext';

const navItems = [
  { path: '/dashboard',   label: 'Dashboard',    icon: LayoutDashboard, permission: null },
  { path: '/clients',     label: 'Clients',      icon: Building2,       permission: 'CLIENTS_VIEW' },
  { path: '/jobs',        label: 'Cron Jobs',    icon: Briefcase,       permission: 'JOBS_VIEW' },
  { path: '/db-jobs',     label: 'DB Jobs',      icon: Play,            permission: 'DBJOBS_VIEW' },
  { path: '/maintenance', label: 'Maintenance',  icon: CalendarClock,   permission: 'MAINTENANCE_VIEW' },
  { path: '/monitor',     label: 'Monitor',      icon: Monitor,         permission: 'MONITOR_VIEW' },
  { path: '/db-monitor',  label: 'DB Jobs Monitor', icon: Database,      permission: 'DBMONITOR_VIEW' },
  { path: '/payroll',     label: 'Payroll Jobs',       icon: DollarSign,      permission: 'PAYROLL_VIEW' },
  { path: '/unprocessed-punch', label: 'Unprocessed Punch', icon: Timer,        permission: 'UNPROC_PUNCH_VIEW' },
  { path: '/alerts',      label: 'Alerts',             icon: Bell,            permission: 'ALERTS_VIEW' },
];

const adminNavItems = [
  { path: '/admin/users',    label: 'Users',    icon: Users,   permission: 'USERS_VIEW' },
  { path: '/admin/profiles', label: 'Profiles', icon: Settings, permission: 'USERS_VIEW' },
  { path: '/admin/purge',    label: 'Purge',    icon: Trash2,   permission: 'DATA_PURGE_VIEW' },
  { path: '/admin/config',   label: 'Config',   icon: Wrench,   permission: 'PERMISSIONS_EDIT' },
];

export default function Layout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const { isConnected } = useWebSocket();
  useBackgroundPolling();
  const { data: escalated = [] } = useEscalatedAlerts();
  const openEscCount = escalated.filter(a => a.status === 'OPEN').length;
  const { user, logout } = useAuth();
  const canManageUsers = usePermission('USERS_VIEW', 'read');
  const { canRead } = useAuth();
  const {
    selectedCluster, selectedClientId,
    setSelectedCluster, setSelectedClientId,
    clients, clusters, clearFilters,
  } = useGlobalFilter();

  const filteredClients = useMemo(() => {
    if (!selectedCluster) return clients;
    return clients.filter(c => c.cluster === selectedCluster);
  }, [clients, selectedCluster]);

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className={`${collapsed ? 'w-16' : 'w-60'} bg-slate-900 text-white transition-all duration-300 flex flex-col`}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-700">
          <Activity className="w-8 h-8 text-zebra-400 flex-shrink-0" />
          {!collapsed && (
            <div>
              <h1 className="text-lg font-bold tracking-tight">WFM Watch</h1>
              <p className="text-xs text-slate-400">Job Monitoring & Alerting</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4">
          {navItems.map(({ path, label, icon: Icon, permission }) => {
            // Hide nav item if user lacks the required read permission
            if (permission && !canRead(permission)) return null;
            const isActive = location.pathname === path || location.pathname.startsWith(path + '/');
            const showRedBadge = path === '/alerts' && openEscCount > 0;
            return (
              <Link
                key={path}
                to={path}
                className={`flex items-center gap-3 px-4 py-3 mx-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-zebra-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <div className="relative flex-shrink-0">
                  <Icon className="w-5 h-5" />
                  {showRedBadge && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-400 rounded-full ring-2 ring-slate-900" />
                  )}
                </div>
                {!collapsed && <span className="text-sm font-medium">{label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Admin Section */}
        {canManageUsers && (
          <nav className="py-2 border-t border-slate-700">
            {!collapsed && (
              <p className="px-4 py-1 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Admin</p>
            )}
            {adminNavItems.map(({ path, label, icon: Icon, permission }) => {
              if (!canRead(permission)) return null;
              const isActive = location.pathname.startsWith(path);
              return (
                <Link
                  key={path}
                  to={path}
                  className={`flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-zebra-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  {!collapsed && <span className="text-sm font-medium">{label}</span>}
                </Link>
              );
            })}
          </nav>
        )}

        {/* User Info + Connection Status */}
        <div className="px-4 py-3 border-t border-slate-700 space-y-2">
          {/* Role badge */}
          {!collapsed && user && (
            <div className="flex items-center gap-2">
              {canManageUsers
                ? <Shield className="w-3.5 h-3.5 text-zebra-400 flex-shrink-0" />
                : <Eye className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              }
              <div className="min-w-0">
                <p className="text-xs text-white font-medium truncate">{user.displayName}</p>
                <p className="text-[10px] text-slate-400">{canManageUsers ? 'Admin' : 'Monitor'}</p>
              </div>
              <button
                onClick={logout}
                title="Sign out"
                className="ml-auto text-slate-400 hover:text-red-400 transition-colors flex-shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {collapsed && (
            <button onClick={logout} title="Sign out" className="flex justify-center w-full text-slate-400 hover:text-red-400 transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          )}
          {/* Connection indicator */}
          <div className="flex items-center gap-2">
            <span className={`status-dot ${isConnected ? 'status-success' : 'status-failed'}`} />
            {!collapsed && (
              <span className="text-xs text-slate-400">
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
            )}
          </div>
        </div>

        {/* Collapse Toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center py-3 border-t border-slate-700 hover:bg-slate-800 transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Global Filter Bar */}
        <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-3 flex-shrink-0">
          <Filter className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Filter</span>

          {/* Cluster */}
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-gray-400" />
            <select
              value={selectedCluster}
              onChange={e => setSelectedCluster(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-zebra-500 min-w-[130px]"
            >
              <option value="">All Clusters</option>
              {clusters.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Client */}
          <div className="flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 text-gray-400" />
            <select
              value={selectedClientId}
              onChange={e => setSelectedClientId(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-zebra-500 min-w-[170px]"
            >
              <option value="">All Clients</option>
              {filteredClients.map(c => (
                <option key={c.id} value={c.id}>{c.clientId} — {c.name}</option>
              ))}
            </select>
          </div>

          {/* Clear */}
          {(selectedCluster || selectedClientId) && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 transition-colors ml-1"
            >
              <X className="w-3.5 h-3.5" />
              Clear
            </button>
          )}
        </div>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
