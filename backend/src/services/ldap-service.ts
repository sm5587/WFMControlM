// ============================================================
// LDAP Service — direct Active Directory / LDAP authentication
// ============================================================

import { Client } from 'ldapts';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';
import { buildLdapDevMockIdentity, isLdapDevMockEnabled } from '../utils/ldap-dev-mock';
import { applyLdapDnPattern, applyLdapUsernameTemplate } from '../utils/ldap-templates';

const logger = createServiceLogger('LDAP');

export { isLdapDevMockEnabled } from '../utils/ldap-dev-mock';

/** Diagnostic reason for LDAP failures — logged server-side, not returned to clients. */
export type LdapAuthFailureReason =
  | 'MISSING_CREDENTIALS'
  | 'NOT_ENABLED'
  | 'URL_MISSING'
  | 'MISCONFIGURED'
  | 'USER_NOT_FOUND'
  | 'SEARCH_AMBIGUOUS'
  | 'SERVICE_BIND_FAILED'
  | 'USER_BIND_FAILED'
  | 'DN_BIND_FAILED'
  | 'UPN_BIND_FAILED'
  | 'STARTTLS_FAILED'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export type LdapAuthMode = 'search+bind' | 'dn-pattern' | 'upn-bind' | 'none';

export type LdapAuthResult =
  | { success: true; username: string; email?: string; displayName?: string }
  | {
      success: false;
      error: string;
      reason: LdapAuthFailureReason;
      mode?: LdapAuthMode;
      phase?: string;
      detail?: string;
      ldapCode?: number;
    };

function buildClient(): Client {
  const url = configService.getString('infra.ldapUrl').trim();
  const rejectUnauthorized = configService.getBool('infra.ldapTlsRejectUnauthorized', true);
  return new Client({
    url,
    tlsOptions: { rejectUnauthorized },
    timeout: configService.getInt('infra.ldapTimeoutMs', 10000),
  });
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = buildClient();
  try {
    if (configService.getBool('infra.ldapUseStartTls', false)) {
      const rejectUnauthorized = configService.getBool('infra.ldapTlsRejectUnauthorized', true);
      await client.startTLS({ rejectUnauthorized });
    }
    return await fn(client);
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}

function readAttr(entry: Record<string, unknown>, attr: string): string | undefined {
  const val = entry[attr];
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (Array.isArray(val) && typeof val[0] === 'string' && val[0].trim()) return val[0].trim();
  return undefined;
}

function resolveAuthMode(
  bindDn: string,
  searchBase: string,
  userDnPattern: string,
  domain: string,
): LdapAuthMode {
  if (bindDn && searchBase) return 'search+bind';
  if (userDnPattern) return 'dn-pattern';
  if (domain) return 'upn-bind';
  return 'none';
}

function classifyLdapError(err: unknown): {
  reason: LdapAuthFailureReason;
  detail: string;
  ldapCode?: number;
} {
  const e = err as { message?: string; code?: number };
  const msg = e?.message || String(err);
  const ldapCode = typeof e?.code === 'number' ? e.code : undefined;

  if (/timeout|ETIMEDOUT|timed out/i.test(msg)) {
    return { reason: 'TIMEOUT', detail: msg, ldapCode };
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|connection reset|connect E/i.test(msg)) {
    return { reason: 'CONNECTION_FAILED', detail: msg, ldapCode };
  }
  if (ldapCode === 49 || /invalid credentials|AcceptSecurityContext|data 525|data 52e|data 530|data 532|data 533|data 701|data 773/i.test(msg)) {
    return { reason: 'USER_BIND_FAILED', detail: msg, ldapCode };
  }
  if (ldapCode === 32 || /no such object|NO_OBJECT/i.test(msg)) {
    return { reason: 'USER_NOT_FOUND', detail: msg, ldapCode };
  }
  if (ldapCode === 34 || /invalid dn syntax/i.test(msg)) {
    return { reason: 'MISCONFIGURED', detail: msg, ldapCode };
  }
  if (ldapCode === 81 || /server down|unavailable/i.test(msg)) {
    return { reason: 'CONNECTION_FAILED', detail: msg, ldapCode };
  }
  return { reason: 'UNKNOWN', detail: msg, ldapCode };
}

function ldapFailure(
  reason: LdapAuthFailureReason,
  error: string,
  ctx: {
    user: string;
    mode?: LdapAuthMode;
    phase?: string;
    detail?: string;
    ldapCode?: number;
    url?: string;
    searchBase?: string;
    filter?: string;
    userDn?: string;
  },
): LdapAuthResult {
  const parts = [
    `[LDAP-AUTH-FAIL] user=${ctx.user}`,
    `reason=${reason}`,
    ctx.mode ? `mode=${ctx.mode}` : '',
    ctx.phase ? `phase=${ctx.phase}` : '',
    ctx.url ? `url=${ctx.url}` : '',
    ctx.searchBase ? `searchBase=${ctx.searchBase}` : '',
    ctx.filter ? `filter=${ctx.filter}` : '',
    ctx.userDn ? `userDn=${ctx.userDn}` : '',
    ctx.ldapCode != null ? `ldapCode=${ctx.ldapCode}` : '',
    ctx.detail ? `detail=${ctx.detail}` : '',
  ].filter(Boolean);

  logger.warn(parts.join(' '));
  return {
    success: false,
    error,
    reason,
    mode: ctx.mode,
    phase: ctx.phase,
    detail: ctx.detail,
    ldapCode: ctx.ldapCode,
  };
}

/** Authenticate username/password against configured LDAP / Active Directory. */
export async function authenticateLdap(username: string, password: string): Promise<LdapAuthResult> {
  const trimmedUser = username.trim();
  if (!trimmedUser || !password) {
    return ldapFailure('MISSING_CREDENTIALS', 'Username and password required', {
      user: trimmedUser || '(empty)',
      phase: 'validate-input',
    });
  }

  if (isLdapDevMockEnabled()) {
    const identity = buildLdapDevMockIdentity(trimmedUser);
    logger.warn(`LDAP DEV MOCK — accepting login user=${identity.username} email=${identity.email} (no server contact)`);
    return { success: true, ...identity };
  }

  if (!configService.getBool('infra.ldapEnabled', false)) {
    return ldapFailure('NOT_ENABLED', 'LDAP is not enabled', {
      user: trimmedUser,
      phase: 'config-check',
    });
  }

  const ldapUrl = configService.getString('infra.ldapUrl').trim();
  if (!ldapUrl) {
    return ldapFailure('URL_MISSING', 'LDAP URL is not configured', {
      user: trimmedUser,
      phase: 'config-check',
    });
  }

  const bindDn = configService.getString('infra.ldapBindDn').trim();
  const bindPassword = configService.getString('infra.ldapBindPassword');
  const baseDn = configService.getString('infra.ldapBaseDn').trim();
  const searchBase = configService.getString('infra.ldapUserSearchBase').trim() || baseDn;
  const userFilterTpl = configService.getString('infra.ldapUserFilter').trim()
    || '(uid={{username}})';
  const userDnPattern = configService.getString('infra.ldapUserDnPattern').trim();
  const emailAttr = configService.getString('infra.ldapEmailAttribute').trim() || 'mail';
  const displayAttr = configService.getString('infra.ldapDisplayNameAttribute').trim() || 'displayName';
  const domain = configService.getString('infra.ldapDomain').trim().replace(/^@/, '');
  const ldapUsername = trimmedUser.includes('@') ? trimmedUser.split('@')[0] : trimmedUser;
  const mode = resolveAuthMode(bindDn, searchBase, userDnPattern, domain);
  const useStartTls = configService.getBool('infra.ldapUseStartTls', false);

  logger.info(
    `[LDAP-AUTH] Attempt user=${trimmedUser} mode=${mode} url=${ldapUrl}` +
    (useStartTls ? ' startTls=true' : ''),
  );

  if (mode === 'none') {
    return ldapFailure(
      'MISCONFIGURED',
      'LDAP misconfigured — set bind DN + search base, user DN pattern, or domain for UPN bind',
      { user: trimmedUser, mode, phase: 'config-check', url: ldapUrl },
    );
  }

  try {
    // Mode A: service bind + user search + user bind
    if (mode === 'search+bind') {
      const filter = applyLdapUsernameTemplate(userFilterTpl, trimmedUser);
      let entries: Record<string, unknown>[];

      try {
        entries = await withClient(async (client) => {
          try {
            await client.bind(bindDn, bindPassword);
          } catch (bindErr) {
            throw Object.assign(new Error((bindErr as Error).message), {
              _ldapPhase: 'service-bind' as const,
              _ldapCause: bindErr,
            });
          }
          try {
            const { searchEntries } = await client.search(searchBase, {
              scope: 'sub',
              filter,
              attributes: ['dn', emailAttr, displayAttr, 'sAMAccountName', 'uid', 'cn'],
              sizeLimit: 2,
            });
            return searchEntries;
          } catch (searchErr) {
            throw Object.assign(new Error((searchErr as Error).message), {
              _ldapPhase: 'user-search' as const,
              _ldapCause: searchErr,
            });
          }
        });
      } catch (err) {
        const phase = (err as { _ldapPhase?: string })._ldapPhase || 'service-bind-or-search';
        const cause = (err as { _ldapCause?: unknown })._ldapCause ?? err;
        const classified = classifyLdapError(cause);
        const reason: LdapAuthFailureReason = phase === 'service-bind'
          ? 'SERVICE_BIND_FAILED'
          : classified.reason === 'UNKNOWN' ? 'UNKNOWN' : classified.reason;
        return ldapFailure(reason, 'Invalid credentials', {
          user: trimmedUser,
          mode,
          phase,
          url: ldapUrl,
          searchBase,
          filter,
          detail: classified.detail,
          ldapCode: classified.ldapCode,
        });
      }

      if (entries.length === 0) {
        return ldapFailure('USER_NOT_FOUND', 'Invalid credentials', {
          user: trimmedUser,
          mode,
          phase: 'user-search',
          url: ldapUrl,
          searchBase,
          filter,
          detail: 'LDAP search returned 0 entries — check infra.ldapUserFilter and infra.ldapUserSearchBase',
        });
      }
      if (entries.length > 1) {
        return ldapFailure('SEARCH_AMBIGUOUS', 'Invalid credentials', {
          user: trimmedUser,
          mode,
          phase: 'user-search',
          url: ldapUrl,
          searchBase,
          filter,
          detail: `LDAP search returned ${entries.length} entries — filter is too broad`,
        });
      }

      const entry = entries[0];
      const userDn = entry.dn as string;
      try {
        await withClient(async (client) => {
          await client.bind(userDn, password);
        });
      } catch (err) {
        const classified = classifyLdapError(err);
        return ldapFailure('USER_BIND_FAILED', 'Invalid credentials', {
          user: trimmedUser,
          mode,
          phase: 'user-bind',
          url: ldapUrl,
          userDn,
          detail: classified.detail,
          ldapCode: classified.ldapCode,
        });
      }

      const email = readAttr(entry, emailAttr);
      const displayName = readAttr(entry, displayAttr) || readAttr(entry, 'cn') || trimmedUser;
      const resolvedUsername = readAttr(entry, 'sAMAccountName') || readAttr(entry, 'uid') || ldapUsername;

      logger.info(`[LDAP-AUTH] Success mode=search+bind user=${resolvedUsername} email=${email || '(none)'}`);
      return { success: true, username: resolvedUsername, email, displayName };
    }

    // Mode B: direct DN bind from pattern (e.g. uid={{username}},cn=users,...)
    if (mode === 'dn-pattern') {
      const userDn = applyLdapDnPattern(userDnPattern, trimmedUser);
      try {
        await withClient(async (client) => {
          await client.bind(userDn, password);
        });
      } catch (err) {
        const classified = classifyLdapError(err);
        return ldapFailure('DN_BIND_FAILED', 'Invalid credentials', {
          user: trimmedUser,
          mode,
          phase: 'dn-bind',
          url: ldapUrl,
          userDn,
          detail: classified.detail,
          ldapCode: classified.ldapCode,
        });
      }

      logger.info(`[LDAP-AUTH] Success mode=dn-pattern user=${ldapUsername}`);
      return {
        success: true,
        username: ldapUsername,
        email: trimmedUser.includes('@') ? trimmedUser.toLowerCase() : undefined,
        displayName: ldapUsername,
      };
    }

    // Mode C: direct UPN bind — username@domain (no service account required)
    const upn = trimmedUser.includes('@') ? trimmedUser : `${trimmedUser}@${domain}`;
    try {
      await withClient(async (client) => {
        await client.bind(upn, password);
      });
    } catch (err) {
      const classified = classifyLdapError(err);
      return ldapFailure('UPN_BIND_FAILED', 'Invalid credentials', {
        user: trimmedUser,
        mode: 'upn-bind',
        phase: 'upn-bind',
        url: ldapUrl,
        userDn: upn,
        detail: classified.detail,
        ldapCode: classified.ldapCode,
      });
    }

    logger.info(`[LDAP-AUTH] Success mode=upn-bind user=${ldapUsername} upn=${upn}`);
    return {
      success: true,
      username: ldapUsername,
      email: upn.includes('@') ? upn.toLowerCase() : undefined,
      displayName: trimmedUser,
    };
  } catch (err) {
    const classified = classifyLdapError(err);
    const reason = /starttls/i.test(classified.detail) ? 'STARTTLS_FAILED' : classified.reason;
    return ldapFailure(reason, 'Invalid credentials', {
      user: trimmedUser,
      mode,
      phase: 'unexpected',
      url: ldapUrl,
      detail: classified.detail,
      ldapCode: classified.ldapCode,
    });
  }
}

export function isLdapEnabled(): boolean {
  if (isLdapDevMockEnabled()) return true;
  return configService.getBool('infra.ldapEnabled', false)
    && !!configService.getString('infra.ldapUrl').trim();
}
