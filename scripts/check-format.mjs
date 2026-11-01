import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const requestedBase =
  process.env.FORMAT_BASE_REF ||
  (process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "origin/main");
const baseCandidates = [
  requestedBase,
  process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "origin/main",
].filter(
  (candidate, index, candidates) => candidates.indexOf(candidate) === index,
);
const isCommit = (ref) => {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};
const base = baseCandidates.find(isCommit);
if (!base) {
  console.error(
    `Could not resolve a formatting comparison base (${baseCandidates.join(", ")}).`,
  );
  process.exit(1);
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
