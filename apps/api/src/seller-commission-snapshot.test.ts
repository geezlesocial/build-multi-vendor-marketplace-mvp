import { describe, expect, it } from "vitest";
import { makeCommissionSnapshot } from "./seller-commission.js";

type CommissionPolicy = NonNullable<
  Parameters<typeof makeCommissionSnapshot>[0]
>;

const capturedAt = new Date("2026-10-29T12:34:56.000Z");

function policy(overrides: Partial<CommissionPolicy> = {}): CommissionPolicy {
  return {
    id: "commission_policy_synthetic_7",
    version: 7,
    type: "PERCENTAGE",
    fixedMinor: null,
    basisPoints: 750,
    minimumMinor: null,
    capMinor: null,
    reason: "Synthetic commission policy fixture",
    currency: "USD",
    storeId: null,
    planVersionId: null,
    freeStoreScopeKey: "FREE_STORES",
    ...overrides,
  };
}

describe("seller commission order snapshots", () => {
  it("captures the zero-commission default with an immutable effective timestamp", () => {
    expect(makeCommissionSnapshot(null, "USD", capturedAt)).toEqual({
      version: 1,
      policyVersionId: null,
      source: "DEFAULT_ZERO",
      type: "ZERO",
      fixedMinor: null,
      basisPoints: null,
      minimumMinor: null,
      capMinor: null,
      currency: "USD",
      capturedAt: capturedAt.toISOString(),
      reason: "No active policy; zero commission applies.",
    });
  });

  it("persists the full free-Store policy terms on the order snapshot", () => {
    expect(makeCommissionSnapshot(policy(), "PHP", capturedAt)).toEqual({
      version: 1,
      policyVersionId: "commission_policy_synthetic_7",
      policyVersion: 7,
      source: "FREE_STORES",
      type: "PERCENTAGE",
      fixedMinor: null,
      basisPoints: 750,
      minimumMinor: null,
      capMinor: null,
      currency: "PHP",
      capturedAt: capturedAt.toISOString(),
      reason: "Synthetic commission policy fixture",
    });
  });

  it.each([
    ["store-specific legacy", { storeId: "store_synthetic_1" }, "LEGACY_STORE"],
    [
      "plan-specific legacy",
      { planVersionId: "plan_version_synthetic_1" },
      "LEGACY_PLAN",
    ],
  ] as Array<[string, Partial<CommissionPolicy>, string]>)(
    "labels %s snapshots without changing their terms",
    (_label, overrides, source) => {
      expect(
        makeCommissionSnapshot(
          policy({ freeStoreScopeKey: null, ...overrides }),
          "USD",
          capturedAt,
        ),
      ).toMatchObject({
        source,
        policyVersionId: "commission_policy_synthetic_7",
        policyVersion: 7,
        basisPoints: 750,
        currency: "USD",
        capturedAt: capturedAt.toISOString(),
      });
    },
  );
});
