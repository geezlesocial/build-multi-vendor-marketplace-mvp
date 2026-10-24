import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { OrderStatus, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { audit, hashPassword, prisma, requireAuth, requireRole, tokenHash, verifyPassword } from './security.js';
import { env } from './config.js';
import { accountPreferencesSchema, displayCurrencyAvailable } from './marketplace-domain.js';
import { liveShoppingState } from './live-domain.js';
import { safePayoutMethod } from './platform-domain.js';
import { availableGlobalDisplayCurrencies } from './currency-routes.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const id = z.string().cuid();
const addressInput = z.object({ label: z.string().trim().min(1).max(80), line1: z.string().trim().min(2).max(150), line2: z.string().trim().max(150).optional(), city: z.string().trim().min(2).max(80), region: z.string().trim().min(2).max(80), postalCode: z.string().trim().min(2).max(20), country: z.string().trim().length(2).transform(value => value.toUpperCase()), latitude: z.number().finite().min(-90).max(90).optional(), longitude: z.number().finite().min(-180).max(180).optional(), isDefault: z.boolean().optional() }).strict().superRefine((value, context) => { if ((value.latitude == null) !== (value.longitude == null)) context.addIssue({ code: 'custom', message: 'Latitude and longitude must be supplied together.' }); });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };

export async function sellerDashboardSummary(sellerId: string) {
  const where = { sellerId, status: { not: OrderStatus.CANCELLED } };
  const [orderCount, totals] = await Promise.all([
    prisma.sellerOrder.count({ where }),
    prisma.$queryRaw<Array<{ currency: string; grossMinor: bigint }>>`
      SELECT parent."currency" AS currency, SUM(seller_order."totalMinor") AS "grossMinor"
      FROM "SellerOrder" AS seller_order
      JOIN "ParentOrder" AS parent ON parent."id" = seller_order."parentId"
      WHERE seller_order."sellerId" = ${sellerId}
        AND seller_order."status" <> 'CANCELLED'::"OrderStatus"
      GROUP BY parent."currency"
      ORDER BY parent."currency"
    `
  ]);
  const grossByCurrency = totals.map(row => {
    const grossMinor = Number(row.grossMinor);
    if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) throw new Error('Seller gross total exceeds the supported integer amount range.');
    return { currency: row.currency, grossMinor };
  });
  return { orderCount, grossByCurrency };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function persistedDisplayEstimate(order: { sellerOrders: { items: { displayAmountMinor: number | null; displayCurrency: string | null; fxSnapshotJson: unknown }[]; shippingSnapshotJson: unknown }[] }) {
  const items = order.sellerOrders.flatMap(sellerOrder => sellerOrder.items);
  if (!items.length || items.some(item => !isMinorAmount(item.displayAmountMinor) || !item.displayCurrency)) return null;

  const currencies = new Set(items.map(item => item.displayCurrency!));
  if (currencies.size !== 1) return null;
  const currency = [...currencies][0]!;
  let itemTotalMinor = 0;
  const rateSnapshots = new Map<string, { provider: string; sourceDate: string; fetchedAt: string; rounding: string }>();
  const addRateSnapshot = (value: unknown) => {
    const snapshot = jsonRecord(value);
    if (!snapshot || typeof snapshot.provider !== 'string' || typeof snapshot.sourceDate !== 'string' || typeof snapshot.fetchedAt !== 'string') return false;
    const rounding = typeof snapshot.rounding === 'string' ? snapshot.rounding : 'HALF_UP';
    const key = `${snapshot.provider}|${snapshot.sourceDate}|${snapshot.fetchedAt}|${rounding}`;
    rateSnapshots.set(key, { provider: snapshot.provider, sourceDate: snapshot.sourceDate, fetchedAt: snapshot.fetchedAt, rounding });
    return true;
  };

  for (const item of items) {
    itemTotalMinor += item.displayAmountMinor!;
    if (!Number.isSafeInteger(itemTotalMinor)) return null;
    const snapshot = jsonRecord(item.fxSnapshotJson);
    if (!snapshot || snapshot.purpose !== 'DISPLAY_ESTIMATE_ONLY' || snapshot.quoteCurrency !== currency || snapshot.quoteAmountMinor !== item.displayAmountMinor || !addRateSnapshot(snapshot)) return null;
  }

  let shippingTotalMinor = 0;
  for (const sellerOrder of order.sellerOrders) {
    const shipping = jsonRecord(sellerOrder.shippingSnapshotJson);
    if (!shipping) continue;
    const estimate = jsonRecord(shipping.displayEstimate);
    if (!estimate || estimate.purpose !== 'DISPLAY_ESTIMATE_ONLY' || estimate.currency !== currency || !isMinorAmount(estimate.amountMinor) || !addRateSnapshot(estimate)) return null;
    shippingTotalMinor += estimate.amountMinor;
    if (!Number.isSafeInteger(shippingTotalMinor)) return null;
  }

  const totalMinor = itemTotalMinor + shippingTotalMinor;
  if (!Number.isSafeInteger(totalMinor)) return null;
  return { currency, itemTotalMinor, shippingTotalMinor, totalMinor, purpose: 'DISPLAY_ESTIMATE_ONLY' as const, rateSnapshots: [...rateSnapshots.values()] };
}

export function registerDashboardRoutes(app: Express) {
  app.get('/api/dashboard/access', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const seller = user.sellerId ? await prisma.seller.findUnique({ where: { id: user.sellerId }, select: { id: true, status: true, reason: true, store: { select: { name: true, slug: true } } } }) : null;
    res.json({ buyer: user.role !== Role.ADMIN, seller: seller?.status === SellerStatus.APPROVED, sellerApplication: seller ? { status: seller.status, reason: seller.reason, store: seller.store } : null, affiliateEligible: Boolean(await prisma.affiliateProfile.findUnique({ where: { userId: user.id, status: 'APPROVED' }, select: { id: true } })) });
  }));

  app.get('/api/dashboard/buyer', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    if (user.role === Role.ADMIN) return res.status(403).json({ error: 'Use the separate admin dashboard' });
    const [orders, cart, favorites, conversations, notifications, addresses, affiliate] = await Promise.all([
      prisma.parentOrder.findMany({ where: { buyerId: user.id }, include: { payment: true, sellerOrders: { include: { items: true, seller: { include: { store: true } } } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { inventory: true, seller: { include: { store: true } } } } } } } }),
      prisma.favorite.findMany({ where: { userId: user.id }, include: { product: { include: { inventory: true, seller: { include: { store: true } } } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.conversation.findMany({ where: { buyerId: user.id }, include: { seller: { include: { store: true } }, product: true, messages: { orderBy: { sentAt: 'desc' }, take: 1 } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
      prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.savedAddress.findMany({ where: { userId: user.id }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }] }),
      prisma.affiliateProfile.findUnique({ where: { userId: user.id }, select: { id: true, status: true, referralCode: true } })
    ]);
    res.json({ orders, cart: cart ?? { items: [] }, favorites, conversations, notifications, addresses, affiliate: affiliate?.status === 'APPROVED' ? affiliate : null });
  }));

  app.get('/api/dashboard/orders/:id', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const order = await prisma.parentOrder.findFirst({ where: { id: param(req.params.id), OR: [{ buyerId: user.id }, ...(user.sellerId ? [{ sellerOrders: { some: { sellerId: user.sellerId } } }] : [])] }, include: { payment: true, sellerOrders: { where: user.sellerId && user.role !== Role.ADMIN ? { sellerId: user.sellerId } : undefined, include: { items: true, seller: { include: { store: true } } } } } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ ...order, displayEstimate: persistedDisplayEstimate(order) });
  }));

  app.patch('/api/account/profile', requireAuth, run(async (req, res) => {
    const user = actor(res); const input = z.object({ name: z.string().trim().min(2).max(100) }).strict().parse(req.body);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { name: input.name }, select: { id: true, email: true, name: true, role: true, avatarMediaId: true } });
    res.json({ id: updated.id, email: updated.email, name: updated.name, role: updated.role, ...(updated.avatarMediaId ? { avatarUrl: '/api/account/avatar' } : {}) });
  }));

  app.get('/api/account/preferences', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const [preference, availableDisplayCurrencies] = await Promise.all([
      prisma.userPreference.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id, displayCurrency: env.CURRENCY } }),
      availableGlobalDisplayCurrencies()
    ]);
    res.json({ preference, availableLanguages: ['en', 'fil'], baseCurrency: env.CURRENCY, availableDisplayCurrencies, fxRatesConfigured: availableDisplayCurrencies.length > 1 });
  }));
  app.patch('/api/account/preferences', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = accountPreferencesSchema.parse(req.body);
    const availableDisplayCurrencies = await availableGlobalDisplayCurrencies();
    if (input.displayCurrency && !displayCurrencyAvailable(input.displayCurrency, env.CURRENCY, availableDisplayCurrencies)) return res.status(409).json({ error: 'That display currency is unavailable until a fresh verified reference rate or authorized manual rate is configured.' });
    const preference = await prisma.userPreference.upsert({ where: { userId: user.id }, update: input, create: { userId: user.id, language: input.language ?? 'en', displayCurrency: input.displayCurrency ?? env.CURRENCY } });
    res.json({ preference, availableLanguages: ['en', 'fil'], baseCurrency: env.CURRENCY, availableDisplayCurrencies, fxRatesConfigured: availableDisplayCurrencies.length > 1 });
  }));
  app.get('/api/account/notification-preferences', requireAuth, run(async (_req, res) => res.json(await prisma.notificationPreference.findMany({ where: { userId: actor(res).id }, orderBy: [{ category: 'asc' }, { channel: 'asc' }] }))));
  app.patch('/api/account/notification-preferences', requireAuth, run(async (req, res) => {
    const input = z.object({ channel: z.enum(['IN_APP', 'EMAIL', 'WEB_PUSH', 'ANDROID_PUSH']), category: z.string().trim().min(2).max(80), enabled: z.boolean() }).strict().parse(req.body);
    res.json(await prisma.notificationPreference.upsert({ where: { userId_channel_category: { userId: actor(res).id, channel: input.channel, category: input.category } }, update: { enabled: input.enabled }, create: { userId: actor(res).id, ...input } }));
  }));
  app.patch('/api/account/password', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10).max(128), confirmPassword: z.string().min(10).max(128) }).strict().parse(req.body);
    if (input.newPassword !== input.confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    if (!record || !(await verifyPassword(input.currentPassword, record.passwordHash))) return res.status(401).json({ error: 'Current password is incorrect' });
    if (input.currentPassword === input.newPassword) return res.status(400).json({ error: 'Choose a different new password' });
    const currentToken = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined;
    const currentTokenHash = currentToken ? tokenHash(currentToken) : null;
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.newPassword) } });
      await tx.session.deleteMany({ where: { userId: user.id, ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {}) } });
    });
    await audit(user.id, 'ACCOUNT_PASSWORD_CHANGED', 'User', user.id);
    res.status(204).send();
  }));
  app.get('/api/account/addresses', requireAuth, run(async (_req, res) => res.json(await prisma.savedAddress.findMany({ where: { userId: actor(res).id }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }] }))));
  app.post('/api/account/addresses', requireAuth, run(async (req, res) => { const user = actor(res); const input = addressInput.parse(req.body); const address = await prisma.$transaction(async tx => { if (input.isDefault) await tx.savedAddress.updateMany({ where: { userId: user.id }, data: { isDefault: false } }); return tx.savedAddress.create({ data: { ...input, userId: user.id } }); }); res.status(201).json(address); }));
  app.patch('/api/account/addresses/:id', requireAuth, run(async (req, res) => { const user = actor(res); const input = addressInput.partial().parse(req.body); const existing = await prisma.savedAddress.findFirst({ where: { id: param(req.params.id), userId: user.id } }); if (!existing) return res.status(404).json({ error: 'Address not found' }); const address = await prisma.$transaction(async tx => { if (input.isDefault) await tx.savedAddress.updateMany({ where: { userId: user.id }, data: { isDefault: false } }); return tx.savedAddress.update({ where: { id: existing.id }, data: input }); }); res.json(address); }));
  app.delete('/api/account/addresses/:id', requireAuth, run(async (req, res) => { const result = await prisma.savedAddress.deleteMany({ where: { id: param(req.params.id), userId: actor(res).id } }); if (!result.count) return res.status(404).json({ error: 'Address not found' }); res.status(204).send(); }));

  app.get('/api/seller/products', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (_req, res) => { const user = actor(res); if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' }); res.json(await prisma.product.findMany({ where: { sellerId: user.sellerId }, include: { inventory: true, variants: true, category: true, images: { orderBy: { id: 'asc' } } }, orderBy: { updatedAt: 'desc' }, take: 200 })); }));
  app.patch('/api/seller/products/:id/archive', requireAuth, requireRole(Role.SELLER), run(async (req, res) => { const user = actor(res); if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' }); const product = await prisma.product.findFirst({ where: { id: param(req.params.id), sellerId: user.sellerId } }); if (!product) return res.status(404).json({ error: 'Product not found' }); const updated = await prisma.product.update({ where: { id: product.id }, data: { status: ProductStatus.ARCHIVED } }); await audit(user.id, 'SELLER_PRODUCT_ARCHIVED', 'Product', updated.id); res.json(updated); }));

  app.get('/api/dashboard/seller', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (_req, res) => {
    const user = actor(res); if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' });
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
    if (!seller) return res.status(403).json({ error: 'Approved seller required' });
    const [summary, products, orders, conversations, payoutMethods, payouts, live] = await Promise.all([
      sellerDashboardSummary(seller.id),
      prisma.product.findMany({ where: { sellerId: seller.id }, include: { inventory: true, variants: true, category: true, images: { orderBy: { id: 'asc' } } }, orderBy: { updatedAt: 'desc' }, take: 200 }),
      prisma.parentOrder.findMany({ where: { sellerOrders: { some: { sellerId: seller.id } } }, include: { payment: true, sellerOrders: { where: { sellerId: seller.id }, include: { items: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.conversation.findMany({ where: { sellerId: seller.id }, include: { buyer: { select: { name: true } }, product: true, messages: { orderBy: { sentAt: 'desc' }, take: 1 } }, orderBy: { updatedAt: 'desc' }, take: 100 }),
      prisma.sellerPayoutMethod.findMany({ where: { sellerId: seller.id }, orderBy: { createdAt: 'desc' } }),
      prisma.sellerPayout.findMany({ where: { sellerId: seller.id }, include: { payoutMethod: { select: { type: true, maskedIdentifier: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      liveShoppingState()
    ]);
    res.json({ store: seller.store, summary, products, orders, conversations, payoutMethods: payoutMethods.map(safePayoutMethod), payouts, live });
  }));
}
