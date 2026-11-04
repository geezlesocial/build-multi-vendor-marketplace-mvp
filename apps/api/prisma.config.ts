import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, env } from "prisma/config";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = new Set([
  path.resolve(configDirectory, "../../.env"),
  path.resolve(process.cwd(), ".env"),
]);
for (const envPath of envCandidates) {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: process.env.PRISMA_MIGRATIONS_PATH ?? "prisma/migrations",
  },
  datasource: { url: env("DATABASE_URL") },
});
