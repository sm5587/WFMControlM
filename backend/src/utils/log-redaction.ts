// ============================================================
// Log redaction — strip secrets from strings and structured meta
// ============================================================

export const REDACTED = '[redacted]';

/** Object keys whose values are always redacted (case-insensitive). */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'apiKey',
  'authorization',
  'auth',
  'jwt',
  'bearer',
  'privatekey',
  'private_key',
  'db2password',
  'db2_password',
  'db2pass',
  'db2_pass',
  'db2_pass_override',
  'db2_user_override',
  'smtppass',
  'smtp_pass',
  'smtpuser',
  'smtp_user',
  'jwtsecret',
  'jwt_secret',
  'config_encryption_key',
  'master_password',
  'master_password_hash',
  'credential',
  'credentials',
  'access_key',
  'accesskey',
  'refresh_token',
  'accesstoken',
  'access_token',
  'sessiontoken',
  'session_token',
  'keeper_token',
  'one_time_token',
]);

const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

const JDBC_CREDS_PATTERN = /jdbc:[a-z0-9+]+:\/\/[^:\s/]+:[^@\s/]+@/gi;

const ENV_SECRET_PATTERN =
  /((?:DB2_PASS_OVERRIDE|DB2_USER_OVERRIDE|CONFIG_ENCRYPTION_KEY(?:_PREVIOUS)?|JWT_SECRET|MASTER_PASSWORD(?:_HASH)?)\s*=\s*)[^\s&'"`,;]+/gi;

const KV_SECRET_PATTERN =
  /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s&'"`,;]+/gi;

const ENC_BLOB_PATTERN = /enc:v1:[A-Za-z0-9+/=]{16,}/g;

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

/**
 * Redact known secret patterns from a free-form log string.
 */
export function redactString(text: string): string {
  if (!text) return text;

  return text
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(JDBC_CREDS_PATTERN, (match) => {
      const schemeEnd = match.indexOf('://') + 3;
      return `${match.slice(0, schemeEnd)}${REDACTED}@`;
    })
    .replace(ENV_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(KV_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(ENC_BLOB_PATTERN, REDACTED);
}

/**
 * Deep-redact objects logged as Winston meta (or nested JSON).
 */
export function redactValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) {
    return REDACTED;
  }

  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }

  return redactString(String(value));
}

/** Scrub remote batch log lines before API response (defence in depth). */
export function scrubRemoteLogLines(lines: string[]): string[] {
  return lines.map(line => redactString(line));
}
