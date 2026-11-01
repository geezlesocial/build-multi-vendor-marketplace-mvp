import express from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { diagnostics } from './diagnostics.js';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { AffiliateAdjustmentType, ApprovalPolicy, LiveSessionStatus, Prisma, PaymentMethod, PaymentStatus, ProductStatus, Role, SellerStatus, OrderStatus } from '@prisma/client';
import type { Stripe as StripeType } from 'stripe';
import { env } from './config.js';
import { prisma, hashPassword, verifyPassword, createSession, currentUser, requireAuth, requireRole, audit, safeUser, resolvePlatformPositionName } from './security.js';
import { registerSchema, loginSchema, checkoutSchema, productSchema, variantSchema, posSchema, settingSchema, liveReportSchema } from './validation.js';
import { capturePaypalOrder, createPaymongoCheckout, createPaypalOrder, createPaystackTransaction, createStripeCheckout, stripe, verifyPaypalWebhook } from './payments.js';
import { liveShoppingState, publicLiveSession, requireLiveShopping } from './live-domain.js';
import { liveProvider } from './live-provider.js';
import { registerLiveProviderConfigurationRoutes, syncLiveProviderFromDatabase } from './live-provider-config.js';
import { liveReplayStorageReady, reconcileLiveRecordings, streamReplayObject } from './live-replays.js';
import { registerContentRoutes } from './content-routes.js';
import { publishDueContent } from './content-scheduler.js';
import { registerGrowthRoutes } from './growth-routes.js';
import { registerCampaignMediaRoutes } from './campaign-media-routes.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { registerSiteChromeRoutes } from './site-chrome-routes.js';
import { registerDashboardRoutes, sellerDashboardSummary } from './dashboard-routes.js';
import { registerMarketplaceRoutes } from './marketplace-routes.js';
import { registerWalletRoutes } from './wallet-routes.js';
import { registerMarketplaceAdRoutes, releaseExpiredMarketplaceAdBudgets } from './marketplace-ad-routes.js';
import { registerAvatarRoutes } from './avatar-routes.js';
import { registerStorePlanRoutes } from './store-plan-routes.js';
import { registerPlatformStoreRoutes } from './platform-store-routes.js';
import { registerStoreSubscriptionRoutes } from './store-subscription-routes.js';
import { expireDueStoreSubscriptions } from './store-subscription-lifecycle.js';
import { registerIntegrationRoutes } from './integration-routes.js';
import { registerStoreContentRoutes } from './store-content-routes.js';
import { registerStoreMediaRoutes } from './store-media-routes.js';
import { registerBrandingMediaRoutes } from './branding-media-routes.js';
import { registerStoreGrowthRoutes } from './store-growth-routes.js';
import { registerEmailProviderConfigurationRoutes } from './store-email-provider-config.js';
import { registerSellerStoreIntegrationRoutes } from './seller-store-integrations.js';
import { registerProductMediaRoutes } from './product-media-routes.js';
import { registerShippingRoutes } from './shipping-routes.js';
import { refreshGlobalReferenceRates, registerCurrencyRoutes } from './currency-routes.js';
import { enabledMarketplaceLanguages } from './marketplace-domain.js';
import { processStoreEmailDeliveryBatch, processTransactionalEmailOutboxBatch } from './store-email-worker.js';
import { registerCommissionRoutes } from './commission-routes.js';
import { registerCatalogRoutes, validateProductCatalogSelection } from './catalog-routes.js';
import { registerProductDiscountRoutes, resolveCartProductDiscount } from './product-discount-routes.js';
import { registerOrderShippingRoutes } from './order-shipping-routes.js';
import { registerOrderResolutionRoutes } from './order-resolution-routes.js';
import { registerSupportRoutes } from './support-routes.js';
import { purgeExpiredJimaConversations, registerJimaRoutes } from './jima-routes.js';
import { registerMemberAdminRoutes } from './member-admin-routes.js';
import { registerPlatformCollaboratorRoutes } from './platform-collaborator-routes.js';
import { registerCarrierRoutes } from './carrier-routes.js';
import { registerDropshippingRoutes } from './dropshipping-routes.js';
import { applicableSellerCommissionPolicy, makeCommissionSnapshot, accrueSellerCommissionsForPaidOrder, reverseSellerCommissionForOrder } from './seller-commission.js';
import { livePaymentActivationBlock } from './provider-activation.js';
import { effectiveStorePlan, isAtLimit, storeEntitlements } from './store-plan-domain.js';
import { reverseAffiliateForOrderInTransaction, settleAffiliateForPaidOrderInTransaction } from './affiliate-ledger.js';
import { referralTokenHash, verifySignedReferralToken } from './growth-domain.js';
import { createApiRateLimiters, resolveApiRateLimitOptions } from './api-rate-limits.js';
import { assertShippingSelectionsMatch, buildSellerShippingQuote, verifyCheckoutShippingQuote, type ShippingCartRecord } from './shipping-routes.js';
import { convertMinorExact, decimalToMinorExact } from './currency-domain.js';
import { effectiveProductPriceMinor, effectiveUnitPriceMinor, isValidSalePrice } from './product-pricing.js';
import { latestDisplayRate } from './currency-routes.js';
import { matchesPersistedPaymentEvent, reconcileVerifiedPaymentEvent, type VerifiedPaymentEvent } from './payment-webhook-reconciliation.js';
import { paypalWebhookEventToVerifiedPaymentEvent } from './paypal-webhook-event.js';
import { codCheckoutEligibilityFailure, exceedsCodOrderLimit } from './cod-policy.js';
import { awardClubCoinsForCompletedOrder } from './club-coins-awards.js';
import { createRoleNotifications, createUserNotification } from './notification-delivery.js';
import { provisionApprovedSellerStore } from './seller-store-provisioning.js';
import { notifyOrderParties } from './order-notifications.js';
import { createAccountVerificationChallenge, deliverAccountVerification, registerAccountVerificationRoutes } from './account-verification-routes.js';
import { registerProductReviewRoutes } from './product-review-routes.js';
import { registerLiveAttendanceRoutes } from './live-attendance-routes.js';
import { registerLiveEngagementRoutes } from './live-engagement-routes.js';
import { registerLiveSocialRoutes } from './live-social-routes.js';
import { registerLiveShopRoutes } from './live-shop-routes.js';
import { registerSellerLiveSessionRoutes } from './seller-live-session-routes.js';
import { purgeExpiredMessageAttachmentDrafts, registerMessageRoutes } from './message-routes.js';
import { wholesaleConfigurationError, wholesaleQuantityError } from './wholesale-domain.js';
import { registerSocialAuthRoutes } from './social-auth-routes.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { handleSponsoredPaypalEvent, handleSponsoredStripeEvent } from './store-buster-sponsored.js';
import { providerCurrencyForMethod, createProviderChargeQuote, paymongoEventToVerifiedPaymentEvent, paystackEventToVerifiedPaymentEvent, verifyPaymongoSignature, verifyPaystackSignature, type ProviderChargeQuote } from './payment-gateway-domain.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use((req, res, next) => {
  const providedId = req.get('x-request-id') ?? '';
  const trustedProxyId = env.TRUST_PROXY_HOPS === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providedId);
  const correlationId = trustedProxyId ? providedId : randomUUID();
  res.setHeader('x-request-id', correlationId);
  diagnostics.runWithRequestContext(correlationId, next);
});
app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'https:', 'https://*.cjdropshipping.com', 'https://*.aliyuncs.com'], mediaSrc: ["'self'", 'https:'] } } }));
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  const publicEmailCapability = req.path === '/api/auth/verify-email' || req.path.startsWith('/api/store-email/confirm/') || req.path.startsWith('/api/store-email/unsubscribe/') || /^\/api\/stores\/[^/]+\/newsletter$/.test(req.path);
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.cookies?.marketplace_csrf) res.cookie('marketplace_csrf', randomUUID(), { httpOnly: false, secure: env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
    return next();
  }
  if (req.path.startsWith('/api/webhooks/') || req.path === '/api/auth/login' || req.path === '/api/auth/register' || publicEmailCapability) return next();
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
registerCampaignMediaRoutes(app);
registerMarketplaceRoutes(app);
registerPlatformRoutes(app);
registerSiteChromeRoutes(app);
registerDashboardRoutes(app);
registerWalletRoutes(app);
registerMarketplaceAdRoutes(app);
registerAvatarRoutes(app);
registerStorePlanRoutes(app);
registerPlatformStoreRoutes(app);
registerStoreSubscriptionRoutes(app);
registerIntegrationRoutes(app);
registerStoreContentRoutes(app);
registerStoreMediaRoutes(app);
registerBrandingMediaRoutes(app);
registerStoreGrowthRoutes(app);
registerEmailProviderConfigurationRoutes(app);
registerSellerStoreIntegrationRoutes(app);
registerProductMediaRoutes(app);
registerShippingRoutes(app);
registerCurrencyRoutes(app);
registerCommissionRoutes(app);
registerCatalogRoutes(app);
registerProductDiscountRoutes(app);
registerOrderShippingRoutes(app);
registerOrderResolutionRoutes(app);
registerSupportRoutes(app);
registerJimaRoutes(app);
registerMemberAdminRoutes(app);
registerPlatformCollaboratorRoutes(app);
registerCarrierRoutes(app);
registerDropshippingRoutes(app);
registerAccountVerificationRoutes(app);
registerProductReviewRoutes(app);
registerLiveAttendanceRoutes(app);
registerLiveEngagementRoutes(app);
registerLiveSocialRoutes(app);
registerLiveShopRoutes(app);
registerMessageRoutes(app);
registerSocialAuthRoutes(app);
registerOnboardingRoutes(app);
registerLiveProviderConfigurationRoutes(app);
if (process.env.NODE_ENV !== 'test') setInterval(() => publishDueContent().catch(error => diagnostics.logOperationalError('CONTENT_SCHEDULER_FAILED', error)), 60_000);
if (process.env.NODE_ENV !== 'test') setInterval(() => expireDueStoreSubscriptions(prisma).catch(error => diagnostics.logOperationalError('STORE_SUBSCRIPTION_EXPIRY_FAILED', error)), 60_000);
if (process.env.NODE_ENV !== 'test') setInterval(() => processStoreEmailDeliveryBatch().catch(error => diagnostics.logOperationalError('STORE_EMAIL_DELIVERY_WORKER_FAILED', error)), 5_000);
if (process.env.NODE_ENV !== 'test') setInterval(() => processTransactionalEmailOutboxBatch().catch(error => diagnostics.logOperationalError('TRANSACTIONAL_EMAIL_DELIVERY_WORKER_FAILED', error)), 5_000);
if (process.env.NODE_ENV !== 'test') setInterval(() => releaseExpiredMarketplaceAdBudgets().catch(error => diagnostics.logOperationalError('MARKETPLACE_AD_BUDGET_RECONCILIATION_FAILED', error)), 60_000);
if (process.env.NODE_ENV !== 'test') setInterval(() => purgeExpiredJimaConversations().catch(error => diagnostics.logOperationalError('JIMA_RETENTION_CLEANUP_FAILED', error)), 60 * 60 * 1000);
if (process.env.NODE_ENV !== 'test') setInterval(() => purgeExpiredMessageAttachmentDrafts().catch(error => diagnostics.logOperationalError('MESSAGE_DRAFT_CLEANUP_FAILED', error)), 60 * 60 * 1000);
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => { void syncLiveProviderFromDatabase().then(reconcileLiveRecordings).catch(error => diagnostics.logOperationalError('LIVE_PROVIDER_SYNC_FAILED', error)); }, 5_000);
  setInterval(() => { void syncLiveProviderFromDatabase().then(reconcileLiveRecordings).catch(error => diagnostics.logOperationalError('LIVE_PROVIDER_SYNC_FAILED', error)); }, 15_000);
}
if (process.env.NODE_ENV !== 'test' && env.FX_REFERENCE_FETCH_ENABLED) {
  const refreshReferenceRates = () => refreshGlobalReferenceRates().catch(error => diagnostics.logOperationalError('REFERENCE_EXCHANGE_RATE_REFRESH_FAILED', error));
  setTimeout(() => void refreshReferenceRates(), 1_500);
  setInterval(() => void refreshReferenceRates(), 24 * 60 * 60 * 1000);
}

const asyncRoute = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);
const routeParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const orderNumber = () => `MV-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

app.get('/health', (_req, res) => res.json({ ok: true, service: 'marketplace-api' }));
app.get('/ready', asyncRoute(async (_req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); }));

app.post('/api/auth/register', credentialLimiter, asyncRoute(async (req, res) => {
  const input = parse(registerSchema, req.body);
  const user = await prisma.$transaction(async tx => {
    const created = await tx.user.create({ data: { email: input.email.toLowerCase(), name: input.name, passwordHash: await hashPassword(input.password) } });
    await createUserNotification(tx, { userId: created.id, eventType: 'ACCOUNT_CREATED', title: 'Welcome to Market Lane', body: 'Your account is ready. Verify your email and complete onboarding to start exploring the marketplace.', link: '/onboarding', payloadJson: { userId: created.id } }, 'account');
    await createRoleNotifications(tx, Role.ADMIN, { eventType: 'ACCOUNT_CREATED', title: 'New member account created', body: `${created.name} (${created.email}) created a marketplace account.`, link: '/admin/platform?section=members', payloadJson: { userId: created.id } }, 'account');
    return created;
  });
  const challenge = await createAccountVerificationChallenge(user.id);
  const delivery = await deliverAccountVerification(challenge);
  await createSession(user.id, res);
  res.status(201).json({ user: safeUser({ id: user.id, email: user.email, name: user.name, role: user.role, emailVerifiedAt: user.emailVerifiedAt, onboardingCompletedAt: user.onboardingCompletedAt }), verificationEmailSent: delivery.sent });
}));
app.post('/api/auth/login', credentialLimiter, asyncRoute(async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, include: { seller: true, platformCollaborator: true } });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  const account = await prisma.$queryRaw<{ accountStatus: string }[]>`SELECT "accountStatus" FROM "User" WHERE "id" = ${user.id}`;
  if (account[0]?.accountStatus !== 'ACTIVE') return res.status(403).json({ error: 'This account is not currently available. Contact platform support.' });
  await createSession(user.id, res);
  const collaborator = user.platformCollaborator;
  const platformPositionName = user.role === Role.PLATFORM_STAFF && collaborator?.enabled ? await resolvePlatformPositionName(collaborator.position) : undefined;
  res.json({ user: safeUser({ id: user.id, email: user.email, name: user.name, role: user.role, emailVerifiedAt: user.emailVerifiedAt, onboardingCompletedAt: user.onboardingCompletedAt, ...(user.seller ? { sellerId: user.seller.id } : {}), ...(user.avatarMediaId ? { avatarUrl: '/api/account/avatar' } : {}), ...(user.role === Role.PLATFORM_STAFF && collaborator?.enabled ? { platformPosition: collaborator.position as import('./platform-access.js').PlatformPosition, platformPositionName, platformPermissions: collaborator.permissions } : {}) }) });
}));
app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => { const token = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined; if (token) await prisma.session.deleteMany({ where: { tokenHash: (await import('node:crypto')).createHash('sha256').update(token).digest('hex') } }); res.clearCookie(env.SESSION_COOKIE_NAME); res.clearCookie('marketplace_csrf'); res.status(204).send(); }));
app.get('/api/auth/me', asyncRoute(async (req, res) => { const user = await currentUser(req); res.json({ user: user ? safeUser(user) : null }); }));

app.get('/api/settings/public', asyncRoute(async (_req, res) => {
  const [marketplace, methods, branding] = await Promise.all([prisma.marketplaceSettings.findUnique({ where: { id: 'default' } }), prisma.paymentMethodSettings.findMany({ select: { method: true, enabled: true } }), prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } })]);
  const live = await liveShoppingState();
  const availableDisplayCurrencies = await (await import('./currency-routes.js')).availableGlobalDisplayCurrencies();
  res.json({ multiVendorEnabled: marketplace?.multiVendorEnabled ?? true, paymentMethods: methods, branding: branding?.publishedJson ?? null, languages: enabledMarketplaceLanguages(marketplace?.enabledLanguages), baseCurrency: env.CURRENCY, checkoutCurrency: env.CURRENCY, availableDisplayCurrencies, fxRatesConfigured: availableDisplayCurrencies.length > 1, subscriptionBillingEnabled: false, liveShopping: { enabled: live.effectiveEnabled, deploymentGate: live.deploymentGate, reason: live.reason } });
}));

app.get('/api/live-shopping/status', asyncRoute(async (_req, res) => {
  const state = await liveShoppingState();
  res.json({ ...state, recordingAvailable: state.readiness.configured && liveReplayStorageReady(), recordingStorageConfigured: liveReplayStorageReady() });
}));
app.get('/api/live-sessions', asyncRoute(async (_req, res) => {
  const liveState = await liveShoppingState();
  const visibleSessions: Prisma.LiveSessionWhereInput[] = [{ status: 'ENDED', recordingStatus: 'READY', replayPublishedAt: { not: null } }];
  if (liveState.effectiveEnabled) visibleSessions.push({ status: { in: [LiveSessionStatus.SCHEDULED, LiveSessionStatus.STARTING, LiveSessionStatus.LIVE, LiveSessionStatus.PAUSED] }, OR: [{ status: { not: LiveSessionStatus.SCHEDULED } }, { scheduledAt: { gte: new Date() } }] });
  const liveSessionWhere: Prisma.LiveSessionWhereInput = { deletedAt: null, seller: { is: { status: SellerStatus.APPROVED } }, OR: visibleSessions };
  const sessions = await prisma.liveSession.findMany({ where: liveSessionWhere, include: { seller: { include: { store: { select: { name: true, slug: true } } } }, products: { where: { product: { is: { status: ProductStatus.APPROVED } } }, orderBy: { sortOrder: 'asc' }, include: { product: { include: { inventory: true } } } } }, orderBy: [{ scheduledAt: 'asc' }, { endedAt: 'desc' }], take: 50 });
  res.json(sessions.map(session => publicLiveSession({ ...session, products: session.products.map(link => ({ ...link, product: { ...link.product, availableStock: link.product.inventory?.quantity ?? 0 } })) })));
}));
app.get('/api/live-sessions/:id', asyncRoute(async (req, res) => {
  const liveState = await liveShoppingState();
  const publicSessionOptions: Prisma.LiveSessionWhereInput[] = [{ status: LiveSessionStatus.ENDED, recordingStatus: 'READY', replayPublishedAt: { not: null } }];
  if (liveState.effectiveEnabled) publicSessionOptions.push({ status: { in: [LiveSessionStatus.SCHEDULED, LiveSessionStatus.STARTING, LiveSessionStatus.LIVE, LiveSessionStatus.PAUSED] }, OR: [{ status: { not: LiveSessionStatus.SCHEDULED } }, { scheduledAt: { gte: new Date() } }] });
  const sessionWhere: Prisma.LiveSessionWhereInput = { id: routeParam(req.params.id), deletedAt: null, seller: { is: { status: SellerStatus.APPROVED } }, OR: publicSessionOptions };
  const session = await prisma.liveSession.findFirst({ where: sessionWhere, include: { seller: { include: { store: { select: { name: true, slug: true } } } }, products: { where: { product: { is: { status: ProductStatus.APPROVED } } }, orderBy: { sortOrder: 'asc' }, include: { product: { include: { inventory: true } } } } } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  res.set('Cache-Control', 'no-store');
  res.json(publicLiveSession({ ...session, products: session.products.map(link => ({ ...link, product: { ...link.product, availableStock: link.product.inventory?.quantity ?? 0 } })) }));
}));
app.get('/api/live-sessions/:id/replay', asyncRoute(async (req, res) => {
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), deletedAt: null, status: 'ENDED', recordingStatus: 'READY', replayPublishedAt: { not: null }, seller: { is: { status: SellerStatus.APPROVED } } }, select: { recordingStorageKey: true } });
  if (!session?.recordingStorageKey) return res.status(404).json({ error: 'Published replay not found.' });
  await streamReplayObject(req, res, session.recordingStorageKey);
}));
app.get('/api/live-sessions/:id/token', asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), deletedAt: null, status: { in: ['STARTING', 'LIVE', 'PAUSED'] }, seller: { is: { status: SellerStatus.APPROVED } }, providerSessionRef: { not: null } }, select: { providerSessionRef: true } });
  if (!session?.providerSessionRef) return res.status(409).json({ error: 'This show is not ready for viewer playback.' });
  const user = await currentUser(req);
  let guestKey = req.cookies?.marketplace_live_viewer as string | undefined;
  if (!user && !/^[a-f0-9]{64}$/i.test(guestKey ?? '')) {
    guestKey = randomBytes(32).toString('hex');
    res.cookie('marketplace_live_viewer', guestKey, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000, path: '/api/live-sessions' });
  }
  const identity = user ? `viewer:${user.id}` : `guest:${createHash('sha256').update(guestKey!).digest('hex')}`;
  res.json({ ...(await liveProvider.issueViewerToken(session.providerSessionRef, identity, user?.name ?? 'Viewer')), role: 'viewer' });
}));
app.post('/api/live-sessions/:id/reports', requireAuth, asyncRoute(async (req, res) => {
  await requireLiveShopping();
  const user = res.locals.user as { id: string };
  const input = parse(liveReportSchema, req.body);
  const session = await prisma.liveSession.findFirst({ where: { id: routeParam(req.params.id), deletedAt: null, status: { in: ['STARTING', 'LIVE', 'PAUSED'] } }, select: { id: true } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  const report = await prisma.liveSessionReport.create({ data: { sessionId: session.id, reporterId: user.id, reason: input.reason } });
  res.status(201).json({ id: report.id, status: report.status });
}));
registerSellerLiveSessionRoutes(app);

app.get('/api/products', asyncRoute(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 12)));
  const where: Prisma.ProductWhereInput = { status: ProductStatus.APPROVED, AND: [{ OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, ...(q ? [{ OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }] }] : []), ...(category ? [{ category: { slug: category } }] : [])] };
  const [items, total] = await Promise.all([prisma.product.findMany({ where, include: { seller: { include: { store: true } }, category: true, brand: true, productType: true, featureAssignments: { include: { feature: true } }, inventory: true, images: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.product.count({ where })]);
  res.json({ items: items.map(p => ({ ...p, availableStock: p.inventory?.quantity ?? 0 })), page, pageSize, total });
}));
app.get('/api/products/:id', asyncRoute(async (req, res) => { const p = await prisma.product.findFirst({ where: { id: routeParam(req.params.id), status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, include: { seller: { include: { store: true } }, category: true, brand: true, productType: true, featureAssignments: { include: { feature: true } }, inventory: true, images: true, mediaAttachments: { where: { mediaAsset: { uploadStatus: 'COMPLETE', scanStatus: 'APPROVED' } }, orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, detectedMime: true, safeName: true, originalName: true } } } } } }); if (!p) return res.status(404).json({ error: 'Product not found' }); const mediaAttachments = p.mediaAttachments.map(({ mediaAsset, ...attachment }) => ({ ...attachment, kind: mediaAsset.kind, detectedMime: mediaAsset.detectedMime, originalName: mediaAsset.originalName, url: `/content-media/${encodeURIComponent(mediaAsset.id)}` })); res.json({ ...p, features: p.featureAssignments.map(item => item.feature), mediaAttachments, availableStock: p.inventory?.quantity ?? 0 }); }));
app.get('/api/categories', asyncRoute(async (_req, res) => res.json(await prisma.category.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }))));

app.post('/api/sellers/apply', requireAuth, asyncRoute(async (_req, res) => {
  const user = res.locals.user as { id: string; role: Role };
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (!settings?.multiVendorEnabled) return res.status(409).json({ error: 'Multi-vendor mode is disabled' });
  const seller = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const existing = await tx.seller.findUnique({ where: { userId: user.id } });
    let result = existing;
    let submitted = false;
    if (!existing) {
      result = await tx.seller.create({ data: { userId: user.id, status: SellerStatus.PENDING } });
      submitted = true;
    } else if (existing.status === SellerStatus.REJECTED) {
      result = await tx.seller.update({ where: { id: existing.id }, data: { status: SellerStatus.PENDING, reason: null } });
      submitted = true;
    }
    if (submitted && result) {
      await createUserNotification(tx, { userId: user.id, eventType: 'SELLER_APPLICATION_PENDING', title: 'Seller application submitted', body: 'Your seller application is pending marketplace review. We will notify you when its status changes.', link: '/dashboard', payloadJson: { sellerId: result.id, status: result.status } }, 'account');
      await createRoleNotifications(tx, Role.ADMIN, { eventType: 'SELLER_APPLICATION_PENDING', title: 'Seller application needs review', body: 'A new seller application is waiting in the Sellers & stores directory.', link: '/admin/platform?section=vendors', payloadJson: { sellerId: result.id } }, 'account');
    }
    return result!;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  res.status(201).json(seller);
}));

app.post('/api/products', requireAuth, requireRole(Role.SELLER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string; role: Role; sellerId?: string };
  const input = parse(productSchema, req.body);
  if (!isValidSalePrice(input.priceMinor, input.salePriceMinor)) return res.status(400).json({ error: 'Sale price must be lower than the regular price.' });
  const wholesaleEnabled = input.wholesaleEnabled ?? false;
  const wholesaleMinQuantity = wholesaleEnabled ? input.wholesaleMinQuantity ?? null : null;
  const wholesaleMaxQuantity = wholesaleEnabled ? input.wholesaleMaxQuantity ?? null : null;
  const wholesaleError = wholesaleConfigurationError({ wholesaleEnabled, wholesaleMinQuantity, wholesaleMaxQuantity });
  if (wholesaleError) return res.status(400).json({ error: wholesaleError, code: 'WHOLESALE_CONFIGURATION_INVALID' });
  const scopedSellerId = user.role === Role.ADMIN
    ? (await prisma.store.findFirst({ where: { isPlatformStore: true }, select: { sellerId: true } }))?.sellerId
    : user.sellerId;
  const seller = scopedSellerId
    ? await prisma.seller.findFirst({ where: { id: scopedSellerId, status: SellerStatus.APPROVED }, include: { store: true } })
    : null;
  if (user.role !== Role.ADMIN && !seller) return res.status(403).json({ error: 'Approved seller required' });
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (seller && user.role !== Role.ADMIN && !settings?.multiVendorEnabled) return res.status(409).json({ error: 'Multi-vendor mode is disabled' });
  const productData = { sellerId: seller?.id, name: input.name, slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`, description: input.description, priceMinor: input.priceMinor, salePriceMinor: input.salePriceMinor ?? null, color: input.color ?? null, currency: seller?.store?.baseCurrency ?? env.CURRENCY, barcode: input.barcode, wholesaleEnabled, wholesaleMinQuantity, wholesaleMaxQuantity, status: user.role === Role.ADMIN || settings?.productApprovalPolicy === ApprovalPolicy.AUTOMATIC ? ProductStatus.APPROVED : ProductStatus.PENDING, inventory: { create: { quantity: input.stock } } };
  if (seller) {
    const store = seller.store ? { id: seller.store.id } : null;
    if (!store) return res.status(409).json({ error: 'Complete Store setup before adding products.' });
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const effective = await effectiveStorePlan(tx, store.id);
      const entitlements = await storeEntitlements(tx, store.id, effective.version);
      const usage = await tx.product.count({ where: { sellerId: seller.id, status: { not: ProductStatus.ARCHIVED } } });
      if (isAtLimit(usage, entitlements.productLimit)) return { limitReached: true as const, usage, limit: entitlements.productLimit };
      const taxonomy = await validateProductCatalogSelection(input, tx);
      return { product: await tx.product.create({ data: { ...productData, categoryId: taxonomy.categoryId, brandId: taxonomy.brandId, productTypeId: taxonomy.productTypeId, featureAssignments: { create: taxonomy.featureIds.map(featureId => ({ featureId })) } } }) };
    });
    if ('limitReached' in result) return res.status(409).json({ code: 'PLAN_LIMIT_REACHED', entitlement: 'productLimit', upgradeRequired: true, error: 'Your Store has reached its product limit. Archive a listing or ask an administrator about a plan change.', usage: result.usage, limit: result.limit, planUrl: '/seller/plan' });
    res.status(201).json(result.product);
    return;
  }
  const product = await prisma.$transaction(async tx => {
    const taxonomy = await validateProductCatalogSelection(input, tx);
    return tx.product.create({ data: { ...productData, categoryId: taxonomy.categoryId, brandId: taxonomy.brandId, productTypeId: taxonomy.productTypeId, featureAssignments: { create: taxonomy.featureIds.map(featureId => ({ featureId })) } } });
  });
  res.status(201).json(product);
}));
app.patch('/api/products/:id', requireAuth, requireRole(Role.SELLER, Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { role: Role; sellerId?: string };
  const input = parse(productSchema.partial(), req.body);
  const existing = await prisma.product.findUnique({ where: { id: routeParam(req.params.id) }, include: { featureAssignments: { select: { featureId: true } } } });
  if (!existing || (user.role !== Role.ADMIN && existing.sellerId !== user.sellerId)) return res.status(404).json({ error: 'Product not found' });
  const nextPriceMinor = input.priceMinor ?? existing.priceMinor;
  const nextSalePriceMinor = input.salePriceMinor !== undefined ? input.salePriceMinor : existing.salePriceMinor;
  if (!isValidSalePrice(nextPriceMinor, nextSalePriceMinor)) return res.status(400).json({ error: 'Sale price must be lower than the regular price.' });
  const wholesaleEnabled = input.wholesaleEnabled ?? existing.wholesaleEnabled;
  const wholesaleMinQuantity = wholesaleEnabled ? input.wholesaleMinQuantity !== undefined ? input.wholesaleMinQuantity : existing.wholesaleMinQuantity : null;
  const wholesaleMaxQuantity = wholesaleEnabled ? input.wholesaleMaxQuantity !== undefined ? input.wholesaleMaxQuantity : existing.wholesaleMaxQuantity : null;
  const wholesaleError = wholesaleConfigurationError({ wholesaleEnabled, wholesaleMinQuantity, wholesaleMaxQuantity });
  if (wholesaleError) return res.status(400).json({ error: wholesaleError, code: 'WHOLESALE_CONFIGURATION_INVALID' });
  const product = await prisma.$transaction(async tx => {
    const taxonomy = await validateProductCatalogSelection({ categoryId: input.categoryId !== undefined ? input.categoryId : existing.categoryId, brandId: input.brandId !== undefined ? input.brandId : existing.brandId, productTypeId: input.productTypeId !== undefined ? input.productTypeId : existing.productTypeId, featureIds: input.featureIds ?? existing.featureAssignments.map(item => item.featureId) }, tx);
    const updated = await tx.product.update({ where: { id: existing.id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.description ? { description: input.description } : {}), ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}), ...(input.salePriceMinor !== undefined ? { salePriceMinor: input.salePriceMinor } : {}), ...(input.categoryId !== undefined ? { categoryId: taxonomy.categoryId } : {}), ...(input.brandId !== undefined ? { brandId: taxonomy.brandId } : {}), ...(input.productTypeId !== undefined ? { productTypeId: taxonomy.productTypeId } : {}), ...(input.color !== undefined ? { color: input.color } : {}), ...(input.barcode !== undefined ? { barcode: input.barcode } : {}), wholesaleEnabled, wholesaleMinQuantity, wholesaleMaxQuantity } });
    if (input.featureIds !== undefined || input.categoryId !== undefined || input.productTypeId !== undefined) {
      await tx.productFeatureAssignment.deleteMany({ where: { productId: existing.id } });
      if (taxonomy.featureIds.length) await tx.productFeatureAssignment.createMany({ data: taxonomy.featureIds.map(featureId => ({ productId: existing.id, featureId })) });
    }
    if (input.stock !== undefined) await tx.inventory.update({ where: { productId: existing.id }, data: { quantity: input.stock } });
    return updated;
  });
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

app.get('/api/cart', requireAuth, asyncRoute(async (_req, res) => { const user = res.locals.user as { id: string }; const cart = await prisma.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { productType: true, inventory: true, seller: { include: { store: true } } } } } } } }); res.json(cart ?? { items: [] }); }));
app.post('/api/cart/items', requireAuth, asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string };
  const body = z.object({ productId: z.string().cuid(), variantId: z.string().cuid().optional(), quantity: z.number().int().positive().max(99) }).parse(req.body);
  const product = await prisma.product.findFirst({ where: { id: body.productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, include: { variants: true } });
  if (!product) return res.status(404).json({ error: 'Product unavailable' });
  const variant = body.variantId ? product.variants.find(v => v.id === body.variantId && v.status === ProductStatus.APPROVED) : null;
  if (body.variantId && !variant) return res.status(409).json({ error: 'Variant unavailable' });
  const configError = wholesaleConfigurationError(product);
  if (configError) return res.status(409).json({ error: configError, code: 'WHOLESALE_CONFIGURATION_INVALID' });
  const available = variant?.stock ?? (await prisma.inventory.findUnique({ where: { productId: product.id } }))?.quantity ?? 0;
  const cart = await prisma.cart.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });
  const item = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cart.id} FOR UPDATE`;
    const existing = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId: body.productId } } });
    const nextQuantity = (existing?.quantity ?? 0) + body.quantity;
    const quantityError = wholesaleQuantityError(product, nextQuantity, false);
    if (quantityError) throw Object.assign(new Error(quantityError), { statusCode: 409, code: 'WHOLESALE_QUANTITY_INVALID' });
    if (nextQuantity > 99) throw Object.assign(new Error('A cart line cannot exceed 99 units.'), { statusCode: 409, code: 'CART_QUANTITY_LIMIT' });
    if (available < nextQuantity) throw Object.assign(new Error('Insufficient stock'), { statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    return existing
      ? tx.cartItem.update({ where: { id: existing.id }, data: { quantity: nextQuantity, variantId: body.variantId } })
      : tx.cartItem.create({ data: { cartId: cart.id, productId: body.productId, variantId: body.variantId, quantity: nextQuantity } });
  });
  res.status(201).json(item);
}));
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
    const quantityError = wholesaleQuantityError(item.product, qty, false);
    if (quantityError) return res.status(409).json({ error: quantityError, code: 'WHOLESALE_QUANTITY_INVALID' });
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
  if (method === PaymentMethod.PAYMONGO && !(env.PAYMONGO_SECRET_KEY?.startsWith('sk_') && !env.PAYMONGO_SECRET_KEY.toLowerCase().includes('placeholder') && env.PAYMONGO_WEBHOOK_SECRET && !env.PAYMONGO_WEBHOOK_SECRET.toLowerCase().includes('placeholder'))) return res.status(503).json({ error: 'PayMongo checkout is not configured with an API key and webhook signing secret.', code: 'PAYMONGO_NOT_CONFIGURED' });
  if (method === PaymentMethod.PAYSTACK && !(env.PAYSTACK_SECRET_KEY?.startsWith('sk_') && !env.PAYSTACK_SECRET_KEY.toLowerCase().includes('placeholder'))) return res.status(503).json({ error: 'Paystack checkout is not configured with a server-side secret key.', code: 'PAYSTACK_NOT_CONFIGURED' });
  const chargeCurrencyCapability = await prisma.currencyCatalogEntry.findFirst({ where: { code: env.CURRENCY, active: true, checkoutEnabled: true }, select: { code: true } });
  if (!chargeCurrencyCapability) return res.status(409).json({ error: `Checkout in ${env.CURRENCY} is unavailable because the platform currency capability is disabled. Your cart is preserved.`, code: 'CHECKOUT_CURRENCY_UNAVAILABLE' });
  const liveActivationBlock = await livePaymentActivationBlock(method);
  if (liveActivationBlock) return res.status(503).json(liveActivationBlock);
  const cart = await prisma.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { productType: true, inventory: true, seller: true } } } } } });
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
    const freshCart = await tx.cart.findUnique({ where: { userId: user.id }, include: { items: { include: { variant: true, product: { include: { productType: true, inventory: true, seller: { include: { store: { include: { currencyOffers: true } } } } } } } } } });
    if (!freshCart?.items.length) throw Object.assign(new Error('Cart changed; refresh and try again'), { statusCode: 409, code: 'SHIPPING_CART_STALE' });
    for (const item of freshCart.items) {
      const quantityError = wholesaleQuantityError(item.product, item.quantity, true);
      if (quantityError) throw Object.assign(new Error(`${item.product.name}: ${quantityError}`), { statusCode: 409, code: 'WHOLESALE_QUANTITY_INVALID' });
    }
    const lockedChargeCurrency = await tx.$queryRaw<{ code: string }[]>`SELECT "code" FROM "CurrencyCatalogEntry" WHERE "code" = ${env.CURRENCY} AND "active" = TRUE AND "checkoutEnabled" = TRUE FOR SHARE`;
    if (!lockedChargeCurrency.length) throw Object.assign(new Error(`Checkout in ${env.CURRENCY} is unavailable because the platform currency capability is disabled. Your cart is preserved.`), { statusCode: 409, code: 'CHECKOUT_CURRENCY_UNAVAILABLE' });
    const lockedPaymentMethod = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "PaymentMethodSettings" WHERE "method" = ${method}::"PaymentMethod" AND "enabled" = TRUE FOR SHARE`;
    if (!lockedPaymentMethod.length) throw Object.assign(new Error(`${method} was disabled before checkout completed. Your cart is preserved.`), { statusCode: 409, code: 'PAYMENT_METHOD_DISABLED' });
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
    const shippingItems = freshCart.items.filter(item => item.product.productType.requiresShipping);
    const shippingSellerGroups = [...new Set(shippingItems.map(item => item.product.sellerId).filter((sellerId): sellerId is string => Boolean(sellerId)))];
    await tx.$queryRaw`SELECT "id" FROM "MarketplaceSettings" WHERE "id" = 'default' FOR SHARE`;
    const currentSettings = await tx.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { multiVendorEnabled: true, sellerShippingEnabled: true, codMaxMinor: true } });
    if (sellerGroups.length && !currentSettings?.multiVendorEnabled) throw Object.assign(new Error('Seller products are unavailable while multi-vendor mode is disabled'), { statusCode: 409 });
    let shippingTotalMinor = 0;
    const grossItemSubtotalMinor = freshCart.items.reduce((sum, item) => sum + effectiveUnitPriceMinor(item) * item.quantity, 0);
    const appliedDiscount = input.discountCode ? await resolveCartProductDiscount(tx, input.discountCode, freshCart.items) : null;
    if (appliedDiscount && appliedDiscount.discount.currency !== env.CURRENCY) throw Object.assign(new Error(`This discount is in ${appliedDiscount.discount.currency} and cannot be charged in ${env.CURRENCY}.`), { statusCode: 409, code: 'DISCOUNT_CURRENCY_UNSUPPORTED' });
    const discountAllocations = new Map((appliedDiscount?.quote.allocations ?? []).map(item => [item.cartItemId, item.discountMinor]));
    const discountMinor = appliedDiscount?.quote.discountMinor ?? 0;
    const productDiscountCode = appliedDiscount?.discount.code ?? null;
    if (appliedDiscount) {
      const limitCondition = appliedDiscount.discount.usageLimit === null ? {} : { usesCount: { lt: appliedDiscount.discount.usageLimit } };
      const usage = await tx.sellerProductDiscount.updateMany({ where: { id: appliedDiscount.discount.id, enabled: true, ...limitCondition, OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] }] }, data: { usesCount: { increment: 1 } } });
      if (usage.count !== 1) throw Object.assign(new Error('This discount code is no longer available. Refresh checkout and try another code.'), { statusCode: 409, code: 'DISCOUNT_UNAVAILABLE' });
    }
    let totalMinor = grossItemSubtotalMinor - discountMinor;
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || totalMinor > 2_147_483_647) throw Object.assign(new Error('Order total exceeds the supported integer minor-unit limit'), { statusCode: 409, code: 'ORDER_TOTAL_OUT_OF_RANGE' });
    const shippingBySeller = new Map<string, { snapshot: Prisma.InputJsonValue; shippingMinor: number; carrierName: string | null }>();
    let providerChargeQuote: ProviderChargeQuote | null = null;
    const requestedDisplayCurrency = input.displayCurrency;
    const displayCurrencyEntry = requestedDisplayCurrency ? await tx.currencyCatalogEntry.findFirst({ where: { code: requestedDisplayCurrency, active: true, displayEnabled: true } }) : null;
    if (requestedDisplayCurrency && !displayCurrencyEntry) throw Object.assign(new Error('This display currency is not enabled by the platform.'), { statusCode: 409, code: 'DISPLAY_CURRENCY_UNAVAILABLE' });
    const itemFxSnapshots = new Map<string, { amountMinor: number; currency: string; snapshot: Prisma.InputJsonValue }>();
    let displayItemsTotalMinor = 0;
    if (requestedDisplayCurrency) {
      for (const item of freshCart.items) {
        const sourceCurrency = item.variant?.currency ?? item.product.currency;
        const store = item.product.seller?.store;
        const rate = await latestDisplayRate(sourceCurrency, requestedDisplayCurrency, store?.id);
        if (!rate || rate.freshness === 'stale') throw Object.assign(new Error(`A fresh ${sourceCurrency}/${requestedDisplayCurrency} estimate is unavailable. Choose another display currency; the cart was preserved.`), { statusCode: 409, code: 'DISPLAY_RATE_UNAVAILABLE' });
        const exponentEntries = await tx.currencyCatalogEntry.findMany({ where: { code: { in: [sourceCurrency, requestedDisplayCurrency] } }, select: { code: true, minorUnitExponent: true } });
        const sourceExponent = exponentEntries.find(entry => entry.code === sourceCurrency)?.minorUnitExponent;
        const quoteExponent = exponentEntries.find(entry => entry.code === requestedDisplayCurrency)?.minorUnitExponent;
        if (sourceExponent == null || quoteExponent == null) throw Object.assign(new Error('Currency precision is not configured.'), { statusCode: 409, code: 'DISPLAY_CURRENCY_UNAVAILABLE' });
        const baseAmount = effectiveUnitPriceMinor(item) * item.quantity - (discountAllocations.get(item.id) ?? 0);
        const estimate = Number(convertMinorExact(BigInt(baseAmount), rate.rate, sourceExponent, quoteExponent));
        if (!Number.isSafeInteger(estimate)) throw Object.assign(new Error('Converted estimate exceeds the supported display amount.'), { statusCode: 409, code: 'DISPLAY_AMOUNT_OUT_OF_RANGE' });
        displayItemsTotalMinor += estimate;
        itemFxSnapshots.set(item.id, { amountMinor: estimate, currency: requestedDisplayCurrency, snapshot: { baseAmountMinor: baseAmount, baseCurrency: sourceCurrency, quoteAmountMinor: estimate, quoteCurrency: requestedDisplayCurrency, rate: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, rounding: 'HALF_UP', purpose: 'DISPLAY_ESTIMATE_ONLY' } as Prisma.InputJsonValue });
      }
    }
    let displayShippingTotalMinor = 0;
    let codShipments: { supportsCod: boolean }[] = [];
    let shippingBreakdown: { storeName: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number }[] = [];
    if (shippingSellerGroups.length) {
      if (currentSettings?.sellerShippingEnabled === false) throw Object.assign(new Error('Seller-managed shipping is disabled. Seller shipments cannot be checked out.'), { statusCode: 409, code: 'SHIPPING_DISABLED' });
      const verifiedQuote = verifyCheckoutShippingQuote({ token: input.shippingQuoteToken, userId: user.id, address: input.address, items: shippingItems as ShippingCartRecord[] });
      const selections = Object.fromEntries(verifiedQuote.selections.map(selection => [selection.sellerId, selection.serviceId]));
      for (const serviceId of [...new Set(verifiedQuote.selections.map(selection => selection.serviceId))].sort()) {
        const lockedService = await tx.$queryRaw<{ carrierProviderId: string | null }[]>`SELECT "carrierProviderId" FROM "SellerShippingService" WHERE "id" = ${serviceId} FOR SHARE`;
        if (!lockedService.length) throw Object.assign(new Error('A selected delivery service changed. Recalculate shipping.'), { statusCode: 409, code: 'SHIPPING_QUOTE_STALE' });
        const carrierProviderId = lockedService[0]!.carrierProviderId;
        if (carrierProviderId) {
          const lockedCarrier = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ShippingCarrierProvider" WHERE "id" = ${carrierProviderId} FOR SHARE`;
          if (!lockedCarrier.length) throw Object.assign(new Error('A selected courier changed. Recalculate shipping.'), { statusCode: 409, code: 'SHIPPING_QUOTE_STALE' });
        }
      }
      const currentQuote = await buildSellerShippingQuote(tx, user.id, input.address, shippingItems as ShippingCartRecord[], selections);
      assertShippingSelectionsMatch(verifiedQuote, currentQuote.shipments.map(shipment => shipment.selected));
      codShipments = currentQuote.shipments.map(shipment => ({ supportsCod: shipment.selected.supportsCod }));
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
          const estimated = Number(convertMinorExact(BigInt(shipment.selected.shippingMinor), rate.rate, baseEntry.minorUnitExponent, quoteEntry.minorUnitExponent));
          if (!Number.isSafeInteger(estimated)) throw Object.assign(new Error('Converted shipping estimate exceeds the supported display amount.'), { statusCode: 409, code: 'DISPLAY_AMOUNT_OUT_OF_RANGE' });
          displayShippingTotalMinor += estimated;
          displayShippingSnapshot = { amountMinor: estimated, currency: requestedDisplayCurrency, rate: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, rounding: 'HALF_UP', purpose: 'DISPLAY_ESTIMATE_ONLY' };
        }
        const snapshot = {
          version: 1, serviceId: shipment.selected.serviceId, serviceName: shipment.selected.serviceName,
          ...(shipment.selected.carrierProviderId ? { carrierProviderId: shipment.selected.carrierProviderId, carrierProviderName: shipment.selected.carrierName, trackingUrlTemplate: shipment.selected.trackingUrlTemplate } : {}),
          destination: input.address, zoneId: shipment.selected.zoneId, feeMinor: shipment.selected.feeMinor,
          discountMinor: shipment.selected.discountMinor, shippingMinor: shipment.selected.shippingMinor,
          currency: shipment.selected.currency, estimatedMinDays: shipment.selected.estimatedMinDays, supportsCod: shipment.selected.supportsCod,
          estimatedMaxDays: shipment.selected.estimatedMaxDays, discount: shipment.selected.discount,
          ...(displayShippingSnapshot ? { displayEstimate: displayShippingSnapshot } : {})
        } as Prisma.InputJsonValue;
        shippingBySeller.set(shipment.sellerId, { snapshot, shippingMinor: shipment.selected.shippingMinor, carrierName: shipment.selected.carrierName ?? null });
      }
    } else if (input.shippingQuoteToken) {
      throw Object.assign(new Error('The cart changed after shipping was calculated. Recalculate the order total.'), { statusCode: 409, code: 'SHIPPING_QUOTE_STALE' });
    }
    if (method === PaymentMethod.COD) {
      const eligibilityFailure = codCheckoutEligibilityFailure(
        freshCart.items.map(item => ({ requiresShipping: item.product.productType.requiresShipping, sellerId: item.product.sellerId })),
        codShipments
      );
      if (eligibilityFailure) throw Object.assign(new Error(eligibilityFailure), { statusCode: 409, code: 'COD_NOT_AVAILABLE' });
      if (exceedsCodOrderLimit(totalMinor, currentSettings?.codMaxMinor)) throw Object.assign(new Error('Order is above the configured COD limit. Choose another payment method or contact the marketplace.'), { statusCode: 409, code: 'COD_ORDER_LIMIT_EXCEEDED' });
    }
    const providerCurrency = providerCurrencyForMethod(method);
    if (providerCurrency) {
      const lockedProviderCurrency = await tx.$queryRaw<{ code: string }[]>`SELECT "code" FROM "CurrencyCatalogEntry" WHERE "code" = ${providerCurrency} AND "active" = TRUE AND "displayEnabled" = TRUE FOR SHARE`;
      if (!lockedProviderCurrency.length) throw Object.assign(new Error(`${providerCurrency} is not currently activated for payment by the platform administrator.`), { statusCode: 409, code: 'PAYMENT_CURRENCY_UNAVAILABLE' });
      const currencyEntries = await tx.currencyCatalogEntry.findMany({ where: { code: { in: [env.CURRENCY, providerCurrency] }, active: true }, select: { code: true, minorUnitExponent: true } });
      const baseExponent = currencyEntries.find(entry => entry.code === env.CURRENCY)?.minorUnitExponent;
      const providerExponent = currencyEntries.find(entry => entry.code === providerCurrency)?.minorUnitExponent;
      if (baseExponent == null || providerExponent == null) throw Object.assign(new Error('Payment currency precision is not configured.'), { statusCode: 409, code: 'PAYMENT_CURRENCY_UNAVAILABLE' });
      const rate = await latestDisplayRate(env.CURRENCY, providerCurrency);
      if (!rate || rate.freshness === 'stale') throw Object.assign(new Error(`A current ${env.CURRENCY}/${providerCurrency} payment conversion rate is unavailable. Choose another payment method; your cart is preserved.`), { statusCode: 409, code: 'PAYMENT_RATE_UNAVAILABLE' });
      try {
        providerChargeQuote = createProviderChargeQuote({ provider: method as 'PAYMONGO' | 'PAYSTACK', baseCurrency: env.CURRENCY, baseAmountMinor: totalMinor, baseExponent, rate, quoteExponent: providerExponent });
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : 'The provider payment amount could not be calculated safely.'), { statusCode: 409, code: 'PAYMENT_AMOUNT_OUT_OF_RANGE' });
      }
    }
    for (const item of freshCart.items) {
      const updated = item.variant
        ? await tx.productVariant.updateMany({ where: { id: item.variant.id, status: ProductStatus.APPROVED, stock: { gte: item.quantity } }, data: { stock: { decrement: item.quantity } } })
        : await tx.inventory.updateMany({ where: { productId: item.productId, quantity: { gte: item.quantity } }, data: { quantity: { decrement: item.quantity } } });
      if (updated.count !== 1) throw Object.assign(new Error(`Stock changed for ${item.product.name}`), { statusCode: 409, code: 'SHIPPING_CART_STALE' });
    }
    const newOrderNumber = orderNumber();
    const created = await tx.parentOrder.create({ data: {
      orderNumber: newOrderNumber, buyerId: user.id, affiliateClickId: affiliateClick?.id,
      buyerEmail: input.buyerEmail, buyerName: input.buyerName, addressJson: input.address,
      totalMinor, currency: env.CURRENCY,
      sellerOrders: { create: await Promise.all([...freshGroups.entries()].map(async ([sellerId, items]) => {
        const itemDiscountMinor = items.reduce((sum, item) => sum + (discountAllocations.get(item.id) ?? 0), 0);
        const itemTotalMinor = items.reduce((sum, item) => sum + effectiveUnitPriceMinor(item) * item.quantity, 0) - itemDiscountMinor;
        const sellerDiscount = items.some(item => discountAllocations.has(item.id)) ? { discountCode: productDiscountCode, discountMinor: itemDiscountMinor } : {};
        const store = items[0]?.product.seller?.store;
        const policy = sellerId === 'platform' || !store ? null : await applicableSellerCommissionPolicy(tx, store.id, env.CURRENCY);
        const commissionSnapshot = sellerId === 'platform' ? null : makeCommissionSnapshot(policy, env.CURRENCY);
        return {
          sellerId: sellerId === 'platform' ? null : sellerId,
          totalMinor: itemTotalMinor,
          ...sellerDiscount,
          shippingSnapshotJson: sellerId === 'platform' ? undefined : shippingBySeller.get(sellerId)?.snapshot,
          shippingCarrier: sellerId === 'platform' ? undefined : shippingBySeller.get(sellerId)?.carrierName,
          ...(commissionSnapshot ? { commissionSnapshotJson: commissionSnapshot as Prisma.InputJsonValue, commissionPolicyVersionId: policy?.id ?? null } : {}),
          items: { create: items.map(item => {
            const fx = itemFxSnapshots.get(item.id);
            const itemCurrency = item.variant?.currency ?? item.product.currency;
            return {
              product: { connect: { id: item.productId } },
              ...(item.variant ? { variant: { connect: { id: item.variant.id } }, variantName: item.variant.name } : {}),
              productName: item.product.name, unitPriceMinor: effectiveUnitPriceMinor(item),
              quantity: item.quantity, discountMinor: discountAllocations.get(item.id) ?? 0, currencySnapshotEntry: { connect: { code: itemCurrency } },
              ...(fx ? { displayAmountMinor: fx.amountMinor, displayCurrencyEntry: { connect: { code: fx.currency } }, fxSnapshotJson: fx.snapshot } : {})
            };
          }) }
        };
      })) }, payment: { create: {
        method, status: PaymentStatus.PENDING,
        ...(providerChargeQuote ? { attempts: { create: { provider: method, idempotencyKey: `checkout-${method}-${newOrderNumber}`, status: PaymentStatus.PENDING, metadata: { purpose: 'BUYER_CHECKOUT', provider: method, chargeCurrency: providerChargeQuote.currency, chargeAmountMinor: providerChargeQuote.amountMinor, baseCurrency: providerChargeQuote.baseCurrency, baseAmountMinor: providerChargeQuote.baseAmountMinor, rate: providerChargeQuote.rate, rateProvider: providerChargeQuote.rateProvider, sourceDate: providerChargeQuote.sourceDate, fetchedAt: providerChargeQuote.fetchedAt, rounding: providerChargeQuote.rounding } as Prisma.InputJsonValue } } } : {})
      } }
    } });
    await notifyOrderParties(tx, {
      orderId: created.id, orderNumber: created.orderNumber, buyerId: user.id,
      sellerIds: [...freshGroups.keys()].filter(sellerId => sellerId !== 'platform'),
      eventType: 'ORDER_CREATED',
      buyer: { title: 'Order recorded', body: `Order ${created.orderNumber} has been recorded. Check payment and delivery status before considering the purchase complete.`, link: '/dashboard?tab=orders' },
      seller: { title: 'New order received', body: `Order ${created.orderNumber} includes items from your Store. Review the order and payment status in your seller dashboard.`, link: '/dashboard?mode=seller&tab=orders' },
      admin: { title: 'New marketplace order', body: `Order ${created.orderNumber} was placed and is awaiting its payment or fulfillment updates.`, link: '/admin/platform?section=orders' }
    });
    await tx.cartItem.deleteMany({ where: { cartId: freshCart.id } });
    return { order: created, shippingTotalMinor, discountMinor, discountCode: productDiscountCode, shippingBreakdown, displayEstimate: requestedDisplayCurrency ? { currency: requestedDisplayCurrency, itemTotalMinor: displayItemsTotalMinor, shippingTotalMinor: displayShippingTotalMinor, totalMinor: displayItemsTotalMinor + displayShippingTotalMinor, purpose: 'DISPLAY_ESTIMATE_ONLY' } : null, providerChargeQuote };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw Object.assign(new Error('Cart or shipping settings changed while checkout was being validated. Recalculate shipping and retry.'), { statusCode: 409, code: 'SHIPPING_QUOTE_STALE' });
    throw error;
  });
  const order = committed.order;
  const totalMinor = order.totalMinor;
  let paymentAction: unknown = null;
  const paymentReturnUrl = `${env.WEB_ORIGIN}/checkout?order=${encodeURIComponent(order.id)}`;
  try {
    if (method === PaymentMethod.STRIPE) { const session = await createStripeCheckout({ id: order.id, orderNumber: order.orderNumber, totalMinor, currency: env.CURRENCY, buyerEmail: input.buyerEmail }, paymentReturnUrl, `${env.WEB_ORIGIN}/checkout?order=${encodeURIComponent(order.id)}&payment=cancelled`); await prisma.payment.update({ where: { parentId: order.id }, data: { providerRef: session.id } }); paymentAction = { provider: 'STRIPE', checkoutUrl: session.url }; }
    if (method === PaymentMethod.PAYPAL) { const pp = await createPaypalOrder({ id: order.id, orderNumber: order.orderNumber, totalMinor, currency: env.CURRENCY }); await prisma.payment.update({ where: { parentId: order.id }, data: { providerRef: pp.id } }); paymentAction = { provider: 'PAYPAL', providerOrderId: pp.id, approvalUrl: pp.links?.find(link => link.rel === 'approve')?.href }; }
    if (method === PaymentMethod.PAYMONGO && committed.providerChargeQuote) {
      const session = await createPaymongoCheckout({ id: order.id, orderNumber: order.orderNumber, totalMinor: committed.providerChargeQuote.amountMinor, currency: committed.providerChargeQuote.currency }, paymentReturnUrl, `${env.WEB_ORIGIN}/checkout?order=${encodeURIComponent(order.id)}&payment=cancelled`);
      await prisma.$transaction(async tx => {
        await tx.payment.update({ where: { parentId: order.id }, data: { providerRef: session.id } });
        await tx.paymentAttempt.updateMany({ where: { payment: { parentId: order.id }, provider: PaymentMethod.PAYMONGO }, data: { providerRef: session.id } });
      });
      paymentAction = { provider: 'PAYMONGO', checkoutUrl: session.checkoutUrl };
    }
    if (method === PaymentMethod.PAYSTACK && committed.providerChargeQuote) {
      const transaction = await createPaystackTransaction({ id: order.id, orderNumber: order.orderNumber, totalMinor: committed.providerChargeQuote.amountMinor, currency: committed.providerChargeQuote.currency, buyerEmail: input.buyerEmail }, paymentReturnUrl);
      await prisma.$transaction(async tx => {
        await tx.payment.update({ where: { parentId: order.id }, data: { providerRef: transaction.reference } });
        await tx.paymentAttempt.updateMany({ where: { payment: { parentId: order.id }, provider: PaymentMethod.PAYSTACK }, data: { providerRef: transaction.reference } });
      });
      paymentAction = { provider: 'PAYSTACK', checkoutUrl: transaction.authorizationUrl };
    }
  } catch (error) {
    await prisma.$transaction(async tx => {
      const failed = await tx.payment.updateMany({ where: { parentId: order.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.FAILED } });
      if (failed.count) {
        const failedOrder = await tx.parentOrder.findUnique({ where: { id: order.id }, select: { id: true, orderNumber: true, buyerId: true, sellerOrders: { select: { sellerId: true } } } });
        if (failedOrder) await notifyOrderParties(tx, {
          orderId: failedOrder.id, orderNumber: failedOrder.orderNumber, buyerId: failedOrder.buyerId,
          sellerIds: failedOrder.sellerOrders.map(sellerOrder => sellerOrder.sellerId), eventType: 'PAYMENT_PROVIDER_SETUP_FAILED',
          buyer: { title: 'Payment could not be started', body: `The payment provider could not start checkout for order ${failedOrder.orderNumber}. Your order remains recorded; retry payment or contact support.`, link: `/checkout?order=${encodeURIComponent(failedOrder.id)}` },
          seller: { title: 'Order payment setup failed', body: `Payment checkout could not be started for order ${failedOrder.orderNumber}. The buyer has been notified.`, link: '/dashboard?mode=seller&tab=orders' },
          admin: { title: 'Payment setup failed', body: `The provider could not start checkout for order ${failedOrder.orderNumber}.`, link: '/admin/platform?section=orders' }
        });
      }
    });
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Payment provider unavailable', orderId: order.id });
  }
  res.status(201).json({ orderId: order.id, orderNumber: order.orderNumber, totalMinor: order.totalMinor, shippingTotalMinor: committed.shippingTotalMinor, discountMinor: committed.discountMinor, discountCode: committed.discountCode, shippingBreakdown: committed.shippingBreakdown, currency: order.currency, displayEstimate: committed.displayEstimate, payment: paymentAction, paymentCurrency: committed.providerChargeQuote?.currency ?? order.currency, paymentAmountMinor: committed.providerChargeQuote?.amountMinor ?? order.totalMinor, paymentStatus: method === PaymentMethod.COD ? 'PENDING' : 'AWAITING_PROVIDER' });
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
    const order = await tx.parentOrder.findFirst({ where: { id: orderId, payment: { method: PaymentMethod.COD } }, include: { payment: true, sellerOrders: { select: { id: true, sellerId: true, status: true, shipmentStatus: true, deliveredAt: true } } } });
    if (!order?.payment) throw Object.assign(new Error('COD order not found.'), { statusCode: 404 });
    const sellerOrders = order.sellerOrders.filter(row => row.sellerId !== null);
    if (user.role !== Role.ADMIN) {
      if (!user.sellerId || !sellerOrders.some(row => row.sellerId === user.sellerId)) throw Object.assign(new Error('This seller cannot collect for the order.'), { statusCode: 404 });
      if (sellerOrders.length !== 1 || order.sellerOrders.some(row => row.sellerId === null)) throw Object.assign(new Error('Only an administrator can confirm collection for a multi-Store or platform order.'), { statusCode: 403 });
    }
    if (!sellerOrders.length || order.sellerOrders.some(row => row.sellerId === null || row.status !== OrderStatus.FULFILLED || row.shipmentStatus !== 'DELIVERED' || !row.deliveredAt)) {
      throw Object.assign(new Error('Every COD shipment must have a recorded delivered status before cash collection can be confirmed.'), { statusCode: 409, code: 'COD_DELIVERY_REQUIRED' });
    }
    if (order.payment.status === PaymentStatus.PAID) {
      // A retry can repair affiliate work left incomplete by an older
      // non-atomic implementation. The helper is idempotent under this lock.
      await settleAffiliateForPaidOrderInTransaction(tx, order.id, `cod-collection:${order.id}`);
      await awardClubCoinsForCompletedOrder(tx, order.id, collectedAt);
      return false;
    }
    if (order.payment.status !== PaymentStatus.PENDING || order.status === OrderStatus.CANCELLED) throw Object.assign(new Error('This COD order is not eligible for collection.'), { statusCode: 409 });
    const update = await tx.payment.updateMany({ where: { id: order.payment.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.PAID, paidAt: collectedAt } });
    if (!update.count) return false;
    await tx.parentOrder.updateMany({ where: { id: order.id, status: { not: OrderStatus.CANCELLED } }, data: { status: OrderStatus.CONFIRMED } });
    await accrueSellerCommissionsForPaidOrder(tx, order.id, `cod-collection:${order.id}`);
    await settleAffiliateForPaidOrderInTransaction(tx, order.id, `cod-collection:${order.id}`);
    await awardClubCoinsForCompletedOrder(tx, order.id, collectedAt);
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
    if (next === OrderStatus.CANCELLED) {
      const openCases = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "OrderResolutionCase" WHERE "sellerOrderId" = ${current.id} AND "status" IN ('OPEN', 'UNDER_REVIEW', 'REFUND_APPROVED') LIMIT 1`;
      if (openCases.length) throw Object.assign(new Error('Resolve the buyer order case before cancelling this Store order.'), { statusCode: 409, code: 'ORDER_CASE_OPEN' });
    }
    if (next === OrderStatus.FULFILLED && current.shippingSnapshotJson && (current.shipmentStatus !== 'DELIVERED' || !current.deliveredAt)) {
      throw Object.assign(new Error('Mark this order fulfilled only after its tracked shipment is recorded as delivered.'), { statusCode: 409, code: 'DELIVERY_REQUIRED' });
    }
    if (next === OrderStatus.CANCELLED && current.shippedAt) throw Object.assign(new Error('A shipped order cannot be cancelled through seller status controls.'), { statusCode: 409, code: 'SHIPMENT_ALREADY_STARTED' });
    if (next === OrderStatus.CANCELLED && current.receivedAt) throw Object.assign(new Error('A buyer-confirmed order cannot be cancelled through seller status controls.'), { statusCode: 409, code: 'BUYER_RECEIPT_CONFIRMED' });
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
      const quantityError = wholesaleQuantityError(product, item.quantity, true);
      if (quantityError) throw Object.assign(new Error(`${product.name}: ${quantityError}`), { statusCode: 409, code: 'WHOLESALE_QUANTITY_INVALID' });
      const updated = await tx.inventory.updateMany({ where: { productId: product.id, quantity: { gte: item.quantity } }, data: { quantity: { decrement: item.quantity } } });
      if (updated.count !== 1) throw Object.assign(new Error(`Insufficient stock for ${product.name}`), { statusCode: 409 });
      products.push({ productId: product.id, quantity: item.quantity, productName: product.name, priceMinor: effectiveProductPriceMinor(product) });
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
app.get('/api/admin/live-sessions', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => {
  const sessions = await prisma.liveSession.findMany({ include: { seller: { include: { store: true } }, products: { include: { product: true } }, reports: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(sessions.map(publicLiveSession));
}));
app.post('/api/admin/live-sessions/:id/terminate', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => {
  const user = res.locals.user as { id: string };
  const session = await prisma.liveSession.findUnique({ where: { id: routeParam(req.params.id) } });
  if (!session) return res.status(404).json({ error: 'Live session not found' });
  if (['ENDED', 'CANCELLED', 'FAILED'].includes(session.status)) return res.json(publicLiveSession(session));
  if (session.providerSessionRef) { await syncLiveProviderFromDatabase(); await liveProvider.endSession(session.providerSessionRef); }
  const endedAt = new Date();
  const changed = await prisma.liveSession.updateMany({ where: { id: session.id, status: session.status }, data: { status: 'ENDED', endedAt } });
  if (!changed.count) return res.status(409).json({ error: 'Live session changed; refresh and retry.' });
  await audit(user.id, 'LIVE_SESSION_TERMINATED', 'LiveSession', session.id, { previousStatus: session.status });
  const updated = await prisma.liveSession.findUnique({ where: { id: session.id } });
  res.json(updated ? publicLiveSession(updated) : { id: session.id, status: 'ENDED' });
}));
app.get('/api/admin/live-reports', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.liveSessionReport.findMany({ include: { session: { select: { id: true, title: true, status: true } }, reporter: { select: { email: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));
app.patch('/api/admin/live-reports/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const id = routeParam(req.params.id); const status = z.object({ status: z.enum(['REVIEWED', 'DISMISSED']) }).parse(req.body).status; const existing = await prisma.liveSessionReport.findUnique({ where: { id }, select: { id: true, status: true } }); if (!existing) return res.status(404).json({ error: 'Live report not found' }); const report = await prisma.liveSessionReport.updateMany({ where: { id, status: existing.status }, data: { status, reviewedById: user.id, reviewedAt: new Date() } }); if (!report.count) return res.status(409).json({ error: 'Live report changed; refresh and retry.' }); await audit(user.id, 'LIVE_REPORT_REVIEWED', 'LiveSessionReport', id, { old: existing.status, status }); res.json({ id, status }); }));
app.get('/api/admin/audit', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { actor: { select: { email: true, name: true } } } }))));
app.get('/api/admin/sellers', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.seller.findMany({ include: { user: { select: { email: true, name: true } }, store: true }, orderBy: { createdAt: 'desc' } }))));
app.patch('/api/admin/sellers/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => {
  const actor = res.locals.user as { id: string };
  const sellerId = routeParam(req.params.id);
  const input = z.object({ status: z.nativeEnum(SellerStatus), reason: z.string().trim().max(500).optional() }).parse(req.body);
  if ((input.status === SellerStatus.REJECTED || input.status === SellerStatus.SUSPENDED) && !input.reason) return res.status(400).json({ error: 'A reason is required for rejection or suspension' });
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Seller" WHERE "id" = ${sellerId} FOR UPDATE`;
    const current = await tx.seller.findUnique({ where: { id: sellerId }, include: { user: { select: { id: true, name: true, email: true } }, store: true } });
    if (!current) throw Object.assign(new Error('Seller not found'), { statusCode: 404 });
    const statusChanged = current.status !== input.status;
    const updated = statusChanged
      ? await tx.seller.update({ where: { id: current.id }, data: { status: input.status, reason: input.reason ?? null } })
      : current;
    if (statusChanged) await tx.sellerModerationEvent.create({ data: { sellerId: updated.id, actorId: actor.id, fromStatus: current.status, toStatus: updated.status, reason: input.reason } });

    let store = current.store;
    let storeCreated = false;
    if (input.status === SellerStatus.APPROVED) {
      await tx.user.update({ where: { id: updated.userId }, data: { role: Role.SELLER } });
      const provisioned = await provisionApprovedSellerStore(tx, { sellerId: updated.id, sellerName: current.user.name });
      store = provisioned.store;
      storeCreated = provisioned.created;
    }
    if (storeCreated) await tx.auditLog.create({ data: { actorId: actor.id, action: 'SELLER_STORE_PROVISIONED', entity: 'Store', entityId: store!.id, metadata: { sellerId: updated.id, source: 'ADMIN_APPROVAL_REPAIR' } } });
    if (statusChanged) {
      const approved = input.status === SellerStatus.APPROVED;
      const title = approved ? 'Seller application approved' : input.status === SellerStatus.PENDING ? 'Seller application is pending' : input.status === SellerStatus.REJECTED ? 'Seller application was not approved' : 'Seller access suspended';
      const body = approved
        ? `Your seller application is approved${store ? ` and ${store.name} is ready` : ''}. Seller tools are now available.`
        : input.status === SellerStatus.PENDING ? 'Your seller application is awaiting marketplace review.' : `Your seller application status changed to ${input.status.toLowerCase()}.${input.reason ? ` Reason: ${input.reason}` : ''}`;
      await createUserNotification(tx, { userId: current.userId, eventType: `SELLER_${input.status}`, title, body, link: approved ? '/dashboard?mode=seller' : '/dashboard', payloadJson: { sellerId: updated.id, status: input.status, storeId: store?.id ?? null } }, 'account');
      await createRoleNotifications(tx, Role.ADMIN, { eventType: `SELLER_${input.status}`, title: `Seller application ${input.status.toLowerCase()}`, body: `${current.user.name} (${current.user.email}) is now ${input.status.toLowerCase()}.`, link: '/admin/platform?section=vendors', payloadJson: { sellerId: updated.id, status: input.status } }, 'account');
    } else if (storeCreated) {
      await createUserNotification(tx, { userId: current.userId, eventType: 'SELLER_STORE_PROVISIONED', title: 'Your Store is ready', body: `${store!.name} has been provisioned. Your approved seller workspace is now available.`, link: '/dashboard?mode=seller', payloadJson: { sellerId: updated.id, storeId: store!.id } }, 'account');
    }
    return { seller: { ...updated, user: current.user, store }, statusChanged, storeCreated };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (result.statusChanged) await audit(actor.id, `SELLER_${input.status}`, 'Seller', sellerId, { reason: input.reason, storeCreated: result.storeCreated });
  res.json(result.seller);
}));
app.post('/api/admin/sellers/:id/provision-store', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => {
  const actor = res.locals.user as { id: string };
  const sellerId = routeParam(req.params.id);
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Seller" WHERE "id" = ${sellerId} FOR UPDATE`;
    const seller = await tx.seller.findUnique({ where: { id: sellerId }, include: { user: { select: { id: true, name: true } }, store: true } });
    if (!seller) throw Object.assign(new Error('Seller not found'), { statusCode: 404 });
    if (seller.status !== SellerStatus.APPROVED) throw Object.assign(new Error('Only an approved seller can have a Store provisioned.'), { statusCode: 409, code: 'SELLER_NOT_APPROVED' });
    await tx.user.update({ where: { id: seller.userId }, data: { role: Role.SELLER } });
    const provisioned = await provisionApprovedSellerStore(tx, { sellerId: seller.id, sellerName: seller.user.name });
    if (provisioned.created) {
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'SELLER_STORE_PROVISIONED', entity: 'Store', entityId: provisioned.store.id, metadata: { sellerId: seller.id, source: 'ADMIN_REPAIR' } } });
      await createUserNotification(tx, { userId: seller.userId, eventType: 'SELLER_STORE_PROVISIONED', title: 'Your Store is ready', body: `${provisioned.store.name} has been provisioned. Your approved seller workspace is now available.`, link: '/dashboard?mode=seller', payloadJson: { sellerId: seller.id, storeId: provisioned.store.id } }, 'account');
    }
    return { store: provisioned.store, created: provisioned.created };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  res.json(result);
}));
app.patch('/api/admin/products/:id', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(ProductStatus), reason: z.string().max(500).optional() }).parse(req.body); const product = await prisma.product.update({ where: { id: routeParam(req.params.id) }, data: { status: input.status } }); await audit(user.id, `PRODUCT_${input.status}`, 'Product', product.id, { reason: input.reason }); res.json(product); }));
app.get('/api/seller/summary', requireAuth, requireRole(Role.SELLER, Role.CASHIER), asyncRoute(async (_req, res) => { const user = res.locals.user as { sellerId?: string }; if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required' }); res.json(await sellerDashboardSummary(user.sellerId)); }));
app.get('/api/admin/orders', requireAuth, requireRole(Role.ADMIN), asyncRoute(async (_req, res) => res.json(await prisma.parentOrder.findMany({ include: { payment: true, sellerOrders: { include: { seller: { include: { store: true } }, items: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe webhook is not configured' });
  let event: StripeType.Event;
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  try { event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'] as string, env.STRIPE_WEBHOOK_SECRET); } catch { return res.status(400).json({ error: 'Invalid Stripe signature' }); }
  const sponsoredFunding = await handleSponsoredStripeEvent(event);
  if (sponsoredFunding.handled) return res.status(sponsoredFunding.reconciliation === 'REVIEW_REQUIRED' ? 202 : sponsoredFunding.reconciliation === 'AWAITING_CAPTURE' ? 202 : 200).json({ received: true, reconciliation: sponsoredFunding.reconciliation });
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
  const sponsoredFunding = await handleSponsoredPaypalEvent(event, async currency => {
    const entry = await prisma.currencyCatalogEntry.findUnique({ where: { code: currency }, select: { minorUnitExponent: true } });
    return entry?.minorUnitExponent ?? null;
  });
  if (sponsoredFunding.handled) return res.status(sponsoredFunding.reconciliation === 'REVIEW_REQUIRED' ? 202 : 200).json({ received: true, reconciliation: sponsoredFunding.reconciliation });
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

app.post('/api/webhooks/paymongo', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  const apiKey = env.PAYMONGO_SECRET_KEY;
  const webhookSecret = env.PAYMONGO_WEBHOOK_SECRET;
  if (!apiKey?.startsWith('sk_') || !webhookSecret) return res.status(503).json({ error: 'PayMongo webhook verification is not configured.' });
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  const headerValue = req.headers['paymongo-signature'];
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const liveMode = apiKey.startsWith('sk_live_');
  if (!verifyPaymongoSignature(rawBody, signature, webhookSecret, liveMode)) return res.status(400).json({ error: 'Invalid PayMongo signature.' });
  let body: unknown;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid PayMongo webhook payload.' }); }
  const event = paymongoEventToVerifiedPaymentEvent(body, liveMode);
  if (!event) return res.status(200).json({ received: true, ignored: true });
  try {
    const result = await prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, event), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return res.status(result.reviewReason ? 202 : 200).json({ received: true, reconciliation: result.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const persisted = await prisma.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: PaymentMethod.PAYMONGO, eventId: event.eventId } } });
      if (persisted && !persisted.identityVerified) return res.status(202).json({ received: true, reconciliation: 'REVIEW_REQUIRED' });
      if (persisted && matchesPersistedPaymentEvent(event, persisted)) return res.status(persisted.reviewReason ? 202 : 200).json({ received: true, reconciliation: persisted.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
    }
    throw error;
  }
}));

app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  const secret = env.PAYSTACK_SECRET_KEY;
  if (!secret?.startsWith('sk_') || secret.toLowerCase().includes('placeholder')) return res.status(503).json({ error: 'Paystack webhook verification is not configured.' });
  const rawBody = ((req as express.Request & { rawBody?: Buffer }).rawBody ?? req.body) as Buffer;
  const headerValue = req.headers['x-paystack-signature'];
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!verifyPaystackSignature(rawBody, signature, secret)) return res.status(400).json({ error: 'Invalid Paystack signature.' });
  let body: unknown;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid Paystack webhook payload.' }); }
  const event = paystackEventToVerifiedPaymentEvent(body);
  if (!event) return res.status(200).json({ received: true, ignored: true });
  try {
    const result = await prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, event), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return res.status(result.reviewReason ? 202 : 200).json({ received: true, reconciliation: result.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const persisted = await prisma.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: PaymentMethod.PAYSTACK, eventId: event.eventId } } });
      if (persisted && !persisted.identityVerified) return res.status(202).json({ received: true, reconciliation: 'REVIEW_REQUIRED' });
      if (persisted && matchesPersistedPaymentEvent(event, persisted)) return res.status(persisted.reviewReason ? 202 : 200).json({ received: true, reconciliation: persisted.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE' });
    }
    throw error;
  }
}));

// Keep unknown API routes as API responses instead of Express's default HTML 404.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

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
  diagnostics.logOperationalError('HTTP_REQUEST_FAILED', error);
  res.status(500).json({ error: 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') app.listen(env.API_PORT, () => console.log(`Marketplace API listening on http://localhost:${env.API_PORT}`));
export { app };
