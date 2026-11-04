import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type RootPackage = { workspaces?: unknown };

function isRepositoryRoot(directory: string) {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    ) as RootPackage;
    return (
      Array.isArray(packageJson.workspaces) &&
      packageJson.workspaces.includes("apps/api")
    );
  } catch {
    return false;
  }
}

export function findRepositoryRoot(startDirectories: string[]) {
  for (const startDirectory of startDirectories) {
    let directory = path.resolve(startDirectory);
    while (true) {
      if (isRepositoryRoot(directory)) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

export function loadProjectEnvironment({
  workingDirectory = process.cwd(),
  moduleDirectory = path.dirname(fileURLToPath(import.meta.url)),
  exists = existsSync,
  load = (filePath: string) => process.loadEnvFile(filePath),
}: {
  workingDirectory?: string;
  moduleDirectory?: string;
  exists?: (filePath: string) => boolean;
  load?: (filePath: string) => void;
} = {}) {
  const repositoryRoot = findRepositoryRoot([
    workingDirectory,
    moduleDirectory,
  ]);
  const candidates = [
    repositoryRoot ? path.join(repositoryRoot, ".env") : undefined,
    path.resolve(workingDirectory, ".env"),
  ].filter((filePath): filePath is string => Boolean(filePath));

  for (const filePath of new Set(candidates)) {
    if (exists(filePath)) load(filePath);
  }
}

loadProjectEnvironment();
