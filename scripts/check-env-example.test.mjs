import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checkScript = readFileSync(
  new URL("./check-env-example.mjs", import.meta.url),
  "utf8",
);
const configSource = (includeNewRequiredSetting = false) => `
const envSchema = {
  DATABASE_URL: z.string(),
  PASSWORD_PEPPER: z.string().min(16),
  OPTIONAL_SETTING: z.string().optional(),
  LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE: liveProviderConfigurationsAvailableSchema,
  CLUB_COINS_HARD_DISABLED: clubCoinsHardDisabledSchema,
  ${includeNewRequiredSetting ? "NEW_REQUIRED_SETTING: z.string()," : ""}
};
`;

const baseExample = `
DATABASE_URL=postgresql://marketplace:marketplace@localhost:5432/marketplace
PASSWORD_PEPPER=replace-with-a-long-random-value
# OPTIONAL_SETTING=
PRISMA_MIGRATIONS_PATH=prisma/migrations
MONEY_MOVEMENT_HARD_DISABLED=true
WALLET_FUNDING_PROVIDER_READY=false
WALLET_FUNDING_SANDBOX_MODE=false
STORE_PLAN_BILLING_SANDBOX_ENABLED=false
LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE=false
LIVE_SHOPPING_AVAILABLE=false
LIVE_RECORDING_STORAGE_AVAILABLE=false
CONTENT_OBJECT_STORAGE_AVAILABLE=false
CONTENT_SCANNER_AVAILABLE=false
STORE_BUSTER_SPONSORED_AVAILABLE=false
STORE_EMAIL_DELIVERY_AVAILABLE=false
CLUB_COINS_HARD_DISABLED=true
`;

function runCheck({ config, example = baseExample }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "marketplace-env-example-"));
  try {
    const scriptDirectory = path.join(root, "scripts");
    const apiSourceDirectory = path.join(root, "apps", "api", "src");
    const apiDirectory = path.dirname(apiSourceDirectory);
    mkdirSync(scriptDirectory, { recursive: true });
    mkdirSync(apiSourceDirectory, { recursive: true });
    writeFileSync(
      path.join(scriptDirectory, "check-env-example.mjs"),
      checkScript,
    );
    writeFileSync(path.join(apiSourceDirectory, "config.ts"), config);
    writeFileSync(
      path.join(apiDirectory, "prisma.config.ts"),
      'process.env.PRISMA_MIGRATIONS_PATH ?? "prisma/migrations";\n',
    );
    writeFileSync(path.join(root, ".env.example"), example);

    const scriptPath = path.join(scriptDirectory, "check-env-example.mjs");
    return spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("environment example guard accepts documented settings and closed gates", () => {
  const result = runCheck({ config: configSource() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 required active/);
});

test("environment example guard rejects a newly added undocumented required key", () => {
  const result = runCheck({ config: configSource(true) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NEW_REQUIRED_SETTING/);
});

test("environment example guard rejects an enabled payment integration sample", () => {
  const example = baseExample.replace(
    "STORE_PLAN_BILLING_SANDBOX_ENABLED=false",
    "STORE_PLAN_BILLING_SANDBOX_ENABLED=true",
  );
  const result = runCheck({ config: configSource(), example });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /STORE_PLAN_BILLING_SANDBOX_ENABLED/);
});
