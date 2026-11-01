import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const baseCandidates = [
  process.env.FORMAT_BASE_REF,
  process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : undefined,
  "origin/main",
];
const base = baseCandidates.find((candidate) => {
  if (
    !candidate?.trim() ||
    /^0+$/.test(candidate.trim()) ||
    candidate.startsWith("-")
  ) {
    return false;
  }

  try {
    run("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    return true;
  } catch {
    return false;
  }
});

if (!base) {
  throw new Error(
    "No valid formatter comparison base was found; fetch the pull-request base or origin/main.",
  );
}

const trackedChanges = run("git", [
  "diff",
  "--name-status",
  "--diff-filter=ACMR",
  `${base}...HEAD`,
]);
const workingChanges = run("git", [
  "diff",
  "--name-status",
  "--diff-filter=ACMR",
  "HEAD",
]);
const untrackedChanges = run("git", [
  "ls-files",
  "--others",
  "--exclude-standard",
])
  .split(/\r?\n/)
  .filter(Boolean)
  .map((file) => `A\t${file}`)
  .join("\n");
const supported =
  /\.(?:cjs|css|graphql|gql|html|js|jsx|json|md|mdx|mjs|mts|scss|svg|ts|tsx|yaml|yml)$/i;
const formatCandidates =
  `${trackedChanges}\n${workingChanges}\n${untrackedChanges}`
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      const [status, ...pathParts] = entry.split("\t");
      return { status, path: pathParts.at(-1) };
    })
    .filter(
      ({ path }) =>
        path && path !== "package-lock.json" && supported.test(path),
    );
const files = [
  ...new Set(
    formatCandidates
      .filter(
        ({ status, path }) =>
          status.startsWith("A") || !/^apps\/(?:api|web)\/src\//.test(path),
      )
      .map(({ path }) => path),
  ),
];

if (files.length === 0) {
  console.log("No changed Prettier-supported files to check.");
  process.exit(0);
}

const prettierCli = require.resolve("prettier/bin/prettier.cjs");
execFileSync(
  process.execPath,
  [prettierCli, "--check", "--ignore-unknown", ...files],
  { stdio: "inherit" },
);
