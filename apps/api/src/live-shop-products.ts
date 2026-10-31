import type { Prisma } from '@prisma/client';

/**
 * Updates only the current shoppable shelf. Historical product links are
 * intentionally retained so older shows are never silently truncated.
 */
export async function syncLiveShopProducts(
  tx: Prisma.TransactionClient,
  sessionId: string,
  productIds: string[],
  featuredProductId?: string | null
) {
  await tx.liveSessionProduct.updateMany({
    where: { sessionId, shopFeatured: true },
    data: { shopFeatured: false, shopSortOrder: null, shopPinned: false }
  });

  const maxSortOrder = await tx.liveSessionProduct.aggregate({
    where: { sessionId },
    _max: { sortOrder: true }
  });
  let nextLegacySortOrder = (maxSortOrder._max.sortOrder ?? -1) + 1;

  for (const [shopSortOrder, productId] of productIds.entries()) {
    const existing = await tx.liveSessionProduct.findUnique({
      where: { sessionId_productId: { sessionId, productId } },
      select: { id: true }
    });
    const data = {
      shopFeatured: true,
      shopSortOrder,
      shopPinned: featuredProductId === productId
    };
    if (existing) {
      await tx.liveSessionProduct.update({ where: { id: existing.id }, data });
    } else {
      await tx.liveSessionProduct.create({
        data: { sessionId, productId, sortOrder: nextLegacySortOrder++, featured: false, ...data }
      });
    }
  }
}
