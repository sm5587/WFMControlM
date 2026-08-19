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
  canRead: (functionId: string) => boolean;
  canWrite: (functionId: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
  ssoLogin: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Non-sensitive profile cache for legacy components (not the session token). */
const USER_KEY = 'wfm_user';

function mapMeToAuthUser(data: {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  timezone?: string;
  permissions?: Record<string, { r: boolean; w: boolean }>;
}): AuthUser {
  return {
    id: data.id,
    username: data.username,
    displayName: data.displayName,
    email: data.email,
    timezone: data.timezone || 'Asia/Kolkata',
    permissions: data.permissions ?? {},
  };
}

function persistUserProfile(user: AuthUser | null): void {
  if (user) {
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    sessionStorage.removeItem(USER_KEY);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Restore session from HttpOnly cookie via /me (JWT not accessible to JavaScript)
  useEffect(() => {
    localStorage.removeItem('wfm_token');

    authApi.me()
      .then((res) => {
        const authUser = mapMeToAuthUser(res.data!);
        persistUserProfile(authUser);
        setUser(authUser);
      })
      .catch(() => {
        sessionStorage.removeItem(USER_KEY);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    await authApi.login(username, password);
    const me = await authApi.me();
    const authUser = mapMeToAuthUser(me.data!);
    persistUserProfile(authUser);
    setUser(authUser);
    setSessionExpired(false);
  }, []);

  const ssoLogin = useCallback(async () => {
    await authApi.ssoLogin();
    const me = await authApi.me();
    const authUser = mapMeToAuthUser(me.data!);
    persistUserProfile(authUser);
    setUser(authUser);
    setSessionExpired(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Clear local state even if server logout fails
    }
    sessionStorage.removeItem(USER_KEY);
    localStorage.removeItem('wfm_token');
    setUser(null);
    setSessionExpired(false);
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => {
      sessionStorage.removeItem(USER_KEY);
      localStorage.removeItem('wfm_token');
      setUser(null);
      setSessionExpired(true);
    });
  }, []);

  const canRead = useCallback((fn: string) => !!user?.permissions?.[fn]?.r, [user]);
  const canWrite = useCallback((fn: string) => !!user?.permissions?.[fn]?.w, [user]);

  return (
    <AuthContext.Provider value={{ user, isLoading, sessionExpired, canRead, canWrite, login, ssoLogin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function usePermission(functionId: string, mode: 'read' | 'write' = 'read'): boolean {
  const { canRead, canWrite } = useAuth();
  return mode === 'write' ? canWrite(functionId) : canRead(functionId);
}
