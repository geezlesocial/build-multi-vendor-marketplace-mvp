import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { Prisma, Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, prisma, requireAuth, requireRole } from './security.js';
import { platformAdminEntitlements } from './store-plan-domain.js';
import { reservedStoreSlug } from './platform-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string };
const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(1000).default(''),
  baseCurrency: z.string().trim().length(3).transform(value => value.toUpperCase()).refine(value => /^[A-Z]{3}$/.test(value)).default('USD')
}).strict();

function adminStoreAccess() {
  return {
    kind: 'PLATFORM_ADMIN_OVERRIDE',
    name: 'Platform administrator — all premium features',
    requiresSubscription: false,
    unlimited: true,
    entitlements: platformAdminEntitlements
  };
}

export function registerPlatformStoreRoutes(app: Express) {
  app.get('/api/admin/platform-store', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const store = await prisma.store.findFirst({
      where: { isPlatformStore: true },
      select: { id: true, name: true, slug: true, description: true, baseCurrency: true, seller: { select: { status: true, _count: { select: { products: true } } } } }
    });
    res.json({ store: store ? { ...store, productCount: store.seller._count.products, sellerStatus: store.seller.status } : null, access: adminStoreAccess() });
  }));

  app.post('/api/admin/platform-store', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = createSchema.parse(req.body);
    if (reservedStoreSlug(input.slug)) return res.status(400).json({ error: 'That public Store URL is reserved.' });
    const currency = await prisma.currencyCatalogEntry.findFirst({ where: { code: input.baseCurrency, active: true, checkoutEnabled: true }, select: { code: true } });
    if (!currency) return res.status(400).json({ error: 'Choose an active currency that is enabled for checkout.' });
    if (await prisma.store.findFirst({ where: { slug: input.slug }, select: { id: true } })) return res.status(409).json({ error: 'That Store URL is already in use.' });

    try {
      const passwordHash = await hashPassword(randomBytes(48).toString('base64url'));
      const store = await prisma.$transaction(async tx => {
        const currentOfficial = await tx.store.findFirst({ where: { isPlatformStore: true }, select: { id: true } });
        if (currentOfficial) throw Object.assign(new Error('The official platform Store already exists.'), { statusCode: 409 });
        const email = 'platform-store-owner@system.invalid';
        const owner = await tx.user.upsert({
          where: { email },
          update: { name: 'Platform Store Owner', role: Role.SELLER, passwordHash },
          create: { email, name: 'Platform Store Owner', role: Role.SELLER, passwordHash }
        });
        let seller = await tx.seller.findUnique({ where: { userId: owner.id }, include: { store: true } });
        if (seller?.store) throw Object.assign(new Error('The reserved platform owner account already has a Store; contact support before recreating it.'), { statusCode: 409 });
        if (!seller) seller = await tx.seller.create({ data: { userId: owner.id, status: SellerStatus.APPROVED }, include: { store: true } });
        else seller = await tx.seller.update({ where: { id: seller.id }, data: { status: SellerStatus.APPROVED, reason: null }, include: { store: true } });
        const created = await tx.store.create({ data: { sellerId: seller.id, isPlatformStore: true, name: input.name, slug: input.slug, description: input.description || null, baseCurrency: input.baseCurrency } });
        await tx.auditLog.create({ data: { actorId: admin.id, action: 'PLATFORM_OFFICIAL_STORE_CREATED', entity: 'Store', entityId: created.id, metadata: { name: created.name, slug: created.slug, baseCurrency: created.baseCurrency, accessOverride: 'PLATFORM_ADMIN' } } });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      res.status(201).json({ store, access: adminStoreAccess() });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) return res.status(409).json({ error: 'The official Store or requested URL already exists. Refresh the page and try again.' });
      throw error;
    }
  }));
}
