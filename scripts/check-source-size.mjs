import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countPhysicalLines,
  evaluateSourceSize,
} from "./source-size-policy.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baselinePath = path.join(
  repositoryRoot,
  "scripts/source-size-baseline.json",
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const trackedAndUntracked = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "apps/api/src",
    "apps/web/src",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const productionSource = trackedAndUntracked.filter(
  (file) =>
    /\.(?:[cm]?js|jsx|tsx?)$/i.test(file) &&
    !/(?:^|\/)__tests__(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file),
);

if (productionSource.length === 0) {
  throw new Error(
    "No production TypeScript/JavaScript source files found under apps/api/src or apps/web/src.",
  );
}

const fileLines = Object.fromEntries(
  productionSource
    .filter((file) => existsSync(path.join(repositoryRoot, file)))
    .map((file) => [
      file.replaceAll(path.sep, "/"),
      countPhysicalLines(readFileSync(path.join(repositoryRoot, file), "utf8")),
    ]),
);
const violations = evaluateSourceSize(fileLines, baseline);

if (violations.length > 0) {
  for (const { path: file, lines, limit } of violations) {
    console.error(
      `${file}: ${lines} physical lines exceeds the ${limit}-line limit.`,
    );
  }
  console.error(
    "Split the module before growing it, or update a reviewed baseline with a documented reason.",
  );
  process.exitCode = 1;
} else {
  const exceptions = Object.keys(baseline.files).filter(
    (file) => fileLines[file] !== undefined,
  ).length;
  console.log(
    `Source-size guard passed for ${Object.keys(fileLines).length} production files; ${exceptions} existing oversized modules are capped at their ${baseline.baselineCommit} baseline.`,
  );
}
