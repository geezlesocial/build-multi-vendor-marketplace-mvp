import { describe, expect, it } from 'vitest';
import { freeStoreCommissionApplies } from './seller-commission-policy-domain.js';
import { planPricingInputSchema, resolvePlanPricing } from './store-plan-pricing.js';

describe('free-Store commission eligibility', () => {
  const freePlan = resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '0.00' }));
  const paidPlan = resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '20.00' }));

  it('applies only to non-platform Stores on a free plan', () => {
    expect(freeStoreCommissionApplies(false, freePlan)).toBe(true);
    expect(freeStoreCommissionApplies(false, paidPlan)).toBe(false);
    expect(freeStoreCommissionApplies(true, freePlan)).toBe(false);
    expect(freeStoreCommissionApplies(false, null)).toBe(false);
  });
});
