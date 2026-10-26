import { describe, expect, it } from 'vitest';
import { calculateSponsoredClickSpend, minorToDecimal } from './store-buster-sponsored-domain.js';

describe('sponsored placement prepaid spend guard', () => {
  it('debits exactly one click from available ad credit', () => {
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 100, storeSpentThisMonthMinor: 250, campaignBudgetMinor: 500, platformBudgetCapMinor: 800 })).toEqual({ amountMinor: 25, balanceAfterMinor: 975, campaignSpendAfterMinor: 125 });
  });

  it('stops at the smaller campaign/platform monthly cap', () => {
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 90, storeSpentThisMonthMinor: 0, campaignBudgetMinor: 100, platformBudgetCapMinor: 500 })).toBeNull();
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 90, campaignBudgetMinor: 500, platformBudgetCapMinor: 100 })).toBeNull();
    expect(calculateSponsoredClickSpend({ availableMinor: 1000, clickPriceMinor: 25, campaignSpentThisMonthMinor: 0, storeSpentThisMonthMinor: 75, campaignBudgetMinor: 500, platformBudgetCapMinor: 100 })?.campaignSpendAfterMinor).toBe(25);
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
