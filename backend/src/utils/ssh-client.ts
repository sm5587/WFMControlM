// ============================================================
// SSH client — credentials, connect, exec with command allowlist
// ============================================================

import { Client as SSH2Client, ConnectConfig } from 'ssh2';
import { generateSync } from 'otplib';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { config } from '../config';
import { createServiceLogger } from './logger';

const logger = createServiceLogger('SSH');

/** Read-only monitoring commands WFM Watch may execute over SSH. */
const ALLOWED_REMOTE_COMMAND =
  /^(cat |tail |tail -|stat |find |pgrep |grep |\(grep |journalctl |db2 |timedatectl |readlink |date |bash -lc )/;

export interface SSHCredentials {
  username: string;
  password: string;
  totpSecret: string;
}

export function sshCredentialsUseTotp(creds: SSHCredentials): boolean {
  return !!creds.totpSecret;
}

export function validateRemoteCommand(command: string): void {
  const cmd = command.trim();
  if (!cmd) {
    throw new Error('Empty SSH command');
  }
  if (!ALLOWED_REMOTE_COMMAND.test(cmd)) {
    throw new Error(`SSH command not permitted: ${cmd.slice(0, 120)}`);
  }
}

function decryptPassword(raw: Record<string, unknown>): string {
  if (!raw.password) return '';
  if (raw.password_format === 'dpapi') {
    try {
      const escaped = String(raw.password).replace(/"/g, '`"');
      const psCmd =
        `$ss = ConvertTo-SecureString '${escaped}'; ` +
        '[System.Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
        '[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))';
      const cmd = `powershell -NoProfile -NonInteractive -Command "${psCmd}"`;
      return execSync(cmd, { timeout: 8000 }).toString().trim();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to DPAPI-decrypt password: ${message}`);
    }
  }
  return Buffer.from(String(raw.password), 'base64').toString();
}

function decodeOptionalBase64(value: unknown): string {
  if (!value) return '';
  return Buffer.from(String(value), 'base64').toString();
}

function findCredentialsFile(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, '.saved_credentials.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function credentialsFromAppConfig(): SSHCredentials | null {
  const username = config.ssh.username?.trim();
  const password = config.ssh.password || '';
  if (!username || !password) return null;

  return {
    username,
    password,
    totpSecret: config.ssh.totpSecret || '',
  };
}

function credentialsFromFile(credPath: string): SSHCredentials | null {
  let text = fs.readFileSync(credPath, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const mode = String(raw.credential_mode || 'service').toLowerCase();

  let creds: SSHCredentials;
  if (mode === 'personal' && raw.personal_username) {
    creds = {
      username: String(raw.personal_username),
      password: decodeOptionalBase64(raw.personal_password),
      totpSecret: decodeOptionalBase64(raw.personal_totp_secret),
    };
  } else {
    creds = {
      username: String(raw.username || ''),
      password: decryptPassword(raw),
      totpSecret: decodeOptionalBase64(raw.totp_secret),
    };
  }

  if (!creds.username || !creds.password) {
    throw new Error(
      `Credentials file ${credPath} is missing username or password (mode=${mode}). ` +
        'Set secrets.sshUsername and secrets.sshPassword in Admin → Config.',
    );
  }
  return creds;
}

/** Load SSH credentials — AppConfig first, then legacy .saved_credentials.json. */
export function loadCredentials(): SSHCredentials {
  const fromConfig = credentialsFromAppConfig();
  if (fromConfig) {
    logger.info(`[Creds] Using SSH credentials from AppConfig (user: ${fromConfig.username})`);
    return fromConfig;
  }

  const explicit = config.ssh.credentialsFile ? [config.ssh.credentialsFile] : [];
  const fromDir = findCredentialsFile(__dirname);
  const fromCwd = findCredentialsFile(process.cwd());
  const candidates = [...explicit, ...(fromDir ? [fromDir] : []), ...(fromCwd ? [fromCwd] : [])];

  for (const credPath of candidates) {
    try {
      const creds = credentialsFromFile(credPath);
      if (creds) {
        logger.info(`[Creds] Loaded from ${credPath} (user: ${creds.username})`);
        return creds;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Creds] Failed to load from ${credPath}: ${message}`);
    }
  }

  throw new Error(
    'No SSH credentials configured. Set secrets.sshUsername and secrets.sshPassword in Admin → Config',
  );
}

/** Build ssh2 connect options — exported for unit tests. */
export function buildSshConnectOptions(
  hostname: string,
  creds: SSHCredentials,
  timeoutMs: number,
): ConnectConfig {
  const connectOpts: ConnectConfig = {
    host: hostname,
    port: config.ssh.port || 22,
    username: creds.username,
    readyTimeout: timeoutMs,
    tryKeyboard: true,
  };

  if (!creds.totpSecret) {
    connectOpts.password = creds.password;
    connectOpts.authHandler = ['password', 'keyboard-interactive'];
  }
  return connectOpts;
}

export function sshConnect(
  hostname: string,
  creds: SSHCredentials,
  hooks?: { onClient?: (conn: SSH2Client) => void },
): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    hooks?.onClient?.(conn);
    const timeoutMs = config.ssh.timeout || 15000;

    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH connection to ${hostname} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn.on('ready', () => {
      clearTimeout(timer);
      resolve(conn);
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH error connecting to ${hostname}: ${err.message}`));
    });

    conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
      const responses: string[] = [];
      for (const prompt of prompts) {
        const p = prompt.prompt.toLowerCase();
        if (p.includes('first') || p.includes('password')) {
          responses.push(creds.password);
        } else if (p.includes('second') || p.includes('token') || p.includes('factor')) {
          responses.push(creds.totpSecret ? generateSync({ secret: creds.totpSecret }) : '');
        } else {
          responses.push(creds.password);
        }
      }
      finish(responses);
    });

    conn.connect(buildSshConnectOptions(hostname, creds, timeoutMs));
  });
}

export function sshExec(conn: SSH2Client, command: string, timeoutSec = 60): Promise<string> {
  validateRemoteCommand(command);
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Command timed out after ${timeoutSec}s: ${command.slice(0, 80)}`));
      }, timeoutSec * 1000);

      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(stdout);
      });
    });
  });
}
