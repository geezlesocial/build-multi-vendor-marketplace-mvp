import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { addressSchema } from './validation.js';
import { effectiveUnitPriceMinor } from './product-pricing.js';
import {
  normalizeCountryCode, normalizeShippingLocation, quoteShippingService, shippingAddressHash,
  shippingCartHash, signShippingQuote, verifyShippingQuote, type ShippingAddress,
  type ShippingCartItem, type ShippingService, type ShippingQuoteSelection, type SignedShippingQuote
} from './shipping-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const MAX_ORDER_TOTAL_MINOR = 2_147_483_647;

function assertOrderTotalFitsDatabase(totalMinor: number) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || totalMinor > MAX_ORDER_TOTAL_MINOR) {
    throw fail(409, 'Order total exceeds the supported integer minor-unit limit.', 'ORDER_TOTAL_OUT_OF_RANGE');
  }
}

const zoneSchema = z.object({
  countryCode: z.string().trim().length(2).transform(normalizeCountryCode),
  region: z.string().trim().max(100).optional().default(''),
  city: z.string().trim().max(100).optional().default('')
}).strict().superRefine((zone, context) => {
  if (zone.city && !zone.region) context.addIssue({ code: z.ZodIssueCode.custom, path: ['region'], message: 'Add a state or province when specifying a city.' });
  if ((zone.region && !normalizeShippingLocation(zone.region)) || (zone.city && !normalizeShippingLocation(zone.city))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Zone locations must contain letters or numbers.' });
});
const zonesSchema = z.array(zoneSchema).min(1).max(30).superRefine((zones, context) => {
  const seen = new Set<string>();
  zones.forEach((zone, index) => {
    const key = `${zone.countryCode}|${normalizeShippingLocation(zone.region)}|${normalizeShippingLocation(zone.city)}`;
    if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'Duplicate zone scope would be ambiguous.' });
    seen.add(key);
  });
});
const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120), feeMinor: z.number().int().min(0).max(2_000_000_000),
  supportsCod: z.boolean().optional(),
  carrierProviderId: z.string().trim().min(1).max(64).nullable().optional(),
  estimatedMinDays: z.number().int().min(0).max(365).nullable().optional(),
  estimatedMaxDays: z.number().int().min(0).max(365).nullable().optional(), enabled: z.boolean().optional(), zones: zonesSchema
}).strict().superRefine((service, context) => {
  if (service.estimatedMinDays != null && service.estimatedMaxDays != null && service.estimatedMaxDays < service.estimatedMinDays) context.addIssue({ code: z.ZodIssueCode.custom, path: ['estimatedMaxDays'], message: 'Maximum delivery days must be at least the minimum.' });
});
const discountSchema = z.object({
  serviceId: z.string().cuid(), name: z.string().trim().min(2).max(120), type: z.enum(['FREE', 'FIXED', 'PERCENTAGE']),
  amountMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  basisPoints: z.number().int().min(0).max(10_000).nullable().optional(), priority: z.number().int().min(-100_000).max(100_000).default(0),
  startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
  minimumQuantity: z.number().int().positive().max(100_000).nullable().optional(),
  minimumSubtotalMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  productIds: z.array(z.string().cuid()).min(1).max(100)
}).strict().superRefine((discount, context) => {
  if (discount.type === 'FREE' && (discount.amountMinor != null || discount.basisPoints != null)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Free shipping discounts do not take an amount.' });
  if (discount.type === 'FIXED' && (discount.amountMinor == null || discount.basisPoints != null)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a fixed discount in minor currency units.' });
  if (discount.type === 'PERCENTAGE' && (discount.basisPoints == null || discount.amountMinor != null)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a percentage discount in basis points.' });
  if (discount.startsAt && discount.endsAt && new Date(discount.endsAt) <= new Date(discount.startsAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'Discount end must be after its start.' });
  if (new Set(discount.productIds).size !== discount.productIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['productIds'], message: 'Each product can be selected only once.' });
});
const quoteSchema = z.object({ address: addressSchema, serviceSelections: z.record(z.string(), z.string().cuid()).optional().default({}) }).strict();

export type ShippingCartRecord = {
  productId: string; variantId: string | null; quantity: number;
  variant: { id: string; priceMinor: number; currency: string } | null;
  product: { id: string; name: string; priceMinor: number; salePriceMinor?: number | null; sellerId: string | null; status: ProductStatus; productType: { requiresShipping: boolean }; seller: { id: string; status: SellerStatus; store: { name: string } | null } | null };
};

async function authorizedSeller(actorUser: ReturnType<typeof actor>) {
  if (!actorUser.sellerId) throw fail(403, 'Seller scope required.');
  const seller = await prisma.seller.findFirst({ where: { id: actorUser.sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
  if (!seller?.store) throw fail(403, 'An approved Store is required to manage shipping.');
  if (actorUser.role === Role.ADMIN && seller.store.isPlatformStore) return seller;
  if (seller.userId !== actorUser.id) {
    const membership = await prisma.sellerStaff.findFirst({ where: { sellerId: seller.id, userId: actorUser.id, canManageShipping: true }, select: { id: true } });
    if (!membership) throw fail(403, 'The Store owner has not granted shipping-management permission.');
  }
  return seller;
}

function zoneRows(zones: z.infer<typeof zonesSchema>) {
  return zones.map(zone => ({
    countryCode: zone.countryCode,
    regionKey: normalizeShippingLocation(zone.region), regionLabel: zone.region || null,
    cityKey: normalizeShippingLocation(zone.city), cityLabel: zone.city || null
  }));
}

function cartLines(items: ShippingCartRecord[]): ShippingCartItem[] {
  return items.filter(item => item.product.productType.requiresShipping).map(item => ({ productId: item.productId, variantId: item.variantId, sellerId: item.product.sellerId, quantity: item.quantity, unitPriceMinor: effectiveUnitPriceMinor(item), productName: item.product.name }));
}

export async function buildSellerShippingQuote(
  db: Prisma.TransactionClient,
  userId: string,
  address: ShippingAddress,
  items: ShippingCartRecord[],
  selections: Record<string, string>,
  now = new Date()
) {
  const lines = cartLines(items);
  const itemSubtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
  assertOrderTotalFitsDatabase(itemSubtotalMinor);
  const sellerIds = [...new Set(lines.map(line => line.sellerId).filter((value): value is string => Boolean(value)))].sort();
  if (!sellerIds.length) return { currency: env.CURRENCY, itemSubtotalMinor, shippingTotalMinor: 0, totalMinor: itemSubtotalMinor, shipments: [], quoteToken: null as string | null, expiresAt: null as number | null };

  const invalidSeller = items.find(item => item.product.productType.requiresShipping && item.product.sellerId && (item.product.status !== ProductStatus.APPROVED || item.product.seller?.status !== SellerStatus.APPROVED));
  if (invalidSeller) throw fail(409, 'A seller or product in the cart is no longer eligible for checkout.', 'SHIPPING_CART_STALE');
  const services = await db.sellerShippingService.findMany({
    where: { sellerId: { in: sellerIds }, enabled: true, currency: env.CURRENCY },
    include: { carrierProvider: true, zones: true, discounts: { where: { enabled: true }, include: { products: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }]
  });
  const shipments: Array<{ sellerId: string; storeName: string; options: unknown[]; selected: ShippingQuoteSelection }> = [];
  for (const sellerId of sellerIds) {
    const sellerItems = items.filter(item => item.product.sellerId === sellerId);
    const sellerLines = lines.filter(line => line.sellerId === sellerId);
    const options = services.filter(service => service.sellerId === sellerId && (!service.carrierProviderId || service.carrierProvider?.enabled)).flatMap(service => {
      const option = quoteShippingService(service as ShippingService, sellerLines, address, env.CURRENCY, now);
      return option ? [option] : [];
    });
    if (!options.length) {
      const storeName = sellerItems[0]?.product.seller?.store?.name ?? 'This Store';
      throw fail(409, `No active shipping service covers this destination for ${storeName}. Ask the Store to configure delivery coverage.`, 'SHIPPING_UNAVAILABLE');
    }
    const selectedId = selections[sellerId] ?? options[0]!.serviceId;
    const selected = options.find(option => option.serviceId === selectedId);
    if (!selected) throw fail(409, 'The selected shipping service is no longer available for this destination. Recalculate shipping.', 'SHIPPING_QUOTE_STALE');
    shipments.push({ sellerId, storeName: sellerItems[0]?.product.seller?.store?.name ?? 'Independent store', options, selected: { ...selected, sellerId } });
  }
  const shippingTotalMinor = shipments.reduce((sum, shipment) => sum + shipment.selected.shippingMinor, 0);
  assertOrderTotalFitsDatabase(itemSubtotalMinor + shippingTotalMinor);
  const expiresAt = now.getTime() + 15 * 60_000;
  const payload: SignedShippingQuote = {
    version: 1, userId, expiresAt, cartHash: shippingCartHash(lines), addressHash: shippingAddressHash(address),
    selections: shipments.map(shipment => shipment.selected).sort((a, b) => a.sellerId.localeCompare(b.sellerId))
  };
  return {
    currency: env.CURRENCY, itemSubtotalMinor, shippingTotalMinor, totalMinor: itemSubtotalMinor + shippingTotalMinor,
    shipments, quoteToken: signShippingQuote(payload, env.PASSWORD_PEPPER), expiresAt
  };
}

export function registerShippingRoutes(app: Express) {
  app.get('/api/seller/shipping', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (_req, res) => {
    const seller = await authorizedSeller(actor(res));
    const [services, carrierProviders] = await Promise.all([
      prisma.sellerShippingService.findMany({ where: { sellerId: seller.id }, include: { carrierProvider: true, zones: true, discounts: { include: { products: { include: { product: { select: { id: true, name: true } } } } } }, _count: { select: { discounts: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      prisma.shippingCarrierProvider.findMany({ where: { enabled: true }, select: { id: true, code: true, name: true, countries: true, trackingUrlTemplate: true }, orderBy: { name: 'asc' } })
    ]);
    res.json({ currency: env.CURRENCY, services, carrierProviders });
  }));

  app.post('/api/seller/shipping/services', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const actorUser = actor(res); const seller = await authorizedSeller(actorUser); const input = serviceSchema.parse(req.body);
    const created = await prisma.$transaction(async tx => {
      if (input.carrierProviderId && !await tx.shippingCarrierProvider.findFirst({ where: { id: input.carrierProviderId, enabled: true }, select: { id: true } })) throw fail(409, 'That carrier is unavailable. Refresh the carrier list and try again.');
      const service = await tx.sellerShippingService.create({ data: { sellerId: seller.id, carrierProviderId: input.carrierProviderId ?? null, name: input.name, feeMinor: input.feeMinor, currency: env.CURRENCY, estimatedMinDays: input.estimatedMinDays ?? null, estimatedMaxDays: input.estimatedMaxDays ?? null, supportsCod: input.supportsCod ?? false, enabled: input.enabled ?? true } });
      await tx.sellerShippingZone.createMany({ data: zoneRows(input.zones).map(zone => ({ ...zone, serviceId: service.id })) });
      await tx.auditLog.create({ data: { actorId: actorUser.id, action: 'SELLER_SHIPPING_SERVICE_CREATED', entity: 'SellerShippingService', entityId: service.id, metadata: { sellerId: seller.id, feeMinor: service.feeMinor, currency: service.currency, supportsCod: service.supportsCod, zoneCount: input.zones.length } } });
      return service;
    });
    res.status(201).json(created);
  }));

  app.patch('/api/seller/shipping/services/:id', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const actorUser = actor(res); const seller = await authorizedSeller(actorUser); const serviceId = param(req.params.id); const input = serviceSchema.parse(req.body);
    const current = await prisma.sellerShippingService.findFirst({ where: { id: serviceId, sellerId: seller.id } });
    if (!current) throw fail(404, 'Shipping service not found for this Store.');
    const updated = await prisma.$transaction(async tx => {
      if (input.carrierProviderId && !await tx.shippingCarrierProvider.findFirst({ where: { id: input.carrierProviderId, enabled: true }, select: { id: true } })) throw fail(409, 'That carrier is unavailable. Refresh the carrier list and try again.');
      const service = await tx.sellerShippingService.update({ where: { id: current.id }, data: { carrierProviderId: input.carrierProviderId ?? null, name: input.name, feeMinor: input.feeMinor, currency: env.CURRENCY, estimatedMinDays: input.estimatedMinDays ?? null, estimatedMaxDays: input.estimatedMaxDays ?? null, supportsCod: input.supportsCod ?? current.supportsCod, enabled: input.enabled ?? current.enabled } });
      await tx.sellerShippingZone.deleteMany({ where: { serviceId: service.id } });
      await tx.sellerShippingZone.createMany({ data: zoneRows(input.zones).map(zone => ({ ...zone, serviceId: service.id })) });
      await tx.auditLog.create({ data: { actorId: actorUser.id, action: 'SELLER_SHIPPING_SERVICE_UPDATED', entity: 'SellerShippingService', entityId: service.id, metadata: { sellerId: seller.id, old: { name: current.name, enabled: current.enabled, feeMinor: current.feeMinor, supportsCod: current.supportsCod }, new: { name: service.name, enabled: service.enabled, feeMinor: service.feeMinor, supportsCod: service.supportsCod, zoneCount: input.zones.length } } } });
      return service;
    });
    res.json(updated);
  }));

  app.post('/api/seller/shipping/services/:id/toggle', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const actorUser = actor(res); const seller = await authorizedSeller(actorUser); const enabled = z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled;
    const current = await prisma.sellerShippingService.findFirst({ where: { id: param(req.params.id), sellerId: seller.id } });
    if (!current) throw fail(404, 'Shipping service not found for this Store.');
    const result = await prisma.$transaction(async tx => {
      const service = await tx.sellerShippingService.update({ where: { id: current.id }, data: { enabled } });
      await tx.auditLog.create({ data: { actorId: actorUser.id, action: enabled ? 'SELLER_SHIPPING_SERVICE_ENABLED' : 'SELLER_SHIPPING_SERVICE_DISABLED', entity: 'SellerShippingService', entityId: service.id, metadata: { sellerId: seller.id, old: current.enabled, new: enabled } } });
      return service;
    });
    res.json(result);
  }));

  app.post('/api/seller/shipping/discounts', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const actorUser = actor(res); const seller = await authorizedSeller(actorUser); const input = discountSchema.parse(req.body);
    const service = await prisma.sellerShippingService.findFirst({ where: { id: input.serviceId, sellerId: seller.id } });
    if (!service) throw fail(404, 'Shipping service not found for this Store.');
    const products = await prisma.product.findMany({ where: { id: { in: input.productIds }, sellerId: seller.id, status: ProductStatus.APPROVED }, select: { id: true } });
    if (products.length !== input.productIds.length) throw fail(400, 'Every discount product must be an approved listing owned by this Store.');
    const discount = await prisma.$transaction(async tx => {
      const created = await tx.sellerShippingDiscount.create({ data: { serviceId: service.id, name: input.name, type: input.type, amountMinor: input.type === 'FIXED' ? input.amountMinor : null, basisPoints: input.type === 'PERCENTAGE' ? input.basisPoints : null, priority: input.priority, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null, minimumQuantity: input.minimumQuantity ?? null, minimumSubtotalMinor: input.minimumSubtotalMinor ?? null, products: { create: products.map(product => ({ productId: product.id })) } }, include: { products: true } });
      await tx.auditLog.create({ data: { actorId: actorUser.id, action: 'SELLER_SHIPPING_DISCOUNT_CREATED', entity: 'SellerShippingDiscount', entityId: created.id, metadata: { sellerId: seller.id, serviceId: service.id, type: created.type, productCount: products.length, priority: created.priority } } });
      return created;
    });
    res.status(201).json(discount);
  }));

  app.patch('/api/seller/shipping/discounts/:id', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const actorUser = actor(res); const seller = await authorizedSeller(actorUser); const enabled = z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled;
    const current = await prisma.sellerShippingDiscount.findFirst({ where: { id: param(req.params.id), service: { sellerId: seller.id } } });
    if (!current) throw fail(404, 'Shipping discount not found for this Store.');
    const updated = await prisma.$transaction(async tx => {
      const result = await tx.sellerShippingDiscount.update({ where: { id: current.id }, data: { enabled } });
      await tx.auditLog.create({ data: { actorId: actorUser.id, action: enabled ? 'SELLER_SHIPPING_DISCOUNT_ENABLED' : 'SELLER_SHIPPING_DISCOUNT_DISABLED', entity: 'SellerShippingDiscount', entityId: result.id, metadata: { sellerId: seller.id, old: current.enabled, new: enabled } } });
      return result;
    });
    res.json(updated);
  }));

  app.post('/api/shipping/quote', requireAuth, run(async (req, res) => {
    const actorUser = actor(res); const input = quoteSchema.parse(req.body);
    const quote = await prisma.$transaction(async tx => {
      const settings = await tx.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { sellerShippingEnabled: true } });
      if (settings?.sellerShippingEnabled === false) throw fail(409, 'Seller-managed shipping is currently unavailable.', 'SHIPPING_DISABLED');
      const cart = await tx.cart.findUnique({
        where: { userId: actorUser.id },
        include: {
          items: {
            include: {
              variant: true,
              product: { include: { productType: true, seller: { include: { store: true } } } }
            }
          }
        }
      });
      if (!cart?.items.length) throw fail(400, 'Cart is empty.');
      return buildSellerShippingQuote(tx, actorUser.id, input.address, cart.items as ShippingCartRecord[], input.serviceSelections);
    });
    res.json(quote);
  }));

  app.get('/api/admin/shipping', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [settings, services] = await Promise.all([
      prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { sellerShippingEnabled: true } }),
      prisma.sellerShippingService.findMany({ include: { seller: { include: { store: true } }, zones: true, discounts: { include: { products: { include: { product: { select: { id: true, name: true } } } } } }, _count: { select: { discounts: true } } }, orderBy: { updatedAt: 'desc' }, take: 200 })
    ]);
    res.json({ enabled: settings?.sellerShippingEnabled ?? true, services });
  }));
}

export function verifyCheckoutShippingQuote(input: {
  token: string | undefined; userId: string; address: ShippingAddress; items: ShippingCartRecord[]; selections?: Record<string, string>; now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!input.token) throw fail(409, 'Calculate shipping before placing this order.', 'SHIPPING_QUOTE_REQUIRED');
  const payload = verifyShippingQuote(input.token, env.PASSWORD_PEPPER);
  if (!payload || payload.userId !== input.userId || payload.expiresAt <= now.getTime()) throw fail(409, 'Shipping quote is invalid or expired. Recalculate shipping.', 'SHIPPING_QUOTE_STALE');
  const lines = cartLines(input.items);
  if (payload.cartHash !== shippingCartHash(lines) || payload.addressHash !== shippingAddressHash(input.address)) throw fail(409, 'Your cart or delivery address changed. Recalculate shipping.', 'SHIPPING_QUOTE_STALE');
  const selections = Object.fromEntries(payload.selections.map(selection => [selection.sellerId, selection.serviceId]));
  if (input.selections && JSON.stringify(Object.entries(selections).sort()) !== JSON.stringify(Object.entries(input.selections).sort())) throw fail(409, 'Shipping selection changed. Recalculate shipping.', 'SHIPPING_QUOTE_STALE');
  return payload;
}

export function assertShippingSelectionsMatch(payload: SignedShippingQuote, current: ShippingQuoteSelection[]) {
  const expected = [...payload.selections].sort((a, b) => a.sellerId.localeCompare(b.sellerId));
  const actual = [...current].sort((a, b) => a.sellerId.localeCompare(b.sellerId));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw fail(409, 'Shipping fees or eligibility changed. Recalculate shipping before placing your order.', 'SHIPPING_QUOTE_STALE');
}
