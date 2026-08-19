// ============================================================
// WebSocket auth — JWT handshake + permission stream rooms
// ============================================================

import { Socket } from 'socket.io';
import {
  extractTokenFromAuthHeader,
  hasPermission,
  JwtUser,
  verifyJwtToken,
} from '../middleware';
import { extractSessionTokenFromCookie } from '../utils/session-cookie';

export const WS_STREAM_ROOMS = {
  execution: 'stream:execution',
  alerts: 'stream:alerts',
  dashboard: 'stream:dashboard',
} as const;

const EXECUTION_ID_PATTERN = /^[\w-]{8,64}$/;

export function extractSocketToken(socket: Socket): string | null {
  const cookieHeader = socket.handshake.headers.cookie;
  if (typeof cookieHeader === 'string') {
    const fromCookie = extractSessionTokenFromCookie(cookieHeader);
    if (fromCookie) return fromCookie;
  }
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }
  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string') {
    return extractTokenFromAuthHeader(header);
  }
  return null;
}

export function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  void (async () => {
    const token = extractSocketToken(socket);
    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    try {
      const decoded = verifyJwtToken(token);
      const { tokenRevocationService } = await import('../services/token-revocation-service');
      const active = await tokenRevocationService.isSessionActive(decoded);
      if (!active) {
        next(new Error('Session revoked'));
        return;
      }
      socket.data.user = decoded;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  })();
}

export function joinPermissionStreams(socket: Socket, user: JwtUser): void {
  socket.join(WS_STREAM_ROOMS.dashboard);
  if (hasPermission(user, 'MONITOR_VIEW', 'read')) {
    socket.join(WS_STREAM_ROOMS.execution);
  }
  if (hasPermission(user, 'ALERTS_VIEW', 'read')) {
    socket.join(WS_STREAM_ROOMS.alerts);
  }
}

export function getSocketUser(socket: Socket): JwtUser | undefined {
  return socket.data.user as JwtUser | undefined;
}

export function isValidExecutionId(executionId: unknown): executionId is string {
  return typeof executionId === 'string' && EXECUTION_ID_PATTERN.test(executionId);
}
