import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, PrismaClient, ProductStatus, Role, SellerStatus, TaxonomyStatus } from '@prisma/client';
import { z } from 'zod';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { effectiveUnitPriceMinor } from './product-pricing.js';
import { quoteProductDiscount, type DiscountCartLine, type DiscountDefinition } from './product-discount-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const inputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  kind: z.enum(['PERCENTAGE', 'FIXED']),
  scope: z.enum(['ALL_PRODUCTS', 'SELECTED_PRODUCTS', 'SELECTED_CATEGORIES']),
  percentOff: z.number().int().min(1).max(99).optional(),
  amountMinor: z.number().int().positive().max(2_000_000_000).optional(),
  minimumSubtotalMinor: z.number().int().nonnegative().max(2_000_000_000).nullable().optional(),
  usageLimit: z.number().int().positive().max(2_000_000_000).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  enabled: z.boolean().default(true),
  productIds: z.array(z.string().cuid()).max(500).default([]),
  categoryIds: z.array(z.string().cuid()).max(200).default([])
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'PERCENTAGE' && (value.percentOff === undefined || value.amountMinor !== undefined)) ctx.addIssue({ code: 'custom', path: ['percentOff'], message: 'Set a percentage discount from 1% to 99%.' });
  if (value.kind === 'FIXED' && (value.amountMinor === undefined || value.percentOff !== undefined)) ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Set a fixed amount in minor currency units.' });
  if (value.scope === 'SELECTED_PRODUCTS' && (!value.productIds.length || value.categoryIds.length)) ctx.addIssue({ code: 'custom', path: ['productIds'], message: 'Select one or more products only.' });
  if (value.scope === 'SELECTED_CATEGORIES' && (!value.categoryIds.length || value.productIds.length)) ctx.addIssue({ code: 'custom', path: ['categoryIds'], message: 'Select one or more categories only.' });
  if (value.scope === 'ALL_PRODUCTS' && (value.categoryIds.length || value.productIds.length)) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'All-products codes cannot include a product or category selection.' });
  if (value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End time must be after start time.' });
});

type CartRecord = { id: string; productId: string; quantity: number; variant?: { priceMinor: number } | null; product: { sellerId: string | null; categoryId: string | null; priceMinor: number; salePriceMinor: number | null } };
type Db = PrismaClient | Prisma.TransactionClient;
const normalizedCode = (code: string) => code.trim().replace(/\s+/g, '').toLocaleUpperCase('en-US');
function sellerUser(res: Response) { return res.locals.user as { id: string; role: Role; sellerId?: string }; }
function discountLines(items: CartRecord[], categoryPaths = new Map<string, string[]>()): DiscountCartLine[] {
  return items.map(item => ({ cartItemId: item.id, productId: item.productId, categoryId: item.product.categoryId, categoryIds: categoryPaths.get(item.productId), sellerId: item.product.sellerId, quantity: item.quantity, unitPriceMinor: effectiveUnitPriceMinor({ product: item.product, variant: item.variant }) }));
}

async function cartCategoryPaths(db: Db, items: CartRecord[]) {
  const categoryIds = new Set(items.map(item => item.product.categoryId).filter((id): id is string => Boolean(id)));
  const unresolved = new Set(categoryIds);
  const parentById = new Map<string, string | null>();
  for (let depth = 0; depth < 3 && unresolved.size; depth += 1) {
    const rows = await db.category.findMany({ where: { id: { in: [...unresolved] } }, select: { id: true, parentId: true } });
    unresolved.clear();
    for (const row of rows) {
      parentById.set(row.id, row.parentId);
      if (row.parentId && !parentById.has(row.parentId)) unresolved.add(row.parentId);
    }
  }
  return new Map(items.map(item => {
    const path: string[] = [];
    let currentId = item.product.categoryId;
    while (currentId && path.length < 3) { path.push(currentId); currentId = parentById.get(currentId) ?? null; }
    return [item.productId, path];
  }));
}

export async function resolveCartProductDiscount(db: Db, code: string, items: CartRecord[], now = new Date()) {
  const discount = await db.sellerProductDiscount.findUnique({ where: { normalizedCode: normalizedCode(code) }, include: { products: { select: { productId: true } }, categories: { select: { categoryId: true } } } });
  if (!discount) throw fail(400, 'Discount code was not found.');
  if (!discount.enabled) throw fail(409, 'This discount code is inactive.');
  if (discount.startsAt && discount.startsAt > now) throw fail(409, 'This discount code is not active yet.');
  if (discount.endsAt && discount.endsAt <= now) throw fail(409, 'This discount code has expired.');
  if (discount.usageLimit !== null && discount.usesCount >= discount.usageLimit) throw fail(409, 'This discount code has reached its usage limit.');
  const definition: DiscountDefinition = { ...discount, productIds: discount.products.map(item => item.productId), categoryIds: discount.categories.map(item => item.categoryId) };
  try {
    const categoryPaths = discount.scope === 'SELECTED_CATEGORIES' ? await cartCategoryPaths(db, items) : undefined;
    const quote = quoteProductDiscount(definition, discountLines(items, categoryPaths), now);
    return { discount, quote };
  } catch (error) {
    throw fail(409, error instanceof Error ? error.message : 'Discount code cannot be applied.');
  }
}

export function registerProductDiscountRoutes(app: Express) {
  app.get('/api/seller/product-discounts', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = sellerUser(res);
    if (!user.sellerId) throw fail(403, 'Approved seller account required.');
    res.json(await prisma.sellerProductDiscount.findMany({ where: { sellerId: user.sellerId }, include: { products: { include: { product: { select: { id: true, name: true } } } }, categories: { include: { category: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' } }));
  }));

  const save = (update: boolean) => run(async (req, res) => {
    const user = sellerUser(res);
    if (!user.sellerId) throw fail(403, 'Approved seller account required.');
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
    if (!seller?.store) throw fail(403, 'An approved Store is required to manage product discount codes.');
    const input = inputSchema.parse(req.body);
    const code = input.code.trim();
    const normalized = normalizedCode(code);
    const id = update ? param(req.params.id) : undefined;
    const existing = id ? await prisma.sellerProductDiscount.findFirst({ where: { id, sellerId: seller.id } }) : null;
    if (id && !existing) throw fail(404, 'Discount code not found.');
    const conflict = await prisma.sellerProductDiscount.findFirst({ where: { normalizedCode: normalized, ...(existing ? { id: { not: existing.id } } : {}) }, select: { id: true } });
    if (conflict) throw fail(409, 'That code is already in use. Choose a globally unique code.');
    if (input.productIds.length) {
      const products = await prisma.product.findMany({ where: { id: { in: input.productIds }, sellerId: seller.id, status: { not: ProductStatus.ARCHIVED } }, select: { id: true } });
      if (products.length !== input.productIds.length) throw fail(400, 'Every selected product must belong to your Store and be active.');
    }
    if (input.categoryIds.length) {
      const categories = await prisma.category.findMany({ where: { id: { in: input.categoryIds }, status: TaxonomyStatus.ACTIVE }, select: { id: true } });
      if (categories.length !== input.categoryIds.length) throw fail(400, 'Every selected category must be active.');
    }
    const data = {
      name: input.name,
      code,
      normalizedCode: normalized,
      kind: input.kind,
      scope: input.scope,
      percentBasisPoints: input.kind === 'PERCENTAGE' ? input.percentOff! * 100 : null,
      amountMinor: input.kind === 'FIXED' ? input.amountMinor! : null,
      currency: seller.store.baseCurrency,
      minimumSubtotalMinor: input.minimumSubtotalMinor ?? null,
      usageLimit: input.usageLimit ?? null,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      enabled: input.enabled
    };
    const record = await prisma.$transaction(async tx => {
      if (existing) {
        await tx.sellerProductDiscountProduct.deleteMany({ where: { discountId: existing.id } });
        await tx.sellerProductDiscountCategory.deleteMany({ where: { discountId: existing.id } });
      }
      const discount = existing
        ? await tx.sellerProductDiscount.update({ where: { id: existing.id }, data: { ...data, products: { create: input.productIds.map(productId => ({ productId })) }, categories: { create: input.categoryIds.map(categoryId => ({ categoryId })) } } })
        : await tx.sellerProductDiscount.create({ data: { ...data, sellerId: seller.id, products: { create: input.productIds.map(productId => ({ productId })) }, categories: { create: input.categoryIds.map(categoryId => ({ categoryId })) } } });
      await tx.auditLog.create({ data: { actorId: user.id, action: existing ? 'SELLER_PRODUCT_DISCOUNT_UPDATED' : 'SELLER_PRODUCT_DISCOUNT_CREATED', entity: 'SellerProductDiscount', entityId: discount.id, metadata: { sellerId: seller.id, code: discount.code, scope: discount.scope, kind: discount.kind } } });
      return discount;
    });
    res.status(existing ? 200 : 201).json(record);
  });

  app.post('/api/seller/product-discounts', requireAuth, requireRole(Role.SELLER), save(false));
  app.patch('/api/seller/product-discounts/:id', requireAuth, requireRole(Role.SELLER), save(true));
  app.patch('/api/seller/product-discounts/:id/enabled', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = sellerUser(res);
    if (!user.sellerId) throw fail(403, 'Approved seller account required.');
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const existing = await prisma.sellerProductDiscount.findFirst({ where: { id: param(req.params.id), sellerId: user.sellerId } });
    if (!existing) throw fail(404, 'Discount code not found.');
    const updated = await prisma.sellerProductDiscount.update({ where: { id: existing.id }, data: { enabled: input.enabled } });
    await audit(user.id, input.enabled ? 'SELLER_PRODUCT_DISCOUNT_ENABLED' : 'SELLER_PRODUCT_DISCOUNT_DISABLED', 'SellerProductDiscount', updated.id, { sellerId: user.sellerId, code: updated.code });
    res.json(updated);
  }));
  app.delete('/api/seller/product-discounts/:id', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = sellerUser(res);
    if (!user.sellerId) throw fail(403, 'Approved seller account required.');
    const existing = await prisma.sellerProductDiscount.findFirst({ where: { id: param(req.params.id), sellerId: user.sellerId } });
    if (!existing) throw fail(404, 'Discount code not found.');
    await prisma.sellerProductDiscount.delete({ where: { id: existing.id } });
    await audit(user.id, 'SELLER_PRODUCT_DISCOUNT_DELETED', 'SellerProductDiscount', existing.id, { sellerId: user.sellerId, code: existing.code });
    res.status(204).send();
  }));

  app.post('/api/cart/discount/validate', requireAuth, run(async (req, res) => {
    const user = sellerUser(res);
    const input = z.object({ code: z.string().trim().min(3).max(64) }).strict().parse(req.body);
    const cart = await prisma.cart.findUnique({
      where: { userId: user.id },
      include: { items: { include: {
        variant: true,
        product: { select: { sellerId: true, categoryId: true, priceMinor: true, salePriceMinor: true } }
      } } }
    });
    if (!cart?.items.length) throw fail(400, 'Your cart is empty.');
    const { discount, quote } = await resolveCartProductDiscount(prisma, input.code, cart.items);
    res.json({ code: discount.code, name: discount.name, currency: discount.currency, discountMinor: quote.discountMinor, eligibleSubtotalMinor: quote.eligibleSubtotalMinor });
  }));
}
