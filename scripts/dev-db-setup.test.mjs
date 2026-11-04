import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  getLocalDatabaseSetupSteps,
  runLocalDatabaseSetup,
  validateLocalDevelopmentEnvironment,
} from "./dev-db-setup.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const localEnv = readFileSync(
  path.join(repositoryRoot, ".env.example"),
  "utf8",
);

test("accepts only the loopback marketplace development database", () => {
  assert.equal(
    validateLocalDevelopmentEnvironment(localEnv, {}).databaseUrl,
    "postgresql://marketplace:marketplace@localhost:5432/marketplace?schema=public",
  );
});

test("rejects remote, non-default, and disposable test databases before commands run", () => {
  for (const databaseUrl of [
    "postgresql://marketplace:secret@db.example.test:5432/marketplace?schema=public",
    "postgresql://marketplace:secret@localhost:5433/marketplace?schema=public",
    "postgresql://marketplace:secret@localhost:5432/wallet_funding_e2e_123?schema=public",
    "postgresql://marketplace:secret@localhost:5432/marketplace?schema=public&host=remote.example.test",
  ]) {
    const unsafe = localEnv.replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=${databaseUrl}`,
    );
    assert.throws(
      () => validateLocalDevelopmentEnvironment(unsafe, {}),
      /loopback marketplace development database/,
    );
  }
});

test("rejects a shell database override or an enabled integration gate", () => {
  assert.throws(
    () =>
      validateLocalDevelopmentEnvironment(localEnv, {
        DATABASE_URL: "postgresql://host.invalid/marketplace",
      }),
    /differs from the repository \.env target/,
  );
  assert.throws(
    () =>
      validateLocalDevelopmentEnvironment(localEnv, {
        LIVE_SHOPPING_AVAILABLE: "true",
      }),
    /LIVE_SHOPPING_AVAILABLE=false/,
  );
  assert.throws(
    () =>
      validateLocalDevelopmentEnvironment(
        localEnv.replace(
          "MONEY_MOVEMENT_HARD_DISABLED=true",
          "MONEY_MOVEMENT_HARD_DISABLED=false",
        ),
        {},
      ),
    /MONEY_MOVEMENT_HARD_DISABLED=true/,
  );
});

test("rejects duplicate database or safety entries rather than guessing", () => {
  assert.throws(
    () =>
      validateLocalDevelopmentEnvironment(
        `${localEnv}\nDATABASE_URL=postgresql://remote.invalid/marketplace`,
        {},
      ),
    /duplicate DATABASE_URL/,
  );
});

test("runs only the local postgres, generate, migrate, and seed commands", () => {
  const calls = [];
  runLocalDatabaseSetup({
    envFileContents: localEnv,
    inheritedEnv: {
      E2E_DATABASE_URL: "postgresql://localhost:55432/wallet_funding_e2e_abc",
      WALLET_FUNDING_SANDBOX_ID: "abc",
    },
    repositoryRoot,
    runCommand(command, args, options) {
      calls.push({ command, args, env: options.env });
      return 0;
    },
  });

  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    getLocalDatabaseSetupSteps().map(({ command, args }) => [command, ...args]),
  );
  assert.equal(calls[0].env.DATABASE_URL.includes("/marketplace?"), true);
  assert.equal(calls[0].env.E2E_DATABASE_URL, "");
  assert.equal(calls[0].env.WALLET_FUNDING_SANDBOX_ID, "");
  assert.equal(calls[0].env.MONEY_MOVEMENT_HARD_DISABLED, "true");
  assert.equal(calls[0].env.LIVE_SHOPPING_AVAILABLE, "false");
});

test("stops at the first failed local setup command", () => {
  const calls = [];
  assert.throws(
    () =>
      runLocalDatabaseSetup({
        envFileContents: localEnv,
        inheritedEnv: {},
        repositoryRoot,
        runCommand(command, args) {
          calls.push(`${command} ${args.join(" ")}`);
          return calls.length === 2 ? 1 : 0;
        },
      }),
    /npm run db:generate failed/,
  );
  assert.deepEqual(calls, [
    "docker compose up -d postgres",
    "npm run db:generate",
  ]);
});
