import { MobileStorefrontTemplate, StorePaymentConnector, StoreThemePreset, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './security.js';
import { isFreePlan, type PlanPricingRecord } from './store-plan-pricing.js';

export const storePlanEntitlementsSchema = z.object({
  productLimit: z.number().int().min(1).max(2_000_000_000),
  storeLimit: z.number().int().min(1).max(100_000),
  vendorLimit: z.number().int().min(1).max(100_000),
  staffSeatLimit: z.number().int().min(0).max(100_000),
  allowedThemes: z.array(z.nativeEnum(StoreThemePreset)).min(1).max(6).refine(values => new Set(values).size === values.length, 'Themes must not contain duplicates'),
  customDomainEligible: z.boolean(),
  paymentConnectors: z.array(z.nativeEnum(StorePaymentConnector)).max(2).refine(values => new Set(values).size === values.length, 'Connectors must not contain duplicates'),
  sellerManagedPaymentsEnabled: z.boolean().default(false),
  sellerManagedCarrierAccountsEnabled: z.boolean().default(false),
  dropshippingEnabled: z.boolean().default(false),
  mobileTemplates: z.array(z.nativeEnum(MobileStorefrontTemplate)).min(1).max(3).refine(values => new Set(values).size === values.length, 'Templates must not contain duplicates'),
  blogPostLimit: z.number().int().min(1).max(2_000_000_000).default(100),
  contentPageLimit: z.number().int().min(1).max(2_000_000_000).default(100),
  mediaStorageLimitBytes: z.number().int().min(1).max(2_000_000_000).default(100_000_000),
  scheduledPublishingEnabled: z.boolean().default(false),
  advancedContentSeoEnabled: z.boolean().default(false),
  storeBusterEnabled: z.boolean().default(false),
  storeBusterCampaignLimit: z.number().int().min(0).max(100_000).default(0),
  storeBusterMonthlyBudgetMinor: z.number().int().min(0).max(2_000_000_000).default(0),
  emailMarketingEnabled: z.boolean().default(false),
  emailSubscriberLimit: z.number().int().min(0).max(2_000_000_000).default(0),
  emailMonthlySendLimit: z.number().int().min(0).max(2_000_000_000).default(0),
  affiliateToolsEnabled: z.boolean().default(false)
}).strict().superRefine((entitlements, context) => {
  if (entitlements.storeBusterEnabled && entitlements.storeBusterCampaignLimit < 1) {
    context.addIssue({ code: 'custom', path: ['storeBusterCampaignLimit'], message: 'Store Buster requires at least one campaign slot.' });
  }
  if (entitlements.emailMarketingEnabled && (entitlements.emailSubscriberLimit < 1 || entitlements.emailMonthlySendLimit < 1)) {
    context.addIssue({ code: 'custom', path: ['emailMarketingEnabled'], message: 'Email marketing requires positive subscriber and monthly send limits.' });
  }
  if (entitlements.sellerManagedPaymentsEnabled && entitlements.paymentConnectors.length === 0) {
    context.addIssue({ code: 'custom', path: ['sellerManagedPaymentsEnabled'], message: 'Seller-managed payment accounts require at least one eligible payment connector.' });
  }
});

export type StorePlanEntitlements = z.infer<typeof storePlanEntitlementsSchema>;
export type StorePlanDb = typeof prisma | Prisma.TransactionClient;

export function sellerPayoutConnectorAllowed(type: string, entitlements: Pick<StorePlanEntitlements, 'sellerManagedPaymentsEnabled' | 'paymentConnectors'>) {
  const connector = type === 'STRIPE_CONNECT' ? StorePaymentConnector.STRIPE
    : type === 'PAYPAL_PAYOUTS' ? StorePaymentConnector.PAYPAL
      : null;
  if (!connector) return true;
  return entitlements.sellerManagedPaymentsEnabled && entitlements.paymentConnectors.includes(connector);
}

export function sellerOwnedConnectionsPlanBlock(
  pricing: Pick<PlanPricingRecord, 'monthlyPriceMinor' | 'annualPriceMinor' | 'introPriceMinor' | 'freeTrialDays'>,
  entitlements: Pick<StorePlanEntitlements, 'sellerManagedPaymentsEnabled' | 'sellerManagedCarrierAccountsEnabled'>
) {
  return isFreePlan(pricing) && (entitlements.sellerManagedPaymentsEnabled || entitlements.sellerManagedCarrierAccountsEnabled)
    ? 'Free plans must use marketplace-managed payment and shipping connections. Seller-owned connections require a paid plan.'
    : null;
}

export function dropshippingPlanBlock(
  pricing: Pick<PlanPricingRecord, 'monthlyPriceMinor' | 'annualPriceMinor' | 'introPriceMinor' | 'freeTrialDays'>,
  entitlements: Pick<StorePlanEntitlements, 'dropshippingEnabled'>
) {
  return entitlements.dropshippingEnabled && isFreePlan(pricing)
    ? 'Dropshipping integrations are available only on paid Store plans.'
    : null;
}

export const legacyCompatibleEntitlements: StorePlanEntitlements = {
  productLimit: 2_000_000_000,
  storeLimit: 1,
  vendorLimit: 1,
  staffSeatLimit: 2_000_000_000,
  allowedThemes: [StoreThemePreset.CLASSIC, StoreThemePreset.EDITORIAL, StoreThemePreset.BOUTIQUE],
  customDomainEligible: false,
  paymentConnectors: Object.values(StorePaymentConnector),
  sellerManagedPaymentsEnabled: false,
  sellerManagedCarrierAccountsEnabled: false,
  dropshippingEnabled: false,
  mobileTemplates: Object.values(MobileStorefrontTemplate),
  blogPostLimit: 2_000_000_000,
  contentPageLimit: 2_000_000_000,
  mediaStorageLimitBytes: 2_000_000_000,
  scheduledPublishingEnabled: true,
  advancedContentSeoEnabled: true,
  storeBusterEnabled: false,
  storeBusterCampaignLimit: 0,
  storeBusterMonthlyBudgetMinor: 0,
  emailMarketingEnabled: false,
  emailSubscriberLimit: 0,
  emailMonthlySendLimit: 0,
  affiliateToolsEnabled: false
};

/** The official platform Store is not a paid subscriber and is never billed. */
export const platformAdminEntitlements: StorePlanEntitlements = {
  ...legacyCompatibleEntitlements,
  productLimit: 2_000_000_000,
  storeLimit: 100_000,
  vendorLimit: 100_000,
  staffSeatLimit: 100_000,
  allowedThemes: Object.values(StoreThemePreset),
  customDomainEligible: true,
  paymentConnectors: Object.values(StorePaymentConnector),
  sellerManagedPaymentsEnabled: true,
  sellerManagedCarrierAccountsEnabled: true,
  dropshippingEnabled: true,
  mobileTemplates: Object.values(MobileStorefrontTemplate),
  blogPostLimit: 2_000_000_000,
  contentPageLimit: 2_000_000_000,
  mediaStorageLimitBytes: 2_000_000_000,
  scheduledPublishingEnabled: true,
  advancedContentSeoEnabled: true,
  storeBusterEnabled: true,
  storeBusterCampaignLimit: 100_000,
  storeBusterMonthlyBudgetMinor: 2_000_000_000,
  emailMarketingEnabled: true,
  emailSubscriberLimit: 2_000_000_000,
  emailMonthlySendLimit: 2_000_000_000,
  affiliateToolsEnabled: true
};

export async function effectiveStorePlan(db: StorePlanDb, storeId: string, now = new Date()) {
  const assignment = await db.storePlanAssignment.findFirst({
    where: {
      storeId,
      status: 'ACTIVE',
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }]
    },
    include: { planVersion: { include: { plan: true } } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }]
  });
  if (assignment) return { assignment, version: assignment.planVersion, plan: assignment.planVersion.plan, source: assignment.source };

  const legacy = await db.storePlanVersion.findFirst({
    where: { plan: { key: 'legacy-compatible' }, version: 1 },
    include: { plan: true }
  });
  if (legacy) return { assignment: null, version: legacy, plan: legacy.plan, source: 'LEGACY_FALLBACK' as const };
  return { assignment: null, version: null, plan: null, source: 'LEGACY_FALLBACK' as const };
}

export function asStorePlanEntitlements(version: {
  productLimit: number;
  storeLimit: number;
  vendorLimit: number;
  staffSeatLimit: number;
  allowedThemes: StoreThemePreset[];
  customDomainEligible: boolean;
  paymentConnectors: StorePaymentConnector[];
  sellerManagedPaymentsEnabled: boolean;
  sellerManagedCarrierAccountsEnabled: boolean;
  dropshippingEnabled: boolean;
  mobileTemplates: MobileStorefrontTemplate[];
  blogPostLimit: number;
  contentPageLimit: number;
  mediaStorageLimitBytes: number;
  scheduledPublishingEnabled: boolean;
  advancedContentSeoEnabled: boolean;
  storeBusterEnabled: boolean;
  storeBusterCampaignLimit: number;
  storeBusterMonthlyBudgetMinor: number;
  emailMarketingEnabled: boolean;
  emailSubscriberLimit: number;
  emailMonthlySendLimit: number;
  affiliateToolsEnabled: boolean;
} | null): StorePlanEntitlements {
  if (!version) return legacyCompatibleEntitlements;
  return {
    productLimit: version.productLimit,
    storeLimit: version.storeLimit,
    vendorLimit: version.vendorLimit,
    staffSeatLimit: version.staffSeatLimit,
    allowedThemes: version.allowedThemes,
    customDomainEligible: version.customDomainEligible,
    paymentConnectors: version.paymentConnectors,
    sellerManagedPaymentsEnabled: version.sellerManagedPaymentsEnabled,
    sellerManagedCarrierAccountsEnabled: version.sellerManagedCarrierAccountsEnabled,
    dropshippingEnabled: version.dropshippingEnabled,
    mobileTemplates: version.mobileTemplates,
    blogPostLimit: version.blogPostLimit,
    contentPageLimit: version.contentPageLimit,
    mediaStorageLimitBytes: version.mediaStorageLimitBytes,
    scheduledPublishingEnabled: version.scheduledPublishingEnabled,
    advancedContentSeoEnabled: version.advancedContentSeoEnabled,
    storeBusterEnabled: version.storeBusterEnabled,
    storeBusterCampaignLimit: version.storeBusterCampaignLimit,
    storeBusterMonthlyBudgetMinor: version.storeBusterMonthlyBudgetMinor,
    emailMarketingEnabled: version.emailMarketingEnabled,
    emailSubscriberLimit: version.emailSubscriberLimit,
    emailMonthlySendLimit: version.emailMonthlySendLimit,
    affiliateToolsEnabled: version.affiliateToolsEnabled
  };
}

type PlanEntitlementVersion = NonNullable<Parameters<typeof asStorePlanEntitlements>[0]>;

/** Gives the marked platform Store its no-subscription admin override; seller Stores remain plan-governed. */
export async function storeEntitlements(db: StorePlanDb, storeId: string, version?: PlanEntitlementVersion | null): Promise<StorePlanEntitlements> {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { isPlatformStore: true } });
  if (store?.isPlatformStore) return platformAdminEntitlements;
  if (version !== undefined) return asStorePlanEntitlements(version);
  return asStorePlanEntitlements((await effectiveStorePlan(db, storeId)).version);
}

export function isAtLimit(usage: number, limit: number) {
  return usage >= limit;
}
