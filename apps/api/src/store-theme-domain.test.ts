import { StoreThemePreset } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ALL_THEME_PRESETS,
  DEFAULT_THEME_PREVIEW_IMAGES,
  FREE_THEME_PRESETS,
  defaultThemeCatalogConfig,
  hasActivePaidThemeSubscription,
  resolveStoreThemeAccess,
  storeThemeCatalog,
  themePreviewAssetMatchesPreset,
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

function themeAccessDb({
  paid = true,
  subscription = paid ? activeSubscription : null,
  allowedThemes = [...FREE_THEME_PRESETS],
}: {
  paid?: boolean;
  subscription?: typeof activeSubscription | null;
  allowedThemes?: StoreThemePreset[];
} = {}) {
  const effectiveFrom = new Date("2026-10-01T00:00:00.000Z");
  const version = {
    id: "immutable-plan-version",
    status: "ACTIVE",
    effectiveFrom,
    effectiveUntil: null,
    monthlyPriceMinor: paid ? 2500 : 0,
    annualPriceMinor: paid ? 27000 : 0,
    introPriceMinor: null,
    freeTrialDays: 0,
    allowedThemes,
    plan: { status: "ACTIVE" },
  };
  const db = {
    marketplaceSettings: {
      findUnique: async () => ({ themeCatalogJson: defaultThemeCatalogConfig }),
    },
    store: {
      findUnique: async () => ({
        isPlatformStore: false,
        seller: { status: "APPROVED" },
      }),
    },
    storePlanAssignment: {
      findFirst: async () => ({
        source: "SUBSCRIPTION",
        effectiveFrom,
        effectiveUntil: null,
        planVersion: version,
      }),
    },
    storePlanVersion: { findFirst: async () => null },
    storeSubscription: {
      findFirst: async () =>
        subscription
          ? {
              status: subscription.subscriptionStatus,
              provider: subscription.subscriptionProvider,
              providerSubscriptionId: subscription.providerSubscriptionId,
              monthlyPriceMinor: subscription.subscriptionMonthlyPriceMinor,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
              trialEndsAt: subscription.trialEndsAt,
              expiresAt: subscription.expiresAt,
              cancelledAt: subscription.cancelledAt,
            }
          : null,
    },
  };
  return db as unknown as Parameters<typeof resolveStoreThemeAccess>[0];
}

describe("storefront theme entitlement policy", () => {
  it("grants all six themes to active paid subscribers on immutable legacy versions", async () => {
    const access = await resolveStoreThemeAccess(
      themeAccessDb({ allowedThemes: [...FREE_THEME_PRESETS] }),
      "synthetic-paid-store",
      now,
    );

    expect(access.premiumEligible).toBe(true);
    expect(access.allowedThemes).toEqual(ALL_THEME_PRESETS);
  });

  it("keeps a free plan on the three free themes even if its snapshot lists all six", async () => {
    const access = await resolveStoreThemeAccess(
      themeAccessDb({
        paid: false,
        subscription: null,
        allowedThemes: [...ALL_THEME_PRESETS],
      }),
      "synthetic-free-store",
      now,
    );

    expect(access.premiumEligible).toBe(false);
    expect(access.allowedThemes).toEqual(FREE_THEME_PRESETS);
  });

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

  it("provides a named default preview image for each theme and uses uploaded previews only when approved", () => {
    const defaults = storeThemeCatalog(defaultThemeCatalogConfig);
    expect(defaults).toHaveLength(6);
    for (const theme of defaults) {
      expect(theme.previewImageUrl).toBe(
        DEFAULT_THEME_PREVIEW_IMAGES[theme.id],
      );
      expect(theme.previewImageUrl).toMatch(
        /^\/theme-previews\/[a-z-]+\.webp$/,
      );
    }

    const customConfig = {
      ...defaultThemeCatalogConfig,
      previewImages: { CLASSIC: "a7a1a901-69f4-4aef-91a8-c08293b3a7fa" },
    };
    const unapproved = storeThemeCatalog(customConfig).find(
      (theme) => theme.id === StoreThemePreset.CLASSIC,
    );
    expect(unapproved?.previewImageUrl).toBe(
      DEFAULT_THEME_PREVIEW_IMAGES.CLASSIC,
    );
    const approved = storeThemeCatalog(
      customConfig,
      new Set(["a7a1a901-69f4-4aef-91a8-c08293b3a7fa"]),
    ).find((theme) => theme.id === StoreThemePreset.CLASSIC);
    expect(approved?.previewImageUrl).toBe(
      "/content-media/a7a1a901-69f4-4aef-91a8-c08293b3a7fa",
    );
  });

  it("keeps legacy stored catalog JSON valid with no preview-image field", () => {
    const legacyConfig = { ...defaultThemeCatalogConfig } as Record<
      string,
      unknown
    >;
    delete legacyConfig.previewImages;
    expect(themeCatalogConfigSchema.parse(legacyConfig).previewImages).toEqual(
      {},
    );
  });

  it("binds uploaded preview assets to the theme-specific immutable filename prefix", () => {
    expect(
      themePreviewAssetMatchesPreset(
        StoreThemePreset.CLASSIC,
        "CLASSIC--classic-preview.webp",
      ),
    ).toBe(true);
    expect(
      themePreviewAssetMatchesPreset(
        StoreThemePreset.CLASSIC,
        "EDITORIAL--editorial-preview.webp",
      ),
    ).toBe(false);
    expect(
      themePreviewAssetMatchesPreset(StoreThemePreset.GROCERIES, "GROCERIES--"),
    ).toBe(false);
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
