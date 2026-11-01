import { StoreThemePreset } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ALL_THEME_PRESETS,
  FREE_THEME_PRESETS,
  defaultThemeCatalogConfig,
  hasActivePaidThemeSubscription,
  themeCatalogConfigSchema,
} from "./store-theme-domain.js";

const now = new Date("2026-11-01T00:00:00.000Z");
const activeSubscription = {
  assignmentSource: "SUBSCRIPTION",
  assignmentEffectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
  assignmentEffectiveUntil: null,
  planStatus: "ACTIVE",
  planVersionStatus: "ACTIVE",
  versionEffectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
  versionEffectiveUntil: null,
  versionMonthlyPriceMinor: 2500,
  versionAnnualPriceMinor: 27000,
  versionIntroPriceMinor: null,
  versionTrialDays: 0,
  subscriptionStatus: "ACTIVE",
  subscriptionProvider: "STRIPE",
  providerSubscriptionId: "sub_synthetic_active",
  subscriptionMonthlyPriceMinor: 2500,
  currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
  trialEndsAt: null,
  expiresAt: null,
  cancelledAt: null,
};

describe("storefront theme entitlement policy", () => {
  it("keeps the existing three free identifiers and adds three distinct paid identifiers", () => {
    expect(FREE_THEME_PRESETS).toEqual([
      StoreThemePreset.CLASSIC,
      StoreThemePreset.EDITORIAL,
      StoreThemePreset.BOUTIQUE,
    ]);
    expect(ALL_THEME_PRESETS).toHaveLength(6);
    expect(new Set(ALL_THEME_PRESETS).size).toBe(6);
    expect(ALL_THEME_PRESETS).toContain(StoreThemePreset.TECH_ELECTRONICS);
    expect(ALL_THEME_PRESETS).toContain(StoreThemePreset.GROCERIES);
    expect(ALL_THEME_PRESETS).toContain(StoreThemePreset.ECOMMERCE_MARKETPLACE);
  });

  it("accepts a complete, accessible six-theme catalog config and keeps all implementations present", () => {
    expect(themeCatalogConfigSchema.parse(defaultThemeCatalogConfig)).toEqual(
      defaultThemeCatalogConfig,
    );
    const hiddenGroceries = {
      ...defaultThemeCatalogConfig,
      visibleThemes: defaultThemeCatalogConfig.visibleThemes.filter(
        (theme) => theme !== StoreThemePreset.GROCERIES,
      ),
    };
    expect(
      themeCatalogConfigSchema.parse(hiddenGroceries).visibleThemes,
    ).not.toContain(StoreThemePreset.GROCERIES);
    expect(() =>
      themeCatalogConfigSchema.parse({
        ...defaultThemeCatalogConfig,
        displayOrder: [StoreThemePreset.EDITORIAL],
      }),
    ).toThrow();
    expect(() =>
      themeCatalogConfigSchema.parse({
        ...defaultThemeCatalogConfig,
        visibleThemes: ALL_THEME_PRESETS.filter(
          (theme) => theme !== StoreThemePreset.CLASSIC,
        ),
      }),
    ).toThrow(/Classic must always remain visible/i);
    const legacyConfig = { ...defaultThemeCatalogConfig } as Record<
      string,
      unknown
    >;
    delete legacyConfig.visibleThemes;
    expect(themeCatalogConfigSchema.parse(legacyConfig).visibleThemes).toEqual(
      ALL_THEME_PRESETS,
    );
    expect(() =>
      themeCatalogConfigSchema.parse({
        ...defaultThemeCatalogConfig,
        tokens: {
          ...defaultThemeCatalogConfig.tokens,
          CLASSIC: {
            ...defaultThemeCatalogConfig.tokens.CLASSIC,
            textColor: "#ffffff",
          },
        },
      }),
    ).toThrow(/contrast/i);
    expect(() =>
      themeCatalogConfigSchema.parse({
        ...defaultThemeCatalogConfig,
        tokens: {
          ...defaultThemeCatalogConfig.tokens,
          CLASSIC: {
            ...defaultThemeCatalogConfig.tokens.CLASSIC,
            accentColor: "#ffffff",
          },
        },
      }),
    ).toThrow(/accent\/link color/i);
  });

  it("grants paid themes only for a provider-backed active subscription and current paid period", () => {
    expect(hasActivePaidThemeSubscription(activeSubscription, now)).toBe(true);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, versionAnnualPriceMinor: 0 },
        now,
      ),
    ).toBe(true);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, subscriptionProvider: null },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, providerSubscriptionId: null },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, assignmentSource: "ADMIN" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, planStatus: "RETIRED" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, planVersionStatus: "SUPERSEDED" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, versionMonthlyPriceMinor: 0 },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, subscriptionMonthlyPriceMinor: 0 },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        {
          ...activeSubscription,
          currentPeriodEnd: new Date("2026-10-31T23:59:59.000Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, currentPeriodStart: null },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, subscriptionStatus: "TRIALING" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, subscriptionStatus: "PAST_DUE" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, subscriptionStatus: "CANCELLED" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        { ...activeSubscription, subscriptionStatus: "UNPAID" },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        {
          ...activeSubscription,
          trialEndsAt: new Date("2026-11-02T00:00:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        {
          ...activeSubscription,
          expiresAt: new Date("2026-10-31T23:59:59.000Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePaidThemeSubscription(
        {
          ...activeSubscription,
          cancelledAt: new Date("2026-10-30T00:00:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
  });
});
