import {
  Prisma,
  SellerStatus,
  StorePlanStatus,
  StorePlanVersionStatus,
  StoreThemePreset,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "./security.js";
import { effectiveStorePlan } from "./store-plan-domain.js";
import { isFreePlan } from "./store-plan-pricing.js";
import { storeThemeSchema } from "./platform-domain.js";

export const FREE_THEME_PRESETS = [
  StoreThemePreset.CLASSIC,
  StoreThemePreset.EDITORIAL,
  StoreThemePreset.BOUTIQUE,
] as const;
export const PAID_THEME_PRESETS = [
  StoreThemePreset.TECH_ELECTRONICS,
  StoreThemePreset.GROCERIES,
  StoreThemePreset.ECOMMERCE_MARKETPLACE,
] as const;
export const ALL_THEME_PRESETS = [
  ...FREE_THEME_PRESETS,
  ...PAID_THEME_PRESETS,
] as const;

export const DEFAULT_THEME_PREVIEW_IMAGES: Record<StoreThemePreset, string> = {
  [StoreThemePreset.CLASSIC]: "/theme-previews/classic.webp",
  [StoreThemePreset.EDITORIAL]: "/theme-previews/editorial.webp",
  [StoreThemePreset.BOUTIQUE]: "/theme-previews/boutique.webp",
  [StoreThemePreset.TECH_ELECTRONICS]: "/theme-previews/tech-electronics.webp",
  [StoreThemePreset.GROCERIES]: "/theme-previews/groceries.webp",
  [StoreThemePreset.ECOMMERCE_MARKETPLACE]:
    "/theme-previews/ecommerce-marketplace.webp",
};

export function themePreviewAssetMatchesPreset(
  preset: StoreThemePreset,
  originalName: string,
) {
  const prefix = `${preset}--`;
  return originalName.startsWith(prefix) && originalName.length > prefix.length;
}

export const STORE_THEME_CATALOG = [
  {
    id: StoreThemePreset.CLASSIC,
    name: "Classic",
    tier: "FREE",
    description:
      "Clear, familiar shopping with store identity, categories and practical product cards.",
    features: [
      "Store identity",
      "Product search",
      "Categories",
      "Standard product cards",
    ],
    defaultTokens: {
      surfaceColor: "#f4f6f1",
      cardColor: "#ffffff",
      textColor: "#17211b",
      mutedColor: "#536158",
      accentColor: "#315d47",
    },
  },
  {
    id: StoreThemePreset.EDITORIAL,
    name: "Editorial",
    tier: "FREE",
    description:
      "Magazine-inspired storytelling, generous typography and curated product photography.",
    features: [
      "Editorial hero",
      "Story-led sections",
      "Serif display type",
      "Curated galleries",
    ],
    defaultTokens: {
      surfaceColor: "#f2efe8",
      cardColor: "#fffdf8",
      textColor: "#27231e",
      mutedColor: "#665f54",
      accentColor: "#765b37",
    },
  },
  {
    id: StoreThemePreset.BOUTIQUE,
    name: "Boutique",
    tier: "FREE",
    description:
      "A refined, intimate storefront for focused collections and brand-led discovery.",
    features: [
      "Curated collections",
      "Soft gallery layout",
      "Brand-focused identity",
      "Elegant product cards",
    ],
    defaultTokens: {
      surfaceColor: "#f8f4f1",
      cardColor: "#ffffff",
      textColor: "#332923",
      mutedColor: "#75665c",
      accentColor: "#80505a",
    },
  },
  {
    id: StoreThemePreset.TECH_ELECTRONICS,
    name: "Tech & Electronics",
    tier: "PAID",
    description:
      "High-clarity product discovery for electronics, using only verified catalog details.",
    features: [
      "Specification highlights",
      "Brand and feature discovery",
      "Variant-aware shopping",
      "Availability-led cards",
    ],
    defaultTokens: {
      surfaceColor: "#10131d",
      cardColor: "#191e2c",
      textColor: "#f5f6fb",
      mutedColor: "#b4bbcf",
      accentColor: "#91a6ff",
    },
  },
  {
    id: StoreThemePreset.GROCERIES,
    name: "Groceries",
    tier: "PAID",
    description:
      "Fresh, category-first browsing with quick shopping and current stock visibility.",
    features: [
      "Department navigation",
      "Quick add controls",
      "Current price and stock",
      "Mobile-first grid",
    ],
    defaultTokens: {
      surfaceColor: "#f0f5e8",
      cardColor: "#ffffff",
      textColor: "#203021",
      mutedColor: "#596d54",
      accentColor: "#39784b",
    },
  },
  {
    id: StoreThemePreset.ECOMMERCE_MARKETPLACE,
    name: "Ecommerce Marketplace",
    tier: "PAID",
    description:
      "A dense, polished catalog layout for one seller-owned Store and its approved products.",
    features: [
      "Search-led discovery",
      "Responsive categories",
      "Promotion placements",
      "Single-Store attribution",
    ],
    defaultTokens: {
      surfaceColor: "#f1f3fb",
      cardColor: "#ffffff",
      textColor: "#20233a",
      mutedColor: "#60657b",
      accentColor: "#505ce0",
    },
  },
] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const tokensSchema = z
  .object({
    surfaceColor: hexColor,
    cardColor: hexColor,
    textColor: hexColor,
    mutedColor: hexColor,
    accentColor: hexColor,
  })
  .strict();

export const themeCatalogConfigSchema = z
  .object({
    displayOrder: z
      .array(z.nativeEnum(StoreThemePreset))
      .length(ALL_THEME_PRESETS.length)
      .refine(
        (values) =>
          new Set(values).size === ALL_THEME_PRESETS.length &&
          ALL_THEME_PRESETS.every((value) => values.includes(value)),
        "All six implemented themes must remain in the catalog.",
      ),
    visibleThemes: z
      .array(z.nativeEnum(StoreThemePreset))
      .min(1)
      .max(ALL_THEME_PRESETS.length)
      .default([...ALL_THEME_PRESETS])
      .refine(
        (values) => new Set(values).size === values.length,
        "Each available theme may be listed only once.",
      ),
    previewImages: z
      .record(z.string(), z.string().uuid())
      .default({})
      .refine(
        (images) =>
          Object.keys(images).every((theme) =>
            ALL_THEME_PRESETS.includes(theme as StoreThemePreset),
          ) &&
          new Set(Object.values(images)).size === Object.keys(images).length,
        "Preview images must map known themes to distinct media assets.",
      ),
    tokens: z
      .record(z.string(), tokensSchema)
      .refine(
        (value) =>
          ALL_THEME_PRESETS.every((theme) => Object.hasOwn(value, theme)) &&
          Object.keys(value).every((theme) =>
            ALL_THEME_PRESETS.includes(theme as StoreThemePreset),
          ),
        "Design tokens must be supplied for exactly the six implemented themes.",
      ),
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.visibleThemes.includes(StoreThemePreset.CLASSIC))
      context.addIssue({
        code: "custom",
        path: ["visibleThemes"],
        message: "Classic must always remain visible as the safe fallback.",
      });
    for (const preset of ALL_THEME_PRESETS) {
      const token = config.tokens[preset];
      if (!token) continue;
      if (contrastRatio(token.textColor, token.cardColor) < 4.5)
        context.addIssue({
          code: "custom",
          path: ["tokens", preset, "textColor"],
          message: `${preset} text color must meet 4.5:1 contrast against its card color.`,
        });
      if (contrastRatio(token.mutedColor, token.cardColor) < 4.5)
        context.addIssue({
          code: "custom",
          path: ["tokens", preset, "mutedColor"],
          message: `${preset} muted color must meet 4.5:1 contrast against its card color.`,
        });
      if (contrastRatio(token.textColor, token.surfaceColor) < 4.5)
        context.addIssue({
          code: "custom",
          path: ["tokens", preset, "textColor"],
          message: `${preset} text color must meet 4.5:1 contrast against its surface color.`,
        });
      if (
        contrastRatio(token.accentColor, token.cardColor) < 4.5 ||
        contrastRatio(token.accentColor, token.surfaceColor) < 4.5
      )
        context.addIssue({
          code: "custom",
          path: ["tokens", preset, "accentColor"],
          message: `${preset} accent/link color must meet 4.5:1 contrast against its card and surface colors.`,
        });
    }
  });

export type ThemeCatalogConfig = z.infer<typeof themeCatalogConfigSchema>;
export const defaultThemeCatalogConfig: ThemeCatalogConfig = {
  displayOrder: [...ALL_THEME_PRESETS],
  visibleThemes: [...ALL_THEME_PRESETS],
  tokens: Object.fromEntries(
    STORE_THEME_CATALOG.map((theme) => [theme.id, theme.defaultTokens]),
  ),
  previewImages: {},
};

type ThemeDb = typeof prisma | Prisma.TransactionClient;

function channel(hex: string, offset: number) {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(first: string, second: string) {
  const luminance = (hex: string) =>
    0.2126 * channel(hex, 1) +
    0.7152 * channel(hex, 3) +
    0.0722 * channel(hex, 5);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

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

export function storeThemeCatalog(
  config: ThemeCatalogConfig,
  approvedPreviewIds: ReadonlySet<string> = new Set(),
) {
  const order = new Map(
    config.displayOrder.map((preset, index) => [preset, index]),
  );
  return [...STORE_THEME_CATALOG]
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    .map((theme) => ({
      ...theme,
      defaultTokens: config.tokens[theme.id],
      available: config.visibleThemes.includes(theme.id),
      previewImageUrl:
        config.previewImages[theme.id] &&
        approvedPreviewIds.has(config.previewImages[theme.id]!)
          ? `/content-media/${encodeURIComponent(config.previewImages[theme.id]!)}`
          : DEFAULT_THEME_PREVIEW_IMAGES[theme.id],
    }));
}
