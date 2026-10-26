import { describe, expect, it } from 'vitest';
import { codCheckoutEligibilityFailure, exceedsCodOrderLimit } from './cod-policy.js';

describe('cash-on-delivery checkout policy', () => {
  it('requires physical seller items and one covered shipment per seller', () => {
    expect(codCheckoutEligibilityFailure([{ requiresShipping: true, sellerId: 'seller-a' }], [{ supportsCod: true }])).toBeNull();
    expect(codCheckoutEligibilityFailure([{ requiresShipping: false, sellerId: 'seller-a' }], [{ supportsCod: true }])).toMatch(/physical items/i);
    expect(codCheckoutEligibilityFailure([{ requiresShipping: true, sellerId: null }], [{ supportsCod: true }])).toMatch(/physical items/i);
    expect(codCheckoutEligibilityFailure([{ requiresShipping: true, sellerId: 'seller-a' }], [])).toMatch(/every seller/i);
    expect(codCheckoutEligibilityFailure([{ requiresShipping: true, sellerId: 'seller-a' }, { requiresShipping: true, sellerId: 'seller-b' }], [{ supportsCod: true }])).toMatch(/every seller/i);
  });

  it('requires COD acceptance from every selected service', () => {
    expect(codCheckoutEligibilityFailure([{ requiresShipping: true, sellerId: 'a' }, { requiresShipping: true, sellerId: 'b' }], [{ supportsCod: true }, { supportsCod: false }])).toMatch(/accept cash on delivery/i);
  });

  it('allows totals at the configured maximum, rejects greater totals, and treats null as uncapped', () => {
    expect(exceedsCodOrderLimit(5000, 5000)).toBe(false);
    expect(exceedsCodOrderLimit(5001, 5000)).toBe(true);
    expect(exceedsCodOrderLimit(50_000, null)).toBe(false);
  });
});
