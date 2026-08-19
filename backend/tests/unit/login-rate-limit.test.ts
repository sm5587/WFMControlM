import express from 'express';
import request from 'supertest';
import {
  LOGIN_RATE_LIMIT_MAX,
  createLoginRateLimiter,
} from '../../src/middleware/login-rate-limit';

jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

function buildApp(max = LOGIN_RATE_LIMIT_MAX) {
  const app = express();
  app.use(express.json());
  app.post('/login', createLoginRateLimiter(max), (_req, res) => {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  });
  return app;
}

describe('login-rate-limit', () => {
  it('allows requests under the limit', async () => {
    const app = buildApp();
    const res = await request(app).post('/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(401);
  });

  it('returns 429 after max failed attempts from the same IP', async () => {
    const app = buildApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      const res = await request(app).post('/login').send({ username: 'a', password: 'b' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post('/login').send({ username: 'a', password: 'b' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many login attempts/i);
  });
});
