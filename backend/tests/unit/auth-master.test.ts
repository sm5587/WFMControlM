// ============================================================
// Integration tests: POST /api/auth/login — master account
// Tests the break-glass bypass path in the login handler.
// ============================================================
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ---- Mock logger ----
jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ---- Mock config ----
jest.mock('../../src/config', () => ({
  config: {
    master: { username: 'wfmmaster', passwordHash: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: '1h',
  },
}));

// ---- Mock bcryptjs ----
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

// ---- Mock prisma (never reached in master-login tests) ----
jest.mock('../../src/database/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

// ---- Mock middleware (not needed for login route) ----
jest.mock('../../src/middleware', () => ({
  authMiddleware: jest.fn((_req: any, _res: any, next: any) => next()),
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  requireAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
  errorHandler: jest.fn((_err: any, _req: any, res: any, _next: any) => res.status(500).end()),
  requestLogger: jest.fn((_req: any, _res: any, next: any) => next()),
}));

import bcrypt from 'bcryptjs';
import authRouter from '../../src/routes/auth';
import { APP_FUNCTIONS } from '../../src/constants/functions';

// Helpers
const { config: mockConfig } = jest.requireMock('../../src/config') as {
  config: { master: { username: string; passwordHash: string }; jwtSecret: string; jwtExpiresIn: string };
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

const MASTER_USER = 'wfmmaster';
const MASTER_PASS = 'SuperSecret!99';
const BCRYPT_HASH = '$2b$10$mockhashfortest.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

beforeEach(() => {
  mockConfig.master.username = MASTER_USER;
  mockConfig.master.passwordHash = BCRYPT_HASH;
});

// ============================================================
// Master login — negative cases
// ============================================================

describe('POST /api/auth/login — master account disabled', () => {
  it('falls through to normal DB auth when MASTER_USERNAME is not configured', async () => {
    mockConfig.master.username = ''; // disabled

    // prisma returns null → 401
    const { prisma } = jest.requireMock('../../src/database/prisma');
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'wfmmaster', password: MASTER_PASS });

    expect(res.status).toBe(401);
    // Normal login error message, not a master-specific one
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/auth/login — master account enabled, negative cases', () => {
  it('returns 401 when MASTER_PASSWORD_HASH is not set', async () => {
    mockConfig.master.passwordHash = ''; // hash missing
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    // bcrypt.compare should NOT have been called — we short-circuit when hash is missing
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong master password', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(bcrypt.compare).toHaveBeenCalledWith('wrongpassword', BCRYPT_HASH);
  });

  it('returns 400 when username or password is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER }); // no password

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ============================================================
// Master login — positive cases
// ============================================================

describe('POST /api/auth/login — master account success', () => {
  beforeEach(() => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  it('returns 200 with a JWT token on successful master login', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(typeof res.body.data.token).toBe('string');
  });

  it('returns user object with master identity (no DB id)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    expect(res.body.data.user.id).toBe('master');
    expect(res.body.data.user.username).toBe(MASTER_USER);
    expect(res.body.data.user.displayName).toBe('Master Admin');
  });

  it('JWT contains isMaster: true', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    const payload = jwt.decode(res.body.data.token) as Record<string, any>;
    expect(payload.isMaster).toBe(true);
  });

  it('JWT grants all APP_FUNCTIONS with r:true and w:true', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    const payload = jwt.decode(res.body.data.token) as Record<string, any>;
    const permissions: Record<string, { r: boolean; w: boolean }> = payload.permissions;

    const allFunctionIds = Object.values(APP_FUNCTIONS).map(f => f.id);

    expect(allFunctionIds.length).toBeGreaterThan(0);

    for (const fnId of allFunctionIds) {
      expect(permissions[fnId]).toBeDefined();
      expect(permissions[fnId].r).toBe(true);
      expect(permissions[fnId].w).toBe(true);
    }
  });

  it('JWT has same number of permissions as APP_FUNCTIONS', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    const payload = jwt.decode(res.body.data.token) as Record<string, any>;
    const permCount = Object.keys(payload.permissions).length;
    const fnCount = Object.keys(APP_FUNCTIONS).length;

    expect(permCount).toBe(fnCount);
  });

  it('does not query the database during master login', async () => {
    const { prisma } = jest.requireMock('../../src/database/prisma');
    prisma.user.findUnique.mockClear();

    const app = buildApp();
    await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('bcrypt.compare is called with the submitted password and stored hash', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/auth/login')
      .send({ username: MASTER_USER, password: MASTER_PASS });

    expect(bcrypt.compare).toHaveBeenCalledWith(MASTER_PASS, BCRYPT_HASH);
  });
});

// ============================================================
// Normal login still works after master check
// ============================================================

describe('POST /api/auth/login — normal users unaffected by master config', () => {
  it('proceeds to DB lookup for non-master username', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const { prisma } = jest.requireMock('../../src/database/prisma');
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'normaluser',
      displayName: 'Normal User',
      email: 'normal@test.com',
      isActive: true,
      passwordHash: '$2b$10$somehash',
    });
    prisma.userProfile.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'normaluser', password: 'pass123' });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { username: 'normaluser' } });
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe('normaluser');
  });

  it('returns 401 for normal user with wrong password', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
    const { prisma } = jest.requireMock('../../src/database/prisma');
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'normaluser',
      displayName: 'Normal',
      email: 'n@test.com',
      isActive: true,
      passwordHash: '$2b$10$somehash',
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'normaluser', password: 'wrongpass' });

    expect(res.status).toBe(401);
  });

  it('returns 401 for inactive user', async () => {
    const { prisma } = jest.requireMock('../../src/database/prisma');
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-2',
      username: 'inactiveuser',
      isActive: false,
      passwordHash: '$2b$10$somehash',
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'inactiveuser', password: 'pass' });

    expect(res.status).toBe(401);
  });
});
