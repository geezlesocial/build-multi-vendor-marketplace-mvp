import { describe, expect, it, vi } from 'vitest';
import { StorePaymentConnector, StoreThemePreset } from '@prisma/client';
import { dropshippingPlanBlock, legacyCompatibleEntitlements, platformAdminEntitlements, isAtLimit, sellerOwnedConnectionsPlanBlock, sellerPayoutConnectorAllowed, storeEntitlements, storePlanEntitlementsSchema, type StorePlanDb } from './store-plan-domain.js';

describe('Store plan entitlements', () => {
  it('validates independent product, Store, vendor, and staff-seat limits', () => {
    const entitlements = storePlanEntitlementsSchema.parse({
      productLimit: 8,
      storeLimit: 1,
      vendorLimit: 1,
      staffSeatLimit: 3,
      allowedThemes: ['CLASSIC', 'EDITORIAL'],
      customDomainEligible: false,
      paymentConnectors: ['STRIPE'],
      sellerManagedPaymentsEnabled: true,
      mobileTemplates: ['RESPONSIVE_STANDARD', 'MOBILE_COMPACT']
    });
    expect(entitlements.storeLimit).toBe(1);
    expect(entitlements.vendorLimit).toBe(1);
    expect(entitlements.staffSeatLimit).toBe(3);
    expect(entitlements.sellerManagedPaymentsEnabled).toBe(true);
    expect(entitlements.dropshippingEnabled).toBe(false);
  });

  it('rejects invalid, empty, and duplicated capability lists and unusable owner limits', () => {
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, productLimit: 0 })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, storeLimit: 0 })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, vendorLimit: 0 })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, allowedThemes: [] })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, allowedThemes: ['CLASSIC', 'CLASSIC'] })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, mobileTemplates: ['UNKNOWN'] })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, extraHtml: '<script />' })).toThrow();
  });

  it('keeps the compatibility plan generous while distinguishing fixed owner counts from staff seats', () => {
    expect(legacyCompatibleEntitlements.productLimit).toBeGreaterThan(1_000_000);
    expect(legacyCompatibleEntitlements.storeLimit).toBe(1);
    expect(legacyCompatibleEntitlements.vendorLimit).toBe(1);
    expect(legacyCompatibleEntitlements.staffSeatLimit).toBeGreaterThan(1_000_000);
    expect(legacyCompatibleEntitlements.customDomainEligible).toBe(false);
    expect(legacyCompatibleEntitlements.allowedThemes).toEqual(['CLASSIC', 'EDITORIAL', 'BOUTIQUE']);
    expect(storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, staffSeatLimit: 100_000, allowedThemes: ['CLASSIC', 'EDITORIAL', 'BOUTIQUE', 'TECH_ELECTRONICS', 'GROCERIES', 'ECOMMERCE_MARKETPLACE'] }).allowedThemes).toHaveLength(6);
    expect(legacyCompatibleEntitlements.sellerManagedPaymentsEnabled).toBe(false);
    expect(legacyCompatibleEntitlements.sellerManagedCarrierAccountsEnabled).toBe(false);
    expect(legacyCompatibleEntitlements.dropshippingEnabled).toBe(false);
    expect(legacyCompatibleEntitlements.blogPostLimit).toBeGreaterThan(1_000_000);
    expect(legacyCompatibleEntitlements.contentPageLimit).toBeGreaterThan(1_000_000);
    expect(legacyCompatibleEntitlements.mediaStorageLimitBytes).toBeGreaterThan(1_000_000);
    expect(legacyCompatibleEntitlements.storeBusterEnabled).toBe(false);
    expect(legacyCompatibleEntitlements.emailMarketingEnabled).toBe(false);
    expect(legacyCompatibleEntitlements.affiliateToolsEnabled).toBe(false);
  });

  it('grants the official platform Store every premium entitlement without plan billing', () => {
    expect(platformAdminEntitlements.productLimit).toBe(2_000_000_000);
    expect(platformAdminEntitlements.customDomainEligible).toBe(true);
    expect(platformAdminEntitlements.sellerManagedPaymentsEnabled).toBe(true);
    expect(platformAdminEntitlements.sellerManagedCarrierAccountsEnabled).toBe(true);
    expect(platformAdminEntitlements.dropshippingEnabled).toBe(true);
    expect(platformAdminEntitlements.allowedThemes).toEqual(Object.values(StoreThemePreset));
    expect(platformAdminEntitlements.scheduledPublishingEnabled).toBe(true);
    expect(platformAdminEntitlements.advancedContentSeoEnabled).toBe(true);
    expect(platformAdminEntitlements.storeBusterEnabled).toBe(true);
    expect(platformAdminEntitlements.emailMarketingEnabled).toBe(true);
    expect(platformAdminEntitlements.affiliateToolsEnabled).toBe(true);
  });

  it('applies the admin override only when the Store is explicitly marked official', async () => {
    const officialDb = { store: { findUnique: vi.fn().mockResolvedValue({ isPlatformStore: true }) } } as unknown as StorePlanDb;
    const sellerDb = { store: { findUnique: vi.fn().mockResolvedValue({ isPlatformStore: false }) } } as unknown as StorePlanDb;
    await expect(storeEntitlements(officialDb, 'official-id', legacyCompatibleEntitlements)).resolves.toEqual(platformAdminEntitlements);
    await expect(storeEntitlements(sellerDb, 'seller-id', legacyCompatibleEntitlements)).resolves.toEqual(legacyCompatibleEntitlements);
  });

  it('keeps basic blog and page publishing outside paid-only entitlements', () => {
    const parsed = storePlanEntitlementsSchema.parse({
      ...legacyCompatibleEntitlements,
      staffSeatLimit: 100_000,
      blogPostLimit: 3,
      contentPageLimit: 2,
      scheduledPublishingEnabled: false
    });
    expect(parsed.blogPostLimit).toBe(3);
    expect(parsed.contentPageLimit).toBe(2);
    expect(parsed.scheduledPublishingEnabled).toBe(false);
  });

  it('requires explicit positive quotas when plan-controlled growth tools are enabled', () => {
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, storeBusterEnabled: true })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, emailMarketingEnabled: true })).toThrow();
    expect(() => storePlanEntitlementsSchema.parse({ ...legacyCompatibleEntitlements, sellerManagedPaymentsEnabled: true, paymentConnectors: [] })).toThrow();
    expect(storePlanEntitlementsSchema.parse({
      ...legacyCompatibleEntitlements,
      staffSeatLimit: 100_000,
      storeBusterEnabled: true,
      storeBusterCampaignLimit: 2,
      storeBusterMonthlyBudgetMinor: 2500,
      emailMarketingEnabled: true,
      emailSubscriberLimit: 500,
      emailMonthlySendLimit: 2000
    }).storeBusterCampaignLimit).toBe(2);
  });

  it('keeps free plans marketplace-managed while allowing paid plans to opt into seller-owned accounts', () => {
    const freePrice = { monthlyPriceMinor: 0, annualPriceMinor: 0, introPriceMinor: null, freeTrialDays: 0 };
    const paidPrice = { ...freePrice, monthlyPriceMinor: 1000 };
    expect(sellerOwnedConnectionsPlanBlock(freePrice, { sellerManagedPaymentsEnabled: true, sellerManagedCarrierAccountsEnabled: false })).toMatch(/Free plans/);
    expect(sellerOwnedConnectionsPlanBlock(freePrice, { sellerManagedPaymentsEnabled: false, sellerManagedCarrierAccountsEnabled: true })).toMatch(/Free plans/);
    expect(sellerOwnedConnectionsPlanBlock(paidPrice, { sellerManagedPaymentsEnabled: true, sellerManagedCarrierAccountsEnabled: true })).toBeNull();
  });

  it('restricts dropshipping entitlement to paid Store plans', () => {
    const freePrice = { monthlyPriceMinor: 0, annualPriceMinor: 0, introPriceMinor: null, freeTrialDays: 0 };
    const paidPrice = { ...freePrice, annualPriceMinor: 1000 };
    expect(dropshippingPlanBlock(freePrice, { dropshippingEnabled: true })).toMatch(/only on paid Store plans/);
    expect(dropshippingPlanBlock(freePrice, { dropshippingEnabled: false })).toBeNull();
    expect(dropshippingPlanBlock(paidPrice, { dropshippingEnabled: true })).toBeNull();
  });

  it('enforces seller-owned payout connector entitlements while preserving manual payout options', () => {
    expect(sellerPayoutConnectorAllowed('STRIPE_CONNECT', legacyCompatibleEntitlements)).toBe(false);
    expect(sellerPayoutConnectorAllowed('PAYPAL_PAYOUTS', legacyCompatibleEntitlements)).toBe(false);
    const paid = { ...legacyCompatibleEntitlements, sellerManagedPaymentsEnabled: true, paymentConnectors: [StorePaymentConnector.STRIPE] };
    expect(sellerPayoutConnectorAllowed('STRIPE_CONNECT', paid)).toBe(true);
    expect(sellerPayoutConnectorAllowed('PAYPAL_PAYOUTS', paid)).toBe(false);
    expect(sellerPayoutConnectorAllowed('MANUAL_BANK', legacyCompatibleEntitlements)).toBe(true);
  });

  it('detects the exact quota boundary without off-by-one errors', () => {
    expect(isAtLimit(0, 1)).toBe(false);
    expect(isAtLimit(1, 1)).toBe(true);
    expect(isAtLimit(7, 8)).toBe(false);
    expect(isAtLimit(8, 8)).toBe(true);
  });
});
