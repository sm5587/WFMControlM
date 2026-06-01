import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { APP_FUNCTIONS } from '../src/constants/functions';

const prisma = new PrismaClient();

// ============================================================
// DB2 connection details are now stored in the database (Client table).
// Use the import-db2-creds.ts script or Admin UI to populate them.
// ============================================================

// ============================================================
// Parse PP_Prod_WAS_Servers.txt (CSV with header)
// Columns: ClientID, Cluster, PP_DNS, Prod_DNS, Status
// Extra clients not in CSV (HMC, MCDDE) are appended below.
// ============================================================
interface ServerRow {
  cid: string;
  cluster: string;
  prodDns?: string;
  ppDns?: string;
}

function loadServerData(): ServerRow[] {
  const csvPath = path.resolve(__dirname, '../../PP_Prod_WAS_Servers.txt');
  const rows: ServerRow[] = [];

  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
    // Skip header row
    for (const line of lines.slice(1)) {
      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < 4) continue;
      const [cid, cluster, ppDns, prodDns] = cols;
      if (!cid) continue;
      rows.push({
        cid,
        cluster,
        prodDns: prodDns || undefined,
        ppDns:   ppDns   || undefined,
      });
    }
    console.log(`Parsed ${rows.length} clients from PP_Prod_WAS_Servers.txt`);
  } else {
    console.warn('PP_Prod_WAS_Servers.txt not found — falling back to empty server list');
  }

  // Extra clients not in the CSV
  const extras: ServerRow[] = [
    { cid: 'HMC',   cluster: 'CL85', prodDns: 'z210sp-hmcrwsprwas01.rfx.zebra.com' },
    { cid: 'MCDDE', cluster: 'CL75', prodDns: 'z182sp-mcdderwsaprwas01.rfx.zebra.com' },
  ];
  for (const extra of extras) {
    if (!rows.find(r => r.cid === extra.cid)) rows.push(extra);
  }

  return rows;
}

// ============================================================
// Realistic timestamps — spread deterministically across clients
// so the UI always shows meaningful data after a reseed.
// ============================================================
function realisticTimestamps(index: number, total: number): {
  lastCronSyncAt: Date | null;
  lastCronAttemptAt: Date | null;
  payrollSyncedAt: Date | null;
} {
  const now = Date.now();
  const h  = 60 * 60 * 1000;
  const d  = 24 * h;

  // Deterministic bucket based on position in list
  const bucket = index % 10;

  // lastCronAttemptAt: 80% of clients attempted recently (within 48h)
  let lastCronAttemptAt: Date | null = null;
  if (bucket < 8) {
    const ageMs = (index % 48) * h + (index % 60) * 60_000;
    lastCronAttemptAt = new Date(now - ageMs);
  }

  // lastCronSyncAt: 50% had a successful sync within 7 days
  let lastCronSyncAt: Date | null = null;
  if (bucket < 5 && lastCronAttemptAt) {
    const ageMs = (index % (7 * 24)) * h;
    lastCronSyncAt = new Date(now - ageMs);
  }

  // payrollSyncedAt: 40% checked within 14 days
  let payrollSyncedAt: Date | null = null;
  if (bucket < 4) {
    const ageMs = (index % (14 * 24)) * h;
    payrollSyncedAt = new Date(now - ageMs);
  }

  return { lastCronSyncAt, lastCronAttemptAt, payrollSyncedAt };
}

async function main() {
  console.log('Seeding WFM Control-M database...');

  // Clear existing data (order matters for foreign keys)
  await prisma.permission.deleteMany();
  await prisma.userProfile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.appFunction.deleteMany();
  await prisma.jobExecution.deleteMany();
  await prisma.alertEvent.deleteMany();
  await prisma.alertRule.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.resourcePool.deleteMany();
  await prisma.calendarDate.deleteMany();
  await prisma.calendar.deleteMany();
  await prisma.syncHistory.deleteMany();
  await prisma.appServer.deleteMany();
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
  console.log('Cleared existing data.');

  // ============================================================
  // CLIENTS & APP SERVERS — loaded dynamically from PP_Prod_WAS_Servers.txt
  // ============================================================

  // White Glove clients (priority customers)
  const whiteGloveClients = new Set([
    'CVSH', 'CVSDC',           // CVS
    'BPG', 'BPUS', 'BPANZ',   // BP
    'HNMG', 'HMC', 'HMROW',   // H&M
    'WAL',                     // Walgreens
    'AZO', 'AZMX',            // Autozone
  ]);

  const db2Map = new Map<string, never>(); // DB2 credentials now managed via Admin UI / import-db2-creds.ts

  // Load server rows from CSV + extras
  const serverData = loadServerData();

  const clientMap: Record<string, string> = {}; // clientCode -> DB id

  for (let i = 0; i < serverData.length; i++) {
    const sd = serverData[i];
    const servers: { id: string; environment: string; serverNum: string; dns: string; isActive: boolean }[] = [];
    if (sd.prodDns) servers.push({ id: uuidv4(), environment: 'Prod', serverNum: '01', dns: sd.prodDns, isActive: true });
    if (sd.ppDns)   servers.push({ id: uuidv4(), environment: 'PP',   serverNum: '01', dns: sd.ppDns,   isActive: true });

    const ts = realisticTimestamps(i, serverData.length);

    const client = await prisma.client.create({
      data: {
        id: uuidv4(),
        clientId: sd.cid,
        name: `${sd.cid} Client`,
        description: `WFM client ${sd.cid} — ${sd.prodDns ? 'Production' : 'Pre-Production only'}`,
        isActive: true,
        cluster: sd.cluster,
        timezone: 'America/Chicago',
        whiteGlove: whiteGloveClients.has(sd.cid),
        db2Port:          50000,
        db2Schema:        'RWSUSER',
        lastCronSyncAt:   ts.lastCronSyncAt,
        lastCronAttemptAt: ts.lastCronAttemptAt,
        payrollSyncedAt:  ts.payrollSyncedAt,
        tags: JSON.stringify([sd.cid.toLowerCase()]),
        appServers: servers.length > 0 ? { create: servers } : undefined,
      },
    });
    clientMap[sd.cid] = client.id;
  }

  const prodCount  = serverData.filter(s => s.prodDns).length;
  const ppCount    = serverData.filter(s => s.ppDns).length;
  const ppOnly     = serverData.filter(s => !s.prodDns);
  console.log(`Created ${serverData.length} clients with ${prodCount} Prod + ${ppCount} PP app servers.`);
  console.log(`  DB2 credentials should be imported separately via import-db2-creds.ts or Admin UI.`);
  if (ppOnly.length) console.log(`  PP-only clients: ${ppOnly.map(s => s.cid).join(', ')}`);


  // ============================================================
  // RESOURCE POOLS
  // ============================================================
  await prisma.resourcePool.createMany({
    data: [
      { id: uuidv4(), name: 'default', description: 'Default resource pool for general jobs', maxConcurrency: 20, currentUsage: 0 },
      { id: uuidv4(), name: 'wfm-compute', description: 'High-compute pool for WFM forecast and optimization', maxConcurrency: 5, currentUsage: 0 },
      { id: uuidv4(), name: 'etl-pool', description: 'Data pipeline and ETL jobs', maxConcurrency: 10, currentUsage: 0 },
    ],
  });
  console.log('Created 3 resource pools');

  // ============================================================
  // RBAC — AppFunctions, Profiles, Permissions, Seed Admin User
  // ============================================================
  console.log('Seeding RBAC (functions, profiles, permissions)...');

  // 1. Upsert all AppFunction rows
  for (const fn of Object.values(APP_FUNCTIONS)) {
    await prisma.appFunction.upsert({
      where: { id: fn.id },
      update: { module: fn.module, name: fn.name, description: fn.description ?? null, sortOrder: fn.sortOrder },
      create: { id: fn.id, module: fn.module, name: fn.name, description: fn.description ?? null, sortOrder: fn.sortOrder },
    });
  }
  console.log(`  Upserted ${Object.keys(APP_FUNCTIONS).length} app functions`);

  // 2. Create default system profiles
  const adminProfileId  = uuidv4();
  const monitorProfileId = uuidv4();
  const readonlyProfileId = uuidv4();

  const adminProfile = await prisma.profile.create({
    data: { id: adminProfileId, name: 'System Admin', description: 'Full access to all features', isSystem: true },
  });
  const monitorProfile = await prisma.profile.create({
    data: { id: monitorProfileId, name: 'Monitor', description: 'Read-only + send email notifications', isSystem: true },
  });
  const readonlyProfile = await prisma.profile.create({
    data: { id: readonlyProfileId, name: 'Read Only', description: 'View all data, no write access', isSystem: true },
  });

  // 3. Permissions for System Admin — all functions read+write
  for (const fn of Object.values(APP_FUNCTIONS)) {
    await prisma.permission.create({
      data: { profileId: adminProfileId, functionId: fn.id, canRead: true, canWrite: true },
    });
  }

  // 4. Permissions for Monitor — read all + write only ALERTS_NOTIFY and JOBS_TRIGGER
  const monitorWriteFns = new Set(['ALERTS_NOTIFY', 'JOBS_TRIGGER']);
  const monitorReadFns = new Set(Object.keys(APP_FUNCTIONS).filter(k =>
    !['USERS_MANAGE', 'PROFILES_MANAGE', 'PERMISSIONS_EDIT', 'USER_PROFILE_ASSIGN'].includes(k)
  ));
  for (const fnId of monitorReadFns) {
    await prisma.permission.create({
      data: { profileId: monitorProfileId, functionId: fnId, canRead: true, canWrite: monitorWriteFns.has(fnId) },
    });
  }

  // 5. Permissions for Read Only — read everything except ADMIN module
  for (const fn of Object.values(APP_FUNCTIONS)) {
    if (fn.module !== 'ADMIN') {
      await prisma.permission.create({
        data: { profileId: readonlyProfileId, functionId: fn.id, canRead: true, canWrite: false },
      });
    }
  }
  console.log('  Created 3 system profiles with permissions');

  // 6. Seed bootstrap admin user (credentials from .env, falls back to defaults)
  const adminUsername = process.env.ADMIN_USERNAME  || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD  || 'wfmadmin2026';
  const adminHash     = await bcrypt.hash(adminPassword, 10);

  const adminUser = await prisma.user.create({
    data: {
      username:    adminUsername,
      email:       `${adminUsername}@zebra.com`,
      displayName: 'Administrator',
      passwordHash: adminHash,
      isActive:    true,
      profiles: {
        create: { profileId: adminProfileId, assignedBy: 'seed' },
      },
    },
  });
  console.log(`  Created bootstrap admin user: ${adminUser.username}`);

  // ============================================================
  // APP CONFIG — Seed all tunable configuration with defaults
  // ============================================================
  console.log('Seeding AppConfig defaults...');
  await prisma.appConfig.deleteMany();

  const configDefaults: Array<{
    key: string; value: string; category: string; label: string; description?: string; isSecret?: boolean;
  }> = [
    // ---- SECRETS ----
    { key: 'secrets.jwtSecret',        value: process.env.JWT_SECRET || 'dev-secret-change-in-production', category: 'SECRETS', label: 'JWT Secret',           description: 'Secret key for signing JWT tokens', isSecret: true },
    { key: 'secrets.jwtExpiresIn',     value: process.env.JWT_EXPIRES_IN || '24h',                        category: 'SECRETS', label: 'JWT Expiry',            description: 'Token lifetime (e.g. 24h, 7d)', isSecret: false },
    { key: 'secrets.smtpHost',         value: process.env.SMTP_HOST || 'localhost',                       category: 'SECRETS', label: 'SMTP Host',             description: 'SMTP relay server hostname', isSecret: false },
    { key: 'secrets.smtpPort',         value: process.env.SMTP_PORT || '587',                             category: 'SECRETS', label: 'SMTP Port',             description: 'SMTP port (587 STARTTLS, 465 implicit TLS, 25 relay)', isSecret: false },
    { key: 'secrets.smtpUser',         value: process.env.SMTP_USER || '',                                category: 'SECRETS', label: 'SMTP Username',         description: 'SMTP auth username (empty = unauthenticated relay)', isSecret: false },
    { key: 'secrets.smtpPass',         value: process.env.SMTP_PASS || '',                                category: 'SECRETS', label: 'SMTP Password',         description: 'SMTP auth password', isSecret: true },
    { key: 'secrets.smtpFromEmail',    value: process.env.ALERT_FROM_EMAIL || 'wfm-controlm@localhost',   category: 'SECRETS', label: 'Email From Address',    description: '"From" address for alert emails', isSecret: false },
    { key: 'secrets.sshUsername',      value: process.env.SSH_USERNAME || '',                              category: 'SECRETS', label: 'SSH Username',          description: 'SSH service account username', isSecret: false },
    { key: 'secrets.sshPassword',      value: process.env.SSH_PASSWORD || '',                              category: 'SECRETS', label: 'SSH Password',          description: 'SSH service account password', isSecret: true },
    { key: 'secrets.sshTotpSecret',    value: process.env.SSH_TOTP_SECRET || '',                           category: 'SECRETS', label: 'SSH TOTP Secret',       description: 'TOTP secret for 2FA SSH auth', isSecret: true },
    { key: 'secrets.slackWebhookUrl',  value: process.env.SLACK_WEBHOOK_URL || '',                        category: 'SECRETS', label: 'Slack Webhook URL',     description: 'Slack incoming webhook URL for notifications', isSecret: true },
    { key: 'secrets.masterUsername',    value: process.env.MASTER_USERNAME || '',                           category: 'SECRETS', label: 'Master Username',       description: 'Break-glass admin username', isSecret: false },
    { key: 'secrets.masterPasswordHash', value: process.env.MASTER_PASSWORD_HASH || '',                    category: 'SECRETS', label: 'Master Password Hash',  description: 'Break-glass admin bcrypt hash', isSecret: true },
    { key: 'secrets.keeperEnabled',    value: process.env.KEEPER_ENABLED || 'false',                      category: 'SECRETS', label: 'Keeper Enabled',        description: 'Enable Keeper Secrets Manager integration', isSecret: false },
    { key: 'secrets.db2Username',      value: process.env.DB2_USERNAME || '',                              category: 'SECRETS', label: 'DB2 Username',          description: 'Fallback DB2 username', isSecret: true },
    { key: 'secrets.db2Password',      value: process.env.DB2_PASSWORD || '',                              category: 'SECRETS', label: 'DB2 Password',          description: 'Fallback DB2 password', isSecret: true },

    // ---- INFRA ----
    { key: 'infra.port',              value: process.env.PORT || '4000',                                   category: 'INFRA', label: 'HTTP Port',              description: 'HTTP server listen port' },
    { key: 'infra.nodeEnv',           value: process.env.NODE_ENV || 'development',                        category: 'INFRA', label: 'Node Environment',       description: 'development or production' },
    { key: 'infra.corsOrigins',       value: 'http://localhost:3000,http://localhost:5173',                 category: 'INFRA', label: 'CORS Origins',           description: 'Comma-separated allowed CORS origins' },
    { key: 'infra.bodySizeLimit',     value: '10mb',                                                       category: 'INFRA', label: 'Body Size Limit',        description: 'Express JSON body size limit' },
    { key: 'infra.sshPort',           value: process.env.SSH_PORT || '22',                                 category: 'INFRA', label: 'SSH Port',               description: 'SSH connection port for app servers' },
    { key: 'infra.sshTimeout',        value: process.env.SSH_TIMEOUT || '15000',                           category: 'INFRA', label: 'SSH Timeout (ms)',       description: 'SSH connection timeout in milliseconds' },
    { key: 'infra.sshCronEntryPath',  value: process.env.CRON_ENTRY_PATH || '/mount/backup/cronEntry',    category: 'INFRA', label: 'SSH Cron Entry Path',    description: 'Remote path to read cron entries' },
    { key: 'infra.sshWfmPathPrefix',  value: process.env.WFM_PATH_PREFIX || '/mount/RWS4',                category: 'INFRA', label: 'WFM Path Prefix',        description: 'Prefix to identify WFM cron jobs' },
    { key: 'infra.db2ConnDir',        value: process.env.DB2_CONN_DIR || '',                               category: 'INFRA', label: 'DB2 Conn Dir',           description: 'Path to DB2 connection .txt files' },
    { key: 'infra.db2LibDir',         value: process.env.DB2_LIB_DIR || '',                                category: 'INFRA', label: 'DB2 Lib Dir',            description: 'Path to DB2Connector.js & db2jcc4.jar' },
    { key: 'infra.db2JjsPath',        value: process.env.JJS_PATH || '',                                   category: 'INFRA', label: 'JJS Path',               description: 'Path to JDK Nashorn jjs binary' },
    { key: 'infra.db2PoolMax',        value: process.env.DB2_POOL_MAX_CONNECTIONS || '10',                 category: 'INFRA', label: 'DB2 Pool Max',           description: 'Max concurrent DB2 pool connections' },
    { key: 'infra.db2PoolIdleMs',     value: process.env.DB2_POOL_IDLE_TIMEOUT_MS || '300000',             category: 'INFRA', label: 'DB2 Pool Idle (ms)',     description: 'Evict idle pool connections after this' },
    { key: 'infra.db2PoolAcquireMs',  value: process.env.DB2_POOL_ACQUIRE_TIMEOUT_MS || '30000',           category: 'INFRA', label: 'DB2 Pool Acquire (ms)',  description: 'Max wait for a DB2 pool slot' },
    { key: 'infra.logDir',            value: process.env.LOG_DIR || 'logs',                                category: 'INFRA', label: 'Log Directory',          description: 'Log file output directory' },
    { key: 'infra.db2DefaultPort',    value: '50000',                                                      category: 'INFRA', label: 'DB2 Default Port',       description: 'Default DB2 port fallback' },

    // ---- POLLING ----
    { key: 'polling.batchRefreshMins',       value: '30',  category: 'POLLING', label: 'Batch Refresh (min)',        description: 'Batch data refresh interval in minutes' },
    { key: 'polling.punchRefreshMins',       value: '30',  category: 'POLLING', label: 'Punch Refresh (min)',        description: 'Punch data refresh interval in minutes' },
    { key: 'polling.escalatedRefreshSecs',   value: '60',  category: 'POLLING', label: 'Escalated Refresh (sec)',    description: 'Escalated alerts refresh interval in seconds' },
    { key: 'polling.punchStatusRefreshSecs', value: '60',  category: 'POLLING', label: 'Punch Status Refresh (sec)', description: 'Punch alert statuses refresh in seconds' },
    { key: 'polling.upcomingJobsRefreshSecs', value: '60', category: 'POLLING', label: 'Upcoming Jobs Refresh (sec)', description: 'Upcoming jobs refresh interval in seconds' },
    { key: 'polling.clientListStaleMins',    value: '5',   category: 'POLLING', label: 'Client List Stale (min)',    description: 'Client list cache TTL in minutes' },
    { key: 'polling.backgroundPollingMins',  value: '30',  category: 'POLLING', label: 'Background Polling (min)',   description: 'Background DB2 poll interval in minutes' },
    { key: 'polling.dbMonitorSyncMins',      value: '30',  category: 'POLLING', label: 'DB Monitor Sync (min)',      description: 'DB Monitor batch sync interval in minutes' },
    { key: 'polling.cronSyncCooldownHrs',    value: '24',  category: 'POLLING', label: 'Cron Sync Cooldown (hrs)',   description: 'Skip cron sync if done less than X hours ago' },
    { key: 'polling.batchCacheTtlMins',      value: '30',  category: 'POLLING', label: 'Batch Cache TTL (min)',      description: 'Backend batch summary cache TTL in minutes' },

    // ---- THRESHOLDS ----
    { key: 'threshold.stalePendingCritical', value: '10',  category: 'THRESHOLDS', label: 'Critical Threshold',       description: 'stalePendingCount >= X → CRITICAL badge' },
    { key: 'threshold.stalePendingWarning',  value: '5',   category: 'THRESHOLDS', label: 'Warning Threshold',        description: 'stalePendingCount >= X → WARNING badge' },
    { key: 'threshold.punchCountMin',        value: '100', category: 'THRESHOLDS', label: 'Min Punch Count',          description: 'Minimum punchCount to flag a client' },
    { key: 'threshold.staleHoursMins',       value: '60',  category: 'THRESHOLDS', label: 'Stale Threshold (min)',     description: 'Minutes before punch/pending is considered stale' },
    { key: 'threshold.escalationMins',       value: '60',  category: 'THRESHOLDS', label: 'Escalation Threshold (min)', description: 'Pending > X mins → escalated to Red tab' },
    { key: 'threshold.jobPriorityCritical',  value: '8',   category: 'THRESHOLDS', label: 'Job Priority Critical',    description: 'Job priority >= X → CRITICAL color' },
    { key: 'threshold.jobPriorityWarning',   value: '5',   category: 'THRESHOLDS', label: 'Job Priority Warning',     description: 'Job priority >= X → WARNING color' },
    { key: 'threshold.purgeRowsRed',         value: '10000', category: 'THRESHOLDS', label: 'Purge Rows Red',         description: 'Admin purge count > X → red highlight' },
    { key: 'threshold.purgeRowsAmber',       value: '1000',  category: 'THRESHOLDS', label: 'Purge Rows Amber',       description: 'Admin purge count > X → amber highlight' },
    { key: 'threshold.defaultSuppressMins',  value: '60',    category: 'THRESHOLDS', label: 'Default Suppress (min)',  description: 'Default suppress duration in modal' },
    { key: 'threshold.stalePendingDbMins',   value: '30',    category: 'THRESHOLDS', label: 'DB Stale Pending (min)',  description: 'DB2 SQL: pending older than X mins = stale' },

    // ---- ENGINE ----
    { key: 'engine.pollIntervalMs',       value: '5000',    category: 'ENGINE', label: 'Poll Interval (ms)',       description: 'Pending job check interval' },
    { key: 'engine.maxConcurrentJobs',    value: '50',      category: 'ENGINE', label: 'Max Concurrent Jobs',     description: 'Global max concurrent job executions' },
    { key: 'engine.heartbeatIntervalMs',  value: '10000',   category: 'ENGINE', label: 'Heartbeat Interval (ms)', description: 'Agent heartbeat interval' },
    { key: 'engine.executionHistoryDays', value: '90',      category: 'ENGINE', label: 'Execution History (days)', description: 'Retain execution history for this many days' },
    { key: 'engine.logRetentionDays',     value: '30',      category: 'ENGINE', label: 'Log Retention (days)',     description: 'Retain execution logs for this many days' },
    { key: 'engine.maxBatchDetailRows',   value: '500',     category: 'ENGINE', label: 'Max Batch Detail Rows',   description: 'FETCH FIRST X ROWS in batch detail DB2 query' },
    { key: 'engine.db2QueryConcurrency',  value: '5',       category: 'ENGINE', label: 'DB2 Query Concurrency',   description: 'Concurrent per-client DB2 queries' },
    { key: 'engine.batchQueryDays',       value: '7',       category: 'ENGINE', label: 'Batch Query Days',         description: 'Default batch status query window in days' },
    { key: 'engine.punchLookbackDays',    value: '2',       category: 'ENGINE', label: 'Punch Lookback (days)',    description: 'Unprocessed punch DB2 lookback window' },
    { key: 'engine.payrollLookbackDays',  value: '7',       category: 'ENGINE', label: 'Payroll Lookback (days)',  description: 'Payroll DB2 lookback window' },
    { key: 'engine.purgeSchedule',        value: '0 2 * * *', category: 'ENGINE', label: 'Purge Schedule',        description: 'Nightly data purge cron expression' },
    { key: 'engine.jjsTimeoutMs',         value: '120000',  category: 'ENGINE', label: 'JJS Timeout (ms)',         description: 'DB2 jjs child process timeout' },
    { key: 'engine.jjsMaxBuffer',         value: '10485760', category: 'ENGINE', label: 'JJS Max Buffer',          description: 'DB2 jjs stdout max buffer size in bytes' },
    { key: 'engine.maxOutputChars',       value: '50000',   category: 'ENGINE', label: 'Max Output Chars',         description: 'Max stored output per execution' },
    { key: 'engine.maxErrorChars',        value: '10000',   category: 'ENGINE', label: 'Max Error Chars',          description: 'Max stored error message per execution' },
    { key: 'engine.keeperCacheTtlMins',   value: '5',       category: 'ENGINE', label: 'Keeper Cache TTL (min)',   description: 'Keeper secret cache TTL in minutes' },
    { key: 'engine.upcomingScanIntervalMins', value: '60',  category: 'ENGINE', label: 'Upcoming Scan Interval (min)', description: 'Upcoming job scanner interval' },
    { key: 'engine.postRunCheckDelayMins', value: '30',     category: 'ENGINE', label: 'Post-Run Check Delay (min)', description: 'Delay before post-run log status check' },
    { key: 'engine.dbMonitorBatchDays',   value: '2',       category: 'ENGINE', label: 'DB Monitor Batch Days',   description: 'Default batch summary window at startup' },

    // ---- DISPLAY ----
    { key: 'display.defaultTimezone',        value: 'Asia/Kolkata', category: 'DISPLAY', label: 'Default Timezone',      description: 'Default timezone when user has none set' },
    { key: 'display.defaultBatchDays',       value: '2',            category: 'DISPLAY', label: 'Default Batch Days',     description: 'Default batch days shown on pages' },
    { key: 'display.panelMinWidth',          value: '160',          category: 'DISPLAY', label: 'Panel Min Width (px)',   description: 'Resizable panel min width in pixels' },
    { key: 'display.panelMaxWidth',          value: '700',          category: 'DISPLAY', label: 'Panel Max Width (px)',   description: 'Resizable panel max width in pixels' },
    { key: 'display.wsReconnectAttempts',    value: '10',           category: 'DISPLAY', label: 'WS Reconnect Attempts', description: 'WebSocket max reconnection attempts' },
    { key: 'display.wsReconnectDelayMs',     value: '1000',         category: 'DISPLAY', label: 'WS Reconnect Delay (ms)', description: 'WebSocket reconnect delay in ms' },
  ];

  for (const c of configDefaults) {
    await prisma.appConfig.create({
      data: {
        key: c.key,
        value: c.value,
        category: c.category,
        label: c.label,
        description: c.description ?? null,
        isSecret: c.isSecret ?? false,
        updatedBy: 'seed',
      },
    });
  }
  console.log(`  Seeded ${configDefaults.length} AppConfig entries`);

  console.log('\n✅ Seed completed successfully!');
  console.log(`Summary:
  - ${serverData.length} clients (${serverData.filter(s => s.prodDns).length} with Prod + ${serverData.filter(s => s.ppDns).length} with PP servers)
  - ${serverData.filter(s => !s.prodDns).length} PP-only clients: ${serverData.filter(s => !s.prodDns).map(s => s.cid).join(', ')}
  - Realistic timestamps seeded (lastCronSyncAt, lastCronAttemptAt, payrollSyncedAt)
  - 0 jobs (jobs are discovered via SSH sync)
  - 3 resource pools
  - 3 system profiles, ${Object.keys(APP_FUNCTIONS).length} functions
  - 1 bootstrap admin user: ${adminUser.username}
  - ${configDefaults.length} AppConfig entries
  `);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
