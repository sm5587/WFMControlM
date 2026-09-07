// Read-only banner when sync AppConfig params are false.

import React from 'react';
import { useConfig } from '../../contexts/ConfigContext';
import { APP_CONFIG_KEYS } from '../../constants/app-config-keys';

type SyncParam = 'ssh' | 'dbJobs' | 'punch';

const MESSAGES: Record<SyncParam, string> = {
  ssh: 'SSH sync is disabled (engine.syncEnabled=false) — cron discovery, log checks, and timezone detection are paused.',
  dbJobs: 'DB Jobs sync is disabled (engine.dbJobsSyncEnabled=false) — DB2 queue fetches are paused (cached data still visible).',
  punch: 'Punch sync is disabled (engine.punchSyncEnabled=false) — unprocessed punch DB2 queries are paused (cached data still visible).',
};

const PARAM_KEYS: Record<SyncParam, string> = {
  ssh: APP_CONFIG_KEYS.syncEnabled,
  dbJobs: APP_CONFIG_KEYS.dbJobsSyncEnabled,
  punch: APP_CONFIG_KEYS.punchSyncEnabled,
};

export default function SyncDisabledBanner({ params }: { params: SyncParam[] }) {
  const { getBool } = useConfig();
  const messages = params
    .filter(p => !getBool(PARAM_KEYS[p], true))
    .map(p => MESSAGES[p]);

  if (messages.length === 0) return null;

  return (
    <div className="space-y-2">
      {messages.map(msg => (
        <div key={msg} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
          <p className="text-xs text-red-800">{msg}</p>
        </div>
      ))}
    </div>
  );
}
