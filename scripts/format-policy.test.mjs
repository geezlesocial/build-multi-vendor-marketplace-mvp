import assert from "node:assert/strict";
import test from "node:test";
import { shouldFormatCandidate } from "./format-policy.mjs";

test("newly added E2E specs are always formatting-checked", () => {
  assert.equal(
    shouldFormatCandidate({
      status: "A",
      path: "e2e/checkout-cart-preservation.spec.ts",
    }),
    true,
  );
});

test("changed E2E specs are checked except for the single legacy baseline file", () => {
  assert.equal(
    shouldFormatCandidate({ status: "M", path: "e2e/product-actions.spec.ts" }),
    false,
  );
  assert.equal(
    shouldFormatCandidate({
      status: "M",
      path: "e2e/another-checkout.spec.ts",
    }),
    true,
  );
});

test("existing application source keeps its incremental baseline exemption", () => {
  assert.equal(
    shouldFormatCandidate({ status: "M", path: "apps/api/src/index.ts" }),
    false,
  );
  assert.equal(
    shouldFormatCandidate({ status: "A", path: "apps/api/src/new-route.ts" }),
    true,
  );
});
