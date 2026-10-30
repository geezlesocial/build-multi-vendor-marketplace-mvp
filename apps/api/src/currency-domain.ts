export type CurrencyMetadata = {
  code: string;
  numericCode: string;
  name: string;
  symbol: string;
  minorUnitExponent: number;
  region: string;
};

// Metadata is seeded by migration 28; this list documents the initially supported ISO catalog.
export const INITIAL_CURRENCY_CODES = [
  'USD', 'PHP', 'JPY', 'CNY', 'SGD', 'MYR', 'THB', 'IDR', 'VND', 'INR', 'KRW', 'BDT', 'PKR', 'LKR',
  'EUR', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY',
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'ILS',
  'ZAR', 'NGN', 'KES', 'GHS', 'EGP', 'MAD', 'TZS', 'UGX', 'RWF', 'XOF', 'XAF'
] as const;

export const RATE_FRESH_FOR_MS = 72 * 60 * 60 * 1000;
const RATE_MAX = 1_000_000_000_000n;

export function parseRate(value: string | number | bigint) {
  const input = String(value);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/.test(input)) throw new Error('Rate must be a positive decimal with at most 12 fractional places.');
  const [whole, fraction = ''] = input.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole!) * denominator + BigInt(fraction || '0');
  if (numerator <= 0n || numerator > RATE_MAX * denominator) throw new Error('Rate is outside the supported positive range.');
  return { numerator, denominator, decimal: input };
}

/** Derive a reference cross-rate where both legs are quoted against USD. */
export function deriveUsdPivotRate(baseUsdRate: string, quoteUsdRate: string) {
  const base = parseRate(baseUsdRate);
  const quote = parseRate(quoteUsdRate);
  const scale = 1_000_000_000_000n;
  const numerator = quote.numerator * base.denominator * scale;
  const denominator = quote.denominator * base.numerator;
  const scaled = (numerator * 2n + denominator) / (2n * denominator);
  if (scaled <= 0n) throw new Error('Derived reference rate is outside the supported precision.');
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(12, '0').replace(/0+$/, '');
  const result = fraction ? `${whole}.${fraction}` : whole.toString();
  parseRate(result);
  return result;
}

export function convertMinorExact(amountMinor: bigint, rateValue: string, baseExponent: number, quoteExponent: number) {
  if (amountMinor < 0n) throw new Error('Amount cannot be negative.');
  if (!Number.isInteger(baseExponent) || baseExponent < 0 || baseExponent > 4 || !Number.isInteger(quoteExponent) || quoteExponent < 0 || quoteExponent > 4) {
    throw new Error('Unsupported currency exponent.');
  }
  const rate = parseRate(rateValue);
  const numerator = amountMinor * rate.numerator * (10n ** BigInt(quoteExponent));
  const denominator = rate.denominator * (10n ** BigInt(baseExponent));
  // Round half up in minor units; all supported monetary amounts here are non-negative.
  return (numerator * 2n + denominator) / (2n * denominator);
}

export function isRateFresh(fetchedAt: Date, now = new Date(), maxAgeMs = RATE_FRESH_FOR_MS, sourceObservedAt?: Date) {
  const age = now.getTime() - fetchedAt.getTime();
  if (age < 0 || age > maxAgeMs) return false;
  if (sourceObservedAt) {
    const sourceAge = now.getTime() - sourceObservedAt.getTime();
    if (sourceAge < 0 || sourceAge > maxAgeMs) return false;
  }
  return true;
}

export function decimalToMinorExact(value: string, exponent: number) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4 || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(value)) throw new Error('Provider amount is not a valid decimal amount.');
  const [whole, fractional = ''] = value.split('.');
  const precision = fractional.slice(exponent);
  if (/[1-9]/.test(precision)) throw new Error('Provider amount has unsupported fractional precision.');
  const minor = BigInt(whole!) * 10n ** BigInt(exponent) + BigInt(fractional.slice(0, exponent).padEnd(exponent, '0') || '0');
  if (minor > 2_147_483_647n) throw new Error('Provider amount exceeds supported integer minor units.');
  return Number(minor);
}

export type ReferenceRate = { base: string; quote: string; rate: string; sourceDate: string };
export interface ReferenceRateProvider {
  readonly provider: string;
  fetchRates(base: string, quotes: string[]): Promise<ReferenceRate[]>;
}

export class ReferenceRateFetchError extends Error {
  constructor(readonly statusCode: number) {
    super(`Reference-rate source returned HTTP ${statusCode}.`);
    this.name = 'ReferenceRateFetchError';
  }
}

export class FrankfurterRateAdapter implements ReferenceRateProvider {
  readonly provider = 'frankfurter';
  constructor(private readonly endpoint = 'https://api.frankfurter.dev/v2', private readonly fetcher: typeof fetch = fetch) {}

  async fetchRates(base: string, quotes: string[]): Promise<ReferenceRate[]> {
    if (!/^[A-Z]{3}$/.test(base) || quotes.some(code => !/^[A-Z]{3}$/.test(code))) throw new Error('Invalid currency code.');
    if (!quotes.length) return [];
    const url = new URL('rates', `${this.endpoint.replace(/\/$/, '')}/`);
    url.searchParams.set('base', base);
    url.searchParams.set('quotes', [...new Set(quotes)].filter(code => code !== base).join(','));
    const response = await this.fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new ReferenceRateFetchError(response.status);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('Reference-rate source returned an invalid response.');
    return payload.map(row => {
      if (!row || typeof row !== 'object') throw new Error('Reference-rate source returned an invalid rate row.');
      const record = row as Record<string, unknown>;
      const rowBase = String(record.base ?? base).toUpperCase();
      const quote = String(record.quote ?? '').toUpperCase();
      const rate = String(record.rate ?? '');
      const sourceDate = String(record.date ?? '');
      parseRate(rate);
      const observed = /^\d{4}-\d{2}-\d{2}$/.test(sourceDate) ? new Date(`${sourceDate}T00:00:00.000Z`) : new Date(Number.NaN);
      if (rowBase !== base || !quotes.includes(quote) || Number.isNaN(observed.getTime()) || observed.toISOString().slice(0, 10) !== sourceDate) throw new Error('Reference-rate source returned an unsupported currency pair or observation date.');
      return { base: rowBase, quote, rate, sourceDate };
    });
  }
}

/** Keep one provider-unsupported pair from blocking every other catalog rate. */
export async function fetchReferenceRatesWithUnsupportedFallback(provider: ReferenceRateProvider, base: string, quotes: string[]) {
  const requested = [...new Set(quotes)].filter(code => code !== base);
  const fetchBatch = async (batch: string[]): Promise<{ rates: ReferenceRate[]; unavailableCurrencies: string[] }> => {
    if (!batch.length) return { rates: [], unavailableCurrencies: [] };
    try {
      const rates = await provider.fetchRates(base, batch);
      const returned = new Set(rates.map(rate => rate.quote));
      return { rates, unavailableCurrencies: batch.filter(code => !returned.has(code)) };
    } catch (error) {
      if (!(error instanceof ReferenceRateFetchError) || error.statusCode !== 422) throw error;
      if (batch.length === 1) return { rates: [], unavailableCurrencies: batch };
      const middle = Math.ceil(batch.length / 2);
      const [left, right] = await Promise.all([fetchBatch(batch.slice(0, middle)), fetchBatch(batch.slice(middle))]);
      return { rates: [...left.rates, ...right.rates], unavailableCurrencies: [...left.unavailableCurrencies, ...right.unavailableCurrencies] };
    }
  };
  return { requested: requested.length, ...(await fetchBatch(requested)) };
}

export type CommissionTerms = {
  type: 'ZERO' | 'FIXED_PER_ORDER' | 'PERCENTAGE' | 'PERCENTAGE_PLUS_FIXED';
  fixedMinor: number | null;
  basisPoints: number | null;
  minimumMinor: number | null;
  capMinor: number | null;
};

export function calculateCommissionMinor(terms: CommissionTerms, eligibleBaseMinor: number) {
  if (!Number.isSafeInteger(eligibleBaseMinor) || eligibleBaseMinor < 0) throw new Error('Commission base must be a non-negative integer minor amount.');
  let amount: bigint;
  const base = BigInt(eligibleBaseMinor);
  const fixed = BigInt(terms.fixedMinor ?? 0);
  const bps = BigInt(terms.basisPoints ?? 0);
  if (bps < 0n || bps > 10_000n || fixed < 0n) throw new Error('Invalid commission terms.');
  amount = (base * bps * 2n + 10_000n) / 20_000n + fixed;
  if (terms.type === 'ZERO') return 0;
  if (terms.minimumMinor != null) amount = amount < BigInt(terms.minimumMinor) ? BigInt(terms.minimumMinor) : amount;
  if (terms.capMinor != null) amount = amount > BigInt(terms.capMinor) ? BigInt(terms.capMinor) : amount;
  if (amount > base) amount = base;
  if (amount > 2_147_483_647n) throw new Error('Commission exceeds the supported integer range.');
  return Number(amount);
}

export function allocateCommission(totalMinor: number, items: { id: string; eligibleBaseMinor: number }[]) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error('Commission must be a non-negative integer.');
  const baseTotal = items.reduce((sum, item) => sum + item.eligibleBaseMinor, 0);
  if (items.some(item => !Number.isSafeInteger(item.eligibleBaseMinor) || item.eligibleBaseMinor < 0) || !Number.isSafeInteger(baseTotal)) throw new Error('Invalid item allocation base.');
  if (totalMinor > baseTotal) throw new Error('Commission cannot exceed the eligible order base.');
  if (!baseTotal) return items.map(item => ({ id: item.id, amountMinor: 0 }));
  const rows = items.map(item => {
    const numerator = BigInt(totalMinor) * BigInt(item.eligibleBaseMinor);
    return { id: item.id, amountMinor: Number(numerator / BigInt(baseTotal)), remainder: numerator % BigInt(baseTotal) };
  });
  let remainder = totalMinor - rows.reduce((sum, row) => sum + row.amountMinor, 0);
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) ranked[index % ranked.length]!.amountMinor += 1;
  return rows.map(({ id, amountMinor }) => ({ id, amountMinor }));
}
