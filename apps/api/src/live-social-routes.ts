import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { LiveSessionStatus, Prisma, ProductStatus, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { currentUser, prisma, requireAuth } from './security.js';
import { liveShoppingState } from './live-domain.js';
import { publicLiveSession } from './live-public.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const idSchema = z.string().cuid();
const socialMutationLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

async function visibleSession(id: string) {
  const live = await liveShoppingState();
  const visible: Prisma.LiveSessionWhereInput[] = [
    { status: LiveSessionStatus.ENDED, recordingStatus: 'READY', replayPublishedAt: { not: null } }
  ];
  if (live.effectiveEnabled) visible.push({ status: LiveSessionStatus.LIVE, providerSessionRef: { not: null } });
  return prisma.liveSession.findFirst({
    where: {
      id,
      deletedAt: null,
      seller: { is: { status: SellerStatus.APPROVED } },
      OR: visible
    },
    select: { id: true, status: true }
  });
}

export function registerLiveSocialRoutes(app: Express) {
  app.get('/api/live-sessions/:id/social', run(async (req, res) => {
    const id = idSchema.parse(param(req.params.id));
    const session = await visibleSession(id);
    if (!session) return res.status(404).json({ error: 'Public live show not found.' });
    const user = await currentUser(req);
    const [repostCount, repost] = await Promise.all([
      prisma.liveSessionRepost.count({ where: { sessionId: id } }),
      user ? prisma.liveSessionRepost.findUnique({ where: { userId_sessionId: { userId: user.id, sessionId: id } }, select: { createdAt: true } }) : Promise.resolve(null)
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ repostCount, reposted: Boolean(repost) });
  }));

  app.post('/api/live-sessions/:id/repost', socialMutationLimit, requireAuth, run(async (req, res) => {
    const id = idSchema.parse(param(req.params.id));
    const session = await visibleSession(id);
    if (!session) return res.status(404).json({ error: 'This live show is no longer available to repost.' });
    const user = res.locals.user as { id: string };
    await prisma.liveSessionRepost.upsert({
      where: { userId_sessionId: { userId: user.id, sessionId: id } },
      update: {},
      create: { userId: user.id, sessionId: id }
    });
    const repostCount = await prisma.liveSessionRepost.count({ where: { sessionId: id } });
    res.status(200).json({ reposted: true, repostCount });
  }));

  app.delete('/api/live-sessions/:id/repost', socialMutationLimit, requireAuth, run(async (req, res) => {
    const id = idSchema.parse(param(req.params.id));
    const user = res.locals.user as { id: string };
    await prisma.liveSessionRepost.deleteMany({ where: { userId: user.id, sessionId: id } });
    const session = await visibleSession(id);
    const repostCount = session ? await prisma.liveSessionRepost.count({ where: { sessionId: id } }) : null;
    res.json({ reposted: false, ...(repostCount === null ? {} : { repostCount }) });
  }));

  app.get('/api/account/live-reposts', requireAuth, run(async (_req, res) => {
    const live = await liveShoppingState();
    const publicShow: Prisma.LiveSessionWhereInput[] = [
      { status: LiveSessionStatus.ENDED, recordingStatus: 'READY', replayPublishedAt: { not: null } }
    ];
    if (live.effectiveEnabled) publicShow.push({ status: LiveSessionStatus.LIVE, providerSessionRef: { not: null } });
    const user = res.locals.user as { id: string };
    const reposts = await prisma.liveSessionRepost.findMany({
      where: {
        userId: user.id,
        session: {
          is: {
            deletedAt: null,
            seller: { is: { status: SellerStatus.APPROVED } },
            OR: publicShow
          }
        }
      },
      include: {
        session: {
          include: {
            seller: { include: { store: { select: { name: true, slug: true } } } },
            products: { where: { product: { is: { status: ProductStatus.APPROVED } } }, orderBy: { sortOrder: 'asc' }, include: { product: { select: { id: true, name: true, priceMinor: true, salePriceMinor: true, currency: true, inventory: { select: { quantity: true } } } } } }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.set('Cache-Control', 'no-store');
    res.json(reposts.map(repost => ({
      repostedAt: repost.createdAt,
      session: publicLiveSession({
        ...repost.session,
        products: repost.session.products.map(link => ({ ...link, product: { ...link.product, availableStock: link.product.inventory?.quantity ?? 0 } }))
      })
    })));
  }));

  app.get('/api/live-sessions/:id/products/:productId', run(async (req, res) => {
    const sessionId = idSchema.parse(param(req.params.id));
    const productId = idSchema.parse(param(req.params.productId));
    const session = await visibleSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Public live show not found.' });
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        status: ProductStatus.APPROVED,
        OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }],
        liveSessionProducts: { some: { sessionId, OR: [{ shopFeatured: true }, { featured: true }] } }
      },
      select: {
        id: true,
        name: true,
        description: true,
        priceMinor: true,
        salePriceMinor: true,
        currency: true,
        wholesaleEnabled: true,
        wholesaleMinQuantity: true,
        wholesaleMaxQuantity: true,
        inventory: { select: { quantity: true } },
        images: { select: { id: true, url: true, alt: true }, take: 8 },
        variants: { where: { status: ProductStatus.APPROVED }, select: { id: true, name: true, priceMinor: true, currency: true, stock: true, imageUrl: true }, orderBy: { name: 'asc' } },
        productType: { select: { name: true, requiresShipping: true } }
      }
    });
    if (!product) return res.status(404).json({ error: 'This product is no longer available in the live show.' });
    res.set('Cache-Control', 'no-store');
    res.json({ ...product, availableStock: product.inventory?.quantity ?? 0 });
  }));
}
