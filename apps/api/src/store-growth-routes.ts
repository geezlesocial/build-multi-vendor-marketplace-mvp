import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, ProductStatus, Role, SellerStatus, StoreBusterCampaignGoal, StoreBusterCampaignStatus, StoreInterestSignalType, StoreEmailSubscriberStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { effectiveStorePlan, asStorePlanEntitlements } from './store-plan-domain.js';
import { scoreInterestCategories } from './store-buster-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, extra?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...extra });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const jsonInput = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const consentSchema = z.object({ enabled: z.boolean() }).strict();
const signalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(StoreInterestSignalType.PRODUCT_VIEW), productId: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal(StoreInterestSignalType.FAVORITE), productId: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal(StoreInterestSignalType.SEARCH_CATEGORY), categoryId: z.string().min(1).max(80) }).strict()
]);
const campaignSchema = z.object({
  name: z.string().trim().min(2).max(100),
  goal: z.nativeEnum(StoreBusterCampaignGoal),
  productIds: z.array(z.string().min(1).max(80)).min(1).max(20),
  audienceCategoryIds: z.array(z.string().min(1).max(80)).max(20).default([])
}).strict().refine(value => new Set(value.productIds).size === value.productIds.length, 'Products must not be repeated');
const settingsSchema = z.object({ enabled: z.boolean(), sponsoredEnabled: z.boolean(), moderationRequired: z.boolean(), maxMonthlyBudgetMinor: z.number().int().min(0).max(2_000_000_000), maxCampaignsPerStore: z.number().int().min(0).max(100_000), pricePerClickMinor: z.number().int().min(0).max(2_000_000_000), reason: z.string().trim().min(3).max(500) }).strict().refine(value => !value.sponsoredEnabled || value.enabled, 'Sponsored placements require Store Buster to be enabled.');
const emailCampaignSchema = z.object({ name: z.string().trim().min(2).max(100), subject: z.string().trim().min(2).max(160), content: z.array(z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(2000).refine(value => !/[<>]/.test(value), 'HTML is not allowed') }).strict()).min(1).max(30) }).strict();
function maskSubscriberEmail(email: string) {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '•••' : `${email.slice(0, 1)}•••${email.slice(at)}`;
}

async function sellerStore(sellerId: string) {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED }, select: { id: true, store: { select: { id: true, name: true, slug: true } } } });
  if (!seller?.store) throw fail(403, 'An approved seller Store is required.');
  return seller.store;
}

export function registerStoreGrowthRoutes(app: Express) {
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
      include: { store: { select: { id: true, name: true, slug: true, sellerId: true, seller: { select: { status: true } } } }, products: { include: { product: { select: { id: true, slug: true, name: true, description: true, priceMinor: true, currency: true, sellerId: true, status: true, category: { select: { id: true, name: true, status: true } }, inventory: { select: { quantity: true } }, images: { take: 1, select: { url: true, alt: true } } } } } } },
      take: 100
    });
    const eligible = [];
    for (const campaign of campaigns) {
      if (campaign.store.seller.status !== SellerStatus.APPROVED) continue;
      const effective = await effectiveStorePlan(prisma, campaign.store.id);
      if (!asStorePlanEntitlements(effective.version).storeBusterEnabled) continue;
      const matchingProducts = campaign.products.filter(item => item.product.status === ProductStatus.APPROVED && item.product.sellerId === campaign.store.sellerId && item.product.inventory && item.product.inventory.quantity > 0 && item.product.category?.status === 'ACTIVE' && categoryIds.includes(item.product.category.id));
      if (matchingProducts.length) eligible.push({ campaign, products: matchingProducts });
    }
    const rankedItems = eligible.flatMap(({ campaign, products: campaignProducts }) => campaignProducts.map(({ product }) => ({
      campaignId: campaign.id,
      categoryId: product.category!.id,
      product: { id: product.id, slug: product.slug, name: product.name, description: product.description, priceMinor: product.priceMinor, currency: product.currency, category: product.category?.name ?? null, image: product.images[0] ?? null },
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

  app.get('/api/seller/store-buster', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId);
    const [effective, settings, campaigns, count] = await Promise.all([
      effectiveStorePlan(prisma, store.id), prisma.storeBusterSettings.findUnique({ where: { id: 'default' } }),
      prisma.storeBusterCampaign.findMany({ where: { storeId: store.id }, include: { products: { include: { product: { select: { id: true, name: true, status: true } } } }, metrics: { orderBy: { day: 'desc' }, take: 90 } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.storeBusterCampaign.count({ where: { storeId: store.id, status: { in: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PAUSED'] } } })
    ]);
    const entitlements = asStorePlanEntitlements(effective.version);
    res.json({ store, enabledForPlan: entitlements.storeBusterEnabled, available: entitlements.storeBusterEnabled && Boolean(settings?.enabled), sponsoredAvailable: env.STORE_BUSTER_SPONSORED_AVAILABLE && Boolean(settings?.sponsoredEnabled), campaignLimit: Math.min(entitlements.storeBusterCampaignLimit, settings?.maxCampaignsPerStore ?? 0), campaignCount: count, monthlyBudgetCapMinor: Math.min(entitlements.storeBusterMonthlyBudgetMinor, settings?.maxMonthlyBudgetMinor ?? 0), campaigns, message: env.STORE_BUSTER_SPONSORED_AVAILABLE ? 'Sponsored placements require separate review and explicit campaign funding.' : 'Sponsored placements are disabled by deployment policy; organic recommendations are separate.' });
  }));

  app.post('/api/seller/store-buster/campaigns', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId); const input = campaignSchema.parse(req.body);
    const campaign = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const [effective, settings] = await Promise.all([effectiveStorePlan(tx, store.id), tx.storeBusterSettings.findUnique({ where: { id: 'default' } })]);
      const entitlements = asStorePlanEntitlements(effective.version);
      if (!entitlements.storeBusterEnabled) throw fail(409, 'Store Buster is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'storeBusterEnabled', planUrl: '/seller/plan' });
      if (!settings?.enabled) throw fail(503, 'Store Buster is currently unavailable by platform policy.');
      const limit = Math.min(entitlements.storeBusterCampaignLimit, settings.maxCampaignsPerStore);
      const count = await tx.storeBusterCampaign.count({ where: { storeId: store.id, status: { in: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PAUSED'] } } });
      if (count >= limit) throw fail(409, 'Your Store has reached its Store Buster campaign limit.', { code: 'PLAN_LIMIT_REACHED', entitlement: 'storeBusterCampaignLimit', usage: count, limit, upgradeRequired: true, planUrl: '/seller/plan' });
      const products = await tx.product.findMany({ where: { id: { in: input.productIds }, sellerId: user.sellerId, status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } } }, select: { id: true } });
      if (products.length !== input.productIds.length) throw fail(400, 'Every campaign product must be approved, in stock, and owned by your Store.');
      if (input.audienceCategoryIds.length && await tx.category.count({ where: { id: { in: input.audienceCategoryIds }, status: 'ACTIVE' } }) !== new Set(input.audienceCategoryIds).size) throw fail(400, 'Choose only active audience interests.');
      const created = await tx.storeBusterCampaign.create({ data: { storeId: store.id, name: input.name, goal: input.goal, sponsored: false, monthlyBudgetMinor: 0, audienceCategoryIds: input.audienceCategoryIds, products: { create: products.map(product => ({ productId: product.id })) } } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_BUSTER_CAMPAIGN_CREATED', entity: 'StoreBusterCampaign', entityId: created.id, metadata: { storeId: store.id, goal: created.goal, sponsored: false, productCount: products.length } } });
      return created;
    });
    res.status(201).json(campaign);
  }));

  app.post('/api/seller/store-buster/campaigns/:id/submit', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await sellerStore(user.sellerId); const id = param(req.params.id);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const [effective, settings, campaign] = await Promise.all([effectiveStorePlan(tx, store.id), tx.storeBusterSettings.findUnique({ where: { id: 'default' } }), tx.storeBusterCampaign.findFirst({ where: { id, storeId: store.id }, include: { products: { include: { product: true } } } })]);
      if (!campaign) throw fail(404, 'Campaign not found.');
      if (!['DRAFT', 'REJECTED'].includes(campaign.status)) throw fail(409, 'Only draft or rejected campaigns can be submitted for review.');
      if (!asStorePlanEntitlements(effective.version).storeBusterEnabled || !settings?.enabled) throw fail(409, 'Store Buster is unavailable for this Store.');
      if (!campaign.products.length || campaign.products.some(item => item.product.status !== ProductStatus.APPROVED || item.product.sellerId !== user.sellerId)) throw fail(409, 'Campaign products are no longer eligible.');
      const status = settings.moderationRequired ? StoreBusterCampaignStatus.PENDING_REVIEW : StoreBusterCampaignStatus.APPROVED;
      const updated = await tx.storeBusterCampaign.update({ where: { id }, data: { status } });
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
    res.json({ ...(await prisma.storeBusterSettings.findUnique({ where: { id: 'default' } })), sponsoredDeploymentGate: env.STORE_BUSTER_SPONSORED_AVAILABLE });
  }));
  app.patch('/api/admin/store-buster/settings', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res); const input = settingsSchema.parse(req.body);
    if (input.sponsoredEnabled && !env.STORE_BUSTER_SPONSORED_AVAILABLE) throw fail(409, 'Sponsored placements are disabled by the deployment hard gate.');
    const result = await prisma.$transaction(async tx => {
      const old = await tx.storeBusterSettings.findUnique({ where: { id: 'default' } });
      const updated = await tx.storeBusterSettings.update({ where: { id: 'default' }, data: { enabled: input.enabled, sponsoredEnabled: input.sponsoredEnabled, moderationRequired: input.moderationRequired, maxMonthlyBudgetMinor: input.maxMonthlyBudgetMinor, maxCampaignsPerStore: input.maxCampaignsPerStore, pricePerClickMinor: input.pricePerClickMinor, updatedById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_BUSTER_SETTINGS_CHANGED', entity: 'StoreBusterSettings', entityId: 'default', metadata: jsonInput({ old: { enabled: old?.enabled, sponsoredEnabled: old?.sponsoredEnabled, maxMonthlyBudgetMinor: old?.maxMonthlyBudgetMinor, maxCampaignsPerStore: old?.maxCampaignsPerStore, pricePerClickMinor: old?.pricePerClickMinor }, new: { enabled: updated.enabled, sponsoredEnabled: updated.sponsoredEnabled, moderationRequired: updated.moderationRequired, maxMonthlyBudgetMinor: updated.maxMonthlyBudgetMinor, maxCampaignsPerStore: updated.maxCampaignsPerStore, pricePerClickMinor: updated.pricePerClickMinor }, reason: input.reason }) } });
      return updated;
    });
    res.json({ ...result, sponsoredDeploymentGate: env.STORE_BUSTER_SPONSORED_AVAILABLE });
  }));
  app.get('/api/admin/store-buster/campaigns', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.storeBusterCampaign.findMany({ include: { store: { select: { id: true, name: true, slug: true } }, products: { include: { product: { select: { id: true, name: true, status: true } } } } }, orderBy: { updatedAt: 'desc' }, take: 200 }))));
  app.patch('/api/admin/store-buster/campaigns/:id/review', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res); const input = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'PAUSED']), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const current = await prisma.storeBusterCampaign.findUnique({ where: { id: param(req.params.id) } }); if (!current) throw fail(404, 'Campaign not found.');
    const status = input.status as StoreBusterCampaignStatus;
    if (status === StoreBusterCampaignStatus.APPROVED && current.status !== StoreBusterCampaignStatus.PENDING_REVIEW) throw fail(409, 'Only a pending campaign can be approved.');
    if (status === StoreBusterCampaignStatus.REJECTED && current.status !== StoreBusterCampaignStatus.PENDING_REVIEW) throw fail(409, 'Only a pending campaign can be rejected.');
    if (status === StoreBusterCampaignStatus.PAUSED && current.status !== StoreBusterCampaignStatus.APPROVED) throw fail(409, 'Only an approved campaign can be paused.');
    const result = await prisma.$transaction(async tx => {
      const updated = await tx.storeBusterCampaign.update({ where: { id: current.id }, data: { status, moderationReason: input.reason, reviewedById: user.id, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: user.id, action: `STORE_BUSTER_CAMPAIGN_${status}`, entity: 'StoreBusterCampaign', entityId: current.id, metadata: { reason: input.reason } } });
      return updated;
    });
    res.json(result);
  }));

  app.get('/api/seller/affiliate-program', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId);
    const [effective, program, settings] = await Promise.all([effectiveStorePlan(prisma, store.id), prisma.storeAffiliateProgram.findUnique({ where: { storeId: store.id } }), prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { affiliateEnabled: true } })]);
    const included = asStorePlanEntitlements(effective.version).affiliateToolsEnabled;
    res.json({ included, enabled: program?.enabled ?? false, marketplaceProgramAvailable: settings?.affiliateEnabled ?? false, payoutRequestsAvailable: false, message: 'This setting controls whether affiliates may promote this Store through the existing platform program. It does not create seller commissions or seller payouts; no payout capability is enabled by this Store plan.' });
  }));
  app.patch('/api/seller/affiliate-program', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId);
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const entitlements = asStorePlanEntitlements((await effectiveStorePlan(tx, store.id)).version);
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
    const entitlements = asStorePlanEntitlements(effective.version);
    res.json({ enabledForPlan: entitlements.emailMarketingEnabled, deliveryAvailable: false, deploymentGate: env.STORE_EMAIL_DELIVERY_AVAILABLE, subscriberLimit: entitlements.emailSubscriberLimit, monthlySendLimit: entitlements.emailMonthlySendLimit, counts: Object.fromEntries(counts.map(item => [item.status, item._count._all])), subscribers: subscribers.map(item => ({ ...item, emailMasked: maskSubscriberEmail(item.email), email: undefined })), campaigns, message: 'No verified email provider adapter is implemented. The deployment gate is only a safety cap; list confirmation and all message delivery remain unavailable.' });
  }));

  app.post('/api/seller/email-campaigns', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res); if (!user.sellerId) throw fail(403, 'Seller scope required.'); const store = await sellerStore(user.sellerId); const input = emailCampaignSchema.parse(req.body);
    const campaign = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const entitlements = asStorePlanEntitlements((await effectiveStorePlan(tx, store.id)).version);
      if (!entitlements.emailMarketingEnabled) throw fail(409, 'Email marketing is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'emailMarketingEnabled', planUrl: '/seller/plan' });
      const created = await tx.storeEmailCampaign.create({ data: { storeId: store.id, name: input.name, subject: input.subject, contentJson: jsonInput(input.content), status: 'DRAFT' } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_EMAIL_CAMPAIGN_DRAFT_CREATED', entity: 'StoreEmailCampaign', entityId: created.id, metadata: { storeId: store.id } } });
      return created;
    });
    res.status(201).json({ ...campaign, deliveryAvailable: false, message: 'Saved as a draft only. Sending remains disabled until an approved email provider, consent checks, suppression lists, and send limits are configured.' });
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
    const store = await prisma.store.findFirst({ where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } }, select: { id: true } }); if (!store) return res.status(404).json({ error: 'Store not found.' });
    const effective = await effectiveStorePlan(prisma, store.id); const entitlements = asStorePlanEntitlements(effective.version);
    if (!entitlements.emailMarketingEnabled) return res.status(409).json({ code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'emailMarketingEnabled', error: 'Email marketing is not enabled for this Store plan.' });
    if (!env.STORE_EMAIL_DELIVERY_AVAILABLE) return res.status(503).json({ code: 'STORE_EMAIL_DELIVERY_UNAVAILABLE', error: 'Subscription confirmation is unavailable because the email delivery provider is not configured. No subscriber record was created.' });
    // Delivery stays fail-closed until a verified provider implementation is added.
    return res.status(503).json({ code: 'STORE_EMAIL_DELIVERY_UNAVAILABLE', error: 'No verified email provider adapter is implemented; no subscriber record was created.' });
  }));

  app.post('/api/store-email/unsubscribe/:token', run(async (req, res) => {
    const hash = crypto.createHash('sha256').update(param(req.params.token)).digest('hex');
    const updated = await prisma.storeEmailSubscriber.updateMany({ where: { unsubscribeTokenHash: hash, status: { notIn: ['UNSUBSCRIBED', 'SUPPRESSED', 'BOUNCED'] } }, data: { status: StoreEmailSubscriberStatus.UNSUBSCRIBED } });
    if (!updated.count) return res.status(404).json({ error: 'Unsubscribe link is invalid or already used.' });
    res.json({ unsubscribed: true });
  }));
}
