import assert from "node:assert/strict";
import test from "node:test";
import { selectFormatBase } from "./format-base.mjs";

test("falls back from the all-zero initial-push SHA to origin/main", () => {
  const base = selectFormatBase({
    requestedBase: "0".repeat(40),
    hasCommit: (ref) => ref === "origin/main",
  });

  assert.equal(base, "origin/main");
});

test("prefers a valid requested base commit", () => {
  const base = selectFormatBase({
    requestedBase: "abc123",
    githubBaseRef: "main",
    hasCommit: (ref) => ref === "abc123" || ref === "origin/main",
  });

  assert.equal(base, "abc123");
});

test("falls back to the pull request base branch when the requested ref is absent", () => {
  const base = selectFormatBase({
    requestedBase: "missing-sha",
    githubBaseRef: "release",
    hasCommit: (ref) => ref === "origin/release",
  });

  assert.equal(base, "origin/release");
});

test("fails closed when no valid comparison base exists", () => {
  assert.throws(
    () =>
      selectFormatBase({
        requestedBase: "0".repeat(40),
        hasCommit: () => false,
      }),
    /valid Git base commit/,
  );
});
