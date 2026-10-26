import { describe, expect, it } from 'vitest';
import { quoteProductDiscount, type DiscountDefinition } from './product-discount-domain.js';

const now = new Date('2026-10-25T00:00:00.000Z');
const definition: DiscountDefinition = {
  id: 'discount-1', sellerId: 'seller-1', code: 'SAVE10', kind: 'PERCENTAGE', scope: 'ALL_PRODUCTS',
  percentBasisPoints: 1000, amountMinor: null, currency: 'USD', minimumSubtotalMinor: null,
  usageLimit: null, usesCount: 0, enabled: true, startsAt: null, endsAt: null, productIds: [], categoryIds: []
};
const lines = [
  { cartItemId: 'cart-a', productId: 'product-a', categoryId: 'child', categoryIds: ['child', 'parent'], sellerId: 'seller-1', quantity: 1, unitPriceMinor: 1001 },
  { cartItemId: 'cart-b', productId: 'product-b', categoryId: 'other', categoryIds: ['other'], sellerId: 'seller-1', quantity: 2, unitPriceMinor: 2000 },
  { cartItemId: 'cart-c', productId: 'product-c', categoryId: null, sellerId: 'seller-2', quantity: 1, unitPriceMinor: 9000 }
];

describe('seller product discount quotes', () => {
  it('scopes lines to the seller and allocates percentage discounts exactly', () => {
    const quote = quoteProductDiscount(definition, lines, now);
    expect(quote.eligibleSubtotalMinor).toBe(5001);
    expect(quote.discountMinor).toBe(500);
    expect(quote.allocations.reduce((sum, allocation) => sum + allocation.discountMinor, 0)).toBe(500);
    expect(quote.allocations.some(allocation => allocation.cartItemId === 'cart-c')).toBe(false);
  });

  it('applies a selected parent category to descendant products', () => {
    const quote = quoteProductDiscount({ ...definition, scope: 'SELECTED_CATEGORIES', categoryIds: ['parent'] }, lines, now);
    expect(quote.eligibleSubtotalMinor).toBe(1001);
    expect(quote.discountMinor).toBe(100);
    expect(quote.allocations).toEqual([{ cartItemId: 'cart-a', discountMinor: 100 }]);
  });

  it('caps fixed discounts below the eligible subtotal and enforces availability rules', () => {
    expect(quoteProductDiscount({ ...definition, kind: 'FIXED', scope: 'SELECTED_PRODUCTS', productIds: ['product-a'], percentBasisPoints: null, amountMinor: 9000 }, lines, now).discountMinor).toBe(1000);
    expect(() => quoteProductDiscount({ ...definition, enabled: false }, lines, now)).toThrow('inactive');
    expect(() => quoteProductDiscount({ ...definition, usageLimit: 1, usesCount: 1 }, lines, now)).toThrow('usage limit');
    expect(() => quoteProductDiscount({ ...definition, scope: 'SELECTED_PRODUCTS', productIds: ['not-in-cart'] }, lines, now)).toThrow('does not apply');
  });
});
