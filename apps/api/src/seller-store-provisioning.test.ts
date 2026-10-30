import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { env } from './config.js';
import { provisionApprovedSellerStore } from './seller-store-provisioning.js';

describe('approved seller Store provisioning', () => {
  it('creates a uniquely named Store and enables its configured base-currency offer', async () => {
    const store = { id: 'store_1', sellerId: 'seller_12345678', name: "A Seller's Store", slug: 'a-seller-12345678', baseCurrency: env.CURRENCY };
    const create = vi.fn(async () => store);
    const offerUpsert = vi.fn(async () => ({}));
    const tx = {
      store: { findUnique: vi.fn(async ({ where }: { where: { sellerId?: string; slug?: string } }) => where.sellerId ? null : null), create },
      currencyCatalogEntry: { findUnique: vi.fn(async () => ({ code: env.CURRENCY, active: true, checkoutEnabled: true })) },
      storeCurrencyOffer: { upsert: offerUpsert }
    } as unknown as Prisma.TransactionClient;

    const result = await provisionApprovedSellerStore(tx, { sellerId: 'seller_12345678', sellerName: 'A Seller' });
    expect(result).toEqual({ store, created: true });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ sellerId: 'seller_12345678', name: "A Seller's Store", baseCurrency: env.CURRENCY }) });
    expect(offerUpsert).toHaveBeenCalledWith({
      where: { storeId_currency: { storeId: store.id, currency: env.CURRENCY } },
      update: {},
      create: { storeId: store.id, currency: env.CURRENCY, displayEnabled: true, checkoutEnabled: true }
    });
  });

  it('reuses an existing Store without creating a duplicate', async () => {
    const existing = { id: 'store_existing', sellerId: 'seller_existing', name: 'Existing Store', slug: 'existing-store', baseCurrency: env.CURRENCY };
    const create = vi.fn();
    const tx = {
      store: { findUnique: vi.fn(async () => existing), create },
      currencyCatalogEntry: { findUnique: vi.fn(async () => ({ code: env.CURRENCY, active: true, checkoutEnabled: false })) },
      storeCurrencyOffer: { upsert: vi.fn(async () => ({})) }
    } as unknown as Prisma.TransactionClient;

    const result = await provisionApprovedSellerStore(tx, { sellerId: existing.sellerId, sellerName: 'Changed Name' });
    expect(result).toEqual({ store: existing, created: false });
    expect(create).not.toHaveBeenCalled();
    expect(tx.storeCurrencyOffer.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it('fails clearly if the configured store base currency is absent from the catalog', async () => {
    const tx = {
      store: { findUnique: vi.fn(async () => null), create: vi.fn() },
      currencyCatalogEntry: { findUnique: vi.fn(async () => null) },
      storeCurrencyOffer: { upsert: vi.fn() }
    } as unknown as Prisma.TransactionClient;
    await expect(provisionApprovedSellerStore(tx, { sellerId: 'seller_1', sellerName: 'Seller' })).rejects.toMatchObject({ statusCode: 409, code: 'STORE_BASE_CURRENCY_NOT_CONFIGURED' });
  });
});
