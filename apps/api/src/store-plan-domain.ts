import { MobileStorefrontTemplate, StorePaymentConnector, StoreThemePreset, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './security.js';

export const storePlanEntitlementsSchema = z.object({
  productLimit: z.number().int().min(1).max(2_000_000_000),
  storeLimit: z.number().int().min(1).max(100_000),
  vendorLimit: z.number().int().min(1).max(100_000),
  staffSeatLimit: z.number().int().min(0).max(100_000),
  allowedThemes: z.array(z.nativeEnum(StoreThemePreset)).min(1).max(3).refine(values => new Set(values).size === values.length, 'Themes must not contain duplicates'),
  customDomainEligible: z.boolean(),
  paymentConnectors: z.array(z.nativeEnum(StorePaymentConnector)).max(2).refine(values => new Set(values).size === values.length, 'Connectors must not contain duplicates'),
  mobileTemplates: z.array(z.nativeEnum(MobileStorefrontTemplate)).min(1).max(3).refine(values => new Set(values).size === values.length, 'Templates must not contain duplicates')
}).strict();

export type StorePlanEntitlements = z.infer<typeof storePlanEntitlementsSchema>;
export type StorePlanDb = typeof prisma | Prisma.TransactionClient;

export const legacyCompatibleEntitlements: StorePlanEntitlements = {
  productLimit: 2_000_000_000,
  storeLimit: 1,
  vendorLimit: 1,
  staffSeatLimit: 2_000_000_000,
  allowedThemes: Object.values(StoreThemePreset),
  customDomainEligible: false,
  paymentConnectors: Object.values(StorePaymentConnector),
  mobileTemplates: Object.values(MobileStorefrontTemplate)
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
  mobileTemplates: MobileStorefrontTemplate[];
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
    mobileTemplates: version.mobileTemplates
  };
}

export function isAtLimit(usage: number, limit: number) {
  return usage >= limit;
}
