import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import { registerDashboardRoutes } from './dashboard-routes.js';
import { registerMarketplaceRoutes } from './marketplace-routes.js';
import { registerWalletRoutes } from './wallet-routes.js';
import { reverseAffiliateForOrder, settleAffiliateForPaidOrder } from './affiliate-ledger.js';
import { referralTokenHash, verifySignedReferralToken } from './growth-domain.js';

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
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60 }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300 }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
registerContentRoutes(app);
registerGrowthRoutes(app);
registerMarketplaceRoutes(app);
registerPlatformRoutes(app);
registerDashboardRoutes(app);
registerWalletRoutes(app);
if (process.env.NODE_ENV !== 'test') setInterval(() => publishDueContent().catch(error => console.error(error instanceof Error ? error.message : 'Content scheduler failed')), 60_000);

const asyncRoute = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);
const routeParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const orderNumber = () => `MV-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

app.get('/health', (_req, res) => res.json({ ok: true, service: 'marketplace-api' }));
app.get('/ready', asyncRoute(async (_req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); }));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const input = parse(registerSchema, req.body);
  const user = await prisma.user.create({ data: { email: input.email.toLowerCase(), name: input.name, passwordHash: await hashPassword(input.password) } });
  await createSession(user.id, res);
  res.status(201).json({ user: safeUser({ id: user.id, email: user.email, name: user.name, role: user.role }) });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, include: { seller: true } });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  await createSession(user.id, res);
  res.json({ user: safeUser({ id: user.id, email: user.email, name: user.name, role: user.role, ...(user.seller ? { sellerId: user.seller.id } : {}) }) });
}));
app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => { const token = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined; if (token) await prisma.session.deleteMany({ where: { tokenHash: (await import('node:crypto')).createHash('sha256').update(token).digest('hex') } }); res.clearCookie(env.SESSION_COOKIE_NAME); res.clearCookie('marketplace_csrf'); res.status(204).send(); }));
app.get('/api/auth/me', asyncRoute(async (req, res) => { const user = await currentUser(req); res.json({ user: user ? safeUser(user) : null }); }));

app.get('/api/settings/public', asyncRoute(async (_req, res) => {
  const [marketplace, methods, branding] = await Promise.all([prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }), prisma.paymentMethodSettings.findMany({ select: { method: true, enabled: true } }), prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } })]);
  const live = await liveShoppingState();
  res.json({ multiVendorEnabled: marketplace?.multiVendorEnabled ?? true, paymentMethods: methods, branding: branding?.publishedJson ?? null, languages: ['en', 'fil'], baseCurrency: env.CURRENCY, availableDisplayCurrencies: [env.CURRENCY], fxRatesConfigured: false, liveShopping: { enabled: live.effectiveEnabled, deploymentGate: live.deploymentGate, reason: live.reason } });
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
  const seller = user.role === Role.ADMIN ? null : await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED } });
  if (user.role !== Role.ADMIN && !seller) return res.status(403).json({ error: 'Approved seller required' });
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (seller && !settings?.multiVendorEnabled) return res.status(409).json({ error: 'Multi-vendor mode is disabled' });
  const product = await prisma.product.create({ data: { sellerId: seller?.id, categoryId: input.categoryId ?? null, name: input.name, slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`, description: input.description, priceMinor: input.priceMinor, barcode: input.barcode, status: user.role === Role.ADMIN || settings?.productApprovalPolicy === ApprovalPolicy.AUTOMATIC ? ProductStatus.APPROVED : ProductStatus.PENDING, inventory: { create: { quantity: input.stock } } } });
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
  const variant = await prisma.productVariant.create({ data: { productId: product.id, ...input, status: user.role === Role.ADMIN ? ProductStatus.APPROVED : ProductStatus.PENDING } });
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
  const cart = await prisma.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { inventory: true, seller: true } } } } } });
  if (!cart?.items.length) return res.status(400).json({ error: 'Cart is empty' });
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (!settings?.multiVendorEnabled && cart.items.some(i => i.product.sellerId)) return res.status(409).json({ error: 'Seller products are unavailable while multi-vendor mode is disabled' });
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
  const totalMinor = cart.items.reduce((sum, item) => sum + (item.variant?.priceMinor ?? item.product.priceMinor) * item.quantity, 0);
  if (method === PaymentMethod.COD && settings?.codMaxMinor && totalMinor > settings.codMaxMinor) return res.status(409).json({ error: 'Order is above the configured COD limit' });
  const grouped = new Map<string, typeof cart.items>();
  for (const item of cart.items) { if ((item.variant?.stock ?? item.product.inventory?.quantity ?? 0) < item.quantity) return res.status(409).json({ error: `Insufficient stock for ${item.product.name}` }); const key = item.product.sellerId ?? 'platform'; grouped.set(key, [...(grouped.get(key) ?? []), item]); }
  const order = await prisma.$transaction(async tx => {
    for (const item of cart.items) { const updated = item.variant ? await tx.productVariant.updateMany({ where: { id: item.variant.id, stock: { gte: item.quantity } }, data: { stock: { decrement: item.quantity } } }) : await tx.inventory.updateMany({ where: { productId: item.productId, quantity: { gte: item.quantity } }, data: { quantity: { decrement: item.quantity } } }); if (updated.count !== 1) throw new Error(`Stock changed for ${item.product.name}`); }
    const created = await tx.parentOrder.create({ data: { orderNumber: orderNumber(), buyerId: user.id, affiliateClickId: affiliateClick?.id, buyerEmail: input.buyerEmail, buyerName: input.buyerName, addressJson: input.address, totalMinor, currency: env.CURRENCY, sellerOrders: { create: [...grouped.entries()].map(([sellerId, items]) => ({ sellerId: sellerId === 'platform' ? null : sellerId, totalMinor: items.reduce((s, i) => s + (i.variant?.priceMinor ?? i.product.priceMinor) * i.quantity, 0), items: { create: items.map(i => ({ productId: i.productId, variantId: i.variant?.id, variantName: i.variant?.name, productName: i.product.name, unitPriceMinor: i.variant?.priceMinor ?? i.product.priceMinor, quantity: i.quantity })) } })) }, payment: { create: { method, status: PaymentStatus.PENDING } } } });
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } }); return created;
  });
  let paymentAction: unknown = null;
  try {
    if (method === PaymentMethod.STRIPE) { const session = await createStripeCheckout({ id: order.id, orderNumber: order.orderNumber, totalMinor, currency: env.CURRENCY, buyerEmail: input.buyerEmail }, `${env.WEB_ORIGIN}/orders/${order.id}?payment=success`, `${env.WEB_ORIGIN}/orders/${order.id}?payment=cancelled`); await prisma.payment.update({ where: { parentId: order.id }, data: { providerRef: session.id } }); paymentAction = { provider: 'STRIPE', checkoutUrl: session.url }; }
    if (method === PaymentMethod.PAYPAL) { const pp = await createPaypalOrder({ id: order.id, orderNumber: order.orderNumber, totalMinor, currency: env.CURRENCY }); await prisma.payment.update({ where: { parentId: order.id }, data: { providerRef: pp.id } }); paymentAction = { provider: 'PAYPAL', providerOrderId: pp.id, approvalUrl: pp.links?.find(link => link.rel === 'approve')?.href }; }
  } catch (error) { await prisma.payment.update({ where: { parentId: order.id }, data: { status: PaymentStatus.FAILED } }); return res.status(502).json({ error: error instanceof Error ? error.message : 'Payment provider unavailable', orderId: order.id }); }
  res.status(201).json({ orderId: order.id, orderNumber: order.orderNumber, payment: paymentAction, paymentStatus: method === PaymentMethod.COD ? 'PENDING' : 'AWAITING_PROVIDER' });
}));

app.post('/api/orders/:id/paypal-capture', requireAuth, asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const order = await prisma.parentOrder.findFirst({ where: { id: routeParam(req.params.id), buyerId: user.id }, include: { payment: true } }); if (!order || order.payment?.method !== PaymentMethod.PAYPAL || !order.payment.providerRef) return res.status(404).json({ error: 'Order not found' }); const captured = await capturePaypalOrder(order.payment.providerRef); if (captured.status !== 'COMPLETED') return res.status(409).json({ error: 'PayPal capture is not completed' }); await prisma.payment.update({ where: { parentId: order.id }, data: { status: PaymentStatus.PAID, paidAt: new Date() } }); await prisma.parentOrder.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } }); await settleAffiliateForPaidOrder(order.id); res.json({ ok: true, status: captured.status }); }));

app.post('/api/orders/:id/cod-collect', requireAuth, requireRole(Role.ADMIN, Role.SELLER, Role.CASHIER), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string; role: Role; sellerId?: string }; const order = await prisma.parentOrder.findFirst({ where: { id: routeParam(req.params.id), payment: { method: PaymentMethod.COD }, ...(user.role === Role.ADMIN ? {} : { sellerOrders: { some: { sellerId: user.sellerId } } }) }, include: { payment: true } }); if (!order || !order.payment) return res.status(404).json({ error: 'COD order not found' }); if (order.payment.status === PaymentStatus.PAID) return res.json({ ok: true, alreadyCollected: true }); await prisma.$transaction([prisma.payment.update({ where: { parentId: order.id }, data: { status: PaymentStatus.PAID, paidAt: new Date() } }), prisma.parentOrder.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } })]); await settleAffiliateForPaidOrder(order.id); await audit(user.id, 'COD_CASH_COLLECTED', 'Payment', order.payment.id, { orderId: order.id }); res.json({ ok: true, collectedAt: new Date().toISOString() }); }));

app.get('/api/orders', requireAuth, asyncRoute(async (req, res) => { const user = res.locals.user as { id: string; role: Role; sellerId?: string }; const orders = user.role === Role.ADMIN ? await prisma.parentOrder.findMany({ include: { payment: true, sellerOrders: true }, orderBy: { createdAt: 'desc' }, take: 100 }) : user.sellerId ? await prisma.parentOrder.findMany({ where: { sellerOrders: { some: { sellerId: user.sellerId } } }, include: { payment: true, sellerOrders: { where: { sellerId: user.sellerId }, include: { items: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }) : await prisma.parentOrder.findMany({ where: { buyerId: user.id }, include: { payment: true, sellerOrders: { include: { items: true } } }, orderBy: { createdAt: 'desc' } }); res.json(orders); }));

app.post('/api/sellers/:sellerId/orders/:orderId/status', requireAuth, requireRole(Role.SELLER, Role.CASHIER, Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { role: Role; sellerId?: string; id: string }; const next = z.object({ status: z.enum(['CONFIRMED', 'PROCESSING', 'FULFILLED', 'CANCELLED']) }).parse(req.body).status as OrderStatus; const sellerId = user.role === Role.ADMIN ? routeParam(req.params.sellerId) : user.sellerId; const sellerOrder = await prisma.sellerOrder.findFirst({ where: { id: routeParam(req.params.orderId), sellerId }, include: { items: true } }); if (!sellerOrder) return res.status(404).json({ error: 'Seller order not found' }); await prisma.sellerOrder.update({ where: { id: sellerOrder.id }, data: { status: next } }); if (next === OrderStatus.CANCELLED) for (const item of sellerOrder.items) await reverseAffiliateForOrder(sellerOrder.parentId, { type: AffiliateAdjustmentType.CANCELLATION, orderItemId: item.id, idempotencyKey: `seller-cancellation:${sellerOrder.id}:${item.id}`, reason: 'Seller order cancelled', createdById: user.id }); await audit(user.id, 'ORDER_STATUS_CHANGED', 'SellerOrder', sellerOrder.id, { status: next }); res.json({ ok: true }); }));

app.post('/api/pos/sales', requireAuth, requireRole(Role.SELLER, Role.CASHIER), asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string; role: Role; sellerId?: string };
  const input = parse(posSchema, req.body);
  const setting = await prisma.paymentMethodSettings.findUnique({ where: { method: PaymentMethod.POS } });
  if (!setting?.enabled) return res.status(409).json({ error: 'POS is disabled' });
  const sellerId = user.sellerId;
  if (!sellerId) return res.status(403).json({ error: 'Approved seller required' });
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED } }); if (!seller) return res.status(403).json({ error: 'Approved seller required' });
  const sale = await prisma.$transaction(async tx => {
    const products = [] as { productId: string; quantity: number; productName: string; priceMinor: number }[];
    for (const item of input.items) { const product = await tx.product.findFirst({ where: { id: item.productId, sellerId, status: ProductStatus.APPROVED }, include: { inventory: true } }); if (!product) throw new Error('Product is not available to this seller'); const updated = await tx.inventory.updateMany({ where: { productId: product.id, quantity: { gte: item.quantity } }, data: { quantity: { decrement: item.quantity } } }); if (updated.count !== 1) throw new Error(`Insufficient stock for ${product.name}`); products.push({ productId: product.id, quantity: item.quantity, productName: product.name, priceMinor: product.priceMinor }); }
    const totalMinor = products.reduce((s, p) => s + p.priceMinor * p.quantity, 0);
    const pos = await tx.pOSSession.create({ data: { sellerId, cashierId: user.id, register: input.register } });
    const order = await tx.parentOrder.create({ data: { orderNumber: orderNumber(), buyerName: input.buyerName, buyerEmail: 'pos@local.invalid', addressJson: {}, totalMinor, currency: env.CURRENCY, status: OrderStatus.CONFIRMED, sellerOrders: { create: { sellerId, totalMinor, status: OrderStatus.FULFILLED, items: { create: products.map(p => ({ productId: p.productId, productName: p.productName, unitPriceMinor: p.priceMinor, quantity: p.quantity })) } } }, payment: { create: { method: PaymentMethod.POS, status: PaymentStatus.PAID, paidAt: new Date() } } } });
    return { order, pos };
  });
  await settleAffiliateForPaidOrder(sale.order.id);
  await audit(user.id, 'POS_SALE_COMPLETED', 'ParentOrder', sale.order.id, { register: input.register });
  res.status(201).json({ orderId: sale.order.id, receiptUrl: `/api/pos/receipts/${sale.order.id}` });
}));
app.get('/api/pos/receipts/:id', requireAuth, asyncRoute(async (req, res) => { const user = res.locals.user as { sellerId?: string; role: Role }; const order = await prisma.parentOrder.findFirst({ where: { id: routeParam(req.params.id), sellerOrders: { some: user.role === Role.ADMIN ? {} : { sellerId: user.sellerId } }, payment: { method: PaymentMethod.POS } }, include: { sellerOrders: { include: { items: true, seller: { include: { store: true } } } }, payment: true } }); if (!order) return res.status(404).send('Receipt not found'); res.type('html').send(`<html><head><title>Receipt ${order.orderNumber}</title><style>body{font-family:system-ui;max-width:420px;margin:2rem auto} @media print{button{display:none}}</style></head><body><h1>Receipt</h1><p>${order.orderNumber}</p>${order.sellerOrders.flatMap(s => s.items.map(i => `<p>${i.quantity} × ${i.productName} — ${(i.unitPriceMinor / 100).toFixed(2)} ${order.currency}</p>`)).join('')}<hr><strong>Total ${(order.totalMinor / 100).toFixed(2)} ${order.currency}</strong><br><button onclick="print()">Print</button></body></html>`); }));

app.get('/api/admin/settings', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => { const [marketplace, paymentMethods, liveShopping] = await Promise.all([prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }), prisma.paymentMethodSettings.findMany({ orderBy: { method: 'asc' } }), liveShoppingState()]); res.json({ marketplace, paymentMethods, liveShopping }); }));
app.patch('/api/admin/settings', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = parse(settingSchema, req.body); if (input.multiVendorEnabled !== undefined) { const old = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }); const updated = await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { multiVendorEnabled: input.multiVendorEnabled }, create: { id: 'default', multiVendorEnabled: input.multiVendorEnabled } }); await audit(user.id, 'MARKETPLACE_MODE_CHANGED', 'MarketplaceSettings', 'default', { old: old?.multiVendorEnabled, new: input.multiVendorEnabled, reason: input.reason }); res.json(updated); return; } if (input.liveShoppingEnabled !== undefined) { const live = await liveShoppingState(); if (input.liveShoppingEnabled && (!live.deploymentGate || !live.readiness.configured || !live.readiness.healthy)) return res.status(409).json({ error: `Live shopping cannot be enabled: ${live.reason}`, liveShopping: live }); const old = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { liveShoppingEnabled: true } }); const updated = await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { liveShoppingEnabled: input.liveShoppingEnabled }, create: { id: 'default', liveShoppingEnabled: input.liveShoppingEnabled } }); await audit(user.id, 'LIVE_SHOPPING_MODE_CHANGED', 'MarketplaceSettings', 'default', { old: old?.liveShoppingEnabled ?? false, new: input.liveShoppingEnabled, reason: input.reason }); res.json(updated); return; } if (input.method && input.enabled !== undefined) { const old = await prisma.paymentMethodSettings.findUnique({ where: { method: input.method as PaymentMethod } }); const updated = await prisma.paymentMethodSettings.upsert({ where: { method: input.method as PaymentMethod }, update: { enabled: input.enabled }, create: { id: input.method.toLowerCase(), method: input.method as PaymentMethod, enabled: input.enabled } }); await audit(user.id, 'PAYMENT_METHOD_CHANGED', 'PaymentMethodSettings', input.method, { old: old?.enabled, new: input.enabled, reason: input.reason }); res.json(updated); return; } res.status(400).json({ error: 'No supported setting provided' }); }));
app.get('/api/admin/live-sessions', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.liveSession.findMany({ include: { seller: { include: { store: true } }, products: { include: { product: true } }, reports: true }, orderBy: { createdAt: 'desc' }, take: 100 }))));
app.post('/api/admin/live-sessions/:id/terminate', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const session = await prisma.liveSession.findUnique({ where: { id: routeParam(req.params.id) } }); if (!session) return res.status(404).json({ error: 'Live session not found' }); if (session.providerSessionRef) await liveProvider.endSession(session.providerSessionRef); const updated = await prisma.liveSession.update({ where: { id: session.id }, data: { status: 'ENDED', endedAt: new Date() } }); await audit(user.id, 'LIVE_SESSION_TERMINATED', 'LiveSession', session.id, { previousStatus: session.status }); res.json(updated); }));
app.get('/api/admin/live-reports', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.liveSessionReport.findMany({ include: { session: true, reporter: { select: { email: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));
app.patch('/api/admin/live-reports/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const status = z.object({ status: z.enum(['REVIEWED', 'DISMISSED']) }).parse(req.body).status; const report = await prisma.liveSessionReport.update({ where: { id: routeParam(req.params.id) }, data: { status, reviewedById: user.id, reviewedAt: new Date() } }); await audit(user.id, 'LIVE_REPORT_REVIEWED', 'LiveSessionReport', report.id, { status }); res.json(report); }));
app.get('/api/admin/audit', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { actor: { select: { email: true, name: true } } } }))));
app.get('/api/admin/sellers', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.seller.findMany({ include: { user: { select: { email: true, name: true } }, store: true }, orderBy: { createdAt: 'desc' } }))));
app.patch('/api/admin/sellers/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(SellerStatus), reason: z.string().trim().max(500).optional() }).parse(req.body); if ((input.status === SellerStatus.REJECTED || input.status === SellerStatus.SUSPENDED) && !input.reason) return res.status(400).json({ error: 'A reason is required for rejection or suspension' }); const seller = await prisma.$transaction(async tx => { const current = await tx.seller.findUnique({ where: { id: routeParam(req.params.id) } }); if (!current) throw Object.assign(new Error('Seller not found'), { statusCode: 404 }); const updated = await tx.seller.update({ where: { id: current.id }, data: { status: input.status, reason: input.reason } }); await tx.sellerModerationEvent.create({ data: { sellerId: updated.id, actorId: user.id, fromStatus: current.status, toStatus: updated.status, reason: input.reason } }); if (input.status === SellerStatus.APPROVED) await tx.user.update({ where: { id: updated.userId }, data: { role: Role.SELLER } }); return updated; }); await audit(user.id, `SELLER_${input.status}`, 'Seller', seller.id, { reason: input.reason }); res.json(seller); }));
app.patch('/api/admin/products/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(ProductStatus), reason: z.string().max(500).optional() }).parse(req.body); const product = await prisma.product.update({ where: { id: routeParam(req.params.id) }, data: { status: input.status } }); await audit(user.id, `PRODUCT_${input.status}`, 'Product', product.id, { reason: input.reason }); res.json(product); }));
app.get('/api/seller/summary', requireAuth, requireRole(Role.SELLER, Role.CASHIER), asyncRoute(async (_req, res) => { const user = res.locals.user as { sellerId?: string }; if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' }); const result = await prisma.sellerOrder.aggregate({ where: { sellerId: user.sellerId, status: { not: OrderStatus.CANCELLED } }, _sum: { totalMinor: true }, _count: { _all: true } }); res.json({ orderCount: result._count._all, grossMinor: result._sum.totalMinor ?? 0, currency: env.CURRENCY }); }));
app.get('/api/admin/orders', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.parentOrder.findMany({ include: { payment: true, sellerOrders: { include: { seller: { include: { store: true } }, items: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe webhook is not configured' });
  let event: StripeType.Event;
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  try { event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'] as string, env.STRIPE_WEBHOOK_SECRET); } catch { return res.status(400).json({ error: 'Invalid Stripe signature' }); }
  const already = await prisma.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: PaymentMethod.STRIPE, eventId: event.id } } });
  if (already) return res.json({ received: true });
  const obj = event.data.object as StripeType.Checkout.Session & { amount?: number; amount_refunded?: number; payment_intent?: string; metadata?: Record<string, string> };
  const matchingPayment = await prisma.payment.findFirst({ where: { method: PaymentMethod.STRIPE, OR: [{ providerRef: obj.id }, ...(obj.payment_intent ? [{ providerRef: obj.payment_intent }] : [])] } });
  const orderId = obj.metadata?.orderId ?? matchingPayment?.parentId;
  if (orderId && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    await prisma.$transaction([prisma.payment.updateMany({ where: { parentId: orderId, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.PAID, paidAt: new Date(), providerRef: obj.id } }), prisma.parentOrder.updateMany({ where: { id: orderId, status: OrderStatus.PENDING }, data: { status: OrderStatus.CONFIRMED } })]);
    await settleAffiliateForPaidOrder(orderId);
  } else if (orderId && ['charge.refunded', 'charge.dispute.created'].includes(event.type)) {
    await reverseAffiliateForOrder(orderId, { type: event.type === 'charge.dispute.created' ? AffiliateAdjustmentType.CHARGEBACK : AffiliateAdjustmentType.REFUND, eventId: event.id, idempotencyKey: event.id, amountMinor: Number(obj.amount_refunded ?? obj.amount ?? 0) || undefined, reason: `Verified Stripe event ${event.type}` });
    if (event.type === 'charge.refunded') await prisma.payment.updateMany({ where: { parentId: orderId }, data: { status: PaymentStatus.REFUNDED } });
  }
  await prisma.processedWebhookEvent.create({ data: { provider: PaymentMethod.STRIPE, eventId: event.id } });
  res.json({ received: true });
}));
app.post('/api/webhooks/paypal', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!env.PAYPAL_WEBHOOK_ID) return res.status(503).json({ error: 'PayPal webhook is not configured' });
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  let verified = false; try { verified = await verifyPaypalWebhook(rawBody, req.headers); } catch { verified = false; }
  if (!verified) return res.status(400).json({ error: 'Invalid PayPal signature' });
  const event = JSON.parse(rawBody.toString('utf8')) as { id: string; event_type: string; resource?: { id?: string; amount?: { value?: string }; supplementary_data?: { related_ids?: { order_id?: string } } } };
  const already = await prisma.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: PaymentMethod.PAYPAL, eventId: event.id } } });
  if (already) return res.json({ received: true });
  const providerRef = event.resource?.supplementary_data?.related_ids?.order_id ?? event.resource?.id;
  const payment = providerRef ? await prisma.payment.findFirst({ where: { method: PaymentMethod.PAYPAL, providerRef } }) : null;
  if (payment && (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'CHECKOUT.ORDER.COMPLETED')) { await prisma.payment.updateMany({ where: { id: payment.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.PAID, paidAt: new Date() } }); await settleAffiliateForPaidOrder(payment.parentId); }
  if (payment && ['PAYMENT.CAPTURE.REFUNDED', 'CUSTOMER.DISPUTE.CREATED'].includes(event.event_type)) { await reverseAffiliateForOrder(payment.parentId, { type: event.event_type === 'CUSTOMER.DISPUTE.CREATED' ? AffiliateAdjustmentType.CHARGEBACK : AffiliateAdjustmentType.REFUND, eventId: event.id, idempotencyKey: event.id, amountMinor: event.resource?.amount?.value ? Math.round(Number(event.resource.amount.value) * 100) : undefined, reason: `Verified PayPal event ${event.event_type}` }); if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.REFUNDED } }); }
  await prisma.processedWebhookEvent.create({ data: { provider: PaymentMethod.PAYPAL, eventId: event.id } });
  res.json({ received: true });
}));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: error.flatten() }); const statusCode = (error as { statusCode?: number }).statusCode; if (statusCode) return res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Live shopping unavailable', liveShopping: (error as { liveShoppingState?: unknown }).liveShoppingState }); console.error(error instanceof Error ? error.message : 'Unhandled error'); res.status(500).json({ error: 'Internal server error' }); });

if (process.env.NODE_ENV !== 'test') app.listen(env.API_PORT, () => console.log(`Marketplace API listening on http://localhost:${env.API_PORT}`));
export { app };
