jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../src/config', () => ({
  config: {
    jwtSecret: 'test-jwt-secret-for-websocket-auth',
    logDir: '/tmp',
    nodeEnv: 'test',
  },
}));

jest.mock('../../src/services/token-revocation-service', () => ({
  tokenRevocationService: {
    isSessionActive: jest.fn(async () => true),
  },
}));

import jwt from 'jsonwebtoken';
import { hasPermission, JwtUser } from '../../src/middleware';
import {
  extractSocketToken,
  isValidExecutionId,
  joinPermissionStreams,
  socketAuthMiddleware,
  WS_STREAM_ROOMS,
} from '../../src/websocket/auth';

function makeUser(overrides: Partial<JwtUser> = {}): JwtUser {
  return {
    userId: 'user-1',
    username: 'operator',
    displayName: 'Operator',
    permissions: {},
    ...overrides,
  };
}

function makeSocket(overrides: {
  auth?: Record<string, unknown>;
  authorization?: string;
} = {}) {
  const rooms = new Set<string>();
  return {
    handshake: {
      auth: overrides.auth ?? {},
      headers: {
        authorization: overrides.authorization,
      },
    },
    data: {} as Record<string, unknown>,
    join(room: string) {
      rooms.add(room);
    },
    get rooms() {
      return rooms;
    },
  };
}

describe('websocket auth', () => {
  it('extracts token from handshake auth', () => {
    const socket = makeSocket({ auth: { token: 'abc123' } });
    expect(extractSocketToken(socket as any)).toBe('abc123');
  });

  it('extracts token from Authorization header', () => {
    const socket = makeSocket({ authorization: 'Bearer header-token' });
    expect(extractSocketToken(socket as any)).toBe('header-token');
  });

  it('rejects handshake without token', () => {
    const socket = makeSocket();
    const next = jest.fn();
    socketAuthMiddleware(socket as any, next);
    expect(next).toHaveBeenCalledWith(new Error('Authentication required'));
  });

  it('accepts valid JWT on handshake', async () => {
    const user = makeUser({
      permissions: { MONITOR_VIEW: { r: true, w: false } },
    });
    const token = jwt.sign(
      { ...user, tv: 0 },
      'test-jwt-secret-for-websocket-auth',
      { jwtid: 'test-jti-123' },
    );
    const socket = makeSocket({ auth: { token } });
    const next = jest.fn();

    await new Promise<void>((resolve, reject) => {
      socketAuthMiddleware(socket as any, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect((socket.data as any).user.username).toBe('operator');
  });

  it('rejects invalid JWT on handshake', () => {
    const socket = makeSocket({ auth: { token: 'not-a-jwt' } });
    const next = jest.fn();
    socketAuthMiddleware(socket as any, next);
    expect(next).toHaveBeenCalledWith(new Error('Invalid or expired token'));
  });

  it('joins permission-scoped stream rooms', () => {
    const socket = makeSocket();
    const user = makeUser({
      permissions: {
        MONITOR_VIEW: { r: true, w: false },
        ALERTS_VIEW: { r: false, w: false },
      },
    });

    joinPermissionStreams(socket as any, user);

    expect(socket.rooms.has(WS_STREAM_ROOMS.dashboard)).toBe(true);
    expect(socket.rooms.has(WS_STREAM_ROOMS.execution)).toBe(true);
    expect(socket.rooms.has(WS_STREAM_ROOMS.alerts)).toBe(false);
  });

  it('validates execution ids', () => {
    expect(isValidExecutionId('clxyz123456789')).toBe(true);
    expect(isValidExecutionId('../etc/passwd')).toBe(false);
    expect(isValidExecutionId('')).toBe(false);
  });

  it('checks permissions via shared helper', () => {
    const user = makeUser({
      permissions: { ALERTS_VIEW: { r: true, w: false } },
    });
    expect(hasPermission(user, 'ALERTS_VIEW', 'read')).toBe(true);
    expect(hasPermission(user, 'MONITOR_VIEW', 'read')).toBe(false);
  });
});
