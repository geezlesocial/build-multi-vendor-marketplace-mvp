import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { PaymentMethod, Prisma, ProductStatus, Role, SellerStatus, StoreBusterAdAccountStatus, StoreBusterCampaignGoal, StoreBusterCampaignStatus, StoreEmailCampaignStatus, StoreEmailDeliveryStatus, StoreInterestSignalType, StoreEmailSubscriberStatus } from '@prisma/client';
import isoCountries from 'i18n-iso-countries';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { effectiveStorePlan, storeEntitlements } from './store-plan-domain.js';
import { scoreInterestCategories } from './store-buster-domain.js';
import { normalizeSubscriberEmail, verifyUnsubscribeToken } from './store-email-domain.js';
import { accountVerificationEmailStatus, sendStoreEmailConfirmation, storeEmailProviderStatus, storeEmailProviderStatusForStore, verifyStoreEmailSmtp, StoreEmailTransportError } from './store-email-delivery.js';
import { capturePaypalOrder, createPaypalStoreBusterOrder, createStripeStoreBusterCheckout, stripe } from './payments.js';
import { convertMinorExact, decimalToMinorExact } from './currency-domain.js';
import { latestDisplayRate } from './currency-routes.js';
import { settleStoreBusterClick, settleStoreBusterFunding, settleStoreBusterImpression } from './store-buster-sponsored.js';
import { calculateSponsoredClickSpend, convertQuotedMinorToBaseMinor, minorToDecimal } from './store-buster-sponsored-domain.js';
import { livePaymentActivationBlock } from './provider-activation.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, extra?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...extra });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const jsonInput = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const consentSchema = z.object({ enabled: z.boolean() }).strict();
const isoCountryCodes = new Set(Object.keys(isoCountries.getAlpha2Codes()));
const countryDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });
const normalizedCountryNames = new Map<string, string>();
for (const code of isoCountryCodes) {
  const name = countryDisplayNames.of(code)?.trim().toLowerCase();
  if (name) normalizedCountryNames.set(name, code);
}
function countryCodeForAddress(value: string) {
  const normalized = value.trim();
  if (isoCountryCodes.has(normalized.toUpperCase())) return normalized.toUpperCase();
  return normalizedCountryNames.get(normalized.toLowerCase()) ?? null;
}
const campaignAudienceSchema = z.enum(['BUYERS', 'SELLERS', 'BOTH']);
const billingModelSchema = z.enum(['CPC', 'CPV']);
const signalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(StoreInterestSignalType.PRODUCT_VIEW), productId: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal(StoreInterestSignalType.FAVORITE), productId: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal(StoreInterestSignalType.SEARCH_CATEGORY), categoryId: z.string().min(1).max(80) }).strict()
]);
const campaignSchema = z.object({
  name: z.string().trim().min(2).max(100),
  goal: z.nativeEnum(StoreBusterCampaignGoal),
  productIds: z.array(z.string().min(1).max(80)).min(1).max(20),
  audienceCategoryIds: z.array(z.string().min(1).max(80)).max(20).default([]),
  sponsored: z.boolean().default(false),
  monthlyBudgetMinor: z.number().int().min(0).max(2_000_000_000).default(0),
  headline: z.string().trim().min(2).max(120).optional(),
  adDescription: z.string().trim().min(2).max(1000).optional(),
  billingModel: billingModelSchema.optional(),
  audience: campaignAudienceSchema.optional(),
  targetCountryCodes: z.array(z.string().length(2).transform(value => value.toUpperCase())).max(250).default([]),
  durationDays: z.number().int().min(1).max(365).optional(),
  dailyBudgetMinor: z.number().int().positive().max(2_000_000_000).optional(),
  budgetCurrency: z.string().length(3).transform(value => value.toUpperCase()).optional(),
  creativeAssetIds: z.array(z.string().min(1).max(80)).max(4).default([])
}).strict()
  .refine(value => new Set(value.productIds).size === value.productIds.length, 'Products must not be repeated')
  .refine(value => new Set(value.targetCountryCodes).size === value.targetCountryCodes.length, 'Target countries must not be repeated')
  .refine(value => new Set(value.creativeAssetIds).size === value.creativeAssetIds.length, 'Creative assets must not be repeated')
  .refine(value => value.sponsored ? Boolean(value.headline && value.adDescription && value.billingModel && value.audience && value.durationDays && value.dailyBudgetMinor && value.budgetCurrency && value.creativeAssetIds.length) : value.monthlyBudgetMinor === 0, 'Paid ads need copy, a billing model, targeting, duration, budget, and at least one approved creative; organic campaigns cannot spend.');
const settingsSchema = z.object({ enabled: z.boolean(), sponsoredEnabled: z.boolean(), moderationRequired: z.boolean(), maxMonthlyBudgetMinor: z.number().int().min(0).max(2_000_000_000), maxCampaignsPerStore: z.number().int().min(0).max(100_000), pricePerClickMinor: z.number().int().min(0).max(2_000_000_000), pricePer100ViewsMinor: z.number().int().min(0).max(2_000_000_000), minimumCampaignUsdMinor: z.number().int().min(1000).max(2_000_000_000), maxCampaignDurationDays: z.number().int().min(1).max(365), reason: z.string().trim().min(3).max(500) }).strict().refine(value => !value.sponsoredEnabled || value.enabled, 'Sponsored placements require Store Buster to be enabled.');
const emailCampaignSchema = z.object({ name: z.string().trim().min(2).max(100), subject: z.string().trim().min(2).max(160).refine(value => !/[\r\n]/.test(value), 'Subject must be a single line.'), content: z.array(z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(2000).refine(value => !/[<>]/.test(value), 'HTML is not allowed') }).strict()).min(1).max(30) }).strict();
function maskSubscriberEmail(email: string) {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '•••' : `${email.slice(0, 1)}•••${email.slice(at)}`;
}

async function sellerStore(sellerId: string) {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED }, select: { id: true, store: { select: { id: true, name: true, slug: true } } } });
  if (!seller?.store) throw fail(403, 'An approved seller Store is required.');
  return seller.store;
}

async function sponsoredBillingStatus() {
  const [methods, currency] = await Promise.all([
    prisma.paymentMethodSettings.findMany({ where: { enabled: true, method: { in: [PaymentMethod.STRIPE, PaymentMethod.PAYPAL] } }, select: { method: true } }),
    prisma.currencyCatalogEntry.findFirst({ where: { code: env.CURRENCY, active: true, checkoutEnabled: true }, select: { code: true } })
  ]);
  const enabled = new Set(methods.map(item => item.method));
  const providers = [
    { method: 'STRIPE', available: enabled.has(PaymentMethod.STRIPE) && Boolean(stripe && env.STRIPE_WEBHOOK_SECRET) },
    { method: 'PAYPAL', available: enabled.has(PaymentMethod.PAYPAL) && Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && !env.PAYPAL_CLIENT_ID.includes('placeholder') && env.PAYPAL_WEBHOOK_ID) }
  ].filter(item => item.available);
  return { providers, available: env.STORE_BUSTER_SPONSORED_AVAILABLE && Boolean(currency) && providers.length > 0 };
}

async function currencyExponent(currency: string) {
  const entry = await prisma.currencyCatalogEntry.findUnique({ where: { code: currency }, select: { minorUnitExponent: true, active: true, checkoutEnabled: true } });
  if (!entry?.active || !entry.checkoutEnabled) throw fail(409, `Platform currency ${currency} is not enabled for checkout in the currency catalog.`);
  return entry.minorUnitExponent;
}
function utcDay(value: Date) { const day = new Date(value); day.setUTCHours(0, 0, 0, 0); return day; }

async function storeAdBudgetCurrencies() {
  const entries = await prisma.currencyCatalogEntry.findMany({ where: { active: true, OR: [{ code: env.CURRENCY }, { displayEnabled: true }] }, orderBy: [{ region: 'asc' }, { name: 'asc' }], select: { code: true, name: true, symbol: true, minorUnitExponent: true, displayEnabled: true } });
  const results = [] as { code: string; name: string; symbol: string; minorUnitExponent: number; platformToCurrencyRate: string }[];
  for (const entry of entries) {
    const rate = await latestDisplayRate(env.CURRENCY, entry.code);
    if (rate && rate.freshness !== 'stale') results.push({ code: entry.code, name: entry.name, symbol: entry.symbol, minorUnitExponent: entry.minorUnitExponent, platformToCurrencyRate: rate.rate });
  }
  return results;
}

async function resolveAdBudget(input: { dailyBudgetMinor: number; durationDays: number; budgetCurrency: string }, settings: { minimumCampaignUsdMinor: number; maxCampaignDurationDays: number }) {
  if (input.durationDays > settings.maxCampaignDurationDays) throw fail(400, `Campaign duration cannot exceed ${settings.maxCampaignDurationDays} days.`);
  if (!Number.isSafeInteger(input.dailyBudgetMinor) || input.dailyBudgetMinor <= 0 || !Number.isSafeInteger(input.dailyBudgetMinor * input.durationDays) || input.dailyBudgetMinor * input.durationDays > 2_000_000_000) throw fail(400, 'Daily budget and campaign duration exceed the supported budget range.');
  const [base, quote, usd] = await Promise.all([
    prisma.currencyCatalogEntry.findFirst({ where: { code: env.CURRENCY, active: true }, select: { code: true, minorUnitExponent: true } }),
    prisma.currencyCatalogEntry.findFirst({ where: { code: input.budgetCurrency, active: true, ...(input.budgetCurrency === env.CURRENCY ? {} : { displayEnabled: true }) }, select: { code: true, minorUnitExponent: true } }),
    prisma.currencyCatalogEntry.findFirst({ where: { code: 'USD', active: true }, select: { code: true, minorUnitExponent: true } })
  ]);
  if (!base || !quote || !usd) throw fail(409, 'The platform, selected, or USD currency is not active in the currency catalog.');
  const quoteRate = input.budgetCurrency === env.CURRENCY ? { rate: '1', freshness: 'fresh' as const } : await latestDisplayRate(env.CURRENCY, input.budgetCurrency);
  if (!quoteRate || quoteRate.freshness === 'stale') throw fail(409, `A current ${env.CURRENCY}/${input.budgetCurrency} exchange rate is unavailable. Refresh platform FX rates before creating this campaign.`);
  const selectedTotal = input.dailyBudgetMinor * input.durationDays;
  const dailyBaseBig = input.budgetCurrency === env.CURRENCY ? BigInt(input.dailyBudgetMinor) : convertQuotedMinorToBaseMinor(BigInt(input.dailyBudgetMinor), quoteRate.rate, base.minorUnitExponent, quote.minorUnitExponent);
  const totalBaseBig = input.budgetCurrency === env.CURRENCY ? BigInt(selectedTotal) : convertQuotedMinorToBaseMinor(BigInt(selectedTotal), quoteRate.rate, base.minorUnitExponent, quote.minorUnitExponent);
  if (dailyBaseBig < 1n || totalBaseBig < 1n || dailyBaseBig > 2_000_000_000n || totalBaseBig > 2_000_000_000n) throw fail(400, 'The converted campaign budget is outside the supported platform-currency range.');
  const platformUsdRate = env.CURRENCY === 'USD' ? { rate: '1', freshness: 'fresh' as const } : await latestDisplayRate(env.CURRENCY, 'USD');
  if (!platformUsdRate || platformUsdRate.freshness === 'stale') throw fail(409, 'A current platform-currency/USD rate is unavailable, so the USD minimum cannot be verified. Refresh platform FX rates before creating this campaign.');
  const usdEquivalentBig = env.CURRENCY === 'USD' ? totalBaseBig : convertMinorExact(totalBaseBig, platformUsdRate.rate, base.minorUnitExponent, usd.minorUnitExponent);
  if (usdEquivalentBig > 2_000_000_000n) throw fail(400, 'The USD-equivalent campaign budget exceeds the supported range.');
  const monthlyBaseBig = dailyBaseBig * BigInt(Math.min(input.durationDays, 30));
  return {
    dailyBudgetBaseMinor: Number(dailyBaseBig),
    lifetimeBudgetBaseMinor: Number(totalBaseBig),
    monthlyBudgetBaseMinor: Number(monthlyBaseBig > totalBaseBig ? totalBaseBig : monthlyBaseBig),
    budgetTotalMinor: selectedTotal,
    budgetCurrency: input.budgetCurrency,
    budgetFxRate: quoteRate.rate,
    usdEquivalentMinor: Number(usdEquivalentBig),
    minimumCampaignUsdMinor: settings.minimumCampaignUsdMinor,
    eligible: usdEquivalentBig >= BigInt(settings.minimumCampaignUsdMinor),
    platformCurrency: env.CURRENCY,
    durationDays: input.durationDays
  };
}

export function registerStoreGrowthRoutes(app: Express) {
  app.get('/api/admin/store-email/status', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [outboxStatuses, outboxTotal] = await Promise.all([
      prisma.emailOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.emailOutbox.count()
    ]);
    const transactionalQueue = Object.fromEntries(outboxStatuses.map(item => [item.status, item._count._all]));
    const [providerStatus, verificationStatus] = await Promise.all([storeEmailProviderStatus(), accountVerificationEmailStatus()]);
    res.json({ ...providerStatus, accountVerification: verificationStatus, transactionalQueue: { total: outboxTotal, ...transactionalQueue } });
  }));
  app.post('/api/admin/store-email/verify', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const user = actor(res);
    try {
      const result = await verifyStoreEmailSmtp();
      await audit(user.id, 'STORE_EMAIL_SMTP_VERIFIED', 'StoreEmailProvider', 'deployment', { verifiedAt: new Date().toISOString() });
      res.json({ ...result, message: 'SMTP connection verified. No email was sent.' });
    } catch (error) {
      const safe = error instanceof StoreEmailTransportError ? error : new StoreEmailTransportError('EMAIL_CONNECTION_FAILED');
      await audit(user.id, 'STORE_EMAIL_SMTP_VERIFICATION_FAILED', 'StoreEmailProvider', 'deployment', { code: safe.code });
      throw fail(safe.code === 'EMAIL_PROVIDER_NOT_CONFIGURED' ? 409 : 502, safe.message, { code: safe.code });
    }
  }));

  app.post('/api/admin/store-email/outbox/retry-failed', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ reason: z.string().trim().min(8).max(500) }).strict().parse(req.body);
    const retried = await prisma.$transaction(async tx => {
      const failed = await tx.emailOutbox.findMany({ where: { status: 'FAILED' }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 500 });
      if (!failed.length) return 0;
      const count = await tx.$executeRaw`UPDATE "EmailOutbox" SET "status" = 'PENDING'::"NotificationDeliveryStatus", "attempts" = 0, "nextAttemptAt" = CURRENT_TIMESTAMP, "claimedAt" = NULL, "providerMessageId" = NULL, "lastError" = NULL WHERE "id" = ANY(${failed.map(item => item.id)}::text[]) AND "status" = 'FAILED'::"NotificationDeliveryStatus"`;
      await tx.auditLog.create({ data: { actorId: user.id, action: 'TRANSACTIONAL_EMAIL_OUTBOX_RETRY_REQUESTED', entity: 'EmailOutbox', entityId: 'failed-batch', metadata: { retriedCount: count, reason: input.reason, maximumBatchSize: 500 } } });
      return count;
    });
    res.json({ retried, message: `${retried} failed transactional email${retried === 1 ? '' : 's'} queued for retry.` });
  }));

  app.get('/api/account/personalization', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const preference = await prisma.userPreference.findUnique({ where: { userId: user.id }, select: { personalizationEnabled: true, personalizationConsentAt: true } });
    res.json(preference ?? { personalizationEnabled: false, personalizationConsentAt: null });
  }));

  app.patch('/api/account/personalization', requireAuth, run(async (req, res) => {
    const user = actor(res); const input = consentSchema.parse(req.body);
    const updated = await prisma.$transaction(async tx => {
      const preference = await tx.userPreference.upsert({ where: { userId: user.id }, create: { userId: user.id, personalizationEnabled: input.enabled, personalizationConsentAt: input.enabled ? new Date() : null }, update: { personalizationEnabled: input.enabled, personalizationConsentAt: input.enabled ? new Date() : null } });
      if (!input.enabled) await tx.storeInterestSignal.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: input.enabled ? 'PERSONALIZATION_ENABLED' : 'PERSONALIZATION_DISABLED', entity: 'UserPreference', entityId: preference.id, metadata: { deletesStoredSignals: !input.enabled } } });
      return preference;
    });
    res.json({ personalizationEnabled: updated.personalizationEnabled, personalizationConsentAt: updated.personalizationConsentAt });
  }));

  app.post('/api/store-buster/signals', requireAuth, run(async (req, res) => {
    const user = actor(res); const input = signalSchema.parse(req.body);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "UserPreference" WHERE "userId" = ${user.id} FOR UPDATE`;
      const preference = await tx.userPreference.findUnique({ where: { userId: user.id }, select: { personalizationEnabled: true, personalizationConsentAt: true } });
      if (!preference?.personalizationEnabled || !preference.personalizationConsentAt) return;
      const now = new Date();
      const retentionCutoff = new Date(now.getTime() - 90 * 86400000);
      const duplicateCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await tx.storeInterestSignal.deleteMany({ where: { userId: user.id, createdAt: { lt: retentionCutoff } } });
      if ('productId' in input) {
        const product = await tx.product.findFirst({ where: { id: input.productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, select: { id: true, categoryId: true } });
        if (!product) throw fail(404, 'Product not found.');
        const duplicate = await tx.storeInterestSignal.findFirst({ where: { userId: user.id, type: input.type, productId: product.id, createdAt: { gte: duplicateCutoff } }, select: { id: true } });
        if (!duplicate) await tx.storeInterestSignal.create({ data: { userId: user.id, type: input.type, productId: product.id, categoryId: product.categoryId } });
      } else {
        const category = await tx.category.findFirst({ where: { id: input.categoryId, status: 'ACTIVE' }, select: { id: true } });
        if (!category) throw fail(404, 'Category not found.');
        const duplicate = await tx.storeInterestSignal.findFirst({ where: { userId: user.id, type: input.type, categoryId: category.id, createdAt: { gte: duplicateCutoff } }, select: { id: true } });
        if (!duplicate) await tx.storeInterestSignal.create({ data: { userId: user.id, type: input.type, categoryId: category.id } });
      }
    });
    res.status(204).send();
  }));

  app.get('/api/store-buster/recommendations', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const preference = await prisma.userPreference.findUnique({ where: { userId: user.id }, select: { personalizationEnabled: true, personalizationConsentAt: true } });
    const platformSettings = await prisma.storeBusterSettings.findUnique({ where: { id: 'default' } });
    if (!preference?.personalizationEnabled || !preference.personalizationConsentAt) return res.json({ personalized: false, items: [], message: 'Enable personalization to see recommendations based on your activity.' });
    if (!platformSettings?.enabled) return res.json({ personalized: true, items: [], message: 'Store recommendations are currently unavailable.' });
    const since = new Date(Date.now() - 90 * 86400000);
    const signals = await prisma.storeInterestSignal.findMany({ where: { userId: user.id, createdAt: { gte: since }, categoryId: { not: null } }, select: { categoryId: true, productId: true, type: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    const categoryScores = scoreInterestCategories(signals);
    const categoryIds = categoryScores.map(item => item.categoryId);
    const scoreByCategory = new Map(categoryScores.map(item => [item.categoryId, item.points]));
    if (categoryIds.length === 0) return res.json({ personalized: true, items: [], message: 'Browse or save products to build recommendations. We never share your individual history with stores.' });
    const campaigns = await prisma.storeBusterCampaign.findMany({
      where: { status: StoreBusterCampaignStatus.APPROVED, sponsored: false, OR: [{ audienceCategoryIds: { hasSome: categoryIds } }, { audienceCategoryIds: { isEmpty: true } }] },
      include: { store: { select: { id: true, name: true, slug: true, sellerId: true, seller: { select: { status: true } } } }, products: { include: { product: { select: { id: true, slug: true, name: true, description: true, priceMinor: true, salePriceMinor: true, currency: true, sellerId: true, status: true, category: { select: { id: true, name: true, status: true } }, inventory: { select: { quantity: true } }, images: { take: 1, select: { url: true, alt: true } } } } } } },
      take: 100
    });
    const eligible = [];
    for (const campaign of campaigns) {
      if (campaign.store.seller.status !== SellerStatus.APPROVED) continue;
      const matchingProducts = campaign.products.filter(item => item.product.status === ProductStatus.APPROVED && item.product.sellerId === campaign.store.sellerId && item.product.inventory && item.product.inventory.quantity > 0 && item.product.category?.status === 'ACTIVE' && categoryIds.includes(item.product.category.id));
      if (matchingProducts.length) eligible.push({ campaign, products: matchingProducts });
    }
    const rankedItems = eligible.flatMap(({ campaign, products: campaignProducts }) => campaignProducts.map(({ product }) => ({
      campaignId: campaign.id,
      categoryId: product.category!.id,
      product: { id: product.id, slug: product.slug, name: product.name, description: product.description, priceMinor: product.priceMinor, salePriceMinor: product.salePriceMinor, currency: product.currency, availableStock: product.inventory?.quantity ?? 0, category: product.category?.name ?? null, image: product.images[0] ?? null },
      store: { id: campaign.store.id, name: campaign.store.name, slug: campaign.store.slug }, placement: 'ORGANIC', reason: `Based on interest in ${product.category?.name ?? 'this category'}`
    }))).sort((left, right) => (scoreByCategory.get(right.categoryId) ?? 0) - (scoreByCategory.get(left.categoryId) ?? 0) || left.campaignId.localeCompare(right.campaignId) || left.product.id.localeCompare(right.product.id));
    const visibleItems = rankedItems.slice(0, 12);
    const byCampaign = new Map<string, number>();
    for (const item of visibleItems) byCampaign.set(item.campaignId, (byCampaign.get(item.campaignId) ?? 0) + 1);
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const impressionTokens = visibleItems.map(() => crypto.randomBytes(32).toString('base64url'));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.$transaction(async tx => {
      for (const [campaignId, impressions] of byCampaign) await tx.storeBusterDailyMetric.upsert({ where: { campaignId_day: { campaignId, day } }, create: { campaignId, day, impressions, clicks: 0 }, update: { impressions: { increment: impressions } } });
      if (visibleItems.length) await tx.storeBusterImpression.createMany({ data: visibleItems.map((item, index) => ({ campaignId: item.campaignId, tokenHash: crypto.createHash('sha256').update(`${user.id}:${impressionTokens[index]}`).digest('hex'), day, expiresAt })) });
    });
    const items = visibleItems.map(({ categoryId: _categoryId, ...item }, index) => ({ ...item, impressionToken: impressionTokens[index] }));
    res.json({ personalized: true, items, message: 'Recommendations use explainable first-party category and product-interest signals. No individual history is visible to stores.' });
  }));

  app.get('/api/store-buster/sponsored', requireAuth, requireRole(Role.BUYER, Role.SELLER), run(async (_req, res) => {
    const user = actor(res);
    const [settings, billing] = await Promise.all([prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }), sponsoredBillingStatus()]);
    if (!env.STORE_BUSTER_SPONSORED_AVAILABLE || !billing.available || !settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired || (settings.pricePerClickMinor <= 0 && settings.pricePer100ViewsMinor <= 0) || settings.maxMonthlyBudgetMinor <= 0) return res.json({ items: [] });
    const now = new Date(); const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0); const today = utcDay(now);
    const address = await prisma.savedAddress.findFirst({ where: { userId: user.id, isDefault: true }, select: { country: true } });
    const userCountry = address ? countryCodeForAddress(address.country) : null;
    const campaigns = await prisma.storeBusterCampaign.findMany({
      where: { sponsored: true, status: StoreBusterCampaignStatus.APPROVED, monthlyBudgetMinor: { gt: 0 }, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }], store: { seller: { status: SellerStatus.APPROVED }, ...(user.sellerId ? { sellerId: { not: user.sellerId } } : {}) } },
      include: {
        store: { include: { seller: { select: { status: true } } } },
        metrics: { where: { day: { gte: monthStart } }, select: { spendMinor: true } },
        creatives: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, scanStatus: true, uploadStatus: true } } } },
        products: { include: { product: { select: {
          id: true, slug: true, name: true, description: true, priceMinor: true, salePriceMinor: true,
          currency: true, sellerId: true, status: true, categoryId: true,
          category: { select: { id: true, name: true, status: true } },
          inventory: { select: { quantity: true } }, images: { take: 1, select: { url: true, alt: true } }
        } } } }
      },
      orderBy: { updatedAt: 'asc' }, take: 200
    });
    const storeSpendRows = await prisma.$queryRaw<{ storeId: string; spendMinor: bigint }[]>`
      SELECT c."storeId", COALESCE(SUM(m."spendMinor"), 0) AS "spendMinor"
      FROM "StoreBusterDailyMetric" m
      JOIN "StoreBusterCampaign" c ON c."id" = m."campaignId"
      WHERE c."sponsored" = TRUE AND m."day" >= ${monthStart}
      GROUP BY c."storeId"
    `;
    const monthlySpendByStore = new Map(storeSpendRows.map(row => [row.storeId, Number.isSafeInteger(Number(row.spendMinor)) ? Number(row.spendMinor) : Number.MAX_SAFE_INTEGER]));
    const eligible: { campaign: (typeof campaigns)[number]; product: NonNullable<(typeof campaigns)[number]['products'][number]['product']>; store: (typeof campaigns)[number]['store'] }[] = [];
    const selectedStoreIds = new Set<string>();
    for (const campaign of campaigns) {
      if (selectedStoreIds.has(campaign.store.id)) continue;
      if (campaign.audience && campaign.audience !== 'BOTH' && campaign.audience !== (user.role === Role.BUYER ? 'BUYERS' : 'SELLERS')) continue;
      if (campaign.targetCountryCodes.length && (!userCountry || !campaign.targetCountryCodes.includes(userCountry))) continue;
      const account = await prisma.storeBusterAdAccount.findUnique({ where: { storeId: campaign.store.id }, select: { availableMinor: true, status: true, currency: true } });
      if (!account || account.status !== 'ACTIVE' || account.currency !== env.CURRENCY || account.availableMinor < 1) continue;
      const spent = campaign.metrics.reduce((sum, metric) => sum + metric.spendMinor, 0);
      const campaignRate = campaign.billingModel === 'CPV' ? campaign.pricePer100ViewsSnapshot ?? settings.pricePer100ViewsMinor : campaign.pricePerClickSnapshot ?? settings.pricePerClickMinor;
      const [todaySpend, lifetimeSpend] = await Promise.all([
        prisma.storeBusterDailyMetric.findUnique({ where: { campaignId_day: { campaignId: campaign.id, day: today } }, select: { spendMinor: true } }),
        prisma.storeBusterDailyMetric.aggregate({ where: { campaignId: campaign.id }, _sum: { spendMinor: true } }),
      ]);
      const campaignSpentLifetime = lifetimeSpend._sum.spendMinor ?? 0;
      const campaignSpentToday = todaySpend?.spendMinor ?? 0;
      const storeMonthlyCap = settings.maxMonthlyBudgetMinor;
      if (campaign.billingModel === 'CPV') {
        if (campaignRate <= 0 || campaignSpentLifetime >= (campaign.lifetimeBudgetMinor ?? campaign.monthlyBudgetMinor) || campaignSpentToday >= (campaign.dailyBudgetMinor ?? campaign.monthlyBudgetMinor) || spent >= campaign.monthlyBudgetMinor || (monthlySpendByStore.get(campaign.store.id) ?? 0) >= storeMonthlyCap) continue;
      } else {
        const spend = calculateSponsoredClickSpend({ availableMinor: account.availableMinor, clickPriceMinor: campaignRate, campaignSpentThisMonthMinor: spent, campaignSpentTodayMinor: campaignSpentToday, campaignDailyBudgetMinor: campaign.dailyBudgetMinor ?? undefined, campaignSpentLifetimeMinor: campaignSpentLifetime, campaignLifetimeBudgetMinor: campaign.lifetimeBudgetMinor ?? undefined, storeSpentThisMonthMinor: monthlySpendByStore.get(campaign.store.id) ?? 0, campaignBudgetMinor: campaign.monthlyBudgetMinor, platformBudgetCapMinor: storeMonthlyCap });
        if (!spend) continue;
      }
      const product = campaign.products.map(item => item.product).find(item => item.status === ProductStatus.APPROVED && item.sellerId === campaign.store.sellerId && item.inventory && item.inventory.quantity > 0 && item.category?.status === 'ACTIVE' && (!campaign.audienceCategoryIds.length || (item.categoryId && campaign.audienceCategoryIds.includes(item.categoryId))));
      if (product && campaign.creatives.some(item => item.mediaAsset.scanStatus === 'APPROVED' && item.mediaAsset.uploadStatus === 'COMPLETE' && ['IMAGE', 'VIDEO'].includes(item.mediaAsset.kind))) { eligible.push({ campaign, product, store: campaign.store }); selectedStoreIds.add(campaign.store.id); }
    }
    const visible = eligible.slice(0, 8);
    const tokens = visible.map(() => crypto.randomBytes(32).toString('base64url'));
    const day = today; const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const impressions = visible.map((item, index) => ({ campaignId: item.campaign.id, productId: item.product.id, tokenHash: crypto.createHash('sha256').update(`${user.id}:${tokens[index]}`).digest('hex'), viewerDayKey: crypto.createHash('sha256').update(`${user.id}:${item.campaign.id}:${day.toISOString().slice(0, 10)}`).digest('hex'), day, expiresAt }));
    if (impressions.length) await prisma.$transaction(async tx => {
      await tx.storeBusterImpression.updateMany({ where: { viewerDayKey: { in: impressions.map(item => item.viewerDayKey) }, shownAt: null, expiresAt: { lte: now } }, data: { viewerDayKey: null } });
      await tx.storeBusterImpression.createMany({ data: impressions, skipDuplicates: true });
    });
    const billableTokenHashes = new Set(impressions.length ? (await prisma.storeBusterImpression.findMany({ where: { tokenHash: { in: impressions.map(item => item.tokenHash) } }, select: { tokenHash: true } })).map(item => item.tokenHash) : []);
    const delivered = visible.flatMap((item, index) => {
      const impression = impressions[index]; const token = tokens[index];
      return impression && token && billableTokenHashes.has(impression.tokenHash) ? [{ item, token }] : [];
    });
    res.json({ items: delivered.map(({ item, token }) => ({ campaignId: item.campaign.id, impressionToken: token, billingModel: item.campaign.billingModel ?? 'CPC', pricePerClickMinor: item.campaign.pricePerClickSnapshot ?? settings.pricePerClickMinor, pricePer100ViewsMinor: item.campaign.pricePer100ViewsSnapshot ?? settings.pricePer100ViewsMinor, headline: item.campaign.headline ?? item.product.name, adDescription: item.campaign.adDescription ?? item.product.description, creatives: item.campaign.creatives.filter(creative => creative.mediaAsset.scanStatus === 'APPROVED' && creative.mediaAsset.uploadStatus === 'COMPLETE').map(creative => ({ id: creative.mediaAsset.id, kind: creative.mediaAsset.kind, url: `/content-media/${encodeURIComponent(creative.mediaAsset.id)}` })), product: { id: item.product.id, slug: item.product.slug, name: item.product.name, description: item.product.description, priceMinor: item.product.priceMinor, salePriceMinor: item.product.salePriceMinor, currency: item.product.currency, availableStock: item.product.inventory?.quantity ?? 0, category: item.product.category?.name ?? null, image: item.product.images[0] ?? null }, store: { id: item.store.id, name: item.store.name, slug: item.store.slug } })) });
  }));

  app.post('/api/store-buster/sponsored/:id/impression', requireAuth, requireRole(Role.BUYER, Role.SELLER), run(async (req, res) => {
    const user = actor(res); const campaignId = param(req.params.id);
    const input = z.object({ impressionToken: z.string().min(32).max(128) }).strict().parse(req.body);
    const [settings, billing] = await Promise.all([prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }), sponsoredBillingStatus()]);
    if (!env.STORE_BUSTER_SPONSORED_AVAILABLE || !billing.available || !settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired) return res.status(409).json({ error: 'Sponsored placements are currently unavailable.' });
    const tokenHash = crypto.createHash('sha256').update(`${user.id}:${input.impressionToken}`).digest('hex'); const now = new Date();
    const impression = await prisma.storeBusterImpression.findFirst({
      where: {
        campaignId,
        tokenHash,
        shownAt: null,
        expiresAt: { gt: now },
        campaign: {
          status: 'APPROVED',
          sponsored: true,
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
          AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
          store: { ...(user.sellerId ? { sellerId: { not: user.sellerId } } : {}) },
        },
      },
    });
    if (!impression) return res.status(409).json({ error: 'This sponsored impression is invalid, expired, or already counted.' });
    const result = await settleStoreBusterImpression({ campaignId, impressionId: impression.id, userId: user.id, now });
    if (!result.counted) return res.status(409).json({ error: 'This sponsored impression is no longer eligible or its campaign has reached a spending limit.' });
    res.json({ counted: true, chargedMinor: result.chargedMinor });
  }));

  app.post('/api/store-buster/sponsored/:id/click', requireAuth, requireRole(Role.BUYER, Role.SELLER), run(async (req, res) => {
    const user = actor(res); const campaignId = param(req.params.id);
    const input = z.object({ impressionToken: z.string().min(32).max(128), productId: z.string().min(1).max(80) }).strict().parse(req.body);
    const [settings, billing] = await Promise.all([prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }), sponsoredBillingStatus()]);
    if (!env.STORE_BUSTER_SPONSORED_AVAILABLE || !billing.available || !settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired) return res.status(409).json({ error: 'Sponsored placements are currently unavailable.' });
    const tokenHash = crypto.createHash('sha256').update(`${user.id}:${input.impressionToken}`).digest('hex');
    const impression = await prisma.storeBusterImpression.findFirst({ where: { campaignId, productId: input.productId, tokenHash, clickedAt: null, expiresAt: { gt: new Date() }, campaign: { status: 'APPROVED', sponsored: true, store: { ...(user.sellerId ? { sellerId: { not: user.sellerId } } : {}) } } }, select: { id: true, day: true, shownAt: true } });
    if (!impression) return res.status(409).json({ error: 'This sponsored click is invalid, expired, or already counted.' });
    if (!impression.shownAt) {
      await prisma.$transaction(async tx => {
        const now = new Date();
        const shown = await tx.storeBusterImpression.updateMany({ where: { id: impression.id, shownAt: null, clickedAt: null, expiresAt: { gt: now } }, data: { shownAt: now } });
        if (shown.count) await tx.storeBusterDailyMetric.upsert({ where: { campaignId_day: { campaignId, day: impression.day } }, create: { campaignId, day: impression.day, impressions: 1, clicks: 0 }, update: { impressions: { increment: 1 } } });
      });
    }
    const result = await settleStoreBusterClick({ campaignId, impressionId: impression.id, userId: user.id });
    res.json({ counted: result.counted, destination: `/products/${encodeURIComponent(result.destinationProductId ?? input.productId)}` });
  }));

  app.get('/api/seller/store-buster', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId);
    const [settings, campaigns, count, billing] = await Promise.all([
      prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }),
      prisma.storeBusterCampaign.findMany({ where: { storeId: store.id }, include: { products: { include: { product: { select: { id: true, name: true, status: true } } } }, creatives: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true } } } }, metrics: { orderBy: { day: 'desc' }, take: 90 } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.storeBusterCampaign.count({ where: { storeId: store.id, status: { in: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PAUSED'] } } }), sponsoredBillingStatus()
    ]);
    const account = await prisma.storeBusterAdAccount.upsert({ where: { storeId: store.id }, create: { storeId: store.id, currency: env.CURRENCY }, update: {} });
    const [ledger, fundings, exponent] = await Promise.all([
      prisma.storeBusterAdLedgerEntry.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, type: true, amountMinor: true, balanceAfterMinor: true, currency: true, createdAt: true, campaign: { select: { name: true } } } }),
      prisma.storeBusterAdFundingIntent.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, amountMinor: true, currency: true, provider: true, status: true, createdAt: true, paidAt: true } }),
      currencyExponent(env.CURRENCY).catch(() => null)
    ]);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const monthlySpend = await prisma.storeBusterDailyMetric.aggregate({ where: { campaign: { storeId: store.id, sponsored: true }, day: { gte: monthStart } }, _sum: { spendMinor: true } });
    const sponsoredAvailable = billing.available && Boolean(settings?.enabled && settings.sponsoredEnabled && settings.moderationRequired && (settings.pricePerClickMinor > 0 || settings.pricePer100ViewsMinor > 0) && settings.maxMonthlyBudgetMinor > 0 && settings.maxCampaignsPerStore > 0);
    const scale = exponent == null ? 100 : 10 ** exponent;
    const [budgetCurrencies, usd] = await Promise.all([storeAdBudgetCurrencies(), prisma.currencyCatalogEntry.findFirst({ where: { code: 'USD', active: true }, select: { minorUnitExponent: true } })]);
    const countries = [...isoCountryCodes].sort().map(code => ({ code, name: countryDisplayNames.of(code) ?? code }));
    res.json({ store, enabledForPlan: true, available: Boolean(settings?.enabled), sponsoredAvailable, campaignLimit: settings?.maxCampaignsPerStore ?? 0, campaignCount: count, monthlyBudgetCapMinor: settings?.maxMonthlyBudgetMinor ?? 0, monthlySpendMinor: monthlySpend._sum.spendMinor ?? 0, pricePerClickMinor: settings?.pricePerClickMinor ?? 0, pricePer100ViewsMinor: settings?.pricePer100ViewsMinor ?? 0, minimumCampaignUsdMinor: settings?.minimumCampaignUsdMinor ?? 1000, usdMinorUnitExponent: usd?.minorUnitExponent ?? 2, maxCampaignDurationDays: settings?.maxCampaignDurationDays ?? 30, budgetCurrencies, countries, sponsoredProviders: billing.providers.map(item => item.method), currency: env.CURRENCY, minorUnitExponent: exponent, adBalance: { availableMinor: account.availableMinor, status: account.status, ledger, fundingIntents: fundings }, minFundingMinor: 5 * scale, maxFundingMinor: 5000 * scale, campaigns, message: sponsoredAvailable ? 'Paid ads are available to every approved Store regardless of plan after prepayment and review. CPC charges a verified click; CPV charges qualified card views by the configured rate per 100.' : 'Paid ads require the deployment and admin gates, enabled payment/webhook, moderation, and a configured CPC or CPV rate. Organic recommendations remain separate.' });
  }));

  app.post('/api/seller/store-buster/ads/estimate', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const input = z.object({ dailyBudgetMinor: z.number().int().positive().max(2_000_000_000), durationDays: z.number().int().min(1).max(365), budgetCurrency: z.string().length(3).transform(value => value.toUpperCase()) }).strict().parse(req.body);
    const store = await sellerStore(user.sellerId);
    const settings = await prisma.storeBusterSettings.findUnique({ where: { id: 'default' } });
    if (!settings?.enabled || !settings.sponsoredEnabled) throw fail(409, 'Paid ads are not available under current platform settings.');
    const estimate = await resolveAdBudget(input, settings);
    const monthlyCap = settings.maxMonthlyBudgetMinor;
    const account = await prisma.storeBusterAdAccount.findUnique({ where: { storeId: store.id }, select: { availableMinor: true } });
    res.json({ ...estimate, monthlyBudgetCapMinor: monthlyCap, withinMonthlyCap: estimate.monthlyBudgetBaseMinor <= monthlyCap, budgetFitsBalance: estimate.lifetimeBudgetBaseMinor <= (account?.availableMinor ?? 0) });
  }));

  app.post('/api/seller/store-buster/ad-funding', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const input = z.object({ provider: z.enum(['STRIPE', 'PAYPAL']), amountMinor: z.number().int().positive().max(50_000_000) }).strict().parse(req.body);
    const store = await sellerStore(user.sellerId);
    const [settings, billing, exponent, paymentMethod, account, checkoutUser] = await Promise.all([
      prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }), sponsoredBillingStatus(), currencyExponent(env.CURRENCY),
      prisma.paymentMethodSettings.findUnique({ where: { method: input.provider as PaymentMethod } }),
      prisma.storeBusterAdAccount.upsert({ where: { storeId: store.id }, create: { storeId: store.id, currency: env.CURRENCY }, update: {} }),
      prisma.user.findUnique({ where: { id: user.id }, select: { email: true, emailVerifiedAt: true } })
    ]);
    const minMinor = 5 * (10 ** exponent); const maxMinor = 5000 * (10 ** exponent);
    if (!settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired || (settings.pricePerClickMinor <= 0 && settings.pricePer100ViewsMinor <= 0) || settings.maxMonthlyBudgetMinor <= 0 || !env.STORE_BUSTER_SPONSORED_AVAILABLE) throw fail(409, 'Sponsored placements are disabled by platform policy, pricing, or deployment gate.');
    if (!billing.providers.some(item => item.method === input.provider) || !paymentMethod?.enabled) throw fail(409, `${input.provider} is not configured and enabled for marketplace payments.`);
    const activationBlock = await livePaymentActivationBlock(input.provider === 'STRIPE' ? PaymentMethod.STRIPE : PaymentMethod.PAYPAL);
    if (activationBlock) throw fail(503, activationBlock.error, { code: activationBlock.code });
    if (input.amountMinor < minMinor || input.amountMinor > maxMinor) throw fail(400, `Top-ups must be between ${minMinor} and ${maxMinor} minor currency units.`);
    if (account.currency !== env.CURRENCY || account.status !== StoreBusterAdAccountStatus.ACTIVE) throw fail(409, 'This advertising balance is unavailable or frozen. Contact marketplace support.');
    if (!checkoutUser?.email || !checkoutUser.emailVerifiedAt) throw fail(409, 'Verify your account email before funding an advertising balance.');
    const intent = await prisma.storeBusterAdFundingIntent.create({ data: { accountId: account.id, createdById: user.id, amountMinor: input.amountMinor, currency: env.CURRENCY, provider: input.provider, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    try {
      if (input.provider === 'STRIPE') {
        if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw fail(503, 'Stripe checkout and webhook reconciliation are not configured.');
        const session = await createStripeStoreBusterCheckout({ fundingIntentId: intent.id, amountMinor: intent.amountMinor, currency: intent.currency, buyerEmail: checkoutUser.email }, `${env.WEB_ORIGIN}/seller/growth?adFunding=success&intentId=${encodeURIComponent(intent.id)}&session_id={CHECKOUT_SESSION_ID}`, `${env.WEB_ORIGIN}/seller/growth?adFunding=cancelled&intentId=${encodeURIComponent(intent.id)}`);
        await prisma.storeBusterAdFundingIntent.update({ where: { id: intent.id }, data: { providerCheckoutRef: session.id } });
        return res.status(201).json({ fundingIntentId: intent.id, provider: input.provider, checkoutUrl: session.url, status: 'PENDING' });
      }
      const paypalOrder = await createPaypalStoreBusterOrder({ fundingIntentId: intent.id, amountDecimal: minorToDecimal(intent.amountMinor, exponent), currency: intent.currency, returnUrl: `${env.WEB_ORIGIN}/seller/growth?adFunding=paypal&intentId=${encodeURIComponent(intent.id)}`, cancelUrl: `${env.WEB_ORIGIN}/seller/growth?adFunding=cancelled&intentId=${encodeURIComponent(intent.id)}` });
      const approvalUrl = paypalOrder.links?.find(link => link.rel === 'approve')?.href;
      if (!paypalOrder.id || !approvalUrl) throw new Error('PayPal did not return an approval URL.');
      await prisma.storeBusterAdFundingIntent.update({ where: { id: intent.id }, data: { providerOrderRef: paypalOrder.id } });
      return res.status(201).json({ fundingIntentId: intent.id, provider: input.provider, approvalUrl, status: 'PENDING' });
    } catch (error) {
      await prisma.storeBusterAdFundingIntent.updateMany({ where: { id: intent.id, status: 'PENDING' }, data: { status: 'FAILED' } });
      if ((error as { statusCode?: number }).statusCode) throw error;
      throw fail(502, error instanceof Error ? error.message : 'Advertising-balance checkout could not be started.');
    }
  }));

  app.post('/api/seller/store-buster/ad-funding/:id/paypal-capture', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId); const id = param(req.params.id);
    const input = z.object({ providerOrderId: z.string().min(4).max(120) }).strict().parse(req.body);
    const intent = await prisma.storeBusterAdFundingIntent.findFirst({ where: { id, provider: 'PAYPAL', account: { storeId: store.id } } });
    if (!intent || !intent.providerOrderRef || intent.providerOrderRef !== input.providerOrderId) throw fail(404, 'PayPal funding session not found.');
    if (intent.status === 'PAID') return res.json({ ok: true, status: 'PAID', alreadyPaid: true });
    if (intent.status !== 'PENDING') throw fail(409, 'This PayPal funding session is no longer pending.');
    const captured = await capturePaypalOrder(intent.providerOrderRef, `store-buster-capture-${intent.id}`);
    const unit = captured.purchase_units?.length === 1 ? captured.purchase_units[0] : null;
    const capture = unit?.payments?.captures?.length === 1 ? unit.payments.captures[0] : null;
    const amount = capture?.amount;
    const exponent = await currencyExponent(intent.currency);
    const amountMinor = amount?.value ? (() => { try { return decimalToMinorExact(amount.value, exponent); } catch { return null; } })() : null;
    const customIdMatches = unit?.custom_id === `store-buster-ad:${intent.id}` && unit?.reference_id === `store-buster-ad:${intent.id}`;
    const settlement = await settleStoreBusterFunding({ provider: 'PAYPAL', eventId: `api-capture:${capture?.id ?? intent.providerOrderRef}`, eventType: 'PAYMENT.CAPTURE.COMPLETED', fundingIntentId: intent.id, providerOrderRef: intent.providerOrderRef, providerPaymentRef: capture?.id, amountMinor, currency: amount?.currency_code ?? null, captureConfirmed: captured.status === 'COMPLETED' && capture?.status === 'COMPLETED' && customIdMatches });
    if (settlement.reconciliation === 'REVIEW_REQUIRED') return res.status(202).json({ ok: false, status: 'REVIEW', message: 'Payment was received but needs marketplace reconciliation before ad credit is available.' });
    res.json({ ok: true, status: 'PAID', alreadyPaid: settlement.reconciliation === 'DUPLICATE' });
  }));

  app.post('/api/seller/store-buster/campaigns', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId); const input = campaignSchema.parse(req.body);
    const budget = input.sponsored ? await resolveAdBudget({ dailyBudgetMinor: input.dailyBudgetMinor!, durationDays: input.durationDays!, budgetCurrency: input.budgetCurrency! }, await prisma.storeBusterSettings.findUniqueOrThrow({ where: { id: 'default' }, select: { minimumCampaignUsdMinor: true, maxCampaignDurationDays: true } })) : null;
    if (budget && !budget.eligible) throw fail(400, `The total campaign budget must be at least ${minorToDecimal(budget.minimumCampaignUsdMinor, (await prisma.currencyCatalogEntry.findUniqueOrThrow({ where: { code: 'USD' }, select: { minorUnitExponent: true } })).minorUnitExponent)} USD or its current equivalent.`);
    const campaign = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const settings = await tx.storeBusterSettings.findUnique({ where: { id: 'default' } });
      if (!settings?.enabled) throw fail(503, 'Store Buster is currently unavailable by platform policy.');
      if (input.targetCountryCodes.some(code => !isoCountryCodes.has(code))) throw fail(400, 'Choose target countries from the ISO country list.');
      const limit = settings.maxCampaignsPerStore;
      if (limit <= 0) throw fail(409, 'Campaign creation is currently disabled by the platform administrator.');
      const count = await tx.storeBusterCampaign.count({ where: { storeId: store.id, status: { in: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PAUSED'] } } });
      if (count >= limit) throw fail(409, 'Your Store has reached the platform campaign limit.', { code: 'PLATFORM_LIMIT_REACHED', usage: count, limit });
      const products = await tx.product.findMany({ where: { id: { in: input.productIds }, sellerId: user.sellerId, status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } } }, select: { id: true, categoryId: true } });
      if (products.length !== input.productIds.length) throw fail(400, 'Every campaign product must be approved, in stock, and owned by your Store.');
      if (input.audienceCategoryIds.length && await tx.category.count({ where: { id: { in: input.audienceCategoryIds }, status: 'ACTIVE' } }) !== new Set(input.audienceCategoryIds).size) throw fail(400, 'Choose only active audience interests.');
      if (input.sponsored && input.audienceCategoryIds.length && !products.some(product => product.categoryId && input.audienceCategoryIds.includes(product.categoryId))) throw fail(400, 'At least one selected product must match the chosen sponsored category audience.');
      if (input.sponsored) {
        const billing = await sponsoredBillingStatus();
        const selectedRate = input.billingModel === 'CPC' ? settings.pricePerClickMinor : settings.pricePer100ViewsMinor;
        if (!billing.available || !settings.sponsoredEnabled || !settings.moderationRequired || selectedRate <= 0) throw fail(409, 'This ad billing model is not configured or payment and review safeguards are not ready.');
        if (!budget || budget.monthlyBudgetBaseMinor > settings.maxMonthlyBudgetMinor) throw fail(400, 'Campaign monthly budget exceeds the platform cap.');
        const approvedAssets = await tx.mediaAsset.findMany({ where: { id: { in: input.creativeAssetIds }, storeId: store.id, purpose: 'STORE_MEDIA', uploadStatus: 'COMPLETE', scanStatus: 'APPROVED', kind: { in: ['IMAGE', 'VIDEO'] } }, select: { id: true, kind: true } });
        if (approvedAssets.length !== input.creativeAssetIds.length || approvedAssets.filter(asset => asset.kind === 'IMAGE').length > 3 || approvedAssets.filter(asset => asset.kind === 'VIDEO').length > 1 || !approvedAssets.length) throw fail(400, 'Ads need 1–3 of your scanned images and may include at most one scanned video.');
        const adAccount = await tx.storeBusterAdAccount.findUnique({ where: { storeId: store.id } });
        if (!adAccount || adAccount.currency !== env.CURRENCY || adAccount.status !== StoreBusterAdAccountStatus.ACTIVE || adAccount.availableMinor < budget.lifetimeBudgetBaseMinor) throw fail(409, 'Your active prepaid ad balance must cover this campaign’s total budget in platform currency.');
      } else if (input.monthlyBudgetMinor !== 0) throw fail(400, 'Organic campaigns do not use advertising credit.');
      const created = await tx.storeBusterCampaign.create({ data: { storeId: store.id, name: input.name, goal: input.goal, sponsored: input.sponsored, monthlyBudgetMinor: budget?.monthlyBudgetBaseMinor ?? input.monthlyBudgetMinor, ...(budget ? { headline: input.headline!, adDescription: input.adDescription!, billingModel: input.billingModel!, audience: input.audience!, targetCountryCodes: input.targetCountryCodes, durationDays: budget.durationDays, dailyBudgetMinor: budget.dailyBudgetBaseMinor, lifetimeBudgetMinor: budget.lifetimeBudgetBaseMinor, budgetCurrency: budget.budgetCurrency, budgetTotalMinor: budget.budgetTotalMinor, budgetFxRate: budget.budgetFxRate, pricePerClickSnapshot: input.billingModel === 'CPC' ? settings!.pricePerClickMinor : null, pricePer100ViewsSnapshot: input.billingModel === 'CPV' ? settings!.pricePer100ViewsMinor : null, creatives: { create: input.creativeAssetIds.map((mediaAssetId, position) => ({ mediaAssetId, position })) } } : {}), audienceCategoryIds: input.audienceCategoryIds, products: { create: products.map(product => ({ productId: product.id })) } } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_BUSTER_CAMPAIGN_CREATED', entity: 'StoreBusterCampaign', entityId: created.id, metadata: { storeId: store.id, goal: created.goal, sponsored: created.sponsored, monthlyBudgetMinor: created.monthlyBudgetMinor, budgetCurrency: created.budgetCurrency, budgetTotalMinor: created.budgetTotalMinor, billingModel: created.billingModel, audience: created.audience, targetCountryCodes: created.targetCountryCodes, durationDays: created.durationDays, productCount: products.length, creativeCount: input.creativeAssetIds.length } } });
      return created;
    });
    res.status(201).json(campaign);
  }));

  app.post('/api/seller/store-buster/campaigns/:id/submit', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId); const id = param(req.params.id);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const [settings, campaign] = await Promise.all([tx.storeBusterSettings.findUnique({ where: { id: 'default' } }), tx.storeBusterCampaign.findFirst({ where: { id, storeId: store.id }, include: { products: { include: { product: true } }, creatives: { include: { mediaAsset: true } } } })]);
      if (!campaign) throw fail(404, 'Campaign not found.');
      if (!['DRAFT', 'REJECTED'].includes(campaign.status)) throw fail(409, 'Only draft or rejected campaigns can be submitted for review.');
      if (!settings?.enabled) throw fail(409, 'Store Buster is unavailable under current platform settings.');
      if (campaign.sponsored) {
        const billing = await sponsoredBillingStatus();
        const adAccount = await tx.storeBusterAdAccount.findUnique({ where: { storeId: store.id } });
        const selectedRate = campaign.billingModel === 'CPV' ? campaign.pricePer100ViewsSnapshot : campaign.pricePerClickSnapshot;
        const spent = await tx.storeBusterDailyMetric.aggregate({ where: { campaignId: campaign.id }, _sum: { spendMinor: true } });
        const remaining = Math.max(0, (campaign.lifetimeBudgetMinor ?? campaign.monthlyBudgetMinor) - (spent._sum.spendMinor ?? 0));
        const validCreativeCount = campaign.creatives.filter(item => item.mediaAsset.storeId === store.id && item.mediaAsset.purpose === 'STORE_MEDIA' && item.mediaAsset.uploadStatus === 'COMPLETE' && item.mediaAsset.scanStatus === 'APPROVED' && ['IMAGE', 'VIDEO'].includes(item.mediaAsset.kind)).length;
        if (!billing.available || !settings.sponsoredEnabled || !settings.moderationRequired || !selectedRate || selectedRate <= 0 || !adAccount || adAccount.status !== 'ACTIVE' || adAccount.currency !== env.CURRENCY || adAccount.availableMinor < remaining || campaign.monthlyBudgetMinor <= 0 || campaign.monthlyBudgetMinor > settings.maxMonthlyBudgetMinor || !campaign.headline || !campaign.adDescription || !campaign.audience || !campaign.billingModel || !campaign.durationDays || !campaign.dailyBudgetMinor || !campaign.lifetimeBudgetMinor || campaign.targetCountryCodes.some(code => !isoCountryCodes.has(code)) || validCreativeCount !== campaign.creatives.length || !campaign.creatives.length) throw fail(409, 'Ad cannot be submitted: payment, media safety, copy, duration, audience, budget, or platform policy validation failed.');
      }
      if (!campaign.products.length || campaign.products.some(item => item.product.status !== ProductStatus.APPROVED || item.product.sellerId !== user.sellerId)) throw fail(409, 'Campaign products are no longer eligible.');
      const status = settings.moderationRequired ? StoreBusterCampaignStatus.PENDING_REVIEW : StoreBusterCampaignStatus.APPROVED;
      const startsAt = status === StoreBusterCampaignStatus.APPROVED ? new Date() : null;
      const updated = await tx.storeBusterCampaign.update({ where: { id }, data: { status, ...(startsAt && campaign.durationDays ? { startsAt, endsAt: new Date(startsAt.getTime() + campaign.durationDays * 86400000) } : {}) } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_BUSTER_CAMPAIGN_SUBMITTED', entity: 'StoreBusterCampaign', entityId: id, metadata: { status } } });
      return updated;
    });
    res.json(result);
  }));

  app.post('/api/store-buster/campaigns/:id/click', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const preference = await prisma.userPreference.findUnique({ where: { userId: user.id }, select: { personalizationEnabled: true, personalizationConsentAt: true } });
    if (!preference?.personalizationEnabled || !preference.personalizationConsentAt) return res.status(204).send();
    const input = z.object({ impressionToken: z.string().min(32).max(128) }).strict().parse(req.body);
    const tokenHash = crypto.createHash('sha256').update(`${user.id}:${input.impressionToken}`).digest('hex');
    const counted = await prisma.$transaction(async tx => {
      const campaign = await tx.storeBusterCampaign.findFirst({ where: { id: param(req.params.id), status: StoreBusterCampaignStatus.APPROVED, sponsored: false }, select: { id: true } });
      if (!campaign) return false;
      const impression = await tx.storeBusterImpression.findFirst({ where: { campaignId: campaign.id, tokenHash, clickedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, day: true } });
      if (!impression) return false;
      const claimed = await tx.storeBusterImpression.updateMany({ where: { id: impression.id, clickedAt: null, expiresAt: { gt: new Date() } }, data: { clickedAt: new Date() } });
      if (claimed.count !== 1) return false;
      const updatedMetric = await tx.$executeRaw`UPDATE "StoreBusterDailyMetric" SET "clicks" = "clicks" + 1 WHERE "campaignId" = ${campaign.id} AND "day" = ${impression.day} AND "clicks" < "impressions"`;
      if (updatedMetric !== 1) throw fail(409, 'This recommendation impression is no longer available to count.');
      return true;
    });
    if (!counted) return res.status(409).json({ error: 'This recommendation impression is invalid, expired, or already counted.' });
    res.status(204).send();
  }));

  app.get('/api/admin/store-buster/settings', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [settings, billing] = await Promise.all([prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }), sponsoredBillingStatus()]);
    res.json({ ...settings, sponsoredDeploymentGate: env.STORE_BUSTER_SPONSORED_AVAILABLE, sponsoredBillingAvailable: billing.available, sponsoredBillingProviders: billing.providers.map(item => item.method), currency: env.CURRENCY });
  }));
  app.patch('/api/admin/store-buster/settings', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res); const input = settingsSchema.parse(req.body);
    if (input.sponsoredEnabled && !env.STORE_BUSTER_SPONSORED_AVAILABLE) throw fail(409, 'Sponsored placements are disabled by the deployment hard gate.');
    const result = await prisma.$transaction(async tx => {
      const old = await tx.storeBusterSettings.findUnique({ where: { id: 'default' } });
      const updated = await tx.storeBusterSettings.update({ where: { id: 'default' }, data: { enabled: input.enabled, sponsoredEnabled: input.sponsoredEnabled, moderationRequired: input.moderationRequired, maxMonthlyBudgetMinor: input.maxMonthlyBudgetMinor, maxCampaignsPerStore: input.maxCampaignsPerStore, pricePerClickMinor: input.pricePerClickMinor, pricePer100ViewsMinor: input.pricePer100ViewsMinor, minimumCampaignUsdMinor: input.minimumCampaignUsdMinor, maxCampaignDurationDays: input.maxCampaignDurationDays, updatedById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_BUSTER_SETTINGS_CHANGED', entity: 'StoreBusterSettings', entityId: 'default', metadata: jsonInput({ old: { enabled: old?.enabled, sponsoredEnabled: old?.sponsoredEnabled, maxMonthlyBudgetMinor: old?.maxMonthlyBudgetMinor, maxCampaignsPerStore: old?.maxCampaignsPerStore, pricePerClickMinor: old?.pricePerClickMinor, pricePer100ViewsMinor: old?.pricePer100ViewsMinor, minimumCampaignUsdMinor: old?.minimumCampaignUsdMinor, maxCampaignDurationDays: old?.maxCampaignDurationDays }, new: { enabled: updated.enabled, sponsoredEnabled: updated.sponsoredEnabled, moderationRequired: updated.moderationRequired, maxMonthlyBudgetMinor: updated.maxMonthlyBudgetMinor, maxCampaignsPerStore: updated.maxCampaignsPerStore, pricePerClickMinor: updated.pricePerClickMinor, pricePer100ViewsMinor: updated.pricePer100ViewsMinor, minimumCampaignUsdMinor: updated.minimumCampaignUsdMinor, maxCampaignDurationDays: updated.maxCampaignDurationDays }, reason: input.reason }) } });
      return updated;
    });
    res.json({ ...result, sponsoredDeploymentGate: env.STORE_BUSTER_SPONSORED_AVAILABLE });
  }));
  app.get('/api/admin/store-buster/campaigns', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.storeBusterCampaign.findMany({ include: { store: { select: { id: true, name: true, slug: true } }, products: { include: { product: { select: { id: true, name: true, status: true } } } }, creatives: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, scanStatus: true, uploadStatus: true } } } }, metrics: { orderBy: { day: 'desc' }, take: 90 } }, orderBy: { updatedAt: 'desc' }, take: 200 }))));
  app.get('/api/admin/store-buster/funding', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [fundingIntents, accounts] = await Promise.all([
      prisma.storeBusterAdFundingIntent.findMany({ where: { status: { in: ['PENDING', 'REVIEW'] } }, include: { account: { include: { store: { select: { id: true, name: true, slug: true } } } }, createdBy: { select: { email: true } }, events: { orderBy: { createdAt: 'desc' }, take: 5 }, ledgerEntry: { select: { id: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.storeBusterAdAccount.findMany({ where: { status: StoreBusterAdAccountStatus.FROZEN }, include: { store: { select: { id: true, name: true } }, fundingIntents: { where: { status: 'REVIEW' }, select: { id: true, ledgerEntry: { select: { id: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 100 })
    ]);
    res.json({ fundingIntents, frozenAccounts: accounts });
  }));
  app.patch('/api/admin/store-buster/funding/:id/resolve', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res); const id = param(req.params.id);
    const input = z.object({ decision: z.enum(['CREDIT', 'VOID']), providerReference: z.string().trim().min(4).max(255).optional(), reason: z.string().trim().min(8).max(500) }).strict().parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdFundingIntent" WHERE "id" = ${id} FOR UPDATE`;
      const intent = await tx.storeBusterAdFundingIntent.findUnique({ where: { id }, include: { account: true } });
      if (!intent || intent.status !== 'REVIEW') throw fail(409, 'Only a funding intent in manual review can be resolved.');
      await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdAccount" WHERE "id" = ${intent.accountId} FOR UPDATE`;
      const current = await tx.storeBusterAdAccount.findUniqueOrThrow({ where: { id: intent.accountId } });
      const existingLedger = await tx.storeBusterAdLedgerEntry.findUnique({ where: { fundingIntentId: intent.id } });
      if (existingLedger) throw fail(409, 'This payment was already credited before a refund, reversal, or dispute. It cannot be credited or voided again; keep the account frozen and use the audited risk-release action only after finance reconciliation.');
      if (input.decision === 'CREDIT') {
        if (!input.providerReference || ![intent.providerOrderRef, intent.providerPaymentRef, intent.providerCheckoutRef].includes(input.providerReference)) throw fail(400, 'Enter the exact provider reference recorded for this funding intent after verifying capture in the provider dashboard.');
        const matchingEvent = await tx.storeBusterFundingEvent.findFirst({ where: { fundingIntentId: intent.id }, orderBy: { createdAt: 'desc' } });
        if (matchingEvent && (matchingEvent.amountMinor !== intent.amountMinor || matchingEvent.currency !== intent.currency)) throw fail(409, 'Provider amount/currency evidence differs from the intent; credit requires exact amount and currency reconciliation.');
        const balanceAfter = current.availableMinor + intent.amountMinor;
        if (balanceAfter > 2_147_483_647) throw fail(409, 'Funding would exceed the supported ad-balance ledger range.');
        await tx.storeBusterAdAccount.update({ where: { id: current.id }, data: { availableMinor: balanceAfter } });
        await tx.storeBusterAdLedgerEntry.create({ data: { accountId: current.id, fundingIntentId: intent.id, type: 'TOP_UP', amountMinor: intent.amountMinor, balanceAfterMinor: balanceAfter, currency: intent.currency, idempotencyKey: `funding:${intent.id}` } });
        await tx.storeBusterAdFundingIntent.update({ where: { id }, data: { status: 'PAID', paidAt: new Date() } });
      } else await tx.storeBusterAdFundingIntent.update({ where: { id }, data: { status: 'FAILED' } });
      await tx.auditLog.create({ data: { actorId: user.id, action: `STORE_BUSTER_FUNDING_${input.decision}_AFTER_REVIEW`, entity: 'StoreBusterAdFundingIntent', entityId: id, metadata: { reason: input.reason, providerReference: input.providerReference ?? null, amountMinor: intent.amountMinor, currency: intent.currency } } });
      return { id, status: input.decision === 'CREDIT' ? 'PAID' : 'FAILED', accountId: intent.accountId };
    });
    res.json(result);
  }));
  app.patch('/api/admin/store-buster/ad-accounts/:id/status', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res); const id = param(req.params.id);
    const input = z.object({ status: z.nativeEnum(StoreBusterAdAccountStatus), riskAcknowledgement: z.boolean().default(false), reason: z.string().trim().min(8).max(500) }).strict().parse(req.body);
    const account = await prisma.$transaction(async tx => {
      const reviewIds = input.status === StoreBusterAdAccountStatus.ACTIVE
        ? await tx.storeBusterAdFundingIntent.findMany({ where: { accountId: id, status: 'REVIEW' }, select: { id: true }, orderBy: { id: 'asc' } })
        : [];
      for (const review of reviewIds) await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdFundingIntent" WHERE "id" = ${review.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdAccount" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.storeBusterAdAccount.findUnique({ where: { id } }); if (!current) throw fail(404, 'Advertising account not found.');
      const reviews = input.status === StoreBusterAdAccountStatus.ACTIVE ? await tx.storeBusterAdFundingIntent.findMany({ where: { accountId: id, status: 'REVIEW' }, include: { ledgerEntry: { select: { id: true } } }, orderBy: { id: 'asc' } }) : [];
      if (reviews.some(intent => !intent.ledgerEntry)) throw fail(409, 'Resolve every uncredited funding review before restoring ad delivery.');
      if (reviews.length && !input.riskAcknowledgement) throw fail(409, 'A refunded/disputed top-up was already credited. Explicit finance-risk acknowledgement is required to reverse remaining ad credit and accept any already-spent loss.');
      let reversedMinor = 0;
      if (reviews.length) {
        if (current.availableMinor > 0) {
          reversedMinor = current.availableMinor;
          const reviewBatch = crypto.createHash('sha256').update(reviews.map(intent => intent.id).sort().join(':')).digest('hex').slice(0, 24);
          await tx.storeBusterAdLedgerEntry.create({ data: { accountId: id, type: 'REFUND_REVERSAL', amountMinor: -reversedMinor, balanceAfterMinor: 0, currency: current.currency, idempotencyKey: `risk-release:${current.id}:${reviewBatch}` } });
        }
        await tx.storeBusterAdAccount.update({ where: { id }, data: { availableMinor: 0 } });
        await tx.storeBusterAdFundingIntent.updateMany({ where: { id: { in: reviews.map(intent => intent.id) }, status: 'REVIEW' }, data: { status: 'FAILED' } });
      }
      const updated = await tx.storeBusterAdAccount.update({ where: { id }, data: { status: input.status } });
      await tx.auditLog.create({ data: { actorId: user.id, action: `STORE_BUSTER_AD_ACCOUNT_${input.status}`, entity: 'StoreBusterAdAccount', entityId: id, metadata: { reason: input.reason, previousStatus: current.status, balanceMinor: current.availableMinor, riskAcknowledgement: input.riskAcknowledgement, reversedAvailableCreditMinor: reversedMinor, riskReviewedFundingIntents: reviews.map(intent => intent.id) } } });
      return updated;
    });
    res.json({ id: account.id, status: account.status });
  }));
  app.patch('/api/admin/store-buster/campaigns/:id/review', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res); const input = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'PAUSED']), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const current = await prisma.storeBusterCampaign.findUnique({ where: { id: param(req.params.id) } }); if (!current) throw fail(404, 'Campaign not found.');
    const status = input.status as StoreBusterCampaignStatus;
    if (status === StoreBusterCampaignStatus.APPROVED && current.status !== StoreBusterCampaignStatus.PENDING_REVIEW && current.status !== StoreBusterCampaignStatus.PAUSED) throw fail(409, 'Only a pending or paused campaign can be approved or resumed.');
    if (status === StoreBusterCampaignStatus.REJECTED && current.status !== StoreBusterCampaignStatus.PENDING_REVIEW) throw fail(409, 'Only a pending campaign can be rejected.');
    if (status === StoreBusterCampaignStatus.PAUSED && current.status !== StoreBusterCampaignStatus.APPROVED) throw fail(409, 'Only an approved campaign can be paused.');
    const result = await prisma.$transaction(async tx => {
      if (status === StoreBusterCampaignStatus.APPROVED && current.sponsored) {
        const [settings, account, billing] = await Promise.all([tx.storeBusterSettings.findUnique({ where: { id: 'default' } }), tx.storeBusterAdAccount.findUnique({ where: { storeId: current.storeId } }), sponsoredBillingStatus()]);
        const selectedRate = current.billingModel === 'CPV' ? current.pricePer100ViewsSnapshot : current.pricePerClickSnapshot;
        const [spent, creativeCount] = await Promise.all([tx.storeBusterDailyMetric.aggregate({ where: { campaignId: current.id }, _sum: { spendMinor: true } }), tx.storeBusterCampaignCreative.count({ where: { campaignId: current.id, mediaAsset: { storeId: current.storeId, purpose: 'STORE_MEDIA', uploadStatus: 'COMPLETE', scanStatus: 'APPROVED', kind: { in: ['IMAGE', 'VIDEO'] } } } })]);
        const remaining = Math.max(0, (current.lifetimeBudgetMinor ?? current.monthlyBudgetMinor) - (spent._sum.spendMinor ?? 0));
        if (!env.STORE_BUSTER_SPONSORED_AVAILABLE || !billing.available || !settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired || !selectedRate || selectedRate <= 0 || !account || account.status !== 'ACTIVE' || account.currency !== env.CURRENCY || account.availableMinor < remaining || current.monthlyBudgetMinor <= 0 || current.monthlyBudgetMinor > settings.maxMonthlyBudgetMinor || !current.durationDays || !current.dailyBudgetMinor || !current.lifetimeBudgetMinor || !current.headline || !current.adDescription || !current.audience || creativeCount < 1 || creativeCount > 4 || current.targetCountryCodes.some(code => !isoCountryCodes.has(code))) throw fail(409, 'Paid campaign cannot be approved while payment, media, targeting, duration, moderation, budget, or prepaid-balance requirements are not met.');
        const [campaignStore, campaignProducts] = await Promise.all([tx.store.findUnique({ where: { id: current.storeId }, select: { sellerId: true } }), tx.storeBusterCampaignProduct.findMany({ where: { campaignId: current.id }, select: { productId: true } })]);
        const eligibleProducts = await tx.product.findMany({ where: { id: { in: campaignProducts.map(item => item.productId) }, sellerId: campaignStore?.sellerId ?? '__missing_store_owner__', status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } } }, select: { categoryId: true } });
        if (!eligibleProducts.length || (current.audienceCategoryIds.length && !eligibleProducts.some(product => product.categoryId && current.audienceCategoryIds.includes(product.categoryId)))) throw fail(409, 'Sponsored campaign has no approved, in-stock product matching its selected audience.');
      }
      const resumingPaused = status === StoreBusterCampaignStatus.APPROVED && current.status === StoreBusterCampaignStatus.PAUSED;
      if (resumingPaused && current.endsAt && current.endsAt <= new Date()) throw fail(409, 'This campaign reached its scheduled end date while paused and cannot be resumed. Create a new campaign to advertise again.');
      const startsAt = status === StoreBusterCampaignStatus.APPROVED && current.sponsored && (!resumingPaused || !current.endsAt) ? new Date() : null;
      const updated = await tx.storeBusterCampaign.update({ where: { id: current.id }, data: { status, moderationReason: input.reason, reviewedById: user.id, reviewedAt: new Date(), ...(startsAt && current.durationDays ? { startsAt, endsAt: new Date(startsAt.getTime() + current.durationDays * 86400000) } : {}) } });
      await tx.auditLog.create({ data: { actorId: user.id, action: `STORE_BUSTER_CAMPAIGN_${status}`, entity: 'StoreBusterCampaign', entityId: current.id, metadata: { reason: input.reason } } });
      return updated;
    });
    res.json(result);
  }));

  app.get('/api/seller/affiliate-program', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId);
    const [effective, program, settings] = await Promise.all([effectiveStorePlan(prisma, store.id), prisma.storeAffiliateProgram.findUnique({ where: { storeId: store.id } }), prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { affiliateEnabled: true } })]);
    const included = (await storeEntitlements(prisma, store.id, effective.version)).affiliateToolsEnabled;
    res.json({ included, enabled: program?.enabled ?? false, marketplaceProgramAvailable: settings?.affiliateEnabled ?? false, payoutRequestsAvailable: false, message: 'This setting controls whether affiliates may promote this Store through the existing platform program. It does not create seller commissions or seller payouts; no payout capability is enabled by this Store plan.' });
  }));
  app.patch('/api/seller/affiliate-program', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId);
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const entitlements = await storeEntitlements(tx, store.id);
      if (input.enabled && !entitlements.affiliateToolsEnabled) throw fail(409, 'Affiliate tools are not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'affiliateToolsEnabled', planUrl: '/seller/plan' });
      const settings = await tx.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { affiliateEnabled: true } });
      if (input.enabled && !settings?.affiliateEnabled) throw fail(409, 'The platform affiliate program is not currently accepting Store participation.');
      const current = await tx.storeAffiliateProgram.findUnique({ where: { storeId: store.id } });
      const program = await tx.storeAffiliateProgram.upsert({ where: { storeId: store.id }, create: { storeId: store.id, enabled: input.enabled }, update: { enabled: input.enabled } });
      await tx.auditLog.create({ data: { actorId: user.id, action: input.enabled ? 'STORE_AFFILIATE_PROGRAM_ENABLED' : 'STORE_AFFILIATE_PROGRAM_DISABLED', entity: 'StoreAffiliateProgram', entityId: program.id, metadata: { storeId: store.id, oldEnabled: current?.enabled ?? false, newEnabled: program.enabled } } });
      return program;
    });
    res.json(result);
  }));

  app.get('/api/seller/email-marketing', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId);
    const [effective, counts, subscribers, campaigns] = await Promise.all([
      effectiveStorePlan(prisma, store.id), prisma.storeEmailSubscriber.groupBy({ by: ['status'], where: { storeId: store.id }, _count: { _all: true } }),
      prisma.storeEmailSubscriber.findMany({ where: { storeId: store.id }, select: { id: true, email: true, status: true, consentRecordedAt: true, createdAt: true, suppressedAt: true, bouncedAt: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.storeEmailCampaign.findMany({ where: { storeId: store.id }, orderBy: { updatedAt: 'desc' }, take: 50 })
    ]);
    const entitlements = await storeEntitlements(prisma, store.id, effective.version);
    const provider = await storeEmailProviderStatusForStore(store.id);
    res.json({ enabledForPlan: entitlements.emailMarketingEnabled, deliveryAvailable: provider.enabled, deploymentGate: provider.deploymentGate, provider, subscriberLimit: entitlements.emailSubscriberLimit, monthlySendLimit: entitlements.emailMonthlySendLimit, counts: Object.fromEntries(counts.map(item => [item.status, item._count._all])), subscribers: subscribers.map(item => ({ ...item, emailMasked: maskSubscriberEmail(item.email), email: undefined })), campaigns, message: !entitlements.emailMarketingEnabled ? 'Email marketing is not included in this Store plan.' : provider.message });
  }));

  app.get('/api/stores/:slug/newsletter/status', run(async (req, res) => {
    const store = await prisma.store.findFirst({ where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } }, select: { id: true } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });
    const effective = await effectiveStorePlan(prisma, store.id);
    const entitlements = await storeEntitlements(prisma, store.id, effective.version);
    const provider = await storeEmailProviderStatusForStore(store.id);
    res.json({ available: entitlements.emailMarketingEnabled && provider.enabled, enabledForPlan: entitlements.emailMarketingEnabled, deliveryAvailable: provider.enabled, message: !entitlements.emailMarketingEnabled ? 'Store updates are not available for this Store plan.' : provider.message });
  }));

  app.post('/api/seller/email-campaigns', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId); const input = emailCampaignSchema.parse(req.body);
    const campaign = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const entitlements = await storeEntitlements(tx, store.id);
      if (!entitlements.emailMarketingEnabled) throw fail(409, 'Email marketing is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'emailMarketingEnabled', planUrl: '/seller/plan' });
      const created = await tx.storeEmailCampaign.create({ data: { storeId: store.id, name: input.name, subject: input.subject, contentJson: jsonInput(input.content), status: 'DRAFT' } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_EMAIL_CAMPAIGN_DRAFT_CREATED', entity: 'StoreEmailCampaign', entityId: created.id, metadata: { storeId: store.id } } });
      return created;
    });
    res.status(201).json({ ...campaign, deliveryAvailable: (await storeEmailProviderStatusForStore(store.id)).enabled, message: 'Campaign saved as a draft. Review its audience and content before queueing.' });
  }));
  app.post('/api/seller/email-campaigns/:id/send', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId);
    const campaignId = param(req.params.id);
    if (!(await storeEmailProviderStatusForStore(store.id)).enabled) throw fail(409, 'Email delivery is not configured and enabled for this Store.', { code: 'STORE_EMAIL_DELIVERY_UNAVAILABLE' });
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const effective = await effectiveStorePlan(tx, store.id);
      const entitlements = await storeEntitlements(tx, store.id, effective.version);
      if (!entitlements.emailMarketingEnabled) throw fail(409, 'Email marketing is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'emailMarketingEnabled', planUrl: '/seller/plan' });
      const campaign = await tx.storeEmailCampaign.findFirst({ where: { id: campaignId, storeId: store.id } });
      if (!campaign) throw fail(404, 'Email campaign not found.');
      if (campaign.status !== StoreEmailCampaignStatus.DRAFT) throw fail(409, 'Only a draft campaign can be queued.');
      const content = emailCampaignSchema.shape.content.parse(campaign.contentJson);
      const subject = emailCampaignSchema.shape.subject.parse(campaign.subject);
      const eligible = await tx.storeEmailSubscriber.findMany({ where: { storeId: store.id, status: StoreEmailSubscriberStatus.SUBSCRIBED, consentRecordedAt: { not: null } }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: entitlements.emailSubscriberLimit + 1 });
      if (eligible.length > entitlements.emailSubscriberLimit) throw fail(409, 'Subscriber count exceeds this plan\u2019s send limit.', { code: 'EMAIL_SUBSCRIBER_LIMIT', limit: entitlements.emailSubscriberLimit });
      if (!eligible.length) throw fail(409, 'There are no confirmed subscribers to receive this campaign.');
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const monthlyReserved = await tx.storeEmailDelivery.count({ where: { campaign: { storeId: store.id }, createdAt: { gte: monthStart }, status: { in: [StoreEmailDeliveryStatus.PENDING, StoreEmailDeliveryStatus.SENDING, StoreEmailDeliveryStatus.SENT, StoreEmailDeliveryStatus.FAILED] } } });
      if (monthlyReserved + eligible.length > entitlements.emailMonthlySendLimit) throw fail(409, 'Queueing this campaign would exceed the plan\u2019s monthly email-send limit.', { code: 'EMAIL_MONTHLY_SEND_LIMIT', usage: monthlyReserved, requested: eligible.length, limit: entitlements.emailMonthlySendLimit });
      await tx.storeEmailDelivery.createMany({ data: eligible.map(subscriber => ({ campaignId, subscriberId: subscriber.id })) });
      const queued = await tx.storeEmailCampaign.update({ where: { id: campaignId }, data: { status: StoreEmailCampaignStatus.QUEUED, recipientCount: eligible.length, queuedAt: new Date(), sentAt: null, sentCount: 0, failedCount: 0 } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_EMAIL_CAMPAIGN_QUEUED', entity: 'StoreEmailCampaign', entityId: campaignId, metadata: { storeId: store.id, recipientCount: eligible.length, subject, contentBlockCount: content.length } } });
      return queued;
    });
    res.json({ campaign: result, message: 'Campaign queued. Delivery is processed in small batches; unsubscribe and consent are checked again for every recipient.' });
  }));
  app.post('/api/seller/email-campaigns/:id/cancel', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId); const campaignId = param(req.params.id);
    const campaign = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const current = await tx.storeEmailCampaign.findFirst({ where: { id: campaignId, storeId: store.id } });
      if (!current) throw fail(404, 'Email campaign not found.');
      if (current.status !== StoreEmailCampaignStatus.DRAFT && current.status !== StoreEmailCampaignStatus.QUEUED) throw fail(409, 'This campaign can no longer be cancelled.');
      await tx.storeEmailDelivery.updateMany({ where: { campaignId, status: StoreEmailDeliveryStatus.PENDING }, data: { status: StoreEmailDeliveryStatus.SKIPPED } });
      const updated = await tx.storeEmailCampaign.update({ where: { id: campaignId }, data: { status: StoreEmailCampaignStatus.CANCELLED } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_EMAIL_CAMPAIGN_CANCELLED', entity: 'StoreEmailCampaign', entityId: campaignId, metadata: { storeId: store.id, priorStatus: current.status } } });
      return updated;
    });
    res.json({ campaign, message: 'Campaign cancelled. Already accepted SMTP deliveries cannot be recalled.' });
  }));
  app.post('/api/seller/email-subscribers/:id/suppress', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId);
    const input = z.object({ reason: z.string().trim().min(3).max(300) }).strict().parse(req.body);
    await prisma.$transaction(async tx => {
      const updated = await tx.storeEmailSubscriber.updateMany({ where: { id: param(req.params.id), storeId: store.id }, data: { status: StoreEmailSubscriberStatus.SUPPRESSED, suppressedAt: new Date(), suppressionReason: input.reason } });
      if (updated.count !== 1) throw fail(404, 'Subscriber not found.');
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_EMAIL_SUBSCRIBER_SUPPRESSED', entity: 'StoreEmailSubscriber', entityId: param(req.params.id), metadata: { storeId: store.id, reason: input.reason } } });
    });
    res.json({ suppressed: true });
  }));

  app.post('/api/stores/:slug/newsletter', run(async (req, res) => {
    const input = z.object({ email: z.string().trim().email().max(254), consent: z.literal(true), consentSource: z.string().trim().min(2).max(80) }).strict().parse(req.body);
    const store = await prisma.store.findFirst({ where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } }, select: { id: true, name: true } }); if (!store) return res.status(404).json({ error: 'Store not found.' });
    const effective = await effectiveStorePlan(prisma, store.id); const entitlements = await storeEntitlements(prisma, store.id, effective.version);
    if (!entitlements.emailMarketingEnabled) return res.status(409).json({ code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'emailMarketingEnabled', error: 'Email marketing is not enabled for this Store plan.' });
    if (!(await storeEmailProviderStatusForStore(store.id)).enabled) return res.status(503).json({ code: 'STORE_EMAIL_DELIVERY_UNAVAILABLE', error: 'Subscription confirmation is temporarily unavailable. Please try again later.' });
    const email = normalizeSubscriberEmail(input.email);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = new Date();
    let subscriberId: string | null = null;
    let shouldSend = false;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const existing = await tx.storeEmailSubscriber.findUnique({ where: { storeId_email: { storeId: store.id, email } } });
      if (existing?.status === StoreEmailSubscriberStatus.SUPPRESSED || existing?.status === StoreEmailSubscriberStatus.BOUNCED) return;
      if (existing?.status === StoreEmailSubscriberStatus.SUBSCRIBED) return;
      if (existing?.status === StoreEmailSubscriberStatus.PENDING_CONFIRMATION && existing.updatedAt.getTime() > now.getTime() - 60_000) return;
      const activeCount = await tx.storeEmailSubscriber.count({ where: { storeId: store.id, status: { in: [StoreEmailSubscriberStatus.PENDING_CONFIRMATION, StoreEmailSubscriberStatus.SUBSCRIBED] } } });
      const existingCountsTowardLimit = existing?.status === StoreEmailSubscriberStatus.PENDING_CONFIRMATION;
      if (!existingCountsTowardLimit && activeCount >= entitlements.emailSubscriberLimit) return;
      const subscriber = existing
        ? await tx.storeEmailSubscriber.update({ where: { id: existing.id }, data: { status: StoreEmailSubscriberStatus.PENDING_CONFIRMATION, consentRecordedAt: null, consentSource: input.consentSource, confirmationTokenHash: tokenHash, confirmationExpiresAt: new Date(now.getTime() + 48 * 60 * 60_000), unsubscribeTokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), suppressedAt: null, suppressionReason: null, bouncedAt: null } })
        : await tx.storeEmailSubscriber.create({ data: { storeId: store.id, email, status: StoreEmailSubscriberStatus.PENDING_CONFIRMATION, consentSource: input.consentSource, confirmationTokenHash: tokenHash, confirmationExpiresAt: new Date(now.getTime() + 48 * 60 * 60_000), unsubscribeTokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex') } });
      subscriberId = subscriber.id;
      shouldSend = true;
    });
    if (shouldSend && subscriberId) {
      try { await sendStoreEmailConfirmation({ to: email, storeId: store.id, storeName: store.name, token }); }
      catch (error) {
        const safe = error instanceof StoreEmailTransportError ? error : new StoreEmailTransportError('EMAIL_CONNECTION_FAILED');
        console.warn(`Store email confirmation delivery failed: ${safe.code}`);
      }
    }
    // Same response for known, pending, suppressed, bounced, and already subscribed addresses.
    res.status(202).json({ accepted: true, message: 'If eligible, a confirmation email will arrive shortly. Your subscription is not active until you confirm.' });
  }));

  app.post('/api/store-email/confirm/:token', run(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const token = param(req.params.token);
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw fail(400, 'Confirmation link is invalid or expired.');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const updated = await prisma.storeEmailSubscriber.updateMany({ where: { confirmationTokenHash: hash, status: StoreEmailSubscriberStatus.PENDING_CONFIRMATION, confirmationExpiresAt: { gt: new Date() } }, data: { status: StoreEmailSubscriberStatus.SUBSCRIBED, consentRecordedAt: new Date(), confirmationTokenHash: null, confirmationExpiresAt: null } });
    if (!updated.count) throw fail(400, 'Confirmation link is invalid, expired, or already used.');
    res.json({ confirmed: true, message: 'Your email subscription is confirmed.' });
  }));

  app.post('/api/store-email/unsubscribe/:token', run(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const token = param(req.params.token);
    const subscriberId = env.STORE_EMAIL_TOKEN_SECRET ? verifyUnsubscribeToken(token, env.STORE_EMAIL_TOKEN_SECRET) : null;
    if (subscriberId) {
      const subscriber = await prisma.storeEmailSubscriber.findUnique({ where: { id: subscriberId }, select: { id: true, status: true } });
      if (!subscriber) throw fail(404, 'Unsubscribe link is invalid.');
      if (subscriber.status !== StoreEmailSubscriberStatus.UNSUBSCRIBED) await prisma.storeEmailSubscriber.update({ where: { id: subscriberId }, data: { status: StoreEmailSubscriberStatus.UNSUBSCRIBED } });
      return res.json({ unsubscribed: true, message: 'You will no longer receive email updates from this Store.' });
    }
    // Compatibility for previously issued opaque tokens stored as a digest.
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const updated = await prisma.storeEmailSubscriber.updateMany({ where: { unsubscribeTokenHash: hash, status: { notIn: [StoreEmailSubscriberStatus.UNSUBSCRIBED, StoreEmailSubscriberStatus.SUPPRESSED, StoreEmailSubscriberStatus.BOUNCED] } }, data: { status: StoreEmailSubscriberStatus.UNSUBSCRIBED } });
    if (!updated.count) throw fail(404, 'Unsubscribe link is invalid or already used.');
    res.json({ unsubscribed: true, message: 'You will no longer receive email updates from this Store.' });
  }));
}
