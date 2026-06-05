import React, { useState } from 'react';
import { Activity, Lock, User, Eye, EyeOff, Clock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useAppName } from '../../contexts/ConfigContext';

export default function LoginPage() {
  const appName = useAppName();
  const { login, sessionExpired } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Activity className="w-10 h-10 text-zebra-400" />
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">{appName}</h1>
              <p className="text-xs text-slate-400">Job Monitoring & Alerting Platform</p>
            </div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-slate-800 rounded-xl shadow-2xl p-8 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-6">Sign in</h2>

          {sessionExpired && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-amber-900/40 border border-amber-700/50 text-amber-300 text-sm">
              <Clock className="w-4 h-4 flex-shrink-0" />
              Session expired. Please sign in again.
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div>
              <label className="block text-sm text-slate-300 mb-1.5">Username</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-zebra-500 focus:border-transparent"
                  placeholder="Enter username"
                  autoFocus
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm text-slate-300 mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-zebra-500 focus:border-transparent"
                  placeholder="Enter password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="text-sm text-red-400 bg-red-900/30 border border-red-800 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full bg-zebra-600 hover:bg-zebra-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors mt-2"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* Role hint */}
          <div className="mt-6 pt-5 border-t border-slate-700 space-y-2">
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Profiles</p>
            <div className="flex gap-2 text-xs">
              <span className="bg-blue-900/40 text-blue-300 border border-blue-800 rounded px-2 py-1">
                <strong>admin</strong> — Full access
              </span>
              <span className="bg-slate-700/60 text-slate-300 border border-slate-600 rounded px-2 py-1">
                <strong>monitor</strong> — Read-only + email alerts
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
