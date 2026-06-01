import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Boot-time config — read from env vars first, then overwritten by DB values via applyDbConfig()
export const config = {
  // Server
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database (SQLite)
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
  
  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',

  // SMTP
  smtp: {
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromEmail: process.env.ALERT_FROM_EMAIL || 'wfm-controlm@localhost',
  },
  
  // Slack
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  
  // WFM Integration
  wfm: {
    apiBaseUrl: process.env.WFM_API_BASE_URL || '',
    apiKey: process.env.WFM_API_KEY || '',
  },

  // SSH / AppServer connectivity
  ssh: {
    port: parseInt(process.env.SSH_PORT || '22', 10),
    timeout: parseInt(process.env.SSH_TIMEOUT || '15000', 10),
    username: process.env.SSH_USERNAME || '',
    password: process.env.SSH_PASSWORD || '',
    totpSecret: process.env.SSH_TOTP_SECRET || '',
    cronEntryPath: process.env.CRON_ENTRY_PATH || '/mount/backup/cronEntry',
    wfmPathPrefix: process.env.WFM_PATH_PREFIX || '/mount/RWS4',
    credentialsFile: process.env.SSH_CREDENTIALS_FILE || '',
  },
  
  // Keeper Secrets Manager (for DB2 passwords, SMTP pass, etc.)
  keeper: {
    // Master on/off switch. Set KEEPER_ENABLED=true to activate Keeper integration.
    // When false (default), connection file passwords are used as-is.
    enabled: process.env.KEEPER_ENABLED === 'true',
    // Path to ksm-config.json written after first-run token binding
    configFile: process.env.KEEPER_CONFIG_FILE || '',
    // One-time access token — set only for first run, then remove from .env
    oneTimeToken: process.env.KEEPER_ONE_TIME_TOKEN || '',
    // Legacy / fallback fields kept for backward compat
    serverUrl: process.env.KEEPER_SERVER_URL || '',
    appId: process.env.KEEPER_APP_ID || '',
    clientKey: process.env.KEEPER_CLIENT_KEY || '',
    db2Username: process.env.DB2_USERNAME || '',
    db2Password: process.env.DB2_PASSWORD || '',
  },

  // Break-glass / master account (bypasses DB auth, granted all permissions)
  // Store a bcrypt hash, never the plaintext password.
  // Generate hash: node -e "const b=require('bcryptjs');b.hash('yourpass',10).then(console.log)"
  master: {
    username: process.env.MASTER_USERNAME || '',
    passwordHash: process.env.MASTER_PASSWORD_HASH || '',
  },

  // DB2 lib paths (externalize for Docker)
  db2Paths: {
    libDir: process.env.DB2_LIB_DIR || '',           // e.g. /config/lib
    jjsPath: process.env.JJS_PATH || '',             // e.g. /usr/bin/jjs
  },

  // Logging
  logDir: process.env.LOG_DIR || 'logs',

  // DB2 Connection Pool — manages SSH+DB2 sessions across 75 clients
  db2Pool: {
    maxConnections: parseInt(process.env.DB2_POOL_MAX_CONNECTIONS || '10', 10),    // Max simultaneous SSH+DB2 sessions
    idleTimeoutMs: parseInt(process.env.DB2_POOL_IDLE_TIMEOUT_MS || '300000', 10), // Evict idle connections after 5 min
    acquireTimeoutMs: parseInt(process.env.DB2_POOL_ACQUIRE_TIMEOUT_MS || '30000', 10), // Max wait for pool slot
  },

  // Engine settings
  engine: {
    pollIntervalMs: 5000,       // How often to check for pending jobs
    maxConcurrentJobs: 50,      // Global max concurrent executions
    heartbeatIntervalMs: 10000, // Agent heartbeat interval
    executionHistoryDays: 90,   // Retain execution history
    logRetentionDays: 30,       // Retain execution logs
  },
};

/**
 * After configService.load(), call this to patch the config object
 * with DB-stored values. Existing code continues to use `config.xxx`.
 */
export function applyDbConfig(): void {
  // Lazy import to avoid circular dependency at module load time
  const { configService } = require('../services/config-service');

  // SECRETS
  config.jwtSecret        = configService.getString('secrets.jwtSecret', config.jwtSecret);
  config.jwtExpiresIn     = configService.getString('secrets.jwtExpiresIn', config.jwtExpiresIn);
  config.smtp.host        = configService.getString('secrets.smtpHost', config.smtp.host);
  config.smtp.port        = configService.getInt('secrets.smtpPort', config.smtp.port);
  config.smtp.user        = configService.getString('secrets.smtpUser', config.smtp.user);
  config.smtp.pass        = configService.getString('secrets.smtpPass', config.smtp.pass);
  config.smtp.fromEmail   = configService.getString('secrets.smtpFromEmail', config.smtp.fromEmail);
  config.ssh.username     = configService.getString('secrets.sshUsername', config.ssh.username);
  config.ssh.password     = configService.getString('secrets.sshPassword', config.ssh.password);
  config.ssh.totpSecret   = configService.getString('secrets.sshTotpSecret', config.ssh.totpSecret);
  config.slackWebhookUrl  = configService.getString('secrets.slackWebhookUrl', config.slackWebhookUrl);
  config.master.username  = configService.getString('secrets.masterUsername', config.master.username);
  config.master.passwordHash = configService.getString('secrets.masterPasswordHash', config.master.passwordHash);
  config.keeper.enabled   = configService.getBool('secrets.keeperEnabled', config.keeper.enabled);
  config.keeper.db2Username = configService.getString('secrets.db2Username', config.keeper.db2Username);
  config.keeper.db2Password = configService.getString('secrets.db2Password', config.keeper.db2Password);

  // INFRA
  config.port             = configService.getInt('infra.port', config.port);
  config.nodeEnv          = configService.getString('infra.nodeEnv', config.nodeEnv);
  config.ssh.port         = configService.getInt('infra.sshPort', config.ssh.port);
  config.ssh.timeout      = configService.getInt('infra.sshTimeout', config.ssh.timeout);
  config.ssh.cronEntryPath = configService.getString('infra.sshCronEntryPath', config.ssh.cronEntryPath);
  config.ssh.wfmPathPrefix = configService.getString('infra.sshWfmPathPrefix', config.ssh.wfmPathPrefix);
  config.db2Paths.libDir  = configService.getString('infra.db2LibDir', config.db2Paths.libDir);
  config.db2Paths.jjsPath = configService.getString('infra.db2JjsPath', config.db2Paths.jjsPath);
  config.db2Pool.maxConnections = configService.getInt('infra.db2PoolMax', config.db2Pool.maxConnections);
  config.db2Pool.idleTimeoutMs  = configService.getInt('infra.db2PoolIdleMs', config.db2Pool.idleTimeoutMs);
  config.db2Pool.acquireTimeoutMs = configService.getInt('infra.db2PoolAcquireMs', config.db2Pool.acquireTimeoutMs);
  config.logDir           = configService.getString('infra.logDir', config.logDir);

  // ENGINE (patch into config.engine)
  config.engine.pollIntervalMs     = configService.getInt('engine.pollIntervalMs', config.engine.pollIntervalMs);
  config.engine.maxConcurrentJobs  = configService.getInt('engine.maxConcurrentJobs', config.engine.maxConcurrentJobs);
  config.engine.heartbeatIntervalMs = configService.getInt('engine.heartbeatIntervalMs', config.engine.heartbeatIntervalMs);
  config.engine.executionHistoryDays = configService.getInt('engine.executionHistoryDays', config.engine.executionHistoryDays);
  config.engine.logRetentionDays   = configService.getInt('engine.logRetentionDays', config.engine.logRetentionDays);
}
