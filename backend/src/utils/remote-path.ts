/**
 * Validation and safe quoting for remote file paths and shell search terms
 * used in SSH commands (cron log paths, pgrep/grep keys).
 */

/** Characters that must never appear in a remote file path passed to SSH. */
const UNSAFE_PATH_CHARS = /[\0;|&`$()<>\n\r\\]/;

/** Characters unsafe inside grep/pgrep search strings. */
const UNSAFE_GREP_CHARS = /[\0;|&`$()<>'"\n\r\\]/;

/** Safe filename fragment for pgrep -f (script basename only). */
const SAFE_PGREP_TERM = /^[A-Za-z0-9._-]+$/;

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface ValidateRemotePathOptions {
  /** Path must equal or start with one of these absolute prefixes (no trailing slash required). */
  allowedPrefixes: string[];
  /** When true (default), path must end with .log, .txt, or .out */
  requireLogExtension?: boolean;
}

function normalizeAllowedPrefixes(prefixes: string[]): string[] {
  return prefixes
    .map((p) => p.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function pathUnderPrefix(normalizedPath: string, prefix: string): boolean {
  return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}

/**
 * Validate a remote log file path before storing or passing to SSH stat/tail.
 * Returns normalized path or null if invalid.
 */
export function validateRemoteLogPath(
  rawPath: string | null | undefined,
  options: ValidateRemotePathOptions,
): string | null {
  if (!rawPath?.trim()) return null;

  const path = rawPath.trim();
  if (!path.startsWith('/')) return null;
  if (path.includes('..')) return null;
  if (UNSAFE_PATH_CHARS.test(path)) return null;

  const segments = path.split('/').filter(Boolean);
  if (segments.some((s) => s === '..')) return null;

  const normalized = `/${segments.join('/')}`;
  const prefixes = normalizeAllowedPrefixes(options.allowedPrefixes);
  if (prefixes.length === 0) return null;

  if (!prefixes.some((prefix) => pathUnderPrefix(normalized, prefix))) {
    return null;
  }

  const requireExt = options.requireLogExtension !== false;
  if (requireExt && !/\.(log|txt|out)$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

/** Default allowlisted roots for WFM cron log paths. */
export function defaultLogPathAllowPrefixes(wfmPathPrefix = '/mount/RWS4'): string[] {
  const wfm = wfmPathPrefix.trim().replace(/\/+$/, '') || '/mount/RWS4';
  return [wfm, '/mount/backup'];
}

/** Validate remote cron entry file path (e.g. /mount/backup/cronEntry). */
export function validateRemoteCronFilePath(
  rawPath: string | null | undefined,
  allowedPrefixes: string[],
): string | null {
  if (!rawPath?.trim()) return null;
  const path = rawPath.trim();
  if (!path.startsWith('/')) return null;
  if (path.includes('..') || UNSAFE_PATH_CHARS.test(path)) return null;

  const segments = path.split('/').filter(Boolean);
  if (segments.some((s) => s === '..')) return null;

  const normalized = `/${segments.join('/')}`;
  const prefixes = normalizeAllowedPrefixes(allowedPrefixes);
  if (!prefixes.some((prefix) => pathUnderPrefix(normalized, prefix))) {
    return null;
  }
  return normalized;
}

/** Sanitize script basename used in pgrep -f (alphanumeric, dot, underscore, hyphen only). */
export function sanitizePgrepSearchTerm(term: string | null | undefined): string | null {
  if (!term?.trim()) return null;
  const t = term.trim();
  return SAFE_PGREP_TERM.test(t) ? t : null;
}

/** Sanitize path fragment used in grep against syslog/cron logs; must stay under WFM prefix. */
export function sanitizeGrepKey(
  key: string | null | undefined,
  wfmPathPrefix: string,
): string | null {
  if (!key?.trim()) return null;
  const k = key.trim();
  if (UNSAFE_GREP_CHARS.test(k) || k.includes('..')) return null;

  const prefix = wfmPathPrefix.trim().replace(/\/+$/, '') || '/mount/RWS4';
  if (!pathUnderPrefix(k, prefix)) return null;

  return k;
}
