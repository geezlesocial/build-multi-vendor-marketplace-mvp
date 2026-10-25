import { describe, expect, it } from 'vitest';
import { stripeStoreBillingTermsSupported } from './stripe-store-billing.js';

describe('Stripe Store billing sandbox term boundary', () => {
  const supported = { currency: 'USD', monthlyPriceMinor: 2000, annualPriceMinor: 21600, introPriceMinor: null, termIntervals: null };

  it('accepts an unbounded USD recurring plan without an introductory charge', () => {
    expect(stripeStoreBillingTermsSupported(supported)).toEqual({ supported: true, reason: null });
  });

  it('fails closed for unsupported currency, paid introductory terms, finite terms, and zero recurring prices', () => {
    expect(stripeStoreBillingTermsSupported({ ...supported, currency: 'JPY' })).toMatchObject({ supported: false, reason: expect.stringContaining('USD only') });
    expect(stripeStoreBillingTermsSupported({ ...supported, introPriceMinor: 100 })).toMatchObject({ supported: false, reason: expect.stringContaining('introductory') });
    expect(stripeStoreBillingTermsSupported({ ...supported, termIntervals: 12 })).toMatchObject({ supported: false, reason: expect.stringContaining('Fixed-duration') });
    expect(stripeStoreBillingTermsSupported({ ...supported, annualPriceMinor: 0 })).toMatchObject({ supported: false, reason: expect.stringContaining('paid monthly and annual') });
  });
});
