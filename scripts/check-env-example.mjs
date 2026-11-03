import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const configPath = path.join(repositoryRoot, "apps/api/src/config.ts");
const prismaConfigPath = path.join(repositoryRoot, "apps/api/prisma.config.ts");
const examplePath = path.join(repositoryRoot, ".env.example");
const configSource = readFileSync(configPath, "utf8");
const prismaConfigSource = readFileSync(prismaConfigPath, "utf8");
const exampleSource = readFileSync(examplePath, "utf8");

// Config schema properties are deliberately one per line so this dependency-free
// check can compare names without loading dotenv or exposing the local .env file.
const schemaProperties = [
  ...configSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:\s*(.+?)\s*$/gm),
];
if (schemaProperties.length === 0) {
  throw new Error(`No top-level environment properties found in ${configPath}`);
}

const documentedNames = new Set();
const activeValues = new Map();
for (const line of exampleSource.split(/\r?\n/)) {
  const documented = line.match(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/);
  if (documented) documentedNames.add(documented[1]);

  const active = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
  if (active) activeValues.set(active[1], active[2].trim());
}

const schemaNames = schemaProperties.map(([, name]) => name);
const prismaConfigNames = [
  ...prismaConfigSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g),
].map(([, name]) => name);
const missingDocumentation = schemaNames.filter(
  (name) => !documentedNames.has(name),
);
const missingPrismaDocumentation = prismaConfigNames.filter(
  (name) => !documentedNames.has(name),
);
// These imported Zod helpers supply their own fail-closed defaults outside config.ts.
const defaultedHelperSchemas = new Set([
  "LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE",
  "CLUB_COINS_HARD_DISABLED",
]);
const requiredNames = schemaProperties
  .filter(
    ([, name, expression]) =>
      !defaultedHelperSchemas.has(name) &&
      !/\.optional\s*\(|\.default\s*\(/.test(expression),
  )
  .map(([, name]) => name);
const inactiveRequired = requiredNames.filter(
  (name) => !activeValues.has(name),
);
const failClosedValues = new Map([
  ["MONEY_MOVEMENT_HARD_DISABLED", "true"],
  ["WALLET_FUNDING_PROVIDER_READY", "false"],
  ["WALLET_FUNDING_SANDBOX_MODE", "false"],
  ["STORE_PLAN_BILLING_SANDBOX_ENABLED", "false"],
  ["LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE", "false"],
  ["LIVE_SHOPPING_AVAILABLE", "false"],
  ["LIVE_RECORDING_STORAGE_AVAILABLE", "false"],
  ["CONTENT_OBJECT_STORAGE_AVAILABLE", "false"],
  ["CONTENT_SCANNER_AVAILABLE", "false"],
  ["STORE_BUSTER_SPONSORED_AVAILABLE", "false"],
  ["STORE_EMAIL_DELIVERY_AVAILABLE", "false"],
  ["CLUB_COINS_HARD_DISABLED", "true"],
]);
const unsafeGates = [...failClosedValues].filter(
  ([name, expected]) => activeValues.get(name) !== expected,
);
const invalidPrismaDefaults =
  activeValues.get("PRISMA_MIGRATIONS_PATH") !== "prisma/migrations";

if (
  missingDocumentation.length ||
  missingPrismaDocumentation.length ||
  inactiveRequired.length ||
  unsafeGates.length ||
  invalidPrismaDefaults
) {
  if (missingDocumentation.length) {
    console.error(
      `Undocumented config schema keys: ${missingDocumentation.join(", ")}`,
    );
  }
  if (missingPrismaDocumentation.length) {
    console.error(
      `Undocumented Prisma CLI environment keys: ${missingPrismaDocumentation.join(", ")}`,
    );
  }
  if (inactiveRequired.length) {
    console.error(
      `Required config schema keys must be active: ${inactiveRequired.join(", ")}`,
    );
  }
  if (unsafeGates.length) {
    console.error(
      `Unsafe or missing fail-closed sample settings: ${unsafeGates.map(([name]) => name).join(", ")}`,
    );
  }
  if (invalidPrismaDefaults) {
    console.error(
      "PRISMA_MIGRATIONS_PATH must actively use the safe default prisma/migrations.",
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `Environment example covers ${schemaNames.length} API settings and ${prismaConfigNames.length} Prisma CLI setting (${requiredNames.length} required active; optional integration settings may remain commented). Critical launch gates are fail-closed.`,
  );
}
