import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_FAIL_CLOSED_SETTINGS,
  parseActiveEnv,
  validateLocalDatabaseUrl,
} from "./dev-bootstrap.mjs";

export function validateLocalDevelopmentEnvironment(
  envFileContents,
  inheritedEnv = {},
) {
  const values = parseActiveEnv(envFileContents);
  const databaseUrl = values.get("DATABASE_URL");
  validateLocalDatabaseUrl(databaseUrl);

  if (
    Object.hasOwn(inheritedEnv, "DATABASE_URL") &&
    inheritedEnv.DATABASE_URL !== databaseUrl
  ) {
    throw new Error(
      "The shell DATABASE_URL differs from the repository .env target; refusing to migrate or seed.",
    );
  }
  if (values.get("NODE_ENV") !== "development") {
    throw new Error("Database setup requires NODE_ENV=development in .env.");
  }
  if (
    Object.hasOwn(inheritedEnv, "NODE_ENV") &&
    inheritedEnv.NODE_ENV !== "development"
  ) {
    throw new Error(
      "Database setup refuses a non-development NODE_ENV override.",
    );
  }
  if (values.get("PRISMA_MIGRATIONS_PATH") !== "prisma/migrations") {
    throw new Error(
      "Database setup requires the repository Prisma migrations directory.",
    );
  }

  for (const [name, expected] of Object.entries(LOCAL_FAIL_CLOSED_SETTINGS)) {
    if (
      values.get(name) !== expected ||
      (Object.hasOwn(inheritedEnv, name) && inheritedEnv[name] !== expected)
    ) {
      throw new Error(
        `Database setup requires the fail-closed local setting ${name}=${expected}.`,
      );
    }
  }

  return { databaseUrl };
}

export function getLocalDatabaseSetupSteps() {
  return [
    { command: "docker", args: ["compose", "up", "-d", "postgres"] },
    { command: "npm", args: ["run", "db:generate"] },
    { command: "npm", args: ["run", "db:deploy"] },
    { command: "npm", args: ["run", "db:seed"] },
  ];
}

export function runLocalDatabaseSetup({
  envFileContents,
  inheritedEnv = process.env,
  repositoryRoot,
  runCommand = (command, args, options) => {
    const result = spawnSync(command, args, {
      ...options,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  },
}) {
  const { databaseUrl } = validateLocalDevelopmentEnvironment(
    envFileContents,
    inheritedEnv,
  );
  const childEnv = {
    ...inheritedEnv,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "development",
    PRISMA_MIGRATIONS_PATH: "prisma/migrations",
    ...LOCAL_FAIL_CLOSED_SETTINGS,
  };
  childEnv.E2E_DATABASE_URL = "";
  childEnv.WALLET_FUNDING_SANDBOX_ID = "";
  childEnv.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST = "";

  for (const step of getLocalDatabaseSetupSteps()) {
    const status = runCommand(step.command, step.args, {
      cwd: repositoryRoot,
      env: childEnv,
    });
    if (status !== 0) {
      throw new Error(
        `Local database setup stopped after ${step.command} ${step.args.join(" ")} failed.`,
      );
    }
  }
}

function runCli() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const envPath = path.join(repositoryRoot, ".env");
  let envFileContents;
  try {
    envFileContents = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(".env is missing. Run npm run dev:setup first.");
  }

  console.log(
    "Preparing only the loopback marketplace development database. This local Docker volume persists between runs; E2E uses a separate disposable database.",
  );
  runLocalDatabaseSetup({ envFileContents, repositoryRoot });
  console.log("Local database migrations and demo seed completed.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local database setup failed.",
    );
    process.exitCode = 1;
  }
}
