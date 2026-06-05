// ============================================================
// ConfigContext — Loads non-secret config from backend at startup.
// Provides typed getters for frontend components.
// ============================================================

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { configApi } from '../services/api';
import { APP_NAME_CONFIG_KEY, DEFAULT_APP_NAME } from '../constants/app-display';

interface ConfigContextValue {
  config: Record<string, string>;
  loaded: boolean;
  appName: string;
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
  getString: (_, fb) => fb,
  getInt: (_, fb) => fb,
  getFloat: (_, fb) => fb,
  getBool: (_, fb) => fb,
  reload: async () => {},
});

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const res = await configApi.getPublic();
      if (res.success && res.data) {
        if (Array.isArray(res.data)) {
          // Array of { key, value } objects
          const map: Record<string, string> = {};
          for (const item of res.data) {
            map[item.key] = item.value;
          }
          setConfig(map);
        } else if (typeof res.data === 'object') {
          // Flat Record<string, string>
          setConfig(res.data as Record<string, string>);
        }
      }
    } catch {
      // Config fetch failed — use defaults
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { load(); }, []);

  const getString = (key: string, fallback: string) => config[key] ?? fallback;
  const appName = useMemo(() => {
    const name = getString(APP_NAME_CONFIG_KEY, DEFAULT_APP_NAME).trim();
    return name || DEFAULT_APP_NAME;
  }, [config]);

  useEffect(() => {
    if (!loaded) return;
    document.title = `${appName} | Job Monitoring & Alerting`;
  }, [loaded, appName]);
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
    <ConfigContext.Provider value={{ config, loaded, appName, getString, getInt, getFloat, getBool, reload: load }}>
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
