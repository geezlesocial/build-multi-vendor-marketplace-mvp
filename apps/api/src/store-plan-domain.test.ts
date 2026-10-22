import { describe, expect, it } from 'vitest';
import { legacyCompatibleEntitlements, isAtLimit, storePlanEntitlementsSchema } from './store-plan-domain.js';

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
      mobileTemplates: ['RESPONSIVE_STANDARD', 'MOBILE_COMPACT']
    });
    expect(entitlements.storeLimit).toBe(1);
    expect(entitlements.vendorLimit).toBe(1);
    expect(entitlements.staffSeatLimit).toBe(3);
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
  });

  it('detects the exact quota boundary without off-by-one errors', () => {
    expect(isAtLimit(0, 1)).toBe(false);
    expect(isAtLimit(1, 1)).toBe(true);
    expect(isAtLimit(7, 8)).toBe(false);
    expect(isAtLimit(8, 8)).toBe(true);
  });
});
