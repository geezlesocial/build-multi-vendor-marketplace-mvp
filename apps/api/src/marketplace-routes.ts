import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { Prisma, ProductStatus, SellerStatus, TaxonomyStatus } from '@prisma/client';
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

const availableProductWhere: Prisma.ProductWhereInput = {
  OR: [
    { variants: { some: { status: ProductStatus.APPROVED, stock: { gt: 0 } } } },
    {
      AND: [
        { inventory: { quantity: { gt: 0 } } },
        { NOT: { variants: { some: { status: ProductStatus.APPROVED } } } },
      ],
    },
  ]
};

const publicProductInclude = {
  inventory: true,
  images: { orderBy: { id: 'asc' }, take: 6 },
  mediaAttachments: {
    where: { mediaAsset: { uploadStatus: 'COMPLETE', scanStatus: 'APPROVED' } },
    orderBy: { position: 'asc' },
    include: { mediaAsset: { select: { id: true, kind: true, originalName: true, detectedMime: true } } }
  },
  variants: {
    where: { status: ProductStatus.APPROVED },
    orderBy: { name: 'asc' },
    include: { mediaAsset: { select: { id: true, kind: true, uploadStatus: true, scanStatus: true } } }
  },
  category: true,
  brand: true,
  featureAssignments: { include: { feature: true } },
  seller: { include: { store: true } }
} satisfies Prisma.ProductInclude;

type PublicProductRecord = Prisma.ProductGetPayload<{ include: typeof publicProductInclude }>;

const publicVariant = (variant: PublicProductRecord['variants'][number]) => ({
  id: variant.id,
  name: variant.name,
  priceMinor: variant.priceMinor,
  currency: variant.currency,
  stock: variant.stock,
  image: variant.mediaAsset?.kind === 'IMAGE' && variant.mediaAsset.uploadStatus === 'COMPLETE' && variant.mediaAsset.scanStatus === 'APPROVED'
    ? { id: variant.mediaAsset.id, url: `/content-media/${encodeURIComponent(variant.mediaAsset.id)}` }
    : null
});

const publicProduct = (product: PublicProductRecord) => {
  const variants = (product.variants ?? []).map(publicVariant);
  const gallery = [
    ...(product.images ?? []).map((image) => ({ id: `image-${image.id}`, kind: 'IMAGE', url: image.url, alt: image.alt })),
    ...(product.mediaAttachments ?? []).map(({ mediaAsset, ...attachment }) => ({
      id: attachment.id,
      kind: mediaAsset.kind,
      url: `/content-media/${encodeURIComponent(mediaAsset.id)}`,
      alt: attachment.label || product.name,
      label: attachment.label,
      originalName: mediaAsset.originalName,
      detectedMime: mediaAsset.detectedMime,
    })),
  ];
  const defaultImage = gallery.find((item) => item.kind === 'IMAGE')
    ? { url: gallery.find((item) => item.kind === 'IMAGE')!.url, alt: gallery.find((item) => item.kind === 'IMAGE')!.alt ?? product.name }
    : null;
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    priceMinor: product.priceMinor,
    salePriceMinor: product.salePriceMinor,
    wholesaleEnabled: product.wholesaleEnabled,
    wholesaleMinQuantity: product.wholesaleMinQuantity,
    wholesaleMaxQuantity: product.wholesaleMaxQuantity,
    color: product.color,
    features: (product.featureAssignments ?? []).map((assignment) => ({ id: assignment.feature.id, name: assignment.feature.name })),
    currency: product.currency,
    availableStock: variants.length ? variants.reduce((sum, variant) => sum + variant.stock, 0) : product.inventory?.quantity ?? 0,
    image: defaultImage,
    gallery,
    variants,
    category: product.category ? { name: product.category.name, slug: product.category.slug } : null,
    brand: product.brand ? { name: product.brand.name, slug: product.brand.slug } : null,
    store: product.seller?.store ? { name: product.seller.store.name, slug: product.seller.store.slug } : null
  };
};

const publicStore = (store: Prisma.StoreGetPayload<Prisma.StoreDefaultArgs>) => ({
  id: store.id,
  name: store.name,
  slug: store.slug,
  description: store.description,
  seoTitle: store.seoTitle,
  seoDescription: store.seoDescription,
  logoMediaId: store.logoMediaId
});

export function registerMarketplaceRoutes(app: Express) {
  app.get('/api/marketplace/home', run(async (_req, res) => {
    const [categories, products, stores] = await Promise.all([
      prisma.category.findMany({ where: { status: TaxonomyStatus.ACTIVE }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }], take: 8 }),
      prisma.product.findMany({ where: { ...approvedProductWhere(), ...availableProductWhere }, include: publicProductInclude, orderBy: { createdAt: 'desc' }, take: 12 }),
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

  app.get('/api/marketplace/categories/:slug', run(async (req, res) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    if (!slug) return res.status(404).json({ error: 'This marketplace category is unavailable.' });
    const category = await prisma.category.findFirst({ where: { slug, status: TaxonomyStatus.ACTIVE }, select: { id: true, name: true, slug: true, description: true, imageUrl: true } });
    if (!category) {
      const redirect = await prisma.slugRedirect.findUnique({ where: { fromPath: `/category/${slug}` } });
      if (redirect && redirect.destinationPath.startsWith('/category/') && !redirect.destinationPath.startsWith('//')) {
        return res.json({ redirectTo: redirect.destinationPath, statusCode: redirect.statusCode });
      }
      return res.status(404).json({ error: 'This marketplace category is unavailable.' });
    }
    const activeCategories = await prisma.category.findMany({ where: { status: TaxonomyStatus.ACTIVE }, select: { id: true, parentId: true, name: true, slug: true, description: true, imageUrl: true, displayOrder: true } });
    const categoriesByParent = new Map<string, typeof activeCategories>();
    for (const item of activeCategories) {
      if (!item.parentId) continue;
      const siblings = categoriesByParent.get(item.parentId) ?? [];
      siblings.push(item);
      categoriesByParent.set(item.parentId, siblings);
    }
    const descendants = new Set([category.id]);
    const pending = [category.id];
    while (pending.length) {
      const parentId = pending.pop()!;
      for (const child of categoriesByParent.get(parentId) ?? []) {
        if (descendants.has(child.id)) continue;
        descendants.add(child.id);
        pending.push(child.id);
      }
    }
    const children = (categoriesByParent.get(category.id) ?? []).sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)).map(({ id, name, slug: childSlug, description, imageUrl }) => ({ id, name, slug: childSlug, description, imageUrl }));
    const products = await prisma.product.findMany({ where: { ...approvedProductWhere(), ...availableProductWhere, categoryId: { in: [...descendants] } }, include: publicProductInclude, orderBy: { createdAt: 'desc' }, take: 48 });
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json({ category, children, items: products.map(publicProduct) });
  }));

  app.get('/api/marketplace/search', run(async (req, res) => {
    const input = normalizeMarketplaceSearch({ q: req.query.q, limit: req.query.limit });
    const [products, stores] = await Promise.all([
      prisma.product.findMany({ where: approvedProductWhere(input.q), include: publicProductInclude, orderBy: { updatedAt: 'desc' }, take: input.limit }),
      prisma.store.findMany({ where: { seller: { status: SellerStatus.APPROVED, products: { some: { status: ProductStatus.APPROVED } } }, OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { description: { contains: input.q, mode: 'insensitive' } }] }, orderBy: { name: 'asc' }, take: input.limit })
    ]);
    res.json({
      query: input.q,
      products: products.map(product => ({ type: publicSearchLabel('product'), ...publicProduct(product) })),
      stores: stores.map(store => ({ type: publicSearchLabel('store'), ...publicStore(store) }))
    });
  }));
}
