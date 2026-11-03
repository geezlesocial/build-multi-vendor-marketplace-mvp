import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import {
  validateE2EBaseURL,
  validateE2EDatabaseURL,
} from "./scripts/e2e-database-url.mjs";

const e2eHost = "127.0.0.1";
const e2eWebPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const e2eApiPort = Number(process.env.E2E_API_PORT ?? 4000);
const e2eBaseURL =
  process.env.E2E_BASE_URL ?? `http://${e2eHost}:${e2eWebPort}`;
const e2eContentStorageDir =
  process.env.E2E_CONTENT_STORAGE_DIR ??
  path.join(os.tmpdir(), `marketplace-e2e-content-${process.pid}`);
process.env.E2E_CONTENT_STORAGE_DIR = e2eContentStorageDir;
validateE2EBaseURL(e2eBaseURL);
const e2eDatabaseURL = process.env.E2E_DATABASE_URL;
const validatedE2EDatabase = validateE2EDatabaseURL(e2eDatabaseURL);
const liveShoppingSimulator =
  process.env.E2E_LIVE_SHOPPING_SIMULATOR === "true";
const e2eLiveKitPort = Number(process.env.E2E_LIVEKIT_PORT ?? 9399);
if (liveShoppingSimulator) {
  const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID ?? "";
  if (
    !/^[a-f0-9]{32}$/.test(sandboxId) ||
    validatedE2EDatabase.databaseName !== `wallet_funding_e2e_${sandboxId}`
  ) {
    throw new Error(
      "The local LiveKit simulator can run only against the matching per-run wallet_funding_e2e database.",
    );
  }
}
const webServerEnv = {
  ...process.env,
  API_PORT: String(e2eApiPort),
  DATABASE_URL: e2eDatabaseURL,
  E2E_DATABASE_URL: e2eDatabaseURL,
  E2E_API_RATE_LIMIT_OVERRIDE: "true",
  // Browser runs must never inherit usable provider or money-movement settings.
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  // Synthetic signing material lets browser tests exercise signature handling;
  // the separate outbound sandbox gate is forced off, so no Stripe call occurs.
  STORE_PLAN_BILLING_SANDBOX_ENABLED: "false",
  STRIPE_STORE_BILLING_SECRET_KEY: "sk_test_e2e_local_only_unused",
  STRIPE_STORE_BILLING_WEBHOOK_SECRET:
    "whsec_e2e_local_only_synthetic_signing_key",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_WEBHOOK_ID: "",
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYMONGO_SECRET_KEY: "",
  PAYMONGO_WEBHOOK_SECRET: "",
  PAYSTACK_SECRET_KEY: "",
  MONEY_MOVEMENT_HARD_DISABLED: "true",
  WALLET_FUNDING_SANDBOX_MODE: "false",
  WALLET_FUNDING_PROVIDER_READY: "false",
  CLUB_COINS_HARD_DISABLED: "true",
  LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE: "false",
  LIVE_SHOPPING_AVAILABLE: liveShoppingSimulator ? "true" : "false",
  // Never inherit a developer's real provider credentials. Outside the
  // dedicated simulator test, use a closed loopback port and keep the feature
  // gate off; this satisfies strict configuration validation without egress.
  LIVEKIT_URL: liveShoppingSimulator
    ? `http://127.0.0.1:${e2eLiveKitPort}`
    : "http://127.0.0.1:1",
  LIVEKIT_API_KEY: "marketplace_e2e_local_only",
  LIVEKIT_API_SECRET: "synthetic_local_test_secret_never_for_deployment",
  CONTENT_STORAGE_DIR: e2eContentStorageDir,
  // Feature provider gates are fixed off in browser tests; no cloud service is contacted.
  CONTENT_OBJECT_STORAGE_AVAILABLE: "false",
  STORE_BUSTER_SPONSORED_AVAILABLE: "false",
  STORE_EMAIL_DELIVERY_AVAILABLE: "false",
  // The API intentionally does not listen when NODE_ENV is "test". Keep the
  // Playwright runner's test mode from disabling its HTTP webServer process.
  NODE_ENV: "development",
  // Keep E2E behavior explicit and safe when no scanner policy is supplied.
  CONTENT_SCAN_REQUIRED: process.env.CONTENT_SCAN_REQUIRED ?? "true",
  // Keep browser tests deterministic and isolated from a developer's local ClamAV service.
  CONTENT_SCANNER_AVAILABLE: "false",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  projects: [
    {
      name: "default",
      testIgnore: "**/site-chrome.spec.ts",
    },
    {
      name: "site-chrome-extended",
      testMatch: "**/site-chrome.spec.ts",
      timeout: 120_000,
    },
  ],
  globalTimeout: 900_000,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  use: {
    baseURL: e2eBaseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    ...(liveShoppingSimulator
      ? [
          {
            command: `node scripts/fake-livekit-server.mjs --port ${e2eLiveKitPort}`,
            url: `http://${e2eHost}:${e2eLiveKitPort}/healthz`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
    {
      command: "npm run dev -w apps/api",
      url: `http://${e2eHost}:${e2eApiPort}/health`,
      env: webServerEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run dev -w apps/web -- --host ${e2eHost} --port ${e2eWebPort}`,
      url: `http://${e2eHost}:${e2eWebPort}`,
      env: webServerEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
