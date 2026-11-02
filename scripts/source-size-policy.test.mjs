import assert from "node:assert/strict";
import test from "node:test";
import {
  countPhysicalLines,
  evaluateSourceSize,
} from "./source-size-policy.mjs";

test("counts physical lines consistently for LF, CRLF, and missing final newline", () => {
  assert.equal(countPhysicalLines("one\ntwo\n"), 2);
  assert.equal(countPhysicalLines("one\r\ntwo\r\n"), 2);
  assert.equal(countPhysicalLines("one\ntwo"), 2);
  assert.equal(countPhysicalLines(""), 0);
});

test("allows current baseline exceptions and files at the default cap", () => {
  const baseline = {
    defaultMaxLines: 500,
    files: { "apps/api/src/index.ts": 1005 },
  };

  assert.deepEqual(
    evaluateSourceSize(
      { "apps/api/src/index.ts": 1005, "apps/web/src/new-component.tsx": 500 },
      baseline,
    ),
    [],
  );
});

test("rejects growth in grandfathered files and oversized new files", () => {
  const baseline = {
    defaultMaxLines: 500,
    files: { "apps/api/src/index.ts": 1005 },
  };

  assert.deepEqual(
    evaluateSourceSize(
      { "apps/api/src/index.ts": 1006, "apps/web/src/new-component.tsx": 501 },
      baseline,
    ),
    [
      { path: "apps/api/src/index.ts", lines: 1006, limit: 1005 },
      { path: "apps/web/src/new-component.tsx", lines: 501, limit: 500 },
    ],
  );
});

test("allows existing modules to shrink without requiring a baseline edit", () => {
  assert.deepEqual(
    evaluateSourceSize(
      { "apps/api/src/index.ts": 900 },
      { defaultMaxLines: 500, files: { "apps/api/src/index.ts": 1005 } },
    ),
    [],
  );
});
