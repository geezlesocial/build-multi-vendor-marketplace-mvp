import { describe, expect, it } from 'vitest';
import { liveSessionSchema, liveShopProductsSchema } from './validation.js';

const productIds = [
  'c12345678901234567890123',
  'c22345678901234567890123',
  'c32345678901234567890123',
  'c42345678901234567890123',
  'c52345678901234567890123',
  'c62345678901234567890123',
  'c72345678901234567890123'
];

describe('live shopping product tags', () => {
  it('accepts up to six unique products and a selected featured product', () => {
    expect(liveShopProductsSchema.safeParse({ productIds: productIds.slice(0, 6), featuredProductId: productIds[0] }).success).toBe(true);
    expect(liveSessionSchema.safeParse({ title: 'Product live show', timezone: 'UTC', productIds: productIds.slice(0, 6), featuredProductId: productIds[0] }).success).toBe(true);
  });

  it('rejects more than six products and duplicate product tags', () => {
    expect(liveShopProductsSchema.safeParse({ productIds }).success).toBe(false);
    expect(liveShopProductsSchema.safeParse({ productIds: [productIds[0], productIds[0]] }).success).toBe(false);
    expect(liveSessionSchema.safeParse({ title: 'Product live show', timezone: 'UTC', productIds }).success).toBe(false);
  });

  it('rejects unknown fields so tag updates cannot alter session or provider state', () => {
    expect(liveShopProductsSchema.safeParse({ productIds: [], status: 'ENDED', providerSessionRef: 'attacker-value' }).success).toBe(false);
  });
});
