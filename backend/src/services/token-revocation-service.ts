// ============================================================
// Token revocation — JWT denylist + tokenVersion invalidation
// ============================================================

import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../database/prisma';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';
import { JwtPayload } from '../middleware';
import { signSessionToken } from '../utils/jwt-config';

const logger = createServiceLogger('TokenRevocation');

const MASTER_TOKEN_VERSION_KEY = 'auth.masterTokenVersion';

class TokenRevocationService {
  getMasterTokenVersion(): number {
    const raw = configService.getString(MASTER_TOKEN_VERSION_KEY);
    const parsed = parseInt(raw || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async getUserTokenVersion(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    return user?.tokenVersion ?? 0;
  }

  async createSessionToken(payload: JwtPayload): Promise<string> {
    const isMaster = payload.isMaster === true || payload.userId === 'master';
    const tv = isMaster
      ? this.getMasterTokenVersion()
      : await this.getUserTokenVersion(payload.userId);

    return signSessionToken(
      { ...payload, tv },
      config.jwtSecret,
      {
        expiresIn: config.jwtExpiresIn,
        jwtid: randomUUID(),
      } as jwt.SignOptions,
    );
  }

  async revokeJti(
    jti: string,
    userId: string,
    expiresAt: Date,
    reason: string,
  ): Promise<void> {
    await prisma.revokedToken.upsert({
      where: { jti },
      update: { reason },
      create: { jti, userId, expiresAt, reason },
    });
    logger.info(`Revoked token jti=${jti} userId=${userId} reason=${reason}`);
  }

  async revokeTokenString(token: string, reason: string): Promise<void> {
    const decoded = jwt.decode(token) as JwtPayload | null;
    if (!decoded?.jti || !decoded.exp) return;
    await this.revokeJti(
      decoded.jti,
      decoded.userId || 'unknown',
      new Date(decoded.exp * 1000),
      reason,
    );
  }

  async revokeAllUserTokens(userId: string, reason: string): Promise<number> {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    logger.info(`Bumped tokenVersion for userId=${userId} to ${updated.tokenVersion} reason=${reason}`);
    return updated.tokenVersion;
  }

  async revokeMasterTokens(reason: string, userId?: string): Promise<number> {
    const next = this.getMasterTokenVersion() + 1;
    await configService.update('auth.masterTokenVersion', String(next), userId || 'system');
    logger.warn(`Master tokenVersion bumped to ${next} reason=${reason}`);
    return next;
  }

  async isSessionActive(payload: JwtPayload): Promise<boolean> {
    if (!payload.jti || payload.tv === undefined) {
      return false;
    }

    const revoked = await prisma.revokedToken.findUnique({
      where: { jti: payload.jti },
      select: { jti: true },
    });
    if (revoked) return false;

    const isMaster = payload.isMaster === true || payload.userId === 'master';
    const expectedTv = isMaster
      ? this.getMasterTokenVersion()
      : await this.getUserTokenVersion(payload.userId);

    return payload.tv === expectedTv;
  }

  async purgeExpired(): Promise<number> {
    const result = await prisma.revokedToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      logger.debug(`Purged ${result.count} expired revoked token(s)`);
    }
    return result.count;
  }
}

export const tokenRevocationService = new TokenRevocationService();
