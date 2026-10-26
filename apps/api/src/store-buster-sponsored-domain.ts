export type SponsoredClickSpend = { balanceAfterMinor: number; campaignSpendAfterMinor: number; amountMinor: number };

/** Calculates a single-click debit without mutating state. Callers must re-check and
 * apply it while holding the store ad-account row lock. */
export function calculateSponsoredClickSpend(input: { availableMinor: number; clickPriceMinor: number; campaignSpentThisMonthMinor: number; storeSpentThisMonthMinor: number; campaignBudgetMinor: number; platformBudgetCapMinor: number }): SponsoredClickSpend | null {
  const values = [input.availableMinor, input.clickPriceMinor, input.campaignSpentThisMonthMinor, input.storeSpentThisMonthMinor, input.campaignBudgetMinor, input.platformBudgetCapMinor];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || input.clickPriceMinor === 0) return null;
  if (input.availableMinor < input.clickPriceMinor || input.campaignSpentThisMonthMinor + input.clickPriceMinor > input.campaignBudgetMinor || input.storeSpentThisMonthMinor + input.clickPriceMinor > input.platformBudgetCapMinor) return null;
  return { balanceAfterMinor: input.availableMinor - input.clickPriceMinor, campaignSpendAfterMinor: input.campaignSpentThisMonthMinor + input.clickPriceMinor, amountMinor: input.clickPriceMinor };
}

export function minorToDecimal(amountMinor: number, exponent: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new Error('Invalid minor-unit amount or currency exponent.');
  const scale = 10 ** exponent;
  const whole = Math.floor(amountMinor / scale);
  if (!exponent) return String(whole);
  return `${whole}.${String(amountMinor % scale).padStart(exponent, '0')}`;
}
