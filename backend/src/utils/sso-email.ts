// ============================================================
// SSO Email — read identity email injected by load balancer / SSO
// ============================================================

import { Request } from 'express';
import { config } from '../config';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SsoEmailExtractResult = {
  email: string | null;
  /** Email was present in header but failed @domain restriction */
  domainRejected: boolean;
  rejectedEmail?: string;
};

/** Normalize and validate an email address from a trusted header value. */
export function normalizeEmail(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

/** Check email is on the configured SSO allowed domain (default: zebra.com). */
export function isAllowedSsoDomain(email: string): boolean {
  const allowed = (config.sso.allowedDomain || 'zebra.com').trim().toLowerCase().replace(/^@/, '');
  if (!allowed) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain === allowed;
}

function readHeaderEmail(req: Request, headerName: string): string | null {
  return normalizeEmail(req.headers[headerName.toLowerCase()] as string);
}

/**
 * Extract SSO email from the request, enforcing domain restriction.
 * Returns null when SSO is disabled, header missing, or domain not allowed.
 */
export function extractSsoEmail(req: Request): string | null {
  return extractSsoEmailDetailed(req).email;
}

/**
 * Detailed SSO email extraction — includes domain-rejection signal for user messaging.
 * SSO/LDAP flow is active only when infra.ssoEnabled=true (Admin → Config).
 */
export function extractSsoEmailDetailed(req: Request): SsoEmailExtractResult {
  if (!config.sso.enabled) {
    return { email: null, domainRejected: false };
  }

  const headerName = config.sso.emailHeader || 'X-Forwarded-Email';
  let raw: string | null = null;

  if (config.nodeEnv !== 'production') {
    raw = readHeaderEmail(req, 'x-dev-sso-email');
  }

  if (!raw) {
    if (!config.https.trustProxy && config.nodeEnv === 'production') {
      return { email: null, domainRejected: false };
    }
    raw = readHeaderEmail(req, headerName);
  }

  if (!raw) {
    return { email: null, domainRejected: false };
  }

  if (!isAllowedSsoDomain(raw)) {
    return { email: null, domainRejected: true, rejectedEmail: raw };
  }

  return { email: raw, domainRejected: false };
}
