import { describe, expect, it } from 'vitest';
import { annualPriceFromDiscount, canTransitionSubscription, formatMinorAmount, isFreePlan, parseMinorAmount, planPricingInputSchema, resolvePlanPricing } from './store-plan-pricing.js';

describe('Store plan price validation and integer money', () => {
  it('parses and formats decimal amounts without floating-point arithmetic', () => {
    expect(parseMinorAmount('0.01')).toBe(1);
    expect(parseMinorAmount('125.9')).toBe(12590);
    expect(formatMinorAmount(12590)).toBe('125.90');
    expect(() => parseMinorAmount('1.009')).toThrow();
    expect(() => parseMinorAmount('20000001.00')).toThrow();
  });

  it('calculates annual totals and savings using integer minor units', () => {
    expect(annualPriceFromDiscount(2000, 10)).toBe(21600);
    expect(2000 * 12 - annualPriceFromDiscount(2000, 10)).toBe(2400);
    const pricing = resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '20.00', annualPriceMode: 'DISCOUNT', annualDiscountPercent: 10 }));
    expect(pricing).toMatchObject({ monthlyPriceMinor: 2000, annualPriceMinor: 21600, annualDiscountPercent: 10 });
  });

  it('supports a free trial and a paid intro as distinct sequential terms', () => {
    const pricing = resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '20.00', freeTrialDays: 14, introPrice: '1.00', introDurationDays: 30 }));
    expect(pricing).toMatchObject({ monthlyPriceMinor: 2000, freeTrialDays: 14, introPriceMinor: 100, introDurationDays: 30 });
    expect(isFreePlan(pricing)).toBe(false);
    expect(() => resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '20.00', introPrice: '0.00', introDurationDays: 30 }))).toThrow(/must be paid/i);
    expect(() => resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '0.00', freeTrialDays: 14 }))).toThrow(/requires a paid recurring plan/i);
    expect(() => resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '20.00', introPrice: '21.00', introDurationDays: 30 }))).toThrow(/below the normal monthly price/i);
  });

  it('accepts free legacy terms and rejects invalid currencies, bounds, date ranges, and price combinations', () => {
    const free = resolvePlanPricing(planPricingInputSchema.parse({}));
    expect(isFreePlan(free)).toBe(true);
    expect(planPricingInputSchema.safeParse({ currency: 'XYZ' }).success).toBe(false);
    expect(planPricingInputSchema.safeParse({ annualPriceMode: 'DISCOUNT', annualDiscountPercent: 95 }).success).toBe(false);
    expect(planPricingInputSchema.safeParse({ freeTrialDays: 91 }).success).toBe(false);
    expect(planPricingInputSchema.safeParse({ effectiveFrom: '2026-10-22T00:00:00Z', effectiveUntil: '2026-10-21T00:00:00Z' }).success).toBe(false);
    expect(() => resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '20.00', annualPriceMode: 'FIXED', annualPrice: '250.00' }))).toThrow(/cannot exceed twelve monthly payments/i);
    expect(() => resolvePlanPricing(planPricingInputSchema.parse({ monthlyPrice: '0.00', annualPriceMode: 'DISCOUNT', annualDiscountPercent: 10 }))).toThrow(/free plan/i);
  });
});

describe('Store subscription state transitions', () => {
  it('allows only explicit lifecycle moves and prevents resurrection of terminal states', () => {
    expect(canTransitionSubscription('PENDING', 'ACTIVE')).toBe(true);
    expect(canTransitionSubscription('TRIALING', 'ACTIVE')).toBe(true);
    expect(canTransitionSubscription('ACTIVE', 'PAST_DUE')).toBe(true);
    expect(canTransitionSubscription('PAST_DUE', 'ACTIVE')).toBe(true);
    expect(canTransitionSubscription('CANCELLED', 'ACTIVE')).toBe(false);
    expect(canTransitionSubscription('EXPIRED', 'ACTIVE')).toBe(false);
  });
});
