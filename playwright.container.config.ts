import { defineConfig } from '@playwright/test';

const baseURL = process.env.STAGING_SMOKE_BASE_URL ?? 'http://127.0.0.1:5174';
const parsedBaseURL = new URL(baseURL);
if (!['127.0.0.1', 'localhost'].includes(parsedBaseURL.hostname)) {
  throw new Error('Container browser smoke tests may target loopback only.');
}

export default defineConfig({
  testDir: './e2e-container',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 120_000,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
