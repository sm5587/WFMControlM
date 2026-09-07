// ============================================================
// LDAP Dev Mock — local testing without a corporate LDAP server
// Enabled only when NODE_ENV !== 'production' and LDAP_DEV_MOCK=true
// or AppConfig infra.ldapDevMock=true.
// ============================================================

import { config } from '../config';
import { configService } from '../services/config-service';

/** True when LDAP auth should be simulated (never in production). */
export function isLdapDevMockEnabled(): boolean {
  if (config.nodeEnv === 'production') return false;

  const envFlag = process.env.LDAP_DEV_MOCK;
  if (envFlag === 'true' || envFlag === '1') return true;

  return configService.getBool('infra.ldapDevMock', false);
}

export function buildLdapDevMockIdentity(username: string): {
  username: string;
  email: string;
  displayName: string;
} {
  const trimmedUser = username.trim();
  const ldapUsername = trimmedUser.includes('@') ? trimmedUser.split('@')[0] : trimmedUser;
  const domain = configService.getString('infra.ldapDomain').trim().replace(/^@/, '') || 'zebra.com';
  const email = trimmedUser.includes('@')
    ? trimmedUser.toLowerCase()
    : `${ldapUsername}@${domain}`.toLowerCase();

  return {
    username: ldapUsername,
    email,
    displayName: `${ldapUsername} (dev mock)`,
  };
}

/** Patch public config so the login UI reflects mock LDAP being active. */
export function applyLdapDevMockPublicConfig(publicConfig: Record<string, string>): void {
  if (!isLdapDevMockEnabled()) return;
  publicConfig['infra.ldapEnabled'] = 'true';
  publicConfig['infra.ldapDevMock'] = 'true';
}
