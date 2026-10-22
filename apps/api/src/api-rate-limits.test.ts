import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  API_REQUEST_LIMIT,
  API_REQUEST_LIMIT_WINDOW_MS,
  AUTH_CREDENTIAL_LIMIT,
  AUTH_CREDENTIAL_LIMIT_WINDOW_MS,
  E2E_API_REQUEST_LIMIT,
  createApiRateLimiters,
  resolveApiRateLimitOptions
} from './api-rate-limits.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function startRateLimitTestServer() {
  const app = express();
  const { credentialLimiter, apiLimiter } = createApiRateLimiters({ credentialLimit: 2 });
  app.use('/api', apiLimiter);
  app.post('/api/auth/login', credentialLimiter, (_req, res) => res.status(401).json({ error: 'Invalid credentials' }));
  app.post('/api/auth/register', credentialLimiter, (_req, res) => res.status(201).json({ ok: true }));
  app.get('/api/auth/me', (_req, res) => res.json({ user: null }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

describe('API rate-limit policy', () => {
  it('retains production defaults for credential attempts and general API traffic', () => {
    expect(AUTH_CREDENTIAL_LIMIT).toBe(60);
    expect(AUTH_CREDENTIAL_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(API_REQUEST_LIMIT).toBe(300);
    expect(API_REQUEST_LIMIT_WINDOW_MS).toBe(60 * 1000);
    expect(resolveApiRateLimitOptions({ NODE_ENV: 'development' })).toEqual({});
  });

  it('allows the bounded E2E request budget only for the exact disposable per-run database', () => {
    const id = 'a'.repeat(32);
    const databaseUrl = `postgresql://e2e:test@127.0.0.1:55432/wallet_funding_e2e_${id}?schema=public`;
    const valid = {
      NODE_ENV: 'development',
      E2E_API_RATE_LIMIT_OVERRIDE: 'true',
      DATABASE_URL: databaseUrl,
      E2E_DATABASE_URL: databaseUrl,
      WALLET_FUNDING_SANDBOX_ID: id
    };
    expect(resolveApiRateLimitOptions(valid)).toEqual({ apiLimit: E2E_API_REQUEST_LIMIT });

    for (const invalid of [
      { ...valid, NODE_ENV: 'production' },
      { ...valid, DATABASE_URL: `${databaseUrl}-other` },
      {
        ...valid,
        DATABASE_URL: `postgresql://e2e:test@remote.example.test:55432/wallet_funding_e2e_${id}`,
        E2E_DATABASE_URL: `postgresql://e2e:test@remote.example.test:55432/wallet_funding_e2e_${id}`
      },
      {
        ...valid,
        DATABASE_URL: 'postgresql://e2e:test@127.0.0.1:5432/marketplace',
        E2E_DATABASE_URL: 'postgresql://e2e:test@127.0.0.1:5432/marketplace'
      },
      { ...valid, WALLET_FUNDING_SANDBOX_ID: 'b'.repeat(32) }
    ]) {
      expect(() => resolveApiRateLimitOptions(invalid)).toThrow(/validated per-run disposable E2E database/);
    }
  });

  it('allows ordinary session inspection beyond the credential-attempt limit while throttling login and registration', async () => {
    const baseUrl = await startRateLimitTestServer();

    for (let request = 0; request < 65; request += 1) {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      expect(response.status, `session request ${request + 1}`).toBe(200);
    }

    expect((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/register`, { method: 'POST' })).status).toBe(429);
  });
});
