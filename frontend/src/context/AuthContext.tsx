import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi, setOnUnauthorized } from '../services/api';

/** Matches the JWT payload from the backend */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  timezone: string;
  /** functionId → { r: read, w: write } */
  permissions: Record<string, { r: boolean; w: boolean }>;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  sessionExpired: boolean;
  /** Check if user can read a specific function */
  canRead: (functionId: string) => boolean;
  /** Check if user can write a specific function */
  canWrite: (functionId: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = 'wfm_token';
const USER_KEY  = 'wfm_user';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]         = useState<AuthUser | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Rehydrate from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(USER_KEY);
    const token  = localStorage.getItem(TOKEN_KEY);
    if (stored && token) {
      try {
        // Check if token is expired before rehydrating
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          setSessionExpired(true);
        } else {
          setUser(JSON.parse(stored) as AuthUser);
        }
      } catch { /* ignore malformed */ }
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    const { token, user: u } = res.data as { token: string; user: { id: string; username: string; displayName: string; email: string } };
    // Decode permissions from JWT (they're embedded in the payload)
    const payload = JSON.parse(atob(token.split('.')[1]));
    const authUser: AuthUser = {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      timezone: payload.timezone || 'Asia/Kolkata',
      permissions: payload.permissions ?? {},
    };
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(authUser));
    setUser(authUser);
    setSessionExpired(false);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    setSessionExpired(false);
  }, []);

  // Wire up the 401 interceptor to auto-logout
  useEffect(() => {
    setOnUnauthorized(() => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setUser(null);
      setSessionExpired(true);
    });
  }, []);

  const canRead  = useCallback((fn: string) => !!user?.permissions?.[fn]?.r, [user]);
  const canWrite = useCallback((fn: string) => !!user?.permissions?.[fn]?.w, [user]);

  return (
    <AuthContext.Provider value={{ user, isLoading, sessionExpired, canRead, canWrite, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Convenience hook: usePermission('JOBS_CREATE', 'write') → boolean */
export function usePermission(functionId: string, mode: 'read' | 'write' = 'read'): boolean {
  const { canRead, canWrite } = useAuth();
  return mode === 'write' ? canWrite(functionId) : canRead(functionId);
}
