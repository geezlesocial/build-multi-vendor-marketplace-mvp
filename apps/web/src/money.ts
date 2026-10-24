/** Format integer ISO-4217 minor units using the currency's own exponent. */
export function formatMinor(minor: number, currency = 'USD', locale?: string) {
  if (!Number.isSafeInteger(minor)) throw new Error('Money must be an integer number of minor units.');
  const exponent = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / (10 ** exponent));
}
