// ============================================================
// Access Request Service — SSO / LDAP registration queue
// ============================================================

import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { isAllowedSsoDomain } from '../utils/sso-email';
import { config } from '../config';

const logger = createServiceLogger('AccessRequest');

export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface SsoAccessStatus {
  ssoEnabled: boolean;
  email: string | null;
  status: AccessRequestStatus | 'ACTIVE' | 'DOMAIN_DENIED' | null;
  canLogin: boolean;
  displayName?: string | null;
  message?: string;
}

export interface AccessRequestOptions {
  displayName?: string;
  requestedUsername?: string;
}

function emailLocalPart(email: string): string {
  return email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user';
}

async function uniqueUsername(base: string): Promise<string> {
  let candidate = base.slice(0, 48);
  let suffix = 0;
  while (true) {
    const username = suffix === 0 ? candidate : `${candidate}${suffix}`;
    const existing = await prisma.user.findUnique({ where: { username } });
    if (!existing) return username;
    suffix += 1;
  }
}

/** Resolve access state for an email — creates a pending request when needed. */
export async function resolveAccessRequestStatus(
  email: string,
  sourceIp?: string,
  options?: AccessRequestOptions,
): Promise<SsoAccessStatus> {
  if (!isAllowedSsoDomain(email)) {
    const allowedDomain = config.sso.allowedDomain || 'zebra.com';
    return {
      ssoEnabled: false,
      email,
      status: 'DOMAIN_DENIED',
      canLogin: false,
      displayName: options?.displayName,
      message: `Access is restricted to @${allowedDomain} accounts only.`,
    };
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    include: { profiles: true },
  });

  if (existingUser) {
    if (!existingUser.isActive) {
      return {
        ssoEnabled: false,
        email,
        status: 'REJECTED',
        canLogin: false,
        displayName: existingUser.displayName,
        message: 'Your account has been deactivated. Contact an administrator.',
      };
    }
    const hasProfiles = existingUser.profiles.length > 0;
    return {
      ssoEnabled: false,
      email,
      status: 'ACTIVE',
      canLogin: hasProfiles,
      displayName: existingUser.displayName,
      message: hasProfiles
        ? undefined
        : 'Your account is approved but no profile has been assigned yet. Contact an administrator.',
    };
  }

  let request = await prisma.accessRequest.findUnique({ where: { email } });

  if (!request) {
    request = await prisma.accessRequest.create({
      data: {
        email,
        sourceIp,
        status: 'PENDING',
        displayName: options?.displayName?.trim() || null,
        requestedUsername: options?.requestedUsername?.trim() || null,
      },
    });
    logger.info(`New access request created email=${email} ip=${sourceIp || 'unknown'}`);
  } else if (request.status === 'REJECTED') {
    request = await prisma.accessRequest.update({
      where: { id: request.id },
      data: {
        status: 'PENDING',
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
        requestedAt: new Date(),
        sourceIp,
        displayName: options?.displayName?.trim() || request.displayName,
        requestedUsername: options?.requestedUsername?.trim() || request.requestedUsername,
      },
    });
    logger.info(`Access request re-opened email=${email}`);
  } else if (options?.displayName || options?.requestedUsername) {
    request = await prisma.accessRequest.update({
      where: { id: request.id },
      data: {
        sourceIp,
        ...(options.displayName?.trim() ? { displayName: options.displayName.trim() } : {}),
        ...(options.requestedUsername?.trim() ? { requestedUsername: options.requestedUsername.trim() } : {}),
      },
    });
  }

  return {
    ssoEnabled: false,
    email,
    status: request.status as AccessRequestStatus,
    canLogin: false,
    displayName: request.displayName,
    message:
      request.status === 'PENDING'
        ? 'Your access request is pending administrator approval.'
        : undefined,
  };
}

/** Resolve SSO access state for an email — creates a pending request when needed. */
export async function resolveSsoAccessStatus(
  email: string,
  sourceIp?: string,
): Promise<SsoAccessStatus> {
  const status = await resolveAccessRequestStatus(email, sourceIp);
  return { ...status, ssoEnabled: true };
}

/** Resolve LDAP access state after successful AD authentication. */
export async function resolveLdapAccessStatus(
  email: string,
  sourceIp?: string,
  options?: AccessRequestOptions,
): Promise<SsoAccessStatus> {
  return resolveAccessRequestStatus(email, sourceIp, options);
}

/** Approve a pending access request — creates user and assigns profile. */
export async function approveAccessRequest(
  requestId: string,
  profileId: string,
  reviewer: string,
  options?: { displayName?: string; username?: string },
): Promise<{ userId: string; username: string }> {
  const request = await prisma.accessRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Access request not found');
  if (request.status !== 'PENDING') throw new Error(`Request is already ${request.status.toLowerCase()}`);

  const profile = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!profile) throw new Error('Profile not found');

  const existingUser = await prisma.user.findUnique({ where: { email: request.email } });
  if (existingUser) throw new Error('A user with this email already exists');

  const baseUsername = options?.username?.trim()
    || request.requestedUsername?.trim()
    || emailLocalPart(request.email);
  const username = await uniqueUsername(baseUsername);
  const displayName = options?.displayName?.trim() || request.displayName || username;
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username,
        email: request.email,
        displayName,
        passwordHash,
        isActive: true,
      },
    });

    await tx.userProfile.create({
      data: { userId: created.id, profileId, assignedBy: reviewer },
    });

    await tx.accessRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedBy: reviewer,
        displayName,
        userId: created.id,
      },
    });

    return created;
  });

  logger.info(`Access request approved id=${requestId} email=${request.email} user=${username} by=${reviewer}`);
  return { userId: user.id, username: user.username };
}

/** Reject a pending access request. */
export async function rejectAccessRequest(
  requestId: string,
  reviewer: string,
  note?: string,
): Promise<void> {
  const request = await prisma.accessRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Access request not found');
  if (request.status !== 'PENDING') throw new Error(`Request is already ${request.status.toLowerCase()}`);

  await prisma.accessRequest.update({
    where: { id: requestId },
    data: {
      status: 'REJECTED',
      reviewedAt: new Date(),
      reviewedBy: reviewer,
      reviewNote: note?.trim() || null,
    },
  });

  logger.info(`Access request rejected id=${requestId} email=${request.email} by=${reviewer}`);
}
