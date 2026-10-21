import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { Prisma, ProductStatus, SellerStatus, TaxonomyStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './security.js';
import { normalizeMarketplaceSearch, publicSearchLabel } from './marketplace-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const approvedProductWhere = (query?: string): Prisma.ProductWhereInput => ({
  status: ProductStatus.APPROVED,
  AND: [
    { OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] },
    ...(query ? [{ OR: [{ name: { contains: query, mode: 'insensitive' as const } }, { description: { contains: query, mode: 'insensitive' as const } }] }] : [])
  ]
});

const publicProduct = (product: any) => ({
  id: product.id,
  slug: product.slug,
  name: product.name,
  description: product.description,
  priceMinor: product.priceMinor,
  currency: product.currency,
  availableStock: product.inventory?.quantity ?? 0,
  image: product.images?.[0] ? { url: product.images[0].url, alt: product.images[0].alt } : null,
  category: product.category ? { name: product.category.name, slug: product.category.slug } : null,
  store: product.seller?.store ? { name: product.seller.store.name, slug: product.seller.store.slug } : null
});

const publicStore = (store: any) => ({
  id: store.id,
  name: store.name,
  slug: store.slug,
  description: store.description,
  logoMediaId: store.logoMediaId
});

export function registerMarketplaceRoutes(app: Express) {
  app.get('/api/marketplace/home', run(async (_req, res) => {
    const [categories, products, stores] = await Promise.all([
      prisma.category.findMany({ where: { status: TaxonomyStatus.ACTIVE }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }], take: 8 }),
      prisma.product.findMany({ where: { ...approvedProductWhere(), inventory: { quantity: { gt: 0 } } }, include: { inventory: true, images: { take: 1 }, category: true, seller: { include: { store: true } } }, orderBy: { createdAt: 'desc' }, take: 12 }),
      prisma.store.findMany({ where: { seller: { status: SellerStatus.APPROVED, products: { some: { status: ProductStatus.APPROVED } } } }, orderBy: { name: 'asc' }, take: 8 })
    ]);
    res.json({
      hero: { title: 'A more thoughtful way to shop independent stores.', description: 'Browse approved products, compare stores, and keep checkout clear from discovery to delivery.' },
      categories: categories.map(category => ({ id: category.id, name: category.name, slug: category.slug, imageUrl: category.imageUrl })),
      featuredDeals: products.slice(0, 6).map(publicProduct),
      productCollection: products.slice(6).map(publicProduct),
      featuredStores: stores.map(publicStore)
    });
  }));

  app.get('/api/marketplace/search', run(async (req, res) => {
    const input = normalizeMarketplaceSearch({ q: req.query.q, limit: req.query.limit });
    const [products, stores] = await Promise.all([
      prisma.product.findMany({ where: approvedProductWhere(input.q), include: { inventory: true, images: { take: 1 }, category: true, seller: { include: { store: true } } }, orderBy: { updatedAt: 'desc' }, take: input.limit }),
      prisma.store.findMany({ where: { seller: { status: SellerStatus.APPROVED, products: { some: { status: ProductStatus.APPROVED } } }, OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { description: { contains: input.q, mode: 'insensitive' } }] }, orderBy: { name: 'asc' }, take: input.limit })
    ]);
    res.json({
      query: input.q,
      products: products.map(product => ({ type: publicSearchLabel('product'), ...publicProduct(product) })),
      stores: stores.map(store => ({ type: publicSearchLabel('store'), ...publicStore(store) }))
    });
  }));
}
