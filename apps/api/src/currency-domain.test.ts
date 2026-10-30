import { describe, expect, it, vi } from 'vitest';
import { allocateCommission, calculateCommissionMinor, convertMinorExact, deriveUsdPivotRate, fetchReferenceRatesWithUnsupportedFallback, FrankfurterRateAdapter, INITIAL_CURRENCY_CODES, isRateFresh, parseRate, ReferenceRateFetchError } from './currency-domain.js';

describe('currency and seller commission domain', () => {
  it('contains the initial requested regional catalog without enabling charge currencies', () => {
    expect(INITIAL_CURRENCY_CODES).toContain('PHP');
    expect(INITIAL_CURRENCY_CODES).toContain('XAF');
  });

  it('parses bounded exact rates and rejects guessed or invalid decimal forms', () => {
    expect(parseRate('1.230000000001').numerator).toBe(1230000000001n);
    expect(() => parseRate('0')).toThrow();
    expect(() => parseRate('1e3')).toThrow();
    expect(() => parseRate('1.1234567890123')).toThrow();
  });

  it('converts minor units exactly and rounds half up using currency exponents', () => {
    expect(convertMinorExact(100n, '1.5', 2, 2)).toBe(150n);
    expect(convertMinorExact(1n, '0.5', 2, 2)).toBe(1n);
    expect(convertMinorExact(100n, '150', 2, 0)).toBe(150n);
  });

  it('derives currency cross-rates through USD without floating-point rounding', () => {
    expect(deriveUsdPivotRate('0.92', '1.35')).toBe('1.467391304348');
    expect(deriveUsdPivotRate('1.35', '0.92')).toBe('0.681481481481');
  });

  it('marks future and stale rates unavailable', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(isRateFresh(new Date('2026-10-23T11:00:00Z'), now)).toBe(true);
    expect(isRateFresh(new Date('2026-10-20T11:00:00Z'), now)).toBe(false);
    expect(isRateFresh(new Date('2026-10-23T13:00:00Z'), now)).toBe(false);
    expect(isRateFresh(new Date('2026-10-23T11:00:00Z'), now, 36 * 60 * 60 * 1000, new Date('2026-10-20T00:00:00Z'))).toBe(false);
    expect(isRateFresh(new Date('2026-10-23T11:00:00Z'), now, 36 * 60 * 60 * 1000, new Date('2026-10-24T00:00:00Z'))).toBe(false);
  });

  it('uses a replaceable Frankfurter adapter with deterministic mocked response parsing', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([{ date: '2026-10-22', base: 'USD', quote: 'EUR', rate: 0.92 }]), { status: 200 }));
    const adapter = new FrankfurterRateAdapter('https://example.test/v2', fetcher as typeof fetch);
    await expect(adapter.fetchRates('USD', ['EUR'])).resolves.toEqual([{ base: 'USD', quote: 'EUR', rate: '0.92', sourceDate: '2026-10-22' }]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v2/rates?');
    const invalidDateAdapter = new FrankfurterRateAdapter('https://example.test/v2', vi.fn(async () => new Response(JSON.stringify([{ date: '2026-02-31', base: 'USD', quote: 'EUR', rate: 0.92 }]), { status: 200 })) as typeof fetch);
    await expect(invalidDateAdapter.fetchRates('USD', ['EUR'])).rejects.toThrow(/observation date/);
  });

  it('keeps a provider-unsupported quote from blocking supported reference currencies', async () => {
    const provider = {
      provider: 'test',
      fetchRates: vi.fn(async (base: string, quotes: string[]) => {
        if (quotes.includes('BAD')) throw new ReferenceRateFetchError(422);
        return quotes.map(quote => ({ base, quote, rate: '1.25', sourceDate: '2026-10-27' }));
      })
    };
    const result = await fetchReferenceRatesWithUnsupportedFallback(provider, 'USD', ['EUR', 'BAD', 'JPY']);
    expect(result).toMatchObject({ requested: 3, unavailableCurrencies: ['BAD'] });
    expect(result.rates.map(rate => rate.quote).sort()).toEqual(['EUR', 'JPY']);
  });

  it('calculates fixed, percentage, capped, and zero policies with integer rounding', () => {
    expect(calculateCommissionMinor({ type: 'FIXED_PER_ORDER', fixedMinor: 25, basisPoints: null, minimumMinor: null, capMinor: null }, 1000)).toBe(25);
    expect(calculateCommissionMinor({ type: 'PERCENTAGE', fixedMinor: null, basisPoints: 500, minimumMinor: null, capMinor: null }, 101)).toBe(5);
    expect(calculateCommissionMinor({ type: 'PERCENTAGE_PLUS_FIXED', fixedMinor: 25, basisPoints: 500, minimumMinor: null, capMinor: 50 }, 1000)).toBe(50);
    expect(calculateCommissionMinor({ type: 'ZERO', fixedMinor: null, basisPoints: null, minimumMinor: 5, capMinor: null }, 1000)).toBe(0);
  });

  it('allocates order commission deterministically across items for partial reversals', () => {
    expect(allocateCommission(10, [{ id: 'b', eligibleBaseMinor: 100 }, { id: 'a', eligibleBaseMinor: 100 }])).toEqual([
      { id: 'b', amountMinor: 5 }, { id: 'a', amountMinor: 5 }
    ]);
    expect(() => allocateCommission(11, [{ id: 'only', eligibleBaseMinor: 10 }])).toThrow();
  });
});
