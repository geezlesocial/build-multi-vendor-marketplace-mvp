import { describe, expect, it } from 'vitest';
import { calculateSponsoredClickSpend, calculateSponsoredViewSpend, convertQuotedMinorToBaseMinor, minorToDecimal } from './store-buster-sponsored-domain.js';

describe('sponsored placement prepaid spend guard', () => {
  it('debits exactly one click from available ad credit', () => {
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 100, storeSpentThisMonthMinor: 250, campaignBudgetMinor: 500, platformBudgetCapMinor: 800 })).toEqual({ amountMinor: 25, balanceAfterMinor: 975, campaignSpendAfterMinor: 125 });
  });

  it('stops at the smaller campaign/platform monthly cap', () => {
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 90, storeSpentThisMonthMinor: 0, campaignBudgetMinor: 100, platformBudgetCapMinor: 500 })).toBeNull();
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 90, campaignBudgetMinor: 500, platformBudgetCapMinor: 100 })).toBeNull();
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 75, campaignBudgetMinor: 500, platformBudgetCapMinor: 100 })?.campaignSpendAfterMinor).toBe(25);
  });

  it('does not let a click cross daily or lifetime campaign caps', () => {
    const base = { availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 0, campaignBudgetMinor: 500, platformBudgetCapMinor: 500 };
    expect(calculateSponsoredClickSpend({ ...base, campaignSpentTodayMinor: 90, campaignDailyBudgetMinor: 100 })).toBeNull();
    expect(calculateSponsoredClickSpend({ ...base, campaignSpentLifetimeMinor: 90, campaignLifetimeBudgetMinor: 100 })).toBeNull();
  });

  it('never spends below zero or accepts invalid prices and counters', () => {
    expect(calculateSponsoredClickSpend({ availableMinor: 24, clickPriceMinor: 25, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 0, campaignBudgetMinor: 100, platformBudgetCapMinor: 100 })).toBeNull();
    expect(calculateSponsoredClickSpend({ availableMinor: 100, clickPriceMinor: 0, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 0, campaignBudgetMinor: 100, platformBudgetCapMinor: 100 })).toBeNull();
    expect(calculateSponsoredClickSpend({ availableMinor: -1, clickPriceMinor: 1, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 0, campaignBudgetMinor: 100, platformBudgetCapMinor: 100 })).toBeNull();
  });
});

describe('PayPal minor-unit formatting', () => {
  it('uses the currency exponent without floating point conversion', () => {
    expect(minorToDecimal(12345, 2)).toBe('123.45');
    expect(minorToDecimal(12345, 0)).toBe('12345');
    expect(minorToDecimal(12345, 3)).toBe('12.345');
    expect(() => minorToDecimal(-1, 2)).toThrow();
  });
});

describe('CPV billing and ad-budget currency conversion', () => {
  it('charges the configured amount for each 100 verified views and carries fractional minor units', () => {
    expect(calculateSponsoredViewSpend({ availableMinor: 100, pricePer100ViewsMinor: 100, billingRemainder: 0, campaignSpendMinor: 0, dailySpendMinor: 0, storeMonthlySpendMinor: 0, campaignBudgetMinor: 1000, dailyBudgetMinor: 500, platformMonthlyBudgetMinor: 900 })).toEqual({ amountMinor: 1, remainderAfter: 0, balanceAfterMinor: 99, campaignSpendAfterMinor: 1 });
    const first = calculateSponsoredViewSpend({ availableMinor: 100, pricePer100ViewsMinor: 1, billingRemainder: 0, campaignSpendMinor: 0, dailySpendMinor: 0, storeMonthlySpendMinor: 0, campaignBudgetMinor: 10, dailyBudgetMinor: 10, platformMonthlyBudgetMinor: 10 });
    expect(first).toMatchObject({ amountMinor: 0, remainderAfter: 1, balanceAfterMinor: 100 });
    expect(calculateSponsoredViewSpend({ availableMinor: 100, pricePer100ViewsMinor: 1, billingRemainder: 99, campaignSpendMinor: 0, dailySpendMinor: 0, storeMonthlySpendMinor: 0, campaignBudgetMinor: 10, dailyBudgetMinor: 10, platformMonthlyBudgetMinor: 10 })).toMatchObject({ amountMinor: 1, remainderAfter: 0, balanceAfterMinor: 99 });
  });

  it('stops CPV serving before available credit or any campaign/day/month cap is exceeded', () => {
    const base = { availableMinor: 10, pricePer100ViewsMinor: 100, billingRemainder: 0, campaignSpendMinor: 0, campaignLifetimeSpendMinor: 0, campaignLifetimeBudgetMinor: 20, dailySpendMinor: 0, storeMonthlySpendMinor: 0, campaignBudgetMinor: 20, dailyBudgetMinor: 20, platformMonthlyBudgetMinor: 20 };
    expect(calculateSponsoredViewSpend({ ...base, availableMinor: 0 })).toBeNull();
    expect(calculateSponsoredViewSpend({ ...base, campaignSpendMinor: 20 })).toBeNull();
    expect(calculateSponsoredViewSpend({ ...base, campaignLifetimeSpendMinor: 20 })).toBeNull();
    expect(calculateSponsoredViewSpend({ ...base, campaignLifetimeSpendMinor: 19, campaignLifetimeBudgetMinor: 19 })).toBeNull();
    expect(calculateSponsoredViewSpend({ ...base, dailySpendMinor: 20 })).toBeNull();
    expect(calculateSponsoredViewSpend({ ...base, storeMonthlySpendMinor: 20 })).toBeNull();
  });

  it('converts selected-currency budgets back to the platform currency with exact minor-unit rounding', () => {
    expect(convertQuotedMinorToBaseMinor(10000n, '56.25', 2, 2)).toBe(178n); // PHP to USD, base USD -> quote PHP.
    expect(convertQuotedMinorToBaseMinor(1000n, '1.5', 2, 2)).toBe(667n);
    expect(convertQuotedMinorToBaseMinor(1000n, '1', 2, 0)).toBe(100000n);
  });
});
