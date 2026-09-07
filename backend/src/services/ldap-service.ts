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

export type LdapAuthResult =
  | { success: true; username: string; email?: string; displayName?: string }
  | { success: false; error: string };

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

/** Authenticate username/password against configured LDAP / Active Directory. */
export async function authenticateLdap(username: string, password: string): Promise<LdapAuthResult> {
  const trimmedUser = username.trim();
  if (!trimmedUser || !password) {
    return { success: false, error: 'Username and password required' };
  }

  if (isLdapDevMockEnabled()) {
    const identity = buildLdapDevMockIdentity(trimmedUser);
    logger.warn(`LDAP DEV MOCK — accepting login user=${identity.username} email=${identity.email} (no server contact)`);
    return { success: true, ...identity };
  }

  if (!configService.getBool('infra.ldapEnabled', false)) {
    return { success: false, error: 'LDAP is not enabled' };
  }

  const ldapUrl = configService.getString('infra.ldapUrl').trim();
  if (!ldapUrl) {
    return { success: false, error: 'LDAP URL is not configured' };
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

  try {
    // Mode A: service bind + user search + user bind
    if (bindDn && searchBase) {
      const filter = applyLdapUsernameTemplate(userFilterTpl, trimmedUser);
      const entries = await withClient(async (client) => {
        await client.bind(bindDn, bindPassword);
        const { searchEntries } = await client.search(searchBase, {
          scope: 'sub',
          filter,
          attributes: ['dn', emailAttr, displayAttr, 'sAMAccountName', 'uid', 'cn'],
          sizeLimit: 2,
        });
        return searchEntries;
      });

      if (entries.length === 0) {
        logger.warn(`LDAP user not found: ${trimmedUser}`);
        return { success: false, error: 'Invalid credentials' };
      }
      if (entries.length > 1) {
        logger.warn(`LDAP search ambiguous for user: ${trimmedUser}`);
        return { success: false, error: 'Invalid credentials' };
      }

      const entry = entries[0];
      const userDn = entry.dn;
      await withClient(async (client) => {
        await client.bind(userDn, password);
      });

      const email = readAttr(entry, emailAttr);
      const displayName = readAttr(entry, displayAttr) || readAttr(entry, 'cn') || trimmedUser;
      const resolvedUsername = readAttr(entry, 'sAMAccountName') || readAttr(entry, 'uid') || ldapUsername;

      logger.info(`LDAP auth success (search+bind) user=${resolvedUsername}`);
      return { success: true, username: resolvedUsername, email, displayName };
    }

    // Mode B: direct DN bind from pattern (e.g. uid={{username}},cn=users,...)
    if (userDnPattern) {
      const userDn = applyLdapDnPattern(userDnPattern, trimmedUser);
      await withClient(async (client) => {
        await client.bind(userDn, password);
      });

      logger.info(`LDAP auth success (DN pattern) user=${ldapUsername}`);
      return {
        success: true,
        username: ldapUsername,
        email: trimmedUser.includes('@') ? trimmedUser.toLowerCase() : undefined,
        displayName: ldapUsername,
      };
    }

    // Mode C: direct UPN bind — username@domain (no service account required)
    if (domain) {
      const upn = trimmedUser.includes('@') ? trimmedUser : `${trimmedUser}@${domain}`;
      await withClient(async (client) => {
        await client.bind(upn, password);
      });

      logger.info(`LDAP auth success (UPN bind) user=${ldapUsername}`);
      return {
        success: true,
        username: ldapUsername,
        email: upn.includes('@') ? upn.toLowerCase() : undefined,
        displayName: trimmedUser,
      };
    }

    return {
      success: false,
      error: 'LDAP misconfigured — set bind DN + search base, user DN pattern, or domain for UPN bind',
    };
  } catch (err: any) {
    const msg = err?.message || 'LDAP authentication failed';
    logger.warn(`LDAP auth failed user=${trimmedUser}: ${msg}`);
    return { success: false, error: 'Invalid credentials' };
  }
}

export function isLdapEnabled(): boolean {
  if (isLdapDevMockEnabled()) return true;
  return configService.getBool('infra.ldapEnabled', false)
    && !!configService.getString('infra.ldapUrl').trim();
}
