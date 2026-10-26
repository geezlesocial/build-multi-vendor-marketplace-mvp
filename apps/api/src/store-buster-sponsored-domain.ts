import { parseRate } from './currency-domain.js';

export type SponsoredClickSpend = { balanceAfterMinor: number; campaignSpendAfterMinor: number; amountMinor: number };

/** Calculates a single-click debit without mutating state. Callers must re-check and
 * apply it while holding the store ad-account row lock. */
export function calculateSponsoredClickSpend(input: { availableMinor: number; clickPriceMinor: number; campaignSpentThisMonthMinor: number; campaignSpentTodayMinor?: number; campaignDailyBudgetMinor?: number; campaignSpentLifetimeMinor?: number; campaignLifetimeBudgetMinor?: number; storeSpentThisMonthMinor: number; campaignBudgetMinor: number; platformBudgetCapMinor: number }): SponsoredClickSpend | null {
  const values = [input.availableMinor, input.clickPriceMinor, input.campaignSpentThisMonthMinor, input.campaignSpentTodayMinor ?? 0, input.campaignDailyBudgetMinor ?? 0, input.campaignSpentLifetimeMinor ?? 0, input.campaignLifetimeBudgetMinor ?? 0, input.storeSpentThisMonthMinor, input.campaignBudgetMinor, input.platformBudgetCapMinor];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || input.clickPriceMinor === 0) return null;
  if (input.campaignDailyBudgetMinor != null && (input.campaignSpentTodayMinor ?? 0) + input.clickPriceMinor > input.campaignDailyBudgetMinor) return null;
  if (input.campaignLifetimeBudgetMinor != null && (input.campaignSpentLifetimeMinor ?? 0) + input.clickPriceMinor > input.campaignLifetimeBudgetMinor) return null;
  if (input.availableMinor < input.clickPriceMinor || input.campaignSpentThisMonthMinor + input.clickPriceMinor > input.campaignBudgetMinor || input.storeSpentThisMonthMinor + input.clickPriceMinor > input.platformBudgetCapMinor) return null;
  return { balanceAfterMinor: input.availableMinor - input.clickPriceMinor, campaignSpendAfterMinor: input.campaignSpentThisMonthMinor + input.clickPriceMinor, amountMinor: input.clickPriceMinor };
}

/** Converts an amount in the quote currency back to the base currency using a
 * fresh base-to-quote rate. Rounds half up in base minor units. */
export function convertQuotedMinorToBaseMinor(amountQuoteMinor: bigint, baseToQuoteRate: string, baseExponent: number, quoteExponent: number) {
  if (amountQuoteMinor < 0n) throw new Error('Amount cannot be negative.');
  if (![baseExponent, quoteExponent].every(value => Number.isInteger(value) && value >= 0 && value <= 4)) throw new Error('Unsupported currency exponent.');
  const rate = parseRate(baseToQuoteRate);
  const numerator = amountQuoteMinor * rate.denominator * (10n ** BigInt(baseExponent));
  const denominator = rate.numerator * (10n ** BigInt(quoteExponent));
  return (numerator * 2n + denominator) / (2n * denominator);
}

export type SponsoredViewSpend = { amountMinor: number; remainderAfter: number; balanceAfterMinor: number; campaignSpendAfterMinor: number };

/** Applies a view-rate in minor units per 100 qualified, visible ad views. The
 * remainder makes rates below one minor unit per view accurate across requests. */
export function calculateSponsoredViewSpend(input: {
  availableMinor: number;
  pricePer100ViewsMinor: number;
  billingRemainder: number;
  campaignSpendMinor: number;
  dailySpendMinor: number;
  storeMonthlySpendMinor: number;
  campaignBudgetMinor: number;
  campaignLifetimeSpendMinor?: number;
  campaignLifetimeBudgetMinor?: number;
  dailyBudgetMinor: number;
  platformMonthlyBudgetMinor: number;
}) : SponsoredViewSpend | null {
  const values = [input.availableMinor, input.pricePer100ViewsMinor, input.billingRemainder, input.campaignSpendMinor, input.campaignLifetimeSpendMinor ?? 0, input.campaignLifetimeBudgetMinor ?? 0, input.dailySpendMinor, input.storeMonthlySpendMinor, input.campaignBudgetMinor, input.dailyBudgetMinor, input.platformMonthlyBudgetMinor];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || input.pricePer100ViewsMinor === 0 || input.billingRemainder > 99) return null;
  if (input.campaignSpendMinor >= input.campaignBudgetMinor || input.dailySpendMinor >= input.dailyBudgetMinor || input.storeMonthlySpendMinor >= input.platformMonthlyBudgetMinor) return null;
  const numerator = input.billingRemainder + input.pricePer100ViewsMinor;
  const amountMinor = Math.floor(numerator / 100);
  if (amountMinor > input.availableMinor || input.campaignSpendMinor + amountMinor > input.campaignBudgetMinor || input.dailySpendMinor + amountMinor > input.dailyBudgetMinor || input.storeMonthlySpendMinor + amountMinor > input.platformMonthlyBudgetMinor) return null;
  if (input.campaignLifetimeBudgetMinor != null && (input.campaignLifetimeSpendMinor ?? 0) + amountMinor > input.campaignLifetimeBudgetMinor) return null;
  return { amountMinor, remainderAfter: numerator % 100, balanceAfterMinor: input.availableMinor - amountMinor, campaignSpendAfterMinor: input.campaignSpendMinor + amountMinor };
}

export function minorToDecimal(amountMinor: number, exponent: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new Error('Invalid minor-unit amount or currency exponent.');
  const scale = 10 ** exponent;
  const whole = Math.floor(amountMinor / scale);
  if (!exponent) return String(whole);
  return `${whole}.${String(amountMinor % scale).padStart(exponent, '0')}`;
}
