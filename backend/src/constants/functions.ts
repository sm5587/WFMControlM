// ============================================================
// Application Function Registry
// Each entry maps to an AppFunction row in the DB.
// id is the stable key used everywhere in code.
// Display `name` values match sidebar menu labels where applicable.
// ============================================================

export interface FunctionDef {
  id: string;
  module: string;
  name: string;
  description?: string;
  sortOrder: number;
}

export const APP_FUNCTIONS: Record<string, FunctionDef> = {

  // ── Cron Jobs (menu: Cron Jobs) ───────────────────────────
  JOBS_VIEW:          { id: 'JOBS_VIEW',          module: 'Cron Jobs', name: 'Cron Jobs',                       sortOrder: 10 },
  JOBS_CREATE:        { id: 'JOBS_CREATE',        module: 'Cron Jobs', name: 'Cron Jobs — Create',              sortOrder: 11 },
  JOBS_EDIT:          { id: 'JOBS_EDIT',          module: 'Cron Jobs', name: 'Cron Jobs — Edit',                sortOrder: 12 },
  JOBS_DELETE:        { id: 'JOBS_DELETE',        module: 'Cron Jobs', name: 'Cron Jobs — Delete',              sortOrder: 13 },
  JOBS_TRIGGER:       { id: 'JOBS_TRIGGER',       module: 'Cron Jobs', name: 'Cron Jobs — Run Now',             sortOrder: 14 },
  JOBS_TOGGLE:        { id: 'JOBS_TOGGLE',        module: 'Cron Jobs', name: 'Cron Jobs — Enable / Disable',    sortOrder: 15 },
  JOBS_LOG_TAIL:      { id: 'JOBS_LOG_TAIL',      module: 'Cron Jobs', name: 'Cron Jobs — Remote Log Tail',     description: 'View remote batch log content via SSH', sortOrder: 16 },

  // ── Clients (menu: Clients) ─────────────────────────────
  CLIENTS_VIEW:       { id: 'CLIENTS_VIEW',       module: 'Clients',   name: 'Clients',                         sortOrder: 20 },
  CLIENTS_CREATE:     { id: 'CLIENTS_CREATE',     module: 'Clients',   name: 'Clients — Add',                   sortOrder: 21 },
  CLIENTS_EDIT:       { id: 'CLIENTS_EDIT',       module: 'Clients',   name: 'Clients — Edit',                  sortOrder: 22 },
  CLIENTS_SYNC:       { id: 'CLIENTS_SYNC',       module: 'Clients',   name: 'Clients — Sync Jobs',             sortOrder: 23 },
  CLIENTS_DETECT_TZ:  { id: 'CLIENTS_DETECT_TZ',  module: 'Clients',   name: 'Clients — Detect Timezones',      sortOrder: 24 },

  // ── Alerts (menu: Alerts) ─────────────────────────────────
  ALERTS_VIEW:        { id: 'ALERTS_VIEW',        module: 'Alerts',    name: 'Alerts',                          sortOrder: 30 },
  ALERTS_RULES:       { id: 'ALERTS_RULES',       module: 'Alerts',    name: 'Alerts — Manage Rules',           sortOrder: 31 },
  ALERTS_ACK:         { id: 'ALERTS_ACK',         module: 'Alerts',    name: 'Alerts — Acknowledge',            sortOrder: 32 },
  ALERTS_SUPPRESS:    { id: 'ALERTS_SUPPRESS',    module: 'Alerts',    name: 'Alerts — Suppress',               sortOrder: 33 },
  ALERTS_NOTIFY:      { id: 'ALERTS_NOTIFY',      module: 'Alerts',    name: 'Alerts — Send Email',             sortOrder: 34 },
  RECIPIENTS_MANAGE:  { id: 'RECIPIENTS_MANAGE',  module: 'Alerts',    name: 'Alerts — Manage Recipients',      sortOrder: 35 },

  // ── DB Jobs Monitor (menu: DB Jobs Monitor) ─────────────
  DBMONITOR_VIEW:     { id: 'DBMONITOR_VIEW',     module: 'DB Jobs Monitor', name: 'DB Jobs Monitor',           sortOrder: 40 },

  // ── DB Jobs (menu: DB Jobs) ─────────────────────────────
  DBJOBS_VIEW:        { id: 'DBJOBS_VIEW',        module: 'DB Jobs',   name: 'DB Jobs',                         sortOrder: 50 },

  // ── Legacy monitor module (no dedicated menu item) ────────
  MONITOR_VIEW:       { id: 'MONITOR_VIEW',       module: 'Monitor',   name: 'Monitor',                         sortOrder: 60 },

  // ── Payroll Jobs (menu: Payroll Jobs) ───────────────────
  PAYROLL_VIEW:       { id: 'PAYROLL_VIEW',       module: 'Payroll Jobs', name: 'Payroll Jobs',               sortOrder: 70 },

  // ── Unprocessed Punch (menu: Unprocessed Punch) ─────────
  UNPROC_PUNCH_VIEW:         { id: 'UNPROC_PUNCH_VIEW',         module: 'Unprocessed Punch', name: 'Unprocessed Punch',                      sortOrder: 75 },
  UNPROC_PUNCH_REFRESH_ALL:  { id: 'UNPROC_PUNCH_REFRESH_ALL',  module: 'Unprocessed Punch', name: 'Unprocessed Punch — Refresh All',        description: 'Reload punch counts for all RTA clients from DB2', sortOrder: 76 },
  UNPROC_PUNCH_REFRESH_HIGH: { id: 'UNPROC_PUNCH_REFRESH_HIGH', module: 'Unprocessed Punch', name: 'Unprocessed Punch — Refresh High Alert', description: 'Reload punch counts for high-alert clients (>500 pending)', sortOrder: 77 },
  UNPROC_PUNCH_REFRESH_ROW:  { id: 'UNPROC_PUNCH_REFRESH_ROW',  module: 'Unprocessed Punch', name: 'Unprocessed Punch — Refresh Client',     description: 'Reload punch count for a single client from DB2', sortOrder: 78 },

  // ── Maintenance (menu: Maintenance) ─────────────────────
  MAINTENANCE_VIEW:   { id: 'MAINTENANCE_VIEW',   module: 'Maintenance', name: 'Maintenance',                   sortOrder: 55 },
  MAINTENANCE_MANAGE: { id: 'MAINTENANCE_MANAGE', module: 'Maintenance', name: 'Maintenance — Manage',          sortOrder: 56 },
  OUTAGE_VIEW:        { id: 'OUTAGE_VIEW',        module: 'Maintenance', name: 'Maintenance — Outage Impact',   sortOrder: 57 },

  // ── Upload Monitor (menu: Upload Monitor) ─────────────────
  FILE_MONITOR_VIEW:  { id: 'FILE_MONITOR_VIEW',  module: 'Upload Monitor', name: 'Upload Monitor',            sortOrder: 58 },

  // ── Admin (menu: Users, Profiles, Purge, Config) ────────
  USERS_VIEW:         { id: 'USERS_VIEW',         module: 'Admin',     name: 'Users',                           sortOrder: 80 },
  USERS_MANAGE:       { id: 'USERS_MANAGE',       module: 'Admin',     name: 'Users — Manage',                sortOrder: 81 },
  PROFILES_VIEW:      { id: 'PROFILES_VIEW',      module: 'Admin',     name: 'Profiles',                        sortOrder: 82 },
  PROFILES_MANAGE:    { id: 'PROFILES_MANAGE',    module: 'Admin',     name: 'Profiles — Manage',               sortOrder: 83 },
  PERMISSIONS_EDIT:   { id: 'PERMISSIONS_EDIT',   module: 'Admin',     name: 'Config',                          sortOrder: 84 },
  USER_PROFILE_ASSIGN:{ id: 'USER_PROFILE_ASSIGN',module: 'Admin',     name: 'Users — Assign Profiles',         sortOrder: 85 },
  DATA_PURGE_VIEW:    { id: 'DATA_PURGE_VIEW',    module: 'Admin',     name: 'Purge',                           sortOrder: 86 },
  DATA_PURGE_RUN:     { id: 'DATA_PURGE_RUN',     module: 'Admin',     name: 'Purge — Run / Configure',         sortOrder: 87 },
};

export type FunctionId = keyof typeof APP_FUNCTIONS;
