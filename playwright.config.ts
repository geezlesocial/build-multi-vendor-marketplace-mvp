import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { validateE2EBaseURL, validateE2EDatabaseURL } from './scripts/e2e-database-url.mjs';

const e2eHost = '127.0.0.1';
const e2eWebPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const e2eApiPort = Number(process.env.E2E_API_PORT ?? 4000);
const e2eBaseURL = process.env.E2E_BASE_URL ?? `http://${e2eHost}:${e2eWebPort}`;
const e2eContentStorageDir = process.env.E2E_CONTENT_STORAGE_DIR ?? path.join(os.tmpdir(), `marketplace-e2e-content-${process.pid}`);
validateE2EBaseURL(e2eBaseURL);
const e2eDatabaseURL = process.env.E2E_DATABASE_URL;
validateE2EDatabaseURL(e2eDatabaseURL);
const webServerEnv = {
  ...process.env,
  DATABASE_URL: e2eDatabaseURL,
  E2E_DATABASE_URL: e2eDatabaseURL,
  E2E_API_RATE_LIMIT_OVERRIDE: 'true',
  // Browser runs must never inherit usable provider or money-movement settings.
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  // Synthetic signing material lets browser tests exercise signature handling;
  // the separate outbound sandbox gate is forced off, so no Stripe call occurs.
  STORE_PLAN_BILLING_SANDBOX_ENABLED: 'false',
  STRIPE_STORE_BILLING_SECRET_KEY: 'sk_test_e2e_local_only_unused',
  STRIPE_STORE_BILLING_WEBHOOK_SECRET: 'whsec_e2e_local_only_synthetic_signing_key',
  PAYPAL_CLIENT_ID: '',
  PAYPAL_CLIENT_SECRET: '',
  PAYPAL_WEBHOOK_ID: '',
  PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com',
  MONEY_MOVEMENT_HARD_DISABLED: 'true',
  WALLET_FUNDING_SANDBOX_MODE: 'false',
  WALLET_FUNDING_PROVIDER_READY: 'false',
  CLUB_COINS_HARD_DISABLED: 'true',
  LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE: 'false',
  LIVE_SHOPPING_AVAILABLE: 'false',
  CONTENT_STORAGE_DIR: e2eContentStorageDir,
  // Feature provider gates are fixed off in browser tests; no cloud service is contacted.
  CONTENT_OBJECT_STORAGE_AVAILABLE: 'false',
  STORE_BUSTER_SPONSORED_AVAILABLE: 'false',
  STORE_EMAIL_DELIVERY_AVAILABLE: 'false',
  // The API intentionally does not listen when NODE_ENV is "test". Keep the
  // Playwright runner's test mode from disabling its HTTP webServer process.
  NODE_ENV: 'development',
  // Keep E2E behavior explicit and safe when no scanner policy is supplied.
  CONTENT_SCAN_REQUIRED: process.env.CONTENT_SCAN_REQUIRED ?? 'true'
};

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
