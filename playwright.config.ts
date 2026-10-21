import { defineConfig } from '@playwright/test';
import { validateE2EBaseURL, validateE2EDatabaseURL } from './scripts/e2e-database-url.mjs';

const e2eHost = '127.0.0.1';
const e2eWebPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const e2eApiPort = Number(process.env.E2E_API_PORT ?? 4000);
const e2eBaseURL = process.env.E2E_BASE_URL ?? `http://${e2eHost}:${e2eWebPort}`;
validateE2EBaseURL(e2eBaseURL);
const e2eDatabaseURL = process.env.E2E_DATABASE_URL;
validateE2EDatabaseURL(e2eDatabaseURL);
const webServerEnv = { ...process.env, DATABASE_URL: e2eDatabaseURL, E2E_DATABASE_URL: e2eDatabaseURL };

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 300_000,
  reporter: process.env.CI ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
  use: {
    baseURL: e2eBaseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: 'npm run dev -w apps/api',
      url: `http://${e2eHost}:${e2eApiPort}/health`,
      env: webServerEnv,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: `npm run dev -w apps/web -- --host ${e2eHost} --port ${e2eWebPort}`,
      url: `http://${e2eHost}:${e2eWebPort}`,
      env: webServerEnv,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
