import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { syncLiveShopProducts } from './live-shop-products.js';

describe('live shopping product shelf persistence', () => {
  it('keeps historical links and legacy featured flags separate from the shop shelf', async () => {
    const existingUpdate = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      liveSessionProduct: {
        updateMany,
        aggregate: vi.fn(async () => ({ _max: { sortOrder: 4 } })),
        findUnique: vi.fn(async ({ where }: { where: { sessionId_productId: { productId: string } } }) => where.sessionId_productId.productId === 'existing-product' ? { id: 'historical-link' } : null),
        update: existingUpdate,
        create
      }
    } as unknown as Prisma.TransactionClient;

    await syncLiveShopProducts(tx, 'session-id', ['existing-product', 'new-product'], 'new-product');

    expect(updateMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-id', shopFeatured: true },
      data: { shopFeatured: false, shopSortOrder: null, shopPinned: false }
    });
    expect(existingUpdate).toHaveBeenCalledWith({
      where: { id: 'historical-link' },
      data: { shopFeatured: true, shopSortOrder: 0, shopPinned: false }
    });
    expect(create).toHaveBeenCalledWith({
      data: { sessionId: 'session-id', productId: 'new-product', sortOrder: 5, featured: false, shopFeatured: true, shopSortOrder: 1, shopPinned: true }
    });
  });

  it('allows clearing the current shelf without deleting linked show history', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn();
    const tx = {
      liveSessionProduct: {
        updateMany,
        aggregate: vi.fn(async () => ({ _max: { sortOrder: 0 } })),
        findUnique: vi.fn(),
        update: vi.fn(),
        create
      }
    } as unknown as Prisma.TransactionClient;

    await syncLiveShopProducts(tx, 'session-id', []);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});
