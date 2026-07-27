import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { GlobalFilterProvider } from './context/GlobalFilterContext';
import LoginPage from './components/Login/LoginPage';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard/Dashboard';
import JobsList from './components/Jobs/JobsList';

import AlertCenter from './components/Alerts/AlertCenter';
import ClientsList from './components/Clients/ClientsList';
import DBMonitor from './components/DBMonitor/DBMonitor';
import PayrollJobs from './components/Payroll/PayrollJobs';
import DBJobs from './components/DBJobs/DBJobs';
import AdminUsers from './components/Admin/AdminUsers';
import AdminProfiles from './components/Admin/AdminProfiles';
import AdminPurge from './components/Admin/AdminPurge';
import AdminConfig from './components/Admin/AdminConfig';
const MaintenanceWindows = React.lazy(() => import('./components/Maintenance/MaintenanceWindows'));
const UploadFileMonitor = React.lazy(() => import('./components/FileMonitor/UploadFileMonitor'));

class RouteErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center">
          <div className="text-slate-400 text-sm">Failed to load page. Please refresh.</div>
        </div>
      );
    }
    return this.props.children;
  }
}
import UnprocessedPunch from './components/UnprocessedPunch/UnprocessedPunch';
import { ConfigProvider } from './contexts/ConfigContext';

/** Allowed routes (must be accessed through menu only) */
const ALLOWED_ROUTES = [
  '/dashboard',
  '/clients',
  '/jobs',
  '/db-monitor',
  '/db-jobs',
  '/maintenance',
  '/file-monitor',
  '/payroll',
  '/unprocessed-punch',
  '/alerts',
  '/admin/users',
  '/admin/profiles',
  '/admin/purge',
  '/admin/config',
];

/** Renders children only if user has the given read permission, otherwise redirects to /dashboard. */
function PermissionRoute({ permission, children }: { permission: string; children: React.ReactNode }) {
  const { canRead } = useAuth();
  if (!canRead(permission)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-zebra-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          {/* Default: redirect root to dashboard */}
          <Route index element={<Navigate to="/dashboard" replace />} />
          
          {/* Dashboard (always accessible) */}
          <Route path="dashboard" element={<Dashboard />} />
          
          {/* Protected routes - menu access only */}
          <Route path="clients" element={<PermissionRoute permission="CLIENTS_VIEW"><ClientsList /></PermissionRoute>} />
          <Route path="jobs" element={<PermissionRoute permission="JOBS_VIEW"><JobsList /></PermissionRoute>} />
          <Route path="db-monitor" element={<PermissionRoute permission="DBMONITOR_VIEW"><DBMonitor /></PermissionRoute>} />
          <Route path="db-jobs" element={<PermissionRoute permission="DBJOBS_VIEW"><DBJobs /></PermissionRoute>} />
          <Route path="maintenance" element={
            <PermissionRoute permission="MAINTENANCE_VIEW">
              <RouteErrorBoundary>
                <Suspense fallback={
                  <div className="flex items-center justify-center h-40">
                    <div className="w-8 h-8 border-4 border-zebra-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                }>
                  <MaintenanceWindows />
                </Suspense>
              </RouteErrorBoundary>
            </PermissionRoute>
          } />
          <Route path="outage" element={<Navigate to="/maintenance?tab=outages&sub=impact" replace />} />
          <Route path="file-monitor" element={
            <PermissionRoute permission="FILE_MONITOR_VIEW">
              <RouteErrorBoundary>
                <Suspense fallback={
                  <div className="flex items-center justify-center h-40">
                    <div className="w-8 h-8 border-4 border-zebra-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                }>
                  <UploadFileMonitor />
                </Suspense>
              </RouteErrorBoundary>
            </PermissionRoute>
          } />
          <Route path="payroll" element={<PermissionRoute permission="PAYROLL_VIEW"><PayrollJobs /></PermissionRoute>} />
          <Route path="unprocessed-punch" element={<PermissionRoute permission="UNPROC_PUNCH_VIEW"><UnprocessedPunch /></PermissionRoute>} />
          <Route path="alerts" element={<PermissionRoute permission="ALERTS_VIEW"><AlertCenter /></PermissionRoute>} />
          <Route path="admin/users" element={<PermissionRoute permission="USERS_VIEW"><AdminUsers /></PermissionRoute>} />
          <Route path="admin/profiles" element={<PermissionRoute permission="USERS_VIEW"><AdminProfiles /></PermissionRoute>} />
          <Route path="admin/purge" element={<PermissionRoute permission="DATA_PURGE_VIEW"><AdminPurge /></PermissionRoute>} />
          <Route path="admin/config" element={<PermissionRoute permission="PERMISSIONS_EDIT"><AdminConfig /></PermissionRoute>} />
          
          {/* Catch-all: redirect any unknown routes to dashboard */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function App() {
  return (
    <AuthProvider>
      <ConfigProvider>
        <GlobalFilterProvider>
          <AppRoutes />
        </GlobalFilterProvider>
      </ConfigProvider>
    </AuthProvider>
  );
}

export default App;
