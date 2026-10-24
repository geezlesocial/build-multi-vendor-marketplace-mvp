import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { AffiliateAdjustmentType, ApprovalPolicy, Prisma, PaymentMethod, PaymentStatus, ProductStatus, Role, SellerStatus, OrderStatus } from '@prisma/client';
import type { Stripe as StripeType } from 'stripe';
import { env } from './config.js';
import { prisma, hashPassword, verifyPassword, createSession, currentUser, requireAuth, requireRole, audit, safeUser } from './security.js';
import { registerSchema, loginSchema, checkoutSchema, productSchema, variantSchema, posSchema, settingSchema, liveSessionSchema, liveReportSchema } from './validation.js';
import { capturePaypalOrder, createPaypalOrder, createStripeCheckout, stripe, verifyPaypalWebhook } from './payments.js';
import { eligibleProducts, eligibleSeller, liveShoppingState, publicLiveSession, requireLiveShopping, canTransitionLiveSession } from './live-domain.js';
import { liveProvider } from './live-provider.js';
import { registerContentRoutes } from './content-routes.js';
import { publishDueContent } from './content-scheduler.js';
import { registerGrowthRoutes } from './growth-routes.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { registerDashboardRoutes, sellerDashboardSummary } from './dashboard-routes.js';
import { registerMarketplaceRoutes } from './marketplace-routes.js';
import { registerWalletRoutes } from './wallet-routes.js';
import { registerAvatarRoutes } from './avatar-routes.js';
import { registerStorePlanRoutes } from './store-plan-routes.js';
import { registerIntegrationRoutes } from './integration-routes.js';
import { registerStoreContentRoutes } from './store-content-routes.js';
import { registerStoreMediaRoutes } from './store-media-routes.js';
import { registerBrandingMediaRoutes } from './branding-media-routes.js';
import { registerStoreGrowthRoutes } from './store-growth-routes.js';
import { registerProductMediaRoutes } from './product-media-routes.js';
import { registerShippingRoutes } from './shipping-routes.js';
import { registerCurrencyRoutes } from './currency-routes.js';
import { registerCommissionRoutes } from './commission-routes.js';
import { applicableSellerCommissionPolicy, makeCommissionSnapshot, accrueSellerCommissionsForPaidOrder, reverseSellerCommissionForOrder } from './seller-commission.js';
import { livePaymentActivationBlock } from './provider-activation.js';
import { asStorePlanEntitlements, effectiveStorePlan, isAtLimit } from './store-plan-domain.js';
import { reverseAffiliateForOrderInTransaction, settleAffiliateForPaidOrderInTransaction } from './affiliate-ledger.js';
import { referralTokenHash, verifySignedReferralToken } from './growth-domain.js';
import { createApiRateLimiters, resolveApiRateLimitOptions } from './api-rate-limits.js';
import { assertShippingSelectionsMatch, buildSellerShippingQuote, verifyCheckoutShippingQuote, type ShippingCartRecord } from './shipping-routes.js';
import { convertMinorExact, decimalToMinorExact } from './currency-domain.js';
import { latestDisplayRate } from './currency-routes.js';
import { matchesPersistedPaymentEvent, reconcileVerifiedPaymentEvent, type VerifiedPaymentEvent } from './payment-webhook-reconciliation.js';
import { paypalWebhookEventToVerifiedPaymentEvent } from './paypal-webhook-event.js';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/api/webhooks/') || req.path === '/api/auth/login' || req.path === '/api/auth/register') return next();
  const csrfCookie = req.cookies?.marketplace_csrf as string | undefined;
  const csrfHeader = req.get('x-csrf-token');
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) return res.status(403).json({ error: 'CSRF validation failed' });
  next();
});
const { credentialLimiter, apiLimiter } = createApiRateLimiters(resolveApiRateLimitOptions({
  NODE_ENV: env.NODE_ENV,
  E2E_API_RATE_LIMIT_OVERRIDE: process.env.E2E_API_RATE_LIMIT_OVERRIDE,
  DATABASE_URL: env.DATABASE_URL,
  E2E_DATABASE_URL: process.env.E2E_DATABASE_URL,
  WALLET_FUNDING_SANDBOX_ID: env.WALLET_FUNDING_SANDBOX_ID,
  WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST: env.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST
}));
app.use('/api', apiLimiter);
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
registerContentRoutes(app);
registerGrowthRoutes(app);
registerMarketplaceRoutes(app);
registerPlatformRoutes(app);
registerDashboardRoutes(app);
registerWalletRoutes(app);
registerAvatarRoutes(app);
registerStorePlanRoutes(app);
registerIntegrationRoutes(app);
registerStoreContentRoutes(app);
registerStoreMediaRoutes(app);
registerBrandingMediaRoutes(app);
registerStoreGrowthRoutes(app);
registerProductMediaRoutes(app);
registerShippingRoutes(app);
registerCurrencyRoutes(app);
registerCommissionRoutes(app);
if (process.env.NODE_ENV !== 'test') setInterval(() => publishDueContent().catch(error => console.error(error instanceof Error ? error.message : 'Content scheduler failed')), 60_000);

const asyncRoute = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);
const routeParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const orderNumber = () => `MV-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

app.get('/health', (_req, res) => res.json({ ok: true, service: 'marketplace-api' }));
app.get('/ready', asyncRoute(async (_req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); }));

app.post('/api/auth/register', credentialLimiter, asyncRoute(async (req, res) => {
  const input = parse(registerSchema, req.body);
  const user = await prisma.user.create({ data: { email: input.email.toLowerCase(), name: input.name, passwordHash: await hashPassword(input.password) } });
  await createSession(user.id, res);
  res.status(201).json({ user: safeUser({ id: user.id, email: user.email, name: user.name, role: user.role }) });
}));
app.post('/api/auth/login', credentialLimiter, asyncRoute(async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, include: { seller: true } });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  await createSession(user.id, res);
  res.json({ user: safeUser({ id: user.id, email: user.email, name: user.name, role: user.role, ...(user.seller ? { sellerId: user.seller.id } : {}), ...(user.avatarMediaId ? { avatarUrl: '/api/account/avatar' } : {}) }) });
}));
app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => { const token = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined; if (token) await prisma.session.deleteMany({ where: { tokenHash: (await import('node:crypto')).createHash('sha256').update(token).digest('hex') } }); res.clearCookie(env.SESSION_COOKIE_NAME); res.clearCookie('marketplace_csrf'); res.status(204).send(); }));
app.get('/api/auth/me', asyncRoute(async (req, res) => { const user = await currentUser(req); res.json({ user: user ? safeUser(user) : null }); }));

app.get('/api/settings/public', asyncRoute(async (_req, res) => {
  const [marketplace, methods, branding] = await Promise.all([prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }), prisma.paymentMethodSettings.findMany({ select: { method: true, enabled: true } }), prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } })]);
  const live = await liveShoppingState();
  const availableDisplayCurrencies = await (await import('./currency-routes.js')).availableGlobalDisplayCurrencies();
  res.json({ multiVendorEnabled: marketplace?.multiVendorEnabled ?? true, paymentMethods: methods, branding: branding?.publishedJson ?? null, languages: ['en', 'fil'], baseCurrency: env.CURRENCY, checkoutCurrency: env.CURRENCY, availableDisplayCurrencies, fxRatesConfigured: availableDisplayCurrencies.length > 1, subscriptionBillingEnabled: false, liveShopping: { enabled: live.effectiveEnabled, deploymentGate: live.deploymentGate, reason: live.reason } });
}));

app.get('/api/live-shopping/status', asyncRoute(async (_req, res) => res.json(await liveShoppingState())));
app.get('/api/live-sessions', asyncRoute(async (_req, res) => {
  await requireLiveShopping();
  const sessions = await prisma.liveSession.findMany({ where: { status: { in: ['SCHEDULED', 'STARTING', 'LIVE', 'PAUSED'] } }, include: { seller: { include: { store: true } }, products: { orderBy: { sortOrder: 'asc' }, include: { product: { include: { inventory: true } } } } }, orderBy: { scheduledAt: 'asc' }, take: 50 });
  res.json(sessions.map(session => publicLiveSession({ ...session, products: session.products.map(link => ({ ...link, product: { ...link.product, availableStock: link.product.inventory?.quantity ?? 0 } })) })));
}));
app.get('/api/live-sessions/:id', asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), status: { in: ['SCHEDULED', 'STARTING', 'LIVE', 'PAUSED'] } }, include: { seller: { include: { store: true } }, products: { orderBy: { sortOrder: 'asc' }, include: { product: { include: { inventory: true } } } } } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  res.json(publicLiveSession({ ...session, products: session.products.map(link => ({ ...link, product: { ...link.product, availableStock: link.product.inventory?.quantity ?? 0 } })) }));
}));
app.post('/api/live-sessions/:id/reports', requireAuth, asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const user = res.locals.user as { id: string };
  const input = parse(liveReportSchema, req.body);
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), status: { in: ['STARTING', 'LIVE', 'PAUSED'] } }, select: { id: true } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  const report = await prisma.liveSessionReport.create({ data: { sessionId: session.id, reporterId: user.id, reason: input.reason } });
  res.status(201).json({ id: report.id, status: report.status });
}));
app.get('/api/seller/live-sessions', requireAuth, requireRole(Role.SELLER), asyncRoute(async (_req, res) => {
  const user = res.locals.user as { id: string; sellerId?: string };
  if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' });
  const sessions = await prisma.liveSession.findMany({ where: { sellerId: user.sellerId }, include: { products: { orderBy: { sortOrder: 'asc' }, include: { product: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(sessions.map(publicLiveSession));
}));
app.post('/api/seller/live-sessions', requireAuth, requireRole(Role.SELLER), asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const user = res.locals.user as { sellerId?: string };
  if (!user.sellerId || !(await eligibleSeller(user.sellerId))) return res.status(403).json({ error: 'Approved, non-suspended seller required' });
  const input = parse(liveSessionSchema, req.body);
  if (input.featuredProductId && !input.productIds.includes(input.featuredProductId)) return res.status(400).json({ error: 'Featured product must be linked to the session' });
  await eligibleProducts(user.sellerId, input.productIds);
  const session = await prisma.liveSession.create({ data: { sellerId: user.sellerId, title: input.title, description: input.description, coverImageUrl: input.coverImageUrl, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, timezone: input.timezone, status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT', products: { create: input.productIds.map((productId, sortOrder) => ({ productId, sortOrder, featured: productId === input.featuredProductId })) } }, include: { products: true } });
  res.status(201).json(publicLiveSession(session));
}));
app.patch('/api/seller/live-sessions/:id', requireAuth, requireRole(Role.SELLER), asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const user = res.locals.user as { sellerId?: string };
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), sellerId: user.sellerId }, include: { products: true } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  const input = parse(liveSessionSchema.partial(), req.body);
  if (input.productIds) { if (input.featuredProductId && !input.productIds.includes(input.featuredProductId)) return res.status(400).json({ error: 'Featured product must be linked to the session' }); await eligibleProducts(session.sellerId, input.productIds); }
  const updated = await prisma.$transaction(async tx => { const next = await tx.liveSession.update({ where: { id: session.id }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.coverImageUrl !== undefined ? { coverImageUrl: input.coverImageUrl } : {}), ...(input.scheduledAt !== undefined ? { scheduledAt: new Date(input.scheduledAt), ...(session.status === 'DRAFT' ? { status: 'SCHEDULED' as const } : {}) } : {}), ...(input.timezone !== undefined ? { timezone: input.timezone } : {}) } }); if (input.productIds) { await tx.liveSessionProduct.deleteMany({ where: { sessionId: session.id } }); await tx.liveSessionProduct.createMany({ data: input.productIds.map((productId, sortOrder) => ({ sessionId: session.id, productId, sortOrder, featured: productId === input.featuredProductId })) }); } return next; });
  res.json(publicLiveSession(updated));
}));
app.post('/api/seller/live-sessions/:id/transition', requireAuth, requireRole(Role.SELLER), asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const user = res.locals.user as { id: string; sellerId?: string };
  const next = z.object({ status: z.enum(['SCHEDULED', 'STARTING', 'LIVE', 'PAUSED', 'ENDED', 'CANCELLED']) }).parse(req.body).status;
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), sellerId: user.sellerId } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  if (!canTransitionLiveSession(session.status, next)) return res.status(409).json({ error: `Invalid live-session transition from ${session.status} to ${next}` });
  if (['STARTING', 'LIVE', 'PAUSED'].includes(next)) return res.status(503).json({ error: 'Provider-backed publishing is not configured' });
  const updated = await prisma.liveSession.updateMany({ where: { id: session.id, status: session.status }, data: { status: next, ...(next === 'ENDED' || next === 'CANCELLED' ? { endedAt: new Date() } : {}) } });
  if (!updated.count) return res.status(409).json({ error: 'Live session changed; retry with current state' });
  await audit(user.id, 'LIVE_SESSION_STATUS_CHANGED', 'LiveSession', session.id, { old: session.status, new: next });
  res.json({ ok: true, status: next });
}));

app.get('/api/products', asyncRoute(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 12)));
  const where: Prisma.ProductWhereInput = { status: ProductStatus.APPROVED, AND: [{ OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, ...(q ? [{ OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }] }] : []), ...(category ? [{ category: { slug: category } }] : [])] };
  const [items, total] = await Promise.all([prisma.product.findMany({ where, include: { seller: { include: { store: true } }, category: true, inventory: true, images: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.product.count({ where })]);
  res.json({ items: items.map(p => ({ ...p, availableStock: p.inventory?.quantity ?? 0 })), page, pageSize, total });
}));
app.get('/api/products/:id', asyncRoute(async (req, res) => { const p = await prisma.product.findFirst({ where: { id: routeParam(req.params.id), status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, include: { seller: { include: { store: true } }, category: true, inventory: true, images: true } }); if (!p) return res.status(404).json({ error: 'Product not found' }); res.json({ ...p, availableStock: p.inventory?.quantity ?? 0 }); }));
app.get('/api/categories', asyncRoute(async (_req, res) => res.json(await prisma.category.findMany({ orderBy: { name: 'asc' } }))));

app.post('/api/sellers/apply', requireAuth, asyncRoute(async (_req, res) => {
  const user = res.locals.user as { id: string; role: Role };
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (!settings?.multiVendorEnabled) return res.status(409).json({ error: 'Multi-vendor mode is disabled' });
  const seller = await prisma.seller.upsert({ where: { userId: user.id }, update: { status: SellerStatus.PENDING }, create: { userId: user.id } });
  res.status(201).json(seller);
}));

app.post('/api/products', requireAuth, requireRole(Role.SELLER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string; role: Role; sellerId?: string };
  const input = parse(productSchema, req.body);
  const seller = user.role === Role.ADMIN ? null : await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
  if (user.role !== Role.ADMIN && !seller) return res.status(403).json({ error: 'Approved seller required' });
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (seller && !settings?.multiVendorEnabled) return res.status(409).json({ error: 'Multi-vendor mode is disabled' });
  const productData = { sellerId: seller?.id, categoryId: input.categoryId ?? null, name: input.name, slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`, description: input.description, priceMinor: input.priceMinor, currency: seller?.store?.baseCurrency ?? env.CURRENCY, barcode: input.barcode, status: user.role === Role.ADMIN || settings?.productApprovalPolicy === ApprovalPolicy.AUTOMATIC ? ProductStatus.APPROVED : ProductStatus.PENDING, inventory: { create: { quantity: input.stock } } };
  if (seller) {
    const store = seller.store ? { id: seller.store.id } : null;
    if (!store) return res.status(409).json({ error: 'Complete Store setup before adding products.' });
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const effective = await effectiveStorePlan(tx, store.id);
      const entitlements = asStorePlanEntitlements(effective.version);
      const usage = await tx.product.count({ where: { sellerId: seller.id, status: { not: ProductStatus.ARCHIVED } } });
      if (isAtLimit(usage, entitlements.productLimit)) return { limitReached: true as const, usage, limit: entitlements.productLimit };
      return { product: await tx.product.create({ data: productData }) };
    });
    if ('limitReached' in result) return res.status(409).json({ code: 'PLAN_LIMIT_REACHED', entitlement: 'productLimit', upgradeRequired: true, error: 'Your Store has reached its product limit. Archive a listing or ask an administrator about a plan change.', usage: result.usage, limit: result.limit, planUrl: '/seller/plan' });
    res.status(201).json(result.product);
    return;
  }
  const product = await prisma.product.create({ data: productData });
  res.status(201).json(product);
}));
app.patch('/api/products/:id', requireAuth, requireRole(Role.SELLER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { role: Role; sellerId?: string };
  const input = parse(productSchema.partial(), req.body);
  const existing = await prisma.product.findUnique({ where: { id: routeParam(req.params.id) } });
  if (!existing || (user.role !== Role.ADMIN && existing.sellerId !== user.sellerId)) return res.status(404).json({ error: 'Product not found' });
  const product = await prisma.$transaction(async tx => { const updated = await tx.product.update({ where: { id: existing.id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.description ? { description: input.description } : {}), ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}), ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}), ...(input.barcode !== undefined ? { barcode: input.barcode } : {}) } }); if (input.stock !== undefined) await tx.inventory.update({ where: { productId: existing.id }, data: { quantity: input.stock } }); return updated; });
  res.json(product);
}));

app.get('/api/products/:id/variants', asyncRoute(async (req, res) => {
  const variants = await prisma.productVariant.findMany({ where: { productId: routeParam(req.params.id), status: ProductStatus.APPROVED }, orderBy: { name: 'asc' } });
  res.json(variants);
}));
app.post('/api/products/:id/variants', requireAuth, requireRole(Role.SELLER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { role: Role; sellerId?: string };
  const input = parse(variantSchema, req.body);
  const product = await prisma.product.findUnique({ where: { id: routeParam(req.params.id) } });
  if (!product || (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)) return res.status(404).json({ error: 'Product not found' });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, ...input, currency: product.currency, status: user.role === Role.ADMIN ? ProductStatus.APPROVED : ProductStatus.PENDING } });
  res.status(201).json(variant);
}));
app.patch('/api/products/:id/variants/:variantId', requireAuth, requireRole(Role.SELLER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { role: Role; sellerId?: string };
  const input = parse(variantSchema.partial(), req.body);
  const variant = await prisma.productVariant.findFirst({ where: { id: routeParam(req.params.variantId), product: { id: routeParam(req.params.id), ...(user.role === Role.ADMIN ? {} : { sellerId: user.sellerId }) } } });
  if (!variant) return res.status(404).json({ error: 'Variant not found' });
  res.json(await prisma.productVariant.update({ where: { id: variant.id }, data: input }));
}));

app.get('/api/cart', requireAuth, asyncRoute(async (_req, res) => { const user = res.locals.user as { id: string }; const cart = await prisma.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { inventory: true, seller: { include: { store: true } } } } } } } }); res.json(cart ?? { items: [] }); }));
app.post('/api/cart/items', requireAuth, asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const body = z.object({ productId: z.string().cuid(), variantId: z.string().cuid().optional(), quantity: z.number().int().positive().max(99) }).parse(req.body); const product = await prisma.product.findFirst({ where: { id: body.productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, include: { variants: true } }); if (!product) return res.status(404).json({ error: 'Product unavailable' }); const variant = body.variantId ? product.variants.find(v => v.id === body.variantId && v.status === ProductStatus.APPROVED) : null; if (body.variantId && !variant) return res.status(409).json({ error: 'Variant unavailable' }); const available = variant?.stock ?? (await prisma.inventory.findUnique({ where: { productId: product.id } }))?.quantity ?? 0; if (available < body.quantity) return res.status(409).json({ error: 'Insufficient stock' }); const cart = await prisma.cart.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } }); const item = await prisma.cartItem.upsert({ where: { cartId_productId: { cartId: cart.id, productId: body.productId } }, update: { quantity: { increment: body.quantity }, variantId: body.variantId }, create: { cartId: cart.id, productId: body.productId, variantId: body.variantId, quantity: body.quantity } }); res.status(201).json(item); }));
app.patch('/api/cart/items/:productId', requireAuth, asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string };
  const qty = z.object({ quantity: z.number().int().nonnegative().max(99) }).parse(req.body).quantity;
  const productId = routeParam(req.params.productId);
  const cart = await prisma.cart.findUnique({ where: { userId: user.id } });
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  const item = await prisma.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId } }, include: { variant: true, product: { include: { inventory: true } } } });
  if (!item) return res.status(404).json({ error: 'Cart item not found' });
  if (qty === 0) await prisma.cartItem.delete({ where: { id: item.id } });
  else {
    const available = item.variant?.stock ?? item.product.inventory?.quantity ?? 0;
    if (qty > available) return res.status(409).json({ error: `Only ${available} available for ${item.product.name}` });
    await prisma.cartItem.update({ where: { id: item.id }, data: { quantity: qty } });
  }
  res.status(204).send();
}));

app.post('/api/orders/checkout', requireAuth, asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string };
  const input = parse(checkoutSchema, req.body);
  const method = input.method as PaymentMethod;
  const methodSetting = await prisma.paymentMethodSettings.findUnique({ where: { method } });
  if (!methodSetting?.enabled) return res.status(409).json({ error: `${method} is disabled` });
  const chargeCurrencyCapability = await prisma.currencyCatalogEntry.findFirst({ where: { code: env.CURRENCY, active: true, checkoutEnabled: true }, select: { code: true } });
  if (!chargeCurrencyCapability) return res.status(409).json({ error: `Checkout in ${env.CURRENCY} is unavailable because the platform currency capability is disabled. Your cart is preserved.`, code: 'CHECKOUT_CURRENCY_UNAVAILABLE' });
  const liveActivationBlock = await livePaymentActivationBlock(method);
  if (liveActivationBlock) return res.status(503).json(liveActivationBlock);
  const cart = await prisma.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { inventory: true, seller: true } } } } } });
  if (!cart?.items.length) return res.status(400).json({ error: 'Cart is empty' });
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { affiliateEnabled: true, affiliateAttributionRule: true } });
  const affiliateToken = input.affiliateToken ?? req.cookies?.affiliate_attribution as string | undefined;
  if (affiliateToken && !settings?.affiliateEnabled) return res.status(409).json({ error: 'Affiliate attribution is disabled' });
  const signed = affiliateToken ? verifySignedReferralToken(affiliateToken, env.AFFILIATE_SIGNING_SECRET ?? env.PASSWORD_PEPPER) : false;
  const affiliateClick = affiliateToken && signed ? await prisma.affiliateClick.findFirst({ where: { tokenHash: referralTokenHash(affiliateToken), convertedAt: null, consentGivenAt: { not: null }, expiresAt: { gt: new Date() }, affiliate: { status: 'APPROVED' } }, include: { affiliate: true, link: true } }) : null;
  if (affiliateToken && !affiliateClick) return res.status(409).json({ error: 'Referral attribution is invalid or expired' });
  if (affiliateClick?.visitorKeyHash && settings) {
    const competingClick = await prisma.affiliateClick.findFirst({ where: { id: { not: affiliateClick.id }, visitorKeyHash: affiliateClick.visitorKeyHash, consentGivenAt: { not: null }, convertedAt: null, expiresAt: { gt: new Date() }, clickedAt: settings.affiliateAttributionRule === 'FIRST_VALID_CLICK' ? { lt: affiliateClick.clickedAt } : { gt: affiliateClick.clickedAt } }, orderBy: { clickedAt: settings.affiliateAttributionRule === 'FIRST_VALID_CLICK' ? 'asc' : 'desc' } });
    if (competingClick) return res.status(409).json({ error: settings.affiliateAttributionRule === 'FIRST_VALID_CLICK' ? 'The first valid referral is already selected' : 'A newer valid referral is available' });
  }
  if (affiliateClick && affiliateClick.affiliate.userId === user.id) return res.status(409).json({ error: 'Self-referrals are not eligible' });
  if (affiliateClick?.productId && !cart.items.some(item => item.productId === affiliateClick.productId)) return res.status(409).json({ error: 'The referred product must be in the order' });
  if (affiliateClick?.link.sellerId && !cart.items.some(item => item.product.sellerId === affiliateClick.link.sellerId)) return res.status(409).json({ error: 'The referred store must be in the order' });
  const grouped = new Map<string, typeof cart.items>();
  for (const item of cart.items) { if ((item.variant?.stock ?? item.product.inventory?.quantity ?? 0) < item.quantity) return res.status(409).json({ error: `Insufficient stock for ${item.product.name}` }); const key = item.product.sellerId ?? 'platform'; grouped.set(key, [...(grouped.get(key) ?? []), item]); }
  const committed = await prisma.$transaction(async tx => {
    const freshCart = await tx.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { inventory: true, seller: { include: { store: { include: { currencyOffers: true } } } } } } } } } });
    if (!freshCart?.items.length) throw Object.assign(new Error('Cart changed; refresh and try again'), { statusCode: 409, code: 'SHIPPING_CART_STALE' });
    const lockedChargeCurrency = await tx.$queryRaw<{ code: string }[]>`SELECT "code" FROM "CurrencyCatalogEntry" WHERE "code" = ${env.CURRENCY} AND "active" = TRUE AND "checkoutEnabled" = TRUE FOR SHARE`;
    if (!lockedChargeCurrency.length) throw Object.assign(new Error(`Checkout in ${env.CURRENCY} is unavailable because the platform currency capability is disabled. Your cart is preserved.`), { statusCode: 409, code: 'CHECKOUT_CURRENCY_UNAVAILABLE' });
    const storeIds = [...new Set(freshCart.items.map(item => item.product.seller?.store?.id).filter((id): id is string => Boolean(id)))].sort();
    for (const storeId of storeIds) {
      const chargeOffer = await tx.$queryRaw<{ storeId: string }[]>`SELECT offer."storeId" FROM "StoreCurrencyOffer" AS offer JOIN "Store" AS store ON store."id" = offer."storeId" WHERE offer."storeId" = ${storeId} AND store."baseCurrency" = ${env.CURRENCY} AND offer."currency" = ${env.CURRENCY} AND offer."displayEnabled" = TRUE AND offer."checkoutEnabled" = TRUE FOR SHARE OF offer, store`;
      if (!chargeOffer.length) throw Object.assign(new Error(`A Store in this cart has not enabled ${env.CURRENCY} checkout. Your cart is preserved.`), { statusCode: 409, code: 'STORE_CHECKOUT_CURRENCY_UNAVAILABLE' });
    }
    const currencyMismatch = freshCart.items.find(item => (item.variant?.currency ?? item.product.currency) !== env.CURRENCY);
    if (currencyMismatch) throw Object.assign(new Error(`The configured payment methods can charge ${env.CURRENCY} only. ${currencyMismatch.product.name} is listed in ${currencyMismatch.variant?.currency ?? currencyMismatch.product.currency}; the cart was preserved.`), { statusCode: 409, code: 'CHECKOUT_CURRENCY_UNSUPPORTED' });
    for (const item of freshCart.items) {
      const productCurrency = item.variant?.currency ?? item.product.currency;
      if (item.product.seller?.store && item.product.seller.store.baseCurrency !== item.product.currency) throw Object.assign(new Error(`Store currency settings do not match ${item.product.name}. Contact the Store before checkout.`), { statusCode: 409, code: 'STORE_CURRENCY_MISMATCH' });
      if (item.variant && item.variant.currency !== item.product.currency) throw Object.assign(new Error(`Variant currency does not match ${item.product.name}.`), { statusCode: 409, code: 'PRODUCT_CURRENCY_MISMATCH' });
      if (!productCurrency) throw Object.assign(new Error('Product currency is unavailable.'), { statusCode: 409, code: 'CHECKOUT_CURRENCY_UNSUPPORTED' });
    }
    const freshGroups = new Map<string, typeof freshCart.items>();
    for (const item of freshCart.items) {
      if (item.product.status !== ProductStatus.APPROVED || (item.product.sellerId && item.product.seller?.status !== SellerStatus.APPROVED)) throw Object.assign(new Error(`Product ${item.product.name} is no longer available`), { statusCode: 409 });
      const key = item.product.sellerId ?? 'platform';
      freshGroups.set(key, [...(freshGroups.get(key) ?? []), item]);
    }
    const sellerGroups = [...freshGroups.entries()].filter(([sellerId]) => sellerId !== 'platform');
    const currentSettings = await tx.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { multiVendorEnabled: true, sellerShippingEnabled: true, codMaxMinor: true } });
    if (sellerGroups.length && !currentSettings?.multiVendorEnabled) throw Object.assign(new Error('Seller products are unavailable while multi-vendor mode is disabled'), { statusCode: 409 });
    let shippingTotalMinor = 0;
    let totalMinor = freshCart.items.reduce((sum, item) => sum + (item.variant?.priceMinor ?? item.product.priceMinor) * item.quantity, 0);
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || totalMinor > 2_147_483_647) throw Object.assign(new Error('Order total exceeds the supported integer minor-unit limit'), { statusCode: 409, code: 'ORDER_TOTAL_OUT_OF_RANGE' });
    const shippingBySeller = new Map<string, { snapshot: Prisma.InputJsonValue; shippingMinor: number }>();
    const requestedDisplayCurrency = input.displayCurrency;
    const displayCurrencyEntry = requestedDisplayCurrency ? await tx.currencyCatalogEntry.findFirst({ where: { code: requestedDisplayCurrency, active: true, displayEnabled: true } }) : null;
    if (requestedDisplayCurrency && !displayCurrencyEntry) throw Object.assign(new Error('This display currency is not enabled by the platform.'), { statusCode: 409, code: 'DISPLAY_CURRENCY_UNAVAILABLE' });
    const itemFxSnapshots = new Map<string, { amountMinor: number; currency: string; snapshot: Prisma.InputJsonValue }>();
    let displayItemsTotalMinor = 0;
    if (requestedDisplayCurrency) {
      for (const item of freshCart.items) {
        const sourceCurrency = item.variant?.currency ?? item.product.currency;
        const store = item.product.seller?.store;
        if (!store && requestedDisplayCurrency !== env.CURRENCY) throw Object.assign(new Error('Platform-owned products are only available in the platform display currency.'), { statusCode: 409, code: 'DISPLAY_CURRENCY_UNAVAILABLE' });
        if (store && requestedDisplayCurrency !== store.baseCurrency && !store.currencyOffers.some(offer => offer.currency === requestedDisplayCurrency && offer.displayEnabled)) throw Object.assign(new Error(`The Store does not offer ${requestedDisplayCurrency} for display.`), { statusCode: 409, code: 'DISPLAY_CURRENCY_NOT_OFFERED' });
        const rate = await latestDisplayRate(sourceCurrency, requestedDisplayCurrency, store?.id);
        if (!rate || rate.freshness === 'stale') throw Object.assign(new Error(`A fresh ${sourceCurrency}/${requestedDisplayCurrency} estimate is unavailable. Choose another display currency; the cart was preserved.`), { statusCode: 409, code: 'DISPLAY_RATE_UNAVAILABLE' });
        const exponentEntries = await tx.currencyCatalogEntry.findMany({ where: { code: { in: [sourceCurrency, requestedDisplayCurrency] } }, select: { code: true, minorUnitExponent: true } });
        const sourceExponent = exponentEntries.find(entry => entry.code === sourceCurrency)?.minorUnitExponent;
        const quoteExponent = exponentEntries.find(entry => entry.code === requestedDisplayCurrency)?.minorUnitExponent;
        if (sourceExponent == null || quoteExponent == null) throw Object.assign(new Error('Currency precision is not configured.'), { statusCode: 409, code: 'DISPLAY_CURRENCY_UNAVAILABLE' });
        const baseAmount = (item.variant?.priceMinor ?? item.product.priceMinor) * item.quantity;
        const estimate = Number(convertMinorExact(BigInt(baseAmount), rate.rate, sourceExponent, quoteExponent));
        if (!Number.isSafeInteger(estimate)) throw Object.assign(new Error('Converted estimate exceeds the supported display amount.'), { statusCode: 409, code: 'DISPLAY_AMOUNT_OUT_OF_RANGE' });
        displayItemsTotalMinor += estimate;
        itemFxSnapshots.set(item.id, { amountMinor: estimate, currency: requestedDisplayCurrency, snapshot: { baseAmountMinor: baseAmount, baseCurrency: sourceCurrency, quoteAmountMinor: estimate, quoteCurrency: requestedDisplayCurrency, rate: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, rounding: 'HALF_UP', purpose: 'DISPLAY_ESTIMATE_ONLY' } as Prisma.InputJsonValue });
      }
    }
    let displayShippingTotalMinor = 0;
    let shippingBreakdown: { storeName: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number }[] = [];
    if (sellerGroups.length) {
      if (currentSettings?.sellerShippingEnabled === false) throw Object.assign(new Error('Seller-managed shipping is disabled. Seller shipments cannot be checked out.'), { statusCode: 409, code: 'SHIPPING_DISABLED' });
      const verifiedQuote = verifyCheckoutShippingQuote({ token: input.shippingQuoteToken, userId: user.id, address: input.address, items: freshCart.items as ShippingCartRecord[] });
      const selections = Object.fromEntries(verifiedQuote.selections.map(selection => [selection.sellerId, selection.serviceId]));
      const currentQuote = await buildSellerShippingQuote(tx, user.id, input.address, freshCart.items as ShippingCartRecord[], selections);
      assertShippingSelectionsMatch(verifiedQuote, currentQuote.shipments.map(shipment => shipment.selected));
      shippingTotalMinor = currentQuote.shippingTotalMinor;
      totalMinor += shippingTotalMinor;
      shippingBreakdown = currentQuote.shipments.map(shipment => ({ storeName: shipment.storeName, serviceName: shipment.selected.serviceName, feeMinor: shipment.selected.feeMinor, discountMinor: shipment.selected.discountMinor, shippingMinor: shipment.selected.shippingMinor }));
      for (const shipment of currentQuote.shipments) {
        let displayShippingSnapshot: Record<string, unknown> | undefined;
        if (requestedDisplayCurrency) {
          const sellerGroup = freshGroups.get(shipment.sellerId) ?? [];
          const store = sellerGroup[0]?.product.seller?.store;
          const rate = await latestDisplayRate(shipment.selected.currency, requestedDisplayCurrency, store?.id);
          const quoteEntry = await tx.currencyCatalogEntry.findUnique({ where: { code: requestedDisplayCurrency }, select: { minorUnitExponent: true } });
          const baseEntry = await tx.currencyCatalogEntry.findUnique({ where: { code: shipment.selected.currency }, select: { minorUnitExponent: true } });
          if (!rate || rate.freshness === 'stale' || !quoteEntry || !baseEntry) throw Object.assign(new Error(`A fresh shipping estimate in ${requestedDisplayCurrency} is unavailable.`), { statusCode: 409, code: 'DISPLAY_RATE_UNAVAILABLE' });
          if (store && requestedDisplayCurrency !== store.baseCurrency && !store.currencyOffers.some(offer => offer.currency === requestedDisplayCurrency && offer.displayEnabled)) throw Object.assign(new Error(`The Store does not offer ${requestedDisplayCurrency} for shipping display.`), { statusCode: 409, code: 'DISPLAY_CURRENCY_NOT_OFFERED' });
          const estimated = Number(convertMinorExact(BigInt(shipment.selected.shippingMinor), rate.rate, baseEntry.minorUnitExponent, quoteEntry.minorUnitExponent));
          if (!Number.isSafeInteger(estimated)) throw Object.assign(new Error('Converted shipping estimate exceeds the supported display amount.'), { statusCode: 409, code: 'DISPLAY_AMOUNT_OUT_OF_RANGE' });
          displayShippingTotalMinor += estimated;
          displayShippingSnapshot = { amountMinor: estimated, currency: requestedDisplayCurrency, rate: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, rounding: 'HALF_UP', purpose: 'DISPLAY_ESTIMATE_ONLY' };
        }
        const snapshot = {
          version: 1, serviceId: shipment.selected.serviceId, serviceName: shipment.selected.serviceName,
          destination: input.address, zoneId: shipment.selected.zoneId, feeMinor: shipment.selected.feeMinor,
          discountMinor: shipment.selected.discountMinor, shippingMinor: shipment.selected.shippingMinor,
          currency: shipment.selected.currency, estimatedMinDays: shipment.selected.estimatedMinDays,
          estimatedMaxDays: shipment.selected.estimatedMaxDays, discount: shipment.selected.discount,
          ...(displayShippingSnapshot ? { displayEstimate: displayShippingSnapshot } : {})
        } as Prisma.InputJsonValue;
        shippingBySeller.set(shipment.sellerId, { snapshot, shippingMinor: shipment.selected.shippingMinor });
      }
    } else if (input.shippingQuoteToken) {
      throw Object.assign(new Error('The cart changed after shipping was calculated. Recalculate the order total.'), { statusCode: 409, code: 'SHIPPING_QUOTE_STALE' });
    }
    if (method === PaymentMethod.COD && currentSettings?.codMaxMinor != null && totalMinor > currentSettings.codMaxMinor) throw Object.assign(new Error('Order is above the configured COD limit'), { statusCode: 409 });
    for (const item of freshCart.items) {
      const updated = item.variant
        ? await tx.productVariant.updateMany({ where: { id: item.variant.id, status: ProductStatus.APPROVED, stock: { gte: item.quantity } }, data: { stock: { decrement: item.quantity } } })
        : await tx.inventory.updateMany({ where: { productId: item.productId, quantity: { gte: item.quantity } }, data: { quantity: { decrement: item.quantity } } });
      if (updated.count !== 1) throw Object.assign(new Error(`Stock changed for ${item.product.name}`), { statusCode: 409, code: 'SHIPPING_CART_STALE' });
    }
    const created = await tx.parentOrder.create({ data: {
      orderNumber: orderNumber(), buyerId: user.id, affiliateClickId: affiliateClick?.id,
      buyerEmail: input.buyerEmail, buyerName: input.buyerName, addressJson: input.address,
      totalMinor, currency: env.CURRENCY,
      sellerOrders: { create: await Promise.all([...freshGroups.entries()].map(async ([sellerId, items]) => {
        const itemTotalMinor = items.reduce((sum, item) => sum + (item.variant?.priceMinor ?? item.product.priceMinor) * item.quantity, 0);
        const store = items[0]?.product.seller?.store;
        const policy = sellerId === 'platform' || !store ? null : await applicableSellerCommissionPolicy(tx, store.id, env.CURRENCY);
        const commissionSnapshot = sellerId === 'platform' ? null : makeCommissionSnapshot(policy, env.CURRENCY);
        return {
          sellerId: sellerId === 'platform' ? null : sellerId,
          totalMinor: itemTotalMinor,
          shippingSnapshotJson: sellerId === 'platform' ? undefined : shippingBySeller.get(sellerId)?.snapshot,
          ...(commissionSnapshot ? { commissionSnapshotJson: commissionSnapshot as Prisma.InputJsonValue, commissionPolicyVersionId: policy?.id ?? null } : {}),
          items: { create: items.map(item => {
            const fx = itemFxSnapshots.get(item.id);
            const itemCurrency = item.variant?.currency ?? item.product.currency;
            return {
              product: { connect: { id: item.productId } },
              ...(item.variant ? { variant: { connect: { id: item.variant.id } }, variantName: item.variant.name } : {}),
              productName: item.product.name, unitPriceMinor: item.variant?.priceMinor ?? item.product.priceMinor,
              quantity: item.quantity, currencySnapshotEntry: { connect: { code: itemCurrency } },
              ...(fx ? { displayAmountMinor: fx.amountMinor, displayCurrencyEntry: { connect: { code: fx.currency } }, fxSnapshotJson: fx.snapshot } : {})
            };
          }) }
        };
      })) }, payment: { create: { method, status: PaymentStatus.PENDING } }
    } });
    await tx.cartItem.deleteMany({ where: { cartId: freshCart.id } });
    return { order: created, shippingTotalMinor, shippingBreakdown, displayEstimate: requestedDisplayCurrency ? { currency: requestedDisplayCurrency, itemTotalMinor: displayItemsTotalMinor, shippingTotalMinor: displayShippingTotalMinor, totalMinor: displayItemsTotalMinor + displayShippingTotalMinor, purpose: 'DISPLAY_ESTIMATE_ONLY' } : null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw Object.assign(new Error('Cart or shipping settings changed while checkout was being validated. Recalculate shipping and retry.'), { statusCode: 409, code: 'SHIPPING_QUOTE_STALE' });
    throw error;
  });
  const order = committed.order;
  const totalMinor = order.totalMinor;
  let paymentAction: unknown = null;
  try {
    if (method === PaymentMethod.STRIPE) { const session = await createStripeCheckout({ id: order.id, orderNumber: order.orderNumber, totalMinor, currency: env.CURRENCY, buyerEmail: input.buyerEmail }, `${env.WEB_ORIGIN}/orders/${order.id}?payment=success`, `${env.WEB_ORIGIN}/orders/${order.id}?payment=cancelled`); await prisma.payment.update({ where: { parentId: order.id }, data: { providerRef: session.id } }); paymentAction = { provider: 'STRIPE', checkoutUrl: session.url }; }
    if (method === PaymentMethod.PAYPAL) { const pp = await createPaypalOrder({ id: order.id, orderNumber: order.orderNumber, totalMinor, currency: env.CURRENCY }); await prisma.payment.update({ where: { parentId: order.id }, data: { providerRef: pp.id } }); paymentAction = { provider: 'PAYPAL', providerOrderId: pp.id, approvalUrl: pp.links?.find(link => link.rel === 'approve')?.href }; }
  } catch (error) { await prisma.payment.update({ where: { parentId: order.id }, data: { status: PaymentStatus.FAILED } }); return res.status(502).json({ error: error instanceof Error ? error.message : 'Payment provider unavailable', orderId: order.id }); }
  res.status(201).json({ orderId: order.id, orderNumber: order.orderNumber, totalMinor: order.totalMinor, shippingTotalMinor: committed.shippingTotalMinor, shippingBreakdown: committed.shippingBreakdown, currency: order.currency, displayEstimate: committed.displayEstimate, payment: paymentAction, paymentStatus: method === PaymentMethod.COD ? 'PENDING' : 'AWAITING_PROVIDER' });
}));

app.post('/api/orders/:id/paypal-capture', requireAuth, asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string };
  const order = await prisma.parentOrder.findFirst({ where: { id: routeParam(req.params.id), buyerId: user.id }, include: { payment: true } });
  if (!order || order.payment?.method !== PaymentMethod.PAYPAL || !order.payment.providerRef) return res.status(404).json({ error: 'Order not found' });
  const captured = await capturePaypalOrder(order.payment.providerRef);
  const capture = captured.purchase_units?.flatMap(unit => unit.payments?.captures ?? []).find(item => item.status === 'COMPLETED');
  const providerAmount = capture?.amount;
  const currency = await prisma.currencyCatalogEntry.findUnique({ where: { code: order.currency }, select: { minorUnitExponent: true } });
  if (captured.status !== 'COMPLETED' || !capture || providerAmount?.currency_code !== order.currency || !currency || decimalToMinorExact(providerAmount.value, currency.minorUnitExponent) !== order.totalMinor) return res.status(409).json({ error: 'PayPal capture amount or currency does not match the saved order.' });
  const capturedAmountMinor = decimalToMinorExact(providerAmount.value, currency!.minorUnitExponent);
  const result = await prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, {
    provider: 'PAYPAL', eventId: `api-capture-${capture.id}`, eventType: 'PAYMENT.CAPTURE.COMPLETED',
    providerObjectRef: order.payment!.providerRef, paymentLookupRef: order.payment!.providerRef,
    amountMinor: capturedAmountMinor, currency: providerAmount.currency_code,
    occurredAt: new Date(), captureConfirmed: true
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  const transitioned = result.becamePaid;
  res.json({ ok: true, status: captured.status, alreadyPaid: !transitioned });
}));

app.post('/api/orders/:id/cod-collect', requireAuth, requireRole(Role.ADMIN, Role.SELLER, Role.CASHIER), asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string; role: Role; sellerId?: string };
  const orderId = routeParam(req.params.id);
  const collectedAt = new Date();
  const transitioned = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.parentOrder.findFirst({ where: { id: orderId, payment: { method: PaymentMethod.COD } }, include: { payment: true, sellerOrders: { select: { id: true, sellerId: true, status: true } } } });
    if (!order?.payment) throw Object.assign(new Error('COD order not found.'), { statusCode: 404 });
    const sellerOrders = order.sellerOrders.filter(row => row.sellerId !== null);
    if (user.role !== Role.ADMIN) {
      if (!user.sellerId || !sellerOrders.some(row => row.sellerId === user.sellerId)) throw Object.assign(new Error('This seller cannot collect for the order.'), { statusCode: 404 });
      if (sellerOrders.length !== 1 || order.sellerOrders.some(row => row.sellerId === null)) throw Object.assign(new Error('Only an administrator can confirm collection for a multi-Store or platform order.'), { statusCode: 403 });
    }
    if (order.payment.status === PaymentStatus.PAID) {
      // A retry can repair affiliate work left incomplete by an older
      // non-atomic implementation. The helper is idempotent under this lock.
      await settleAffiliateForPaidOrderInTransaction(tx, order.id, `cod-collection:${order.id}`);
      return false;
    }
    if (order.payment.status !== PaymentStatus.PENDING || order.status === OrderStatus.CANCELLED) throw Object.assign(new Error('This COD order is not eligible for collection.'), { statusCode: 409 });
    if (order.sellerOrders.some(row => row.sellerId !== null && row.status !== OrderStatus.FULFILLED)) throw Object.assign(new Error('Every seller shipment must be marked delivered before COD cash collection is confirmed.'), { statusCode: 409, code: 'COD_DELIVERY_REQUIRED' });
    const update = await tx.payment.updateMany({ where: { id: order.payment.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.PAID, paidAt: collectedAt } });
    if (!update.count) return false;
    await tx.parentOrder.updateMany({ where: { id: order.id, status: { not: OrderStatus.CANCELLED } }, data: { status: OrderStatus.CONFIRMED } });
    await accrueSellerCommissionsForPaidOrder(tx, order.id, `cod-collection:${order.id}`);
    await settleAffiliateForPaidOrderInTransaction(tx, order.id, `cod-collection:${order.id}`);
    await tx.auditLog.create({ data: { actorId: user.id, action: 'COD_CASH_COLLECTED', entity: 'Payment', entityId: order.payment.id, metadata: { orderId: order.id, collectedAt: collectedAt.toISOString(), sellerIds: sellerOrders.map(row => row.sellerId) } } });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  res.json({ ok: true, alreadyCollected: !transitioned, collectedAt: transitioned ? collectedAt.toISOString() : undefined });
}));

app.get('/api/orders', requireAuth, asyncRoute(async (req, res) => { const user = res.locals.user as { id: string; role: Role; sellerId?: string }; const orders = user.role === Role.ADMIN ? await prisma.parentOrder.findMany({ include: { payment: true, sellerOrders: true }, orderBy: { createdAt: 'desc' }, take: 100 }) : user.sellerId ? await prisma.parentOrder.findMany({ where: { sellerOrders: { some: { sellerId: user.sellerId } } }, include: { payment: true, sellerOrders: { where: { sellerId: user.sellerId }, include: { items: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }) : await prisma.parentOrder.findMany({ where: { buyerId: user.id }, include: { payment: true, sellerOrders: { include: { items: true } } }, orderBy: { createdAt: 'desc' } }); res.json(orders); }));

app.post('/api/sellers/:sellerId/orders/:orderId/status', requireAuth, requireRole(Role.SELLER, Role.CASHIER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { role: Role; sellerId?: string; id: string };
  const next = z.object({ status: z.enum(['CONFIRMED', 'PROCESSING', 'FULFILLED', 'CANCELLED']) }).parse(req.body).status as OrderStatus;
  const sellerId = user.role === Role.ADMIN ? routeParam(req.params.sellerId) : user.sellerId;
  const orderId = routeParam(req.params.orderId);
  const sellerOrder = await prisma.sellerOrder.findFirst({ where: { id: orderId, sellerId }, include: { items: true, parent: { include: { payment: true } } } });
  if (!sellerOrder) return res.status(404).json({ error: 'Seller order not found' });
  const transitioned = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${sellerOrder.parentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${sellerOrder.id} FOR UPDATE`;
    const current = await tx.sellerOrder.findUnique({ where: { id: sellerOrder.id }, include: { items: true, parent: { include: { payment: true } } } });
    if (!current) throw Object.assign(new Error('Seller order not found.'), { statusCode: 404 });
    if (current.status === OrderStatus.CANCELLED) {
      if (next !== OrderStatus.CANCELLED) throw Object.assign(new Error('A cancelled seller order cannot be reopened.'), { statusCode: 409, code: 'CANCELLED_ORDER_TERMINAL' });
      return false;
    }
    if (current.status === next) return false;
    await tx.sellerOrder.update({ where: { id: sellerOrder.id }, data: { status: next } });
    if (next === OrderStatus.CANCELLED && current.parent.payment?.status === PaymentStatus.PAID) await reverseSellerCommissionForOrder(tx, sellerOrder.parentId, `seller-cancellation:${sellerOrder.id}`, 'Seller order cancelled after payment.', sellerOrder.id);
    if (next === OrderStatus.CANCELLED) {
      for (const item of current.items) await reverseAffiliateForOrderInTransaction(tx, sellerOrder.parentId, {
        type: AffiliateAdjustmentType.CANCELLATION,
        orderItemId: item.id,
        idempotencyKey: `seller-cancellation:${sellerOrder.id}:${item.id}`,
        reason: 'Seller order cancelled',
        createdById: user.id
      });
    }
    if (next === OrderStatus.CANCELLED) {
      const remainingSellerOrders = await tx.sellerOrder.count({ where: { parentId: sellerOrder.parentId, status: { not: OrderStatus.CANCELLED } } });
      if (remainingSellerOrders === 0) {
        const parentCancelled = await tx.parentOrder.updateMany({ where: { id: sellerOrder.parentId, status: { not: OrderStatus.CANCELLED } }, data: { status: OrderStatus.CANCELLED } });
        if (parentCancelled.count) await tx.auditLog.create({ data: { actorId: user.id, action: 'PARENT_ORDER_CANCELLED_AFTER_SELLER_CANCELLATION', entity: 'ParentOrder', entityId: sellerOrder.parentId, metadata: { sellerOrderId: sellerOrder.id } } });
      }
    }
    await tx.auditLog.create({ data: { actorId: user.id, action: 'ORDER_STATUS_CHANGED', entity: 'SellerOrder', entityId: sellerOrder.id, metadata: { from: current.status, status: next } } });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  res.json({ ok: true, alreadyApplied: !transitioned });
}));

app.post('/api/pos/sales', requireAuth, requireRole(Role.SELLER, Role.CASHIER), asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string; role: Role; sellerId?: string };
  const input = parse(posSchema, req.body);
  const setting = await prisma.paymentMethodSettings.findUnique({ where: { method: PaymentMethod.POS } });
  if (!setting?.enabled) return res.status(409).json({ error: 'POS is disabled' });
  const sellerId = user.sellerId;
  if (!sellerId) return res.status(403).json({ error: 'Approved seller required' });
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
  if (!seller?.store) return res.status(403).json({ error: 'Approved seller required' });
  const sale = await prisma.$transaction(async tx => {
    const products = [] as { productId: string; quantity: number; productName: string; priceMinor: number }[];
    for (const item of input.items) {
      const product = await tx.product.findFirst({ where: { id: item.productId, sellerId, status: ProductStatus.APPROVED }, include: { inventory: true } });
      if (!product) throw Object.assign(new Error('Product is not available to this seller'), { statusCode: 409 });
      if (product.currency !== env.CURRENCY || seller.store!.baseCurrency !== product.currency) throw Object.assign(new Error(`Cash POS can only accept the configured ${env.CURRENCY} Store currency.`), { statusCode: 409, code: 'CHECKOUT_CURRENCY_UNSUPPORTED' });
      const updated = await tx.inventory.updateMany({ where: { productId: product.id, quantity: { gte: item.quantity } }, data: { quantity: { decrement: item.quantity } } });
      if (updated.count !== 1) throw Object.assign(new Error(`Insufficient stock for ${product.name}`), { statusCode: 409 });
      products.push({ productId: product.id, quantity: item.quantity, productName: product.name, priceMinor: product.priceMinor });
    }
    const totalMinor = products.reduce((sum, product) => sum + product.priceMinor * product.quantity, 0);
    if (!Number.isSafeInteger(totalMinor) || totalMinor > 2_147_483_647) throw Object.assign(new Error('POS total exceeds the supported minor-unit range.'), { statusCode: 409 });
    const pos = await tx.pOSSession.create({ data: { sellerId, cashierId: user.id, register: input.register } });
    const policy = await applicableSellerCommissionPolicy(tx, seller.store!.id, env.CURRENCY);
    const commissionSnapshot = makeCommissionSnapshot(policy, env.CURRENCY);
    const order = await tx.parentOrder.create({ data: {
      orderNumber: orderNumber(), buyerName: input.buyerName, buyerEmail: 'pos@local.invalid', addressJson: {}, totalMinor, currency: env.CURRENCY, status: OrderStatus.CONFIRMED,
      sellerOrders: { create: { sellerId, totalMinor, status: OrderStatus.FULFILLED, commissionSnapshotJson: commissionSnapshot as Prisma.InputJsonValue, commissionPolicyVersionId: policy?.id ?? null,
        items: { create: products.map(product => ({ product: { connect: { id: product.productId } }, productName: product.productName, unitPriceMinor: product.priceMinor, quantity: product.quantity, currencySnapshotEntry: { connect: { code: env.CURRENCY } } })) } } },
      payment: { create: { method: PaymentMethod.POS, status: PaymentStatus.PAID, paidAt: new Date() } }
    } });
    await accrueSellerCommissionsForPaidOrder(tx, order.id, `pos:${order.id}`);
    await settleAffiliateForPaidOrderInTransaction(tx, order.id, `pos:${order.id}`);
    await tx.auditLog.create({ data: { actorId: user.id, action: 'POS_SALE_COMPLETED', entity: 'ParentOrder', entityId: order.id, metadata: { register: input.register } } });
    return { order, pos };
  });
  res.status(201).json({ orderId: sale.order.id, receiptUrl: `/api/pos/receipts/${sale.order.id}` });
}));
app.get('/api/pos/receipts/:id', requireAuth, asyncRoute(async (req, res) => { const user = res.locals.user as { sellerId?: string; role: Role }; const order = await prisma.parentOrder.findFirst({ where: { id: routeParam(req.params.id), sellerOrders: { some: user.role === Role.ADMIN ? {} : { sellerId: user.sellerId } }, payment: { method: PaymentMethod.POS } }, include: { sellerOrders: { include: { items: true, seller: { include: { store: true } } } }, payment: true } }); if (!order) return res.status(404).send('Receipt not found'); res.type('html').send(`<html><head><title>Receipt ${order.orderNumber}</title><style>body{font-family:system-ui;max-width:420px;margin:2rem auto} @media print{button{display:none}}</style></head><body><h1>Receipt</h1><p>${order.orderNumber}</p>${order.sellerOrders.flatMap(s => s.items.map(i => `<p>${i.quantity} × ${i.productName} — ${(i.unitPriceMinor / 100).toFixed(2)} ${order.currency}</p>`)).join('')}<hr><strong>Total ${(order.totalMinor / 100).toFixed(2)} ${order.currency}</strong><br><button onclick="print()">Print</button></body></html>`); }));

app.get('/api/admin/settings', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => { const [marketplace, paymentMethods, liveShopping] = await Promise.all([prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }), prisma.paymentMethodSettings.findMany({ orderBy: { method: 'asc' } }), liveShoppingState()]); res.json({ marketplace, paymentMethods, liveShopping }); }));
app.patch('/api/admin/settings', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res, next) => { const input = parse(settingSchema, req.body); if (!input.method || input.enabled !== true) return next(); const block = await livePaymentActivationBlock(input.method as PaymentMethod); if (block) return res.status(409).json(block); return next(); }));
app.patch('/api/admin/settings', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = parse(settingSchema, req.body); if (input.multiVendorEnabled !== undefined) { const old = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }); const updated = await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { multiVendorEnabled: input.multiVendorEnabled }, create: { id: 'default', multiVendorEnabled: input.multiVendorEnabled } }); await audit(user.id, 'MARKETPLACE_MODE_CHANGED', 'MarketplaceSettings', 'default', { old: old?.multiVendorEnabled, new: input.multiVendorEnabled, reason: input.reason }); res.json(updated); return; } if (input.liveShoppingEnabled !== undefined) { const live = await liveShoppingState(); if (input.liveShoppingEnabled && (!live.deploymentGate || !live.readiness.configured || !live.readiness.healthy)) return res.status(409).json({ error: `Live shopping cannot be enabled: ${live.reason}`, liveShopping: live }); const old = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { liveShoppingEnabled: true } }); const updated = await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { liveShoppingEnabled: input.liveShoppingEnabled }, create: { id: 'default', liveShoppingEnabled: input.liveShoppingEnabled } }); await audit(user.id, 'LIVE_SHOPPING_MODE_CHANGED', 'MarketplaceSettings', 'default', { old: old?.liveShoppingEnabled ?? false, new: input.liveShoppingEnabled, reason: input.reason }); res.json(updated); return; } if (input.method && input.enabled !== undefined) { const old = await prisma.paymentMethodSettings.findUnique({ where: { method: input.method as PaymentMethod } }); const updated = await prisma.paymentMethodSettings.upsert({ where: { method: input.method as PaymentMethod }, update: { enabled: input.enabled }, create: { id: input.method.toLowerCase(), method: input.method as PaymentMethod, enabled: input.enabled } }); await audit(user.id, 'PAYMENT_METHOD_CHANGED', 'PaymentMethodSettings', input.method, { old: old?.enabled, new: input.enabled, reason: input.reason }); res.json(updated); return; } res.status(400).json({ error: 'No supported setting provided' }); }));
app.get('/api/admin/live-sessions', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.liveSession.findMany({ include: { seller: { include: { store: true } }, products: { include: { product: true } }, reports: true }, orderBy: { createdAt: 'desc' }, take: 100 }))));
app.post('/api/admin/live-sessions/:id/terminate', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const session = await prisma.liveSession.findUnique({ where: { id: routeParam(req.params.id) } }); if (!session) return res.status(404).json({ error: 'Live session not found' }); if (session.providerSessionRef) await liveProvider.endSession(session.providerSessionRef); const updated = await prisma.liveSession.update({ where: { id: session.id }, data: { status: 'ENDED', endedAt: new Date() } }); await audit(user.id, 'LIVE_SESSION_TERMINATED', 'LiveSession', session.id, { previousStatus: session.status }); res.json(updated); }));
app.get('/api/admin/live-reports', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.liveSessionReport.findMany({ include: { session: true, reporter: { select: { email: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));
app.patch('/api/admin/live-reports/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const status = z.object({ status: z.enum(['REVIEWED', 'DISMISSED']) }).parse(req.body).status; const report = await prisma.liveSessionReport.update({ where: { id: routeParam(req.params.id) }, data: { status, reviewedById: user.id, reviewedAt: new Date() } }); await audit(user.id, 'LIVE_REPORT_REVIEWED', 'LiveSessionReport', report.id, { status }); res.json(report); }));
app.get('/api/admin/audit', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { actor: { select: { email: true, name: true } } } }))));
app.get('/api/admin/sellers', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.seller.findMany({ include: { user: { select: { email: true, name: true } }, store: true }, orderBy: { createdAt: 'desc' } }))));
app.patch('/api/admin/sellers/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(SellerStatus), reason: z.string().trim().max(500).optional() }).parse(req.body); if ((input.status === SellerStatus.REJECTED || input.status === SellerStatus.SUSPENDED) && !input.reason) return res.status(400).json({ error: 'A reason is required for rejection or suspension' }); const seller = await prisma.$transaction(async tx => { const current = await tx.seller.findUnique({ where: { id: routeParam(req.params.id) } }); if (!current) throw Object.assign(new Error('Seller not found'), { statusCode: 404 }); const updated = await tx.seller.update({ where: { id: current.id }, data: { status: input.status, reason: input.reason } }); await tx.sellerModerationEvent.create({ data: { sellerId: updated.id, actorId: user.id, fromStatus: current.status, toStatus: updated.status, reason: input.reason } }); if (input.status === SellerStatus.APPROVED) await tx.user.update({ where: { id: updated.userId }, data: { role: Role.SELLER } }); return updated; }); await audit(user.id, `SELLER_${input.status}`, 'Seller', seller.id, { reason: input.reason }); res.json(seller); }));
app.patch('/api/admin/products/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(ProductStatus), reason: z.string().max(500).optional() }).parse(req.body); const product = await prisma.product.update({ where: { id: routeParam(req.params.id) }, data: { status: input.status } }); await audit(user.id, `PRODUCT_${input.status}`, 'Product', product.id, { reason: input.reason }); res.json(product); }));
app.get('/api/seller/summary', requireAuth, requireRole(Role.SELLER, Role.CASHIER), asyncRoute(async (_req, res) => { const user = res.locals.user as { sellerId?: string }; if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' }); res.json(await sellerDashboardSummary(user.sellerId)); }));
app.get('/api/admin/orders', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.parentOrder.findMany({ include: { payment: true, sellerOrders: { include: { seller: { include: { store: true } }, items: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe webhook is not configured' });
  let event: StripeType.Event;
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  try { event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'] as string, env.STRIPE_WEBHOOK_SECRET); } catch { return res.status(400).json({ error: 'Invalid Stripe signature' }); }
  const obj = event.data.object as unknown as { id: string; amount?: number; amount_refunded?: number; amount_total?: number | null; payment_intent?: string | { id: string } | null; metadata?: Record<string, string> | null; currency?: string | null; payment_status?: string };
  const paymentIntentId = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
  const isCapture = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type);
  const isRefund = event.type === 'charge.refunded';
  const amountMinor = isRefund ? obj.amount_refunded : event.type === 'charge.dispute.created' ? obj.amount : obj.amount_total;
  const currency = obj.currency ? String(obj.currency).toUpperCase() : null;
  const reconciliationEvent: VerifiedPaymentEvent = {
    provider: 'STRIPE', eventId: event.id, eventType: event.type,
    providerObjectRef: paymentIntentId ?? obj.id,
    paymentLookupRef: isCapture ? obj.id : paymentIntentId ?? obj.id,
    metadataOrderId: obj.metadata?.orderId ?? null,
    amountMinor: typeof amountMinor === 'number' ? amountMinor : null,
    currency,
    providerTotalMinor: isRefund ? obj.amount ?? null : null,
    occurredAt: new Date(event.created * 1000),
    captureConfirmed: isCapture && obj.payment_status === 'paid'
  };
  try {
    const result = await prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, reconciliationEvent), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return res.status(result.reviewReason ? 202 : 200).json({ received: true, reconciliation: result.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const persisted = await prisma.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'STRIPE', eventId: event.id } } });
      if (persisted && !persisted.identityVerified) return res.status(202).json({ received: true, reconciliation: 'REVIEW_REQUIRED' });
      if (persisted && matchesPersistedPaymentEvent(reconciliationEvent, persisted)) {
        return res.status(persisted.reviewReason ? 202 : 200).json({ received: true, reconciliation: persisted.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
      }
    }
    throw error;
  }
}));
app.post('/api/webhooks/paypal', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!env.PAYPAL_WEBHOOK_ID) return res.status(503).json({ error: 'PayPal webhook is not configured' });
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  let verified = false; try { verified = await verifyPaypalWebhook(rawBody, req.headers); } catch { verified = false; }
  if (!verified) return res.status(400).json({ error: 'Invalid PayPal signature' });
  const event = JSON.parse(rawBody.toString('utf8')) as unknown;
  const reconciliationEvent = await paypalWebhookEventToVerifiedPaymentEvent(event, async currency => {
    const entry = await prisma.currencyCatalogEntry.findUnique({ where: { code: currency }, select: { minorUnitExponent: true } });
    return entry?.minorUnitExponent ?? null;
  });
  try {
    const result = await prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, reconciliationEvent), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return res.status(result.reviewReason ? 202 : 200).json({ received: true, reconciliation: result.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const persisted = await prisma.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'PAYPAL', eventId: reconciliationEvent.eventId } } });
      if (persisted && !persisted.identityVerified) return res.status(202).json({ received: true, reconciliation: 'REVIEW_REQUIRED' });
      if (persisted && matchesPersistedPaymentEvent(reconciliationEvent, persisted)) {
        return res.status(persisted.reviewReason ? 202 : 200).json({ received: true, reconciliation: persisted.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
      }
    }
    throw error;
  }
}));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: error.flatten() });
  const apiError = error as Record<string, unknown>;
  const statusCode = typeof apiError.statusCode === 'number' ? apiError.statusCode : undefined;
  if (statusCode) {
    const body: Record<string, unknown> = { error: error instanceof Error ? error.message : 'Live shopping unavailable' };
    if (typeof apiError.code === 'string') body.code = apiError.code;
    if (typeof apiError.entitlement === 'string') body.entitlement = apiError.entitlement;
    for (const field of ['usage', 'requested', 'limit'] as const) {
      const value = apiError[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) body[field] = value;
    }
    if (typeof apiError.upgradeRequired === 'boolean') body.upgradeRequired = apiError.upgradeRequired;
    if (apiError.planUrl === '/seller/plan') body.planUrl = apiError.planUrl;
    if (apiError.liveShoppingState !== undefined) body.liveShopping = apiError.liveShoppingState;
    return res.status(statusCode).json(body);
  }
  console.error(error instanceof Error ? error.message : 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') app.listen(env.API_PORT, () => console.log(`Marketplace API listening on http://localhost:${env.API_PORT}`));
export { app };
