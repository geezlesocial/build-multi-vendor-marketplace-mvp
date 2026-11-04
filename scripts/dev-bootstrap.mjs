import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_FAIL_CLOSED_SETTINGS = Object.freeze({
  MONEY_MOVEMENT_HARD_DISABLED: "true",
  WALLET_FUNDING_PROVIDER_READY: "false",
  WALLET_FUNDING_SANDBOX_MODE: "false",
  STORE_PLAN_BILLING_SANDBOX_ENABLED: "false",
  LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE: "false",
  LIVE_SHOPPING_AVAILABLE: "false",
  LIVE_RECORDING_STORAGE_AVAILABLE: "false",
  CONTENT_OBJECT_STORAGE_AVAILABLE: "false",
  CONTENT_SCANNER_AVAILABLE: "false",
  STORE_BUSTER_SPONSORED_AVAILABLE: "false",
  STORE_EMAIL_DELIVERY_AVAILABLE: "false",
  CLUB_COINS_HARD_DISABLED: "true",
});

const LOCAL_SECRET_KEYS = [
  "PASSWORD_PEPPER",
  "SOCIAL_LOGIN_ENCRYPTION_KEY",
  "PAYOUT_ENCRYPTION_KEY",
  "DROPSHIPPING_ENCRYPTION_KEY",
  "AFFILIATE_SIGNING_SECRET",
];

export function parseActiveEnv(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (values.has(name)) {
      throw new Error(
        `The environment file contains duplicate ${name} entries.`,
      );
    }
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return values;
}

export function validateLocalDatabaseUrl(value) {
  let parsed;
  let databaseName;
  try {
    parsed = new URL(value);
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("The local DATABASE_URL must be a valid PostgreSQL URL.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const safeQuery =
    [...parsed.searchParams.entries()].length === 1 &&
    parsed.searchParams.get("schema") === "public";
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
    parsed.port !== "5432" ||
    databaseName !== "marketplace" ||
    !safeQuery ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Local development setup is limited to the loopback marketplace development database on port 5432 with the public schema.",
    );
  }
}

export function validateLocalEnvTemplate(source) {
  const values = parseActiveEnv(source);
  if (values.get("NODE_ENV") !== "development") {
    throw new Error(
      "The local environment template must use NODE_ENV=development.",
    );
  }
  if (values.get("PRISMA_MIGRATIONS_PATH") !== "prisma/migrations") {
    throw new Error(
      "The local environment template must use the repository Prisma migrations directory.",
    );
  }
  validateLocalDatabaseUrl(values.get("DATABASE_URL") ?? "");

  const unsafeSettings = Object.entries(LOCAL_FAIL_CLOSED_SETTINGS)
    .filter(([name, expected]) => values.get(name) !== expected)
    .map(([name]) => name);
  if (unsafeSettings.length > 0) {
    throw new Error(
      `Local setup refuses to enable integrations or financial features: ${unsafeSettings.join(", ")}.`,
    );
  }
  return values;
}

export function renderLocalEnv(
  template,
  { generateSecret = () => randomBytes(32).toString("base64url") } = {},
) {
  validateLocalEnvTemplate(template);
  const newline = template.includes("\r\n") ? "\r\n" : "\n";
  const lines = template.split(/\r?\n/);
  const generatedSecrets = new Set();

  for (const key of LOCAL_SECRET_KEYS) {
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (new RegExp(`^\\s*${key}=`).test(lines[index])) matches.push(index);
    }
    if (matches.length !== 1) {
      throw new Error(
        `The environment template must contain exactly one active ${key} entry.`,
      );
    }

    const secret = generateSecret(key);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || generatedSecrets.has(secret)) {
      throw new Error(
        "Local secrets must be unique, 32-byte base64url values.",
      );
    }
    generatedSecrets.add(secret);
    lines[matches[0]] = `${key}=${secret}`;
  }

  return lines.join(newline);
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

export function createLocalEnvFile({
  examplePath,
  envPath,
  fileSystem = {
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
    fsyncSync,
  },
  generateSecret,
}) {
  const template = fileSystem.readFileSync(examplePath, "utf8");
  const contents = renderLocalEnv(template, { generateSecret });
  let descriptor;
  let createdIdentity;

  try {
    descriptor = fileSystem.openSync(envPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        if (fileSystem.lstatSync(envPath).isFile()) return { status: "exists" };
      } catch {
        // Fall through to the safe refusal below if the existing path vanished.
      }
      throw new Error(
        "A non-file path already exists at .env; it was left untouched.",
        { cause: error },
      );
    }
    throw new Error("Could not create the local environment file.", {
      cause: error,
    });
  }

  try {
    createdIdentity = fileSystem.fstatSync(descriptor);
    fileSystem.writeFileSync(descriptor, contents, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    return { status: "created" };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Cleanup below is still attempted if closing the descriptor fails.
      }
      descriptor = undefined;
    }

    let partialFileRemoved = false;
    try {
      const currentIdentity = fileSystem.lstatSync(envPath);
      if (
        createdIdentity &&
        currentIdentity.isFile() &&
        sameFileIdentity(createdIdentity, currentIdentity)
      ) {
        fileSystem.unlinkSync(envPath);
        partialFileRemoved = true;
      }
    } catch {
      // Do not remove a file unless it can be proven to be the one created here.
    }

    throw new Error(
      partialFileRemoved
        ? "Could not finish creating the local environment file; the partial file created by this command was removed."
        : "Could not finish creating the local environment file; inspect the path before retrying because partial-file cleanup could not be confirmed.",
      { cause: error },
    );
  }
}

function runCli() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = createLocalEnvFile({
    examplePath: path.join(repositoryRoot, ".env.example"),
    envPath: path.join(repositoryRoot, ".env"),
  });

  if (result.status === "created") {
    console.log(
      "Created .env with fresh local-only secrets. Secret values were not displayed.",
    );
    console.log("Next: run npm run dev:db:setup, then npm run dev.");
  } else {
    console.log(".env already exists; it was left unchanged.");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local setup failed.",
    );
    process.exitCode = 1;
  }
}
