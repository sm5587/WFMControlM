import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createCsrfTokenFromSession } from '../../src/utils/csrf-token';

jest.mock('../../src/config', () => ({
  config: { jwtSecret: 'test-csrf-secret' },
}));

jest.mock('../../src/utils/session-cookie', () => ({
  SESSION_COOKIE_NAME: 'wfm_session',
  extractSessionTokenFromCookie: (header?: string) => {
    if (!header) return null;
    const match = header.match(/wfm_session=([^;]+)/);
    if (!match) return null;
    return decodeURIComponent(match[1]);
  },
}));

import { csrfMiddleware } from '../../src/middleware/csrf';
import { SESSION_COOKIE_NAME } from '../../src/utils/session-cookie';

function makeSessionToken(): string {
  return jwt.sign(
    { userId: 'u1', username: 'test', jti: 'csrf-jti-1', tv: 0 },
    'test-csrf-secret',
    { expiresIn: '1h' },
  );
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', csrfMiddleware);
  app.post('/api/auth/login', (_req, res) => res.json({ ok: true }));
  app.post('/api/protected', (_req, res) => res.json({ ok: true }));
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('csrfMiddleware', () => {
  it('allows GET without CSRF token even with session cookie', async () => {
    const session = makeSessionToken();
    const app = buildApp();
    const res = await request(app)
      .get('/api/protected')
      .set('Cookie', sessionCookie(session));

    expect(res.status).toBe(200);
  });

  it('allows public POST /auth/login without CSRF token', async () => {
    const session = makeSessionToken();
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Cookie', sessionCookie(session))
      .send({ username: 'a', password: 'b' });

    expect(res.status).toBe(200);
  });

  it('allows Bearer-only POST without CSRF token', async () => {
    const session = makeSessionToken();
    const app = buildApp();
    const res = await request(app)
      .post('/api/protected')
      .set('Authorization', `Bearer ${session}`)
      .send({ action: 'x' });

    expect(res.status).toBe(200);
  });

  it('blocks cookie-authenticated POST without CSRF token', async () => {
    const session = makeSessionToken();
    const app = buildApp();
    const res = await request(app)
      .post('/api/protected')
      .set('Cookie', sessionCookie(session))
      .send({ action: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/i);
  });

  it('allows cookie-authenticated POST with valid CSRF token', async () => {
    const session = makeSessionToken();
    const csrf = createCsrfTokenFromSession(session)!;
    const app = buildApp();
    const res = await request(app)
      .post('/api/protected')
      .set('Cookie', sessionCookie(session))
      .set('X-CSRF-Token', csrf)
      .send({ action: 'x' });

    expect(res.status).toBe(200);
  });

  it('blocks cookie-authenticated PATCH with invalid CSRF token', async () => {
    const session = makeSessionToken();
    const app = express();
    app.use(express.json());
    app.use('/api', csrfMiddleware);
    app.patch('/api/item', (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .patch('/api/item')
      .set('Cookie', sessionCookie(session))
      .set('X-CSRF-Token', 'bad.token')
      .send({ name: 'x' });

    expect(res.status).toBe(403);
  });
});
