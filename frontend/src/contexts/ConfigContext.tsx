// ============================================================
// ConfigContext — Loads non-secret config from backend at startup.
// Provides typed getters for frontend components.
// ============================================================

import React, { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { configApi } from '../services/api';
import { deploymentHint } from '../components/DeploymentBadge';
import { APP_NAME_CONFIG_KEY, DEFAULT_APP_NAME, DEFAULT_DEPLOYMENT_LABEL } from '../constants/app-display';
import { useAuth } from '../context/AuthContext';

interface ConfigContextValue {
  config: Record<string, string>;
  loaded: boolean;
  appName: string;
  deploymentLabel: string;
  appVersion: string;
  getString: (key: string, fallback: string) => string;
  getInt: (key: string, fallback: number) => number;
  getFloat: (key: string, fallback: number) => number;
  getBool: (key: string, fallback: boolean) => boolean;
  reload: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextValue>({
  config: {},
  loaded: false,
  appName: DEFAULT_APP_NAME,
  deploymentLabel: DEFAULT_DEPLOYMENT_LABEL,
  appVersion: '',
  getString: (_, fb) => fb,
  getInt: (_, fb) => fb,
  getFloat: (_, fb) => fb,
  getBool: (_, fb) => fb,
  reload: async () => {},
});

function mergeConfigMap(
  prev: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  return { ...prev, ...incoming };
}

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [deploymentLabel, setDeploymentLabel] = useState(DEFAULT_DEPLOYMENT_LABEL);
  const [appVersion, setAppVersion] = useState('');

  const applyConfigValues = useCallback((values: Record<string, string>) => {
    if (Object.keys(values).length === 0) return;
    setConfig((prev) => mergeConfigMap(prev, values));
  }, []);

  /** Public — no auth. Includes menu display flags for instant sidebar rendering. */
  const loadDeploymentInfo = useCallback(async () => {
    try {
      const depRes = await fetch('/api/deployment-info');
      if (depRes.ok) {
        const depJson = await depRes.json();
        const label = depJson?.data?.label;
        if (typeof label === 'string' && label.trim()) {
          setDeploymentLabel(label.trim());
        }
        const version = depJson?.data?.version;
        if (typeof version === 'string' && version.trim()) {
          setAppVersion(version.trim());
        }
        const displayFlags = depJson?.data?.displayFlags;
        if (displayFlags && typeof displayFlags === 'object') {
          applyConfigValues(displayFlags as Record<string, string>);
        }
      }
    } catch {
      // deployment-info unavailable — keep default
    } finally {
      setLoaded(true);
    }
  }, [applyConfigValues]);

  const loadAppConfig = useCallback(async () => {
    try {
      const res = await configApi.getPublic();
      if (res.success && res.data) {
        if (Array.isArray(res.data)) {
          const map: Record<string, string> = {};
          for (const item of res.data) {
            map[item.key] = item.value;
          }
          applyConfigValues(map);
        } else if (typeof res.data === 'object') {
          applyConfigValues(res.data as Record<string, string>);
        }
      }
    } catch {
      // Config fetch failed — menu flags from deployment-info still apply
    }
  }, [applyConfigValues]);

  const load = useCallback(async () => {
    await loadDeploymentInfo();
    if (user) {
      await loadAppConfig();
    }
  }, [user, loadDeploymentInfo, loadAppConfig]);

  // Menu flags: fetch immediately (parallel with auth restore)
  useEffect(() => {
    loadDeploymentInfo();
  }, [loadDeploymentInfo]);

  // Full config: fetch in parallel once session is known (background merge)
  useEffect(() => {
    if (authLoading || !user) return;
    loadAppConfig();
  }, [authLoading, user?.id, loadAppConfig]);

  const getString = (key: string, fallback: string) => config[key] ?? fallback;
  const appName = useMemo(() => {
    const name = getString(APP_NAME_CONFIG_KEY, DEFAULT_APP_NAME).trim();
    return name || DEFAULT_APP_NAME;
  }, [config]);

  useEffect(() => {
    if (!loaded) return;
    document.title = `${appName} · ${deploymentHint(deploymentLabel)} | Job Monitoring & Alerting`;
  }, [loaded, appName, deploymentLabel]);
  const getInt = (key: string, fallback: number) => {
    const v = config[key];
    if (v === undefined) return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const getFloat = (key: string, fallback: number) => {
    const v = config[key];
    if (v === undefined) return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const getBool = (key: string, fallback: boolean) => {
    const v = config[key];
    if (v === undefined) return fallback;
    return v === 'true' || v === '1';
  };

  return (
    <ConfigContext.Provider value={{ config, loaded, appName, deploymentLabel, appVersion, getString, getInt, getFloat, getBool, reload: load }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  return useContext(ConfigContext);
}

export function useAppName(): string {
  return useContext(ConfigContext).appName;
}

export function useDeploymentLabel(): string {
  return useContext(ConfigContext).deploymentLabel;
}

export function useAppVersion(): string {
  return useContext(ConfigContext).appVersion;
}
