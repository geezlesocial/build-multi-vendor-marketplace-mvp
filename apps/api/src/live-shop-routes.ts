import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { LiveSessionStatus, Role } from '@prisma/client';
import { liveShopProductsSchema } from './validation.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { eligibleProducts, requireLiveShopping } from './live-domain.js';
import { publicLiveSession } from './live-public.js';
import { syncLiveShopProducts } from './live-shop-products.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const editableStatuses: LiveSessionStatus[] = ['DRAFT', 'SCHEDULED', 'STARTING', 'LIVE', 'PAUSED'];

export function registerLiveShopRoutes(app: Express) {
  app.patch('/api/seller/live-sessions/:id/products', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = res.locals.user as { id: string; sellerId?: string };
    if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const session = await prisma.liveSession.findFirst({
      where: { id: param(req.params.id), sellerId: user.sellerId, deletedAt: null },
      select: { id: true, status: true }
    });
    if (!session) return res.status(404).json({ error: 'Live show not found.' });
    if (!editableStatuses.includes(session.status)) return res.status(409).json({ error: 'Featured products can only be changed on a draft, scheduled, or active show.' });
    if (['STARTING', 'LIVE', 'PAUSED'].includes(session.status)) await requireLiveShopping();

    const input = liveShopProductsSchema.parse(req.body);
    if (input.featuredProductId && !input.productIds.includes(input.featuredProductId)) {
      return res.status(400).json({ error: 'Choose the featured item from the six selected products.' });
    }
    await eligibleProducts(user.sellerId, input.productIds);

    const updated = await prisma.$transaction(async tx => {
      const changed = await tx.liveSession.updateMany({
        where: { id: session.id, sellerId: user.sellerId, status: session.status, deletedAt: null },
        data: { updatedAt: new Date() }
      });
      if (!changed.count) return null;
      await syncLiveShopProducts(tx, session.id, input.productIds, input.featuredProductId);
      return tx.liveSession.findUnique({
        where: { id: session.id },
        include: { products: { orderBy: [{ shopSortOrder: 'asc' }, { sortOrder: 'asc' }], include: { product: true } } }
      });
    });
    if (!updated) return res.status(409).json({ error: 'The show changed while products were being saved. Refresh and retry.' });
    await audit(user.id, 'LIVE_SESSION_PRODUCTS_UPDATED', 'LiveSession', session.id, {
      status: session.status,
      shopProductCount: input.productIds.length
    });
    res.json(publicLiveSession(updated));
  }));
}
