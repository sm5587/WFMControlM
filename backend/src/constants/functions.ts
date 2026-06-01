// ============================================================
// Application Function Registry
// Each entry maps to an AppFunction row in the DB.
// id is the stable key used everywhere in code.
// ============================================================

export interface FunctionDef {
  id: string;
  module: string;
  name: string;
  description?: string;
  sortOrder: number;
}

export const APP_FUNCTIONS: Record<string, FunctionDef> = {

  // ── JOBS ──────────────────────────────────────────────────
  JOBS_VIEW:          { id: 'JOBS_VIEW',          module: 'JOBS',      name: 'View Jobs',                  sortOrder: 10 },
  JOBS_CREATE:        { id: 'JOBS_CREATE',         module: 'JOBS',      name: 'Create Jobs',                sortOrder: 11 },
  JOBS_EDIT:          { id: 'JOBS_EDIT',           module: 'JOBS',      name: 'Edit Jobs',                  sortOrder: 12 },
  JOBS_DELETE:        { id: 'JOBS_DELETE',         module: 'JOBS',      name: 'Delete Jobs',                sortOrder: 13 },
  JOBS_TRIGGER:       { id: 'JOBS_TRIGGER',        module: 'JOBS',      name: 'Trigger (Run Now)',           sortOrder: 14 },
  JOBS_TOGGLE:        { id: 'JOBS_TOGGLE',         module: 'JOBS',      name: 'Enable / Disable Jobs',      sortOrder: 15 },

  // ── CLIENTS ───────────────────────────────────────────────
  CLIENTS_VIEW:       { id: 'CLIENTS_VIEW',        module: 'CLIENTS',   name: 'View Clients',               sortOrder: 20 },
  CLIENTS_CREATE:     { id: 'CLIENTS_CREATE',      module: 'CLIENTS',   name: 'Add Client',                 sortOrder: 21 },
  CLIENTS_EDIT:       { id: 'CLIENTS_EDIT',        module: 'CLIENTS',   name: 'Edit Client',                sortOrder: 22 },
  CLIENTS_SYNC:       { id: 'CLIENTS_SYNC',        module: 'CLIENTS',   name: 'Sync Client Jobs',           sortOrder: 23 },
  CLIENTS_DETECT_TZ:  { id: 'CLIENTS_DETECT_TZ',   module: 'CLIENTS',   name: 'Detect Timezones',           sortOrder: 24 },

  // ── ALERTS ────────────────────────────────────────────────
  ALERTS_VIEW:        { id: 'ALERTS_VIEW',         module: 'ALERTS',    name: 'View Alerts',                sortOrder: 30 },
  ALERTS_RULES:       { id: 'ALERTS_RULES',        module: 'ALERTS',    name: 'Manage Alert Rules',         sortOrder: 31 },
  ALERTS_ACK:         { id: 'ALERTS_ACK',          module: 'ALERTS',    name: 'Acknowledge Alerts',         sortOrder: 32 },
  ALERTS_SUPPRESS:    { id: 'ALERTS_SUPPRESS',     module: 'ALERTS',    name: 'Suppress Alerts',            sortOrder: 33 },
  ALERTS_NOTIFY:      { id: 'ALERTS_NOTIFY',       module: 'ALERTS',    name: 'Send Email Notification',    sortOrder: 34 },
  RECIPIENTS_MANAGE:  { id: 'RECIPIENTS_MANAGE',   module: 'ALERTS',    name: 'Manage Notification Recipients', sortOrder: 35 },

  // ── DB MONITOR ────────────────────────────────────────────
  DBMONITOR_VIEW:     { id: 'DBMONITOR_VIEW',      module: 'DBMONITOR', name: 'View DB Monitor',            sortOrder: 40 },

  // ── DB JOBS ───────────────────────────────────────────────
  DBJOBS_VIEW:        { id: 'DBJOBS_VIEW',         module: 'DBJOBS',    name: 'View DB Jobs',               sortOrder: 50 },

  // ── MONITORING / PAYROLL ──────────────────────────────────
  MONITOR_VIEW:       { id: 'MONITOR_VIEW',        module: 'MONITOR',   name: 'View Monitor',               sortOrder: 60 },
  PAYROLL_VIEW:       { id: 'PAYROLL_VIEW',        module: 'PAYROLL',   name: 'View Payroll',               sortOrder: 70 },
  UNPROC_PUNCH_VIEW:  { id: 'UNPROC_PUNCH_VIEW',   module: 'UNPROC_PUNCH', name: 'View Unprocessed Punches', sortOrder: 75 },

  // ── MAINTENANCE ───────────────────────────────────────────
  MAINTENANCE_VIEW:   { id: 'MAINTENANCE_VIEW',    module: 'MAINTENANCE', name: 'View Maintenance Windows',   sortOrder: 55 },
  MAINTENANCE_MANAGE: { id: 'MAINTENANCE_MANAGE',  module: 'MAINTENANCE', name: 'Create / Edit / Cancel Maintenance Windows', sortOrder: 56 },

  // ── ADMIN ─────────────────────────────────────────────────
  USERS_VIEW:         { id: 'USERS_VIEW',          module: 'ADMIN',     name: 'View Users',                 sortOrder: 80 },
  USERS_MANAGE:       { id: 'USERS_MANAGE',        module: 'ADMIN',     name: 'Create / Edit / Deactivate Users', sortOrder: 81 },
  PROFILES_VIEW:      { id: 'PROFILES_VIEW',       module: 'ADMIN',     name: 'View Profiles',              sortOrder: 82 },
  PROFILES_MANAGE:    { id: 'PROFILES_MANAGE',     module: 'ADMIN',     name: 'Create / Edit Profiles',     sortOrder: 83 },
  PERMISSIONS_EDIT:   { id: 'PERMISSIONS_EDIT',    module: 'ADMIN',     name: 'Edit Profile Permissions',   sortOrder: 84 },
  USER_PROFILE_ASSIGN:{ id: 'USER_PROFILE_ASSIGN', module: 'ADMIN',     name: 'Assign Users to Profiles',   sortOrder: 85 },
  DATA_PURGE_VIEW:    { id: 'DATA_PURGE_VIEW',     module: 'ADMIN',     name: 'View Data Purge Settings',   sortOrder: 86 },
  DATA_PURGE_RUN:     { id: 'DATA_PURGE_RUN',      module: 'ADMIN',     name: 'Run / Configure Data Purge', sortOrder: 87 },
};

export type FunctionId = keyof typeof APP_FUNCTIONS;
