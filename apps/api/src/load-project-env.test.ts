import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRepositoryRoot,
  loadProjectEnvironment,
} from "./load-project-env.js";

const temporaryDirectories: string[] = [];
const testVariable = "MARKETPLACE_PROJECT_ENV_LOADER_TEST_VALUE";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project environment loading", () => {
  it("finds the workspace root and uses root settings before workspace fallbacks", () => {
    const temporaryRoot = mkdtempSync(
      path.join(os.tmpdir(), "marketplace-env-loader-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const workspace = path.join(temporaryRoot, "apps", "api");
    const workspaceEnv = path.join(workspace, ".env");
    const rootEnv = path.join(temporaryRoot, ".env");
    const packageJsonPath = path.join(temporaryRoot, "package.json");
    const previousValue = process.env[testVariable];

    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ workspaces: ["apps/api"] }),
    );
    writeFileSync(workspaceEnv, `${testVariable}=workspace-value\n`);
    writeFileSync(rootEnv, `${testVariable}=root-value\n`);

    try {
      delete process.env[testVariable];
      expect(findRepositoryRoot([workspace])).toBe(temporaryRoot);
      loadProjectEnvironment({
        workingDirectory: workspace,
        moduleDirectory: workspace,
      });
      expect(process.env[testVariable]).toBe("root-value");

      delete process.env[testVariable];
      rmSync(rootEnv);
      loadProjectEnvironment({
        workingDirectory: workspace,
        moduleDirectory: workspace,
      });
      expect(process.env[testVariable]).toBe("workspace-value");
    } finally {
      if (previousValue === undefined) delete process.env[testVariable];
      else process.env[testVariable] = previousValue;
    }
  });
});
