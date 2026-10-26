import { describe, expect, it } from 'vitest';
import { effectiveProductPriceMinor, effectiveUnitPriceMinor, isValidSalePrice } from './product-pricing.js';

describe('product sale pricing', () => {
  it('uses the sale price when present and the regular price otherwise', () => {
    expect(effectiveProductPriceMinor({ priceMinor: 2400, salePriceMinor: 1800 })).toBe(1800);
    expect(effectiveProductPriceMinor({ priceMinor: 2400, salePriceMinor: null })).toBe(2400);
  });

  it('keeps an explicit variant price authoritative', () => {
    expect(effectiveUnitPriceMinor({ product: { priceMinor: 2400, salePriceMinor: 1800 }, variant: { priceMinor: 2500 } })).toBe(2500);
    expect(effectiveUnitPriceMinor({ product: { priceMinor: 2400, salePriceMinor: 1800 }, variant: null })).toBe(1800);
  });

  it('requires a sale price to be a positive integer below the regular price', () => {
    expect(isValidSalePrice(2400, 1800)).toBe(true);
    expect(isValidSalePrice(2400, null)).toBe(true);
    expect(isValidSalePrice(2400, 2400)).toBe(false);
    expect(isValidSalePrice(2400, 0)).toBe(false);
    expect(isValidSalePrice(2400, 1.5)).toBe(false);
  });
});
