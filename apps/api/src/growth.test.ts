import { describe, expect, it } from 'vitest';
import { commissionMinor, generatedReferralCode, proportionalCommission, safeInternalPath, signedReferralToken, validWholesaleQuantity, verifySignedReferralToken, wholesaleUnitPrice } from './growth-domain.js';

describe('growth domain rules', () => {
  it('calculates integer affiliate commissions without floating point money', () => {
    expect(commissionMinor(1999, 750, null)).toBe(149);
    expect(commissionMinor(1999, null, 500)).toBe(500);
    expect(() => commissionMinor(1999, 10001, null)).toThrow();
  });
  it('selects the highest applicable wholesale tier and enforces pack rules', () => {
    expect(wholesaleUnitPrice([{ minQuantity: 10, unitPriceMinor: 900 }, { minQuantity: 25, unitPriceMinor: 800 }], 30, 1000)).toBe(800);
    expect(validWholesaleQuantity(30, 10, 5)).toBe(true);
    expect(validWholesaleQuantity(31, 10, 5)).toBe(false);
  });
  it('rejects open redirects and creates non-trivial referral codes', () => {
    expect(safeInternalPath('/products/demo')).toBe('/products/demo');
    expect(() => safeInternalPath('https://example.com')).toThrow();
    expect(() => safeInternalPath('/../admin')).toThrow();
    expect(generatedReferralCode('affiliate-123456789')).toMatch(/^[A-Z0-9]{8,16}$/);
  });
  it('signs and verifies consent attribution tokens without exposing the signing secret', () => {
    const token = signedReferralToken('a-test-only-affiliate-secret-that-is-long-enough');
    expect(verifySignedReferralToken(token, 'a-test-only-affiliate-secret-that-is-long-enough')).toBe(true);
    expect(verifySignedReferralToken(`${token}x`, 'a-test-only-affiliate-secret-that-is-long-enough')).toBe(false);
    expect(verifySignedReferralToken(token, 'a-different-test-secret-that-is-long-enough')).toBe(false);
  });
  it('calculates capped proportional reversals with integer minor units', () => {
    expect(proportionalCommission(150, 1000, 400)).toBe(60);
    expect(proportionalCommission(150, 1000, 2000)).toBe(150);
  });
});
