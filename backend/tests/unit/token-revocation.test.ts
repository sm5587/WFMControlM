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
    jwtSecret: 'test-jwt-secret-revocation',
    jwtExpiresIn: '1h',
  },
}));

jest.mock('../../src/services/config-service', () => ({
  configService: {
    getString: jest.fn((key: string) => (key === 'auth.masterTokenVersion' ? '0' : '')),
    update: jest.fn(async () => ({ category: 'AUTH', requiresRestart: false })),
  },
}));

const prismaMock = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  revokedToken: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
};

jest.mock('../../src/database/prisma', () => ({
  prisma: prismaMock,
}));

import jwt from 'jsonwebtoken';
import { tokenRevocationService } from '../../src/services/token-revocation-service';

describe('token-revocation-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 0 });
    prismaMock.revokedToken.findUnique.mockResolvedValue(null);
    prismaMock.user.update.mockResolvedValue({ tokenVersion: 1 });
  });

  it('creates tokens with jti and tv claims', async () => {
    const token = await tokenRevocationService.createSessionToken({
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      permissions: {},
    });
    const decoded = jwt.decode(token) as any;
    expect(decoded.jti).toBeTruthy();
    expect(decoded.tv).toBe(0);
  });

  it('rejects revoked jti', async () => {
    const token = await tokenRevocationService.createSessionToken({
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      permissions: {},
    });
    const decoded = jwt.decode(token) as any;
    await tokenRevocationService.revokeJti(decoded.jti, 'user-1', new Date(Date.now() + 3600000), 'logout');
    prismaMock.revokedToken.findUnique.mockResolvedValue({ jti: decoded.jti });
    const active = await tokenRevocationService.isSessionActive(decoded);
    expect(active).toBe(false);
  });

  it('rejects token after user tokenVersion bump', async () => {
    const token = await tokenRevocationService.createSessionToken({
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      permissions: {},
    });
    const decoded = jwt.decode(token) as any;
    prismaMock.user.findUnique.mockResolvedValue({ tokenVersion: 1 });
    const active = await tokenRevocationService.isSessionActive(decoded);
    expect(active).toBe(false);
  });

  it('rejects legacy tokens without jti/tv', async () => {
    const legacy = jwt.sign(
      { userId: 'user-1', username: 'alice', displayName: 'Alice', permissions: {} },
      'test-jwt-secret-revocation',
      { expiresIn: '1h' },
    );
    const decoded = jwt.decode(legacy) as any;
    const active = await tokenRevocationService.isSessionActive(decoded);
    expect(active).toBe(false);
  });
});
