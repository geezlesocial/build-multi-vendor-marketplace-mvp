import {
  Prisma,
  SellerStatus,
  StorePlanStatus,
  StorePlanVersionStatus,
  StoreThemePreset,
} from "@prisma/client";
import { prisma } from "./security.js";
import { effectiveStorePlan } from "./store-plan-domain.js";
import { isFreePlan } from "./store-plan-pricing.js";
import { storeThemeSchema } from "./platform-domain.js";
import {
  ALL_THEME_PRESETS,
  FREE_THEME_PRESETS,
  defaultThemeCatalogConfig,
  storeThemeCatalog,
  themeCatalogConfigSchema,
} from "./store-theme-catalog.js";
import type { ThemeCatalogConfig } from "./store-theme-catalog.js";

export {
  ALL_THEME_PRESETS,
  DEFAULT_THEME_PREVIEW_IMAGES,
  FREE_THEME_PRESETS,
  PAID_THEME_PRESETS,
  STORE_THEME_CATALOG,
  contrastRatio,
  defaultThemeCatalogConfig,
  storeThemeCatalog,
  themeCatalogConfigSchema,
  themePreviewAssetMatchesPreset,
} from "./store-theme-catalog.js";
export type { ThemeCatalogConfig } from "./store-theme-catalog.js";
type ThemeDb = typeof prisma | Prisma.TransactionClient;

export type PaidThemeSubscriptionFacts = {
  assignmentSource: string | null;
  assignmentEffectiveFrom: Date | null;
  assignmentEffectiveUntil: Date | null;
  planStatus: string | null;
  planVersionStatus: string | null;
  versionEffectiveFrom: Date | null;
  versionEffectiveUntil: Date | null;
  versionMonthlyPriceMinor: number;
  versionAnnualPriceMinor: number;
  versionIntroPriceMinor: number | null;
  versionTrialDays: number;
  subscriptionStatus: string | null;
  subscriptionProvider: string | null;
  providerSubscriptionId: string | null;
  subscriptionMonthlyPriceMinor: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  expiresAt: Date | null;
  cancelledAt: Date | null;
};

export function hasActivePaidThemeSubscription(
  facts: PaidThemeSubscriptionFacts | null,
  now = new Date(),
) {
  if (
    !facts ||
    facts.assignmentSource !== "SUBSCRIPTION" ||
    facts.planStatus !== StorePlanStatus.ACTIVE ||
    facts.planVersionStatus !== StorePlanVersionStatus.ACTIVE
  )
    return false;
  // Annual billing may be disabled for a valid paid plan (annualPriceMinor = 0).
  // The active subscription snapshot must still be non-zero and provider-backed.
  if (
    facts.versionMonthlyPriceMinor <= 0 ||
    facts.subscriptionMonthlyPriceMinor <= 0
  )
    return false;
  if (
    facts.subscriptionStatus !== "ACTIVE" ||
    !facts.subscriptionProvider ||
    !facts.providerSubscriptionId ||
    facts.cancelledAt
  )
    return false;
  if (
    (facts.assignmentEffectiveFrom && facts.assignmentEffectiveFrom > now) ||
    (facts.assignmentEffectiveUntil && facts.assignmentEffectiveUntil <= now)
  )
    return false;
  if (
    (facts.versionEffectiveFrom && facts.versionEffectiveFrom > now) ||
    (facts.versionEffectiveUntil && facts.versionEffectiveUntil <= now)
  )
    return false;
  if (
    !facts.currentPeriodStart ||
    facts.currentPeriodStart > now ||
    !facts.currentPeriodEnd ||
    facts.currentPeriodEnd <= now
  )
    return false;
  if (
    (facts.expiresAt && facts.expiresAt <= now) ||
    (facts.trialEndsAt && facts.trialEndsAt > now)
  )
    return false;
  return true;
}

export async function resolveStoreThemeAccess(
  db: ThemeDb,
  storeId: string,
  now = new Date(),
) {
  const catalogConfig = await readThemeCatalogConfig(db);
  const applyVisibility = (themes: StoreThemePreset[]) =>
    themes.filter(
      (theme) =>
        theme === StoreThemePreset.CLASSIC ||
        catalogConfig.visibleThemes.includes(theme),
    );
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { isPlatformStore: true, seller: { select: { status: true } } },
  });
  if (!store || store.seller.status !== SellerStatus.APPROVED)
    return {
      allowedThemes: applyVisibility([...FREE_THEME_PRESETS]),
      premiumEligible: false,
      reason: "STORE_UNAVAILABLE" as const,
    };
  if (store.isPlatformStore)
    return {
      allowedThemes: applyVisibility([...ALL_THEME_PRESETS]),
      premiumEligible: true,
      reason: "PLATFORM_STORE" as const,
    };

  const effective = await effectiveStorePlan(db, storeId, now);
  const version = effective.version;
  const assignment = effective.assignment;
  if (
    !version ||
    !assignment ||
    isFreePlan(version) ||
    version.plan.status !== StorePlanStatus.ACTIVE ||
    version.status !== StorePlanVersionStatus.ACTIVE
  ) {
    return {
      allowedThemes: applyVisibility([...FREE_THEME_PRESETS]),
      premiumEligible: false,
      reason: "FREE_OR_INACTIVE_PLAN" as const,
    };
  }
  const subscription = await db.storeSubscription.findFirst({
    where: {
      storeId,
      planVersionId: version.id,
      status: "ACTIVE",
      provider: { not: null },
      providerSubscriptionId: { not: null },
      monthlyPriceMinor: { gt: 0 },
      currentPeriodStart: { lte: now },
      currentPeriodEnd: { gt: now },
      cancelledAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }] },
      ],
    },
    select: {
      provider: true,
      providerSubscriptionId: true,
      status: true,
      monthlyPriceMinor: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      trialEndsAt: true,
      expiresAt: true,
      cancelledAt: true,
    },
  });
  const eligible = hasActivePaidThemeSubscription(
    {
      assignmentSource: assignment.source,
      assignmentEffectiveFrom: assignment.effectiveFrom,
      assignmentEffectiveUntil: assignment.effectiveUntil,
      planStatus: version.plan.status,
      planVersionStatus: version.status,
      versionEffectiveFrom: version.effectiveFrom,
      versionEffectiveUntil: version.effectiveUntil,
      versionMonthlyPriceMinor: version.monthlyPriceMinor,
      versionAnnualPriceMinor: version.annualPriceMinor,
      versionIntroPriceMinor: version.introPriceMinor,
      versionTrialDays: version.freeTrialDays,
      subscriptionStatus: subscription?.status ?? null,
      subscriptionProvider: subscription?.provider ?? null,
      providerSubscriptionId: subscription?.providerSubscriptionId ?? null,
      subscriptionMonthlyPriceMinor: subscription?.monthlyPriceMinor ?? 0,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      expiresAt: subscription?.expiresAt ?? null,
      cancelledAt: subscription?.cancelledAt ?? null,
    },
    now,
  );
  // Theme availability is a product entitlement, not a snapshot of the
  // catalog that happened to exist when an immutable plan version was issued.
  // Any provider-verified active paid subscriber receives the current six-theme
  // product; free and ineligible accounts remain restricted to the free tier.
  const allowed = eligible ? ALL_THEME_PRESETS : FREE_THEME_PRESETS;
  return {
    allowedThemes: [
      ...new Set(
        applyVisibility(
          allowed.filter((theme) => ALL_THEME_PRESETS.includes(theme)),
        ),
      ),
    ],
    premiumEligible: eligible,
    reason: eligible
      ? ("ACTIVE_PAID_SUBSCRIPTION" as const)
      : ("PAID_SUBSCRIPTION_INACTIVE" as const),
  };
}

export async function resolvePublishedStoreTheme(
  db: ThemeDb,
  store: { id: string; themePublishedJson: unknown },
  now = new Date(),
) {
  const access = await resolveStoreThemeAccess(db, store.id, now);
  const parsed = storeThemeSchema.safeParse(store.themePublishedJson ?? {});
  const saved = parsed.success ? parsed.data : storeThemeSchema.parse({});
  const themePreset = access.allowedThemes.includes(saved.themePreset)
    ? saved.themePreset
    : StoreThemePreset.CLASSIC;
  return {
    theme: { ...saved, themePreset },
    savedThemePreset: saved.themePreset,
    effectiveFallback: themePreset !== saved.themePreset,
    access,
  };
}

export async function readThemeCatalogConfig(
  db: ThemeDb = prisma,
): Promise<ThemeCatalogConfig> {
  const settings = await db.marketplaceSettings.findUnique({
    where: { id: "default" },
    select: { themeCatalogJson: true },
  });
  const parsed = themeCatalogConfigSchema.safeParse(settings?.themeCatalogJson);
  return parsed.success ? parsed.data : defaultThemeCatalogConfig;
}

export async function publicStoreThemeCatalog(db: ThemeDb = prisma) {
  const config = await readThemeCatalogConfig(db);
  const previewIds = Object.values(config.previewImages);
  const approvedPreviewIds = previewIds.length
    ? new Set(
        (
          await db.mediaAsset.findMany({
            where: {
              id: { in: previewIds },
              storeId: null,
              purpose: "THEME_PREVIEW",
              kind: "IMAGE",
              uploadStatus: "COMPLETE",
              scanStatus: "APPROVED",
              storageProvider: { in: ["OBJECT", "LOCAL"] },
            },
            select: { id: true },
          })
        ).map((asset) => asset.id),
      )
    : new Set<string>();
  return storeThemeCatalog(config, approvedPreviewIds).filter(
    (theme) => theme.available,
  );
}
