import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { AffiliateAdjustmentType, AffiliateAttributionRule, AffiliatePayoutStatus, AffiliateStatus, CommissionEntryType, CommissionStatus, MediaScanStatus, MediaUploadStatus, MessageReactionKind, Prisma, ProductStatus, Role, SellerStatus, WholesaleStatus } from '@prisma/client';
import { z } from 'zod';
import { audit, currentUser, prisma, requireAuth, requireRole } from './security.js';
import { env } from './config.js';
import { generatedReferralCode, referralTokenHash, safeInternalPath, signedReferralToken, verifySignedReferralToken, escapeHtmlAttribute } from './growth-domain.js';
import { reverseAffiliateForOrder } from './affiliate-ledger.js';
import { effectiveStorePlan, storeEntitlements } from './store-plan-domain.js';
import { createUserNotification } from './notification-delivery.js';
import { campaignMediaFailure } from './campaign-media-domain.js';

const run = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => Promise.resolve(handler(req, res)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const idSchema = z.string().cuid();

async function assertStoreAffiliateEligible(storeId: string) {
  const participation = await prisma.storeAffiliateProgram.findUnique({ where: { storeId } });
  // Stores without a record retain the legacy platform affiliate behavior.
  if (!participation) return;
  const plan = await effectiveStorePlan(prisma, storeId);
  if (!participation.enabled || !(await storeEntitlements(prisma, storeId, plan.version)).affiliateToolsEnabled) {
    const error = Object.assign(new Error('This Store is not currently eligible for affiliate promotion.'), { statusCode: 409, code: 'STORE_AFFILIATE_NOT_AVAILABLE' });
    throw error;
  }
}

async function assertAffiliateLinkStoreEligible(link: { sellerId: string | null; productId: string | null }) {
  if (link.sellerId) {
    const store = await prisma.store.findUnique({ where: { sellerId: link.sellerId }, select: { id: true } });
    if (!store) throw Object.assign(new Error('This Store is not currently eligible for affiliate promotion.'), { statusCode: 409, code: 'STORE_AFFILIATE_NOT_AVAILABLE' });
    return assertStoreAffiliateEligible(store.id);
  }
  if (link.productId) {
    const product = await prisma.product.findUnique({ where: { id: link.productId }, select: { sellerId: true } });
    if (product?.sellerId) {
      const store = await prisma.store.findUnique({ where: { sellerId: product.sellerId }, select: { id: true } });
      if (!store) throw Object.assign(new Error('This Store is not currently eligible for affiliate promotion.'), { statusCode: 409, code: 'STORE_AFFILIATE_NOT_AVAILABLE' });
      return assertStoreAffiliateEligible(store.id);
    }
  }
}

export function registerGrowthRoutes(app: Express) {
  app.get('/api/favorites/ids', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string };
    const favorites = await prisma.favorite.findMany({ where: { userId: user.id }, select: { productId: true } });
    res.json({ productIds: favorites.map(favorite => favorite.productId) });
  }));
  app.get('/api/member/header-summary', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string; sellerId?: string };
    const conversationScope: Prisma.ConversationWhereInput = {
      OR: [{ buyerId: user.id }, ...(user.sellerId ? [{ sellerId: user.sellerId }] : [])]
    };
    const [favoriteCount, unreadNotificationCount, unreadMessageCount, notifications, recentMessages] = await Promise.all([
      prisma.favorite.count({ where: { userId: user.id, product: { status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] } } }),
      prisma.notification.count({ where: { userId: user.id, readAt: null } }),
      prisma.message.count({ where: { conversation: conversationScope, senderId: { not: user.id }, readAt: null } }),
      prisma.notification.findMany({
        where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 10,
        select: { id: true, title: true, body: true, link: true, readAt: true, createdAt: true }
      }),
      prisma.message.findMany({
        where: { conversation: conversationScope }, orderBy: { sentAt: 'desc' }, take: 10,
        select: {
          id: true, conversationId: true, senderId: true, body: true, sentAt: true, readAt: true,
          sender: { select: { name: true } },
          conversation: { select: { status: true, product: { select: { name: true } } } },
          attachments: {
            select: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true } } }
          }
        }
      })
    ]);
    const messageIds = recentMessages.map(message => message.id);
    const [reactionGroups, myReactions] = messageIds.length ? await Promise.all([
      prisma.messageReaction.groupBy({ by: ['messageId', 'reaction'], where: { messageId: { in: messageIds } }, _count: { _all: true } }),
      prisma.messageReaction.findMany({ where: { messageId: { in: messageIds }, userId: user.id }, select: { messageId: true, reaction: true } })
    ]) : [[], []];
    const reactionCounts = new Map<string, Record<MessageReactionKind, number>>();
    for (const group of reactionGroups) {
      const counts = reactionCounts.get(group.messageId) ?? Object.fromEntries(Object.values(MessageReactionKind).map(kind => [kind, 0])) as Record<MessageReactionKind, number>;
      counts[group.reaction] = group._count._all;
      reactionCounts.set(group.messageId, counts);
    }
    const myReactionByMessage = new Map(myReactions.map(reaction => [reaction.messageId, reaction.reaction]));
    res.set('Cache-Control', 'private, no-store');
    res.json({
      favoriteCount, unreadNotificationCount, unreadMessageCount,
      notifications,
      messages: recentMessages.map(({ sender, conversation, attachments, ...message }) => ({
        ...message,
        senderName: sender.name,
        productName: conversation.product?.name ?? null,
        conversationStatus: conversation.status,
        attachments: attachments.map(({ mediaAsset }) => ({
          ...mediaAsset,
          url: mediaAsset.scanStatus === MediaScanStatus.APPROVED && mediaAsset.uploadStatus === MediaUploadStatus.COMPLETE
            ? `/api/conversations/${encodeURIComponent(message.conversationId)}/attachments/${encodeURIComponent(mediaAsset.id)}`
            : null
        })),
        reactions: reactionCounts.get(message.id) ?? Object.fromEntries(Object.values(MessageReactionKind).map(kind => [kind, 0])),
        myReaction: myReactionByMessage.get(message.id) ?? null
      }))
    });
  }));
  app.get('/api/favorites', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string };
    const favorites = await prisma.favorite.findMany({
      where: { userId: user.id, product: { status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] } },
      select: {
        id: true, createdAt: true, productId: true,
        product: { select: {
          id: true, name: true, description: true, priceMinor: true, salePriceMinor: true, currency: true,
          images: { select: { url: true, alt: true }, take: 1 },
          inventory: { select: { quantity: true } },
          category: { select: { name: true } },
          seller: { select: { store: { select: { name: true, slug: true } } } }
        } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(favorites);
  }));
  app.post('/api/favorites/:productId', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const productId = idSchema.parse(param(req.params.productId));
    const product = await prisma.product.findFirst({ where: { id: productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] } });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const favorite = await prisma.$transaction(async tx => {
      const existing = await tx.favorite.findUnique({ where: { userId_productId: { userId: user.id, productId } }, select: { id: true } });
      const saved = await tx.favorite.upsert({ where: { userId_productId: { userId: user.id, productId } }, update: {}, create: { userId: user.id, productId } });
      if (!existing) {
        await tx.$queryRaw`SELECT "id" FROM "UserPreference" WHERE "userId" = ${user.id} FOR UPDATE`;
        const preference = await tx.userPreference.findUnique({ where: { userId: user.id }, select: { personalizationEnabled: true, personalizationConsentAt: true } });
        if (preference?.personalizationEnabled && preference.personalizationConsentAt) await tx.storeInterestSignal.create({ data: { userId: user.id, type: 'FAVORITE', productId, categoryId: product.categoryId } });
      }
      return saved;
    });
    res.status(201).json(favorite);
  }));
  app.delete('/api/favorites/:productId', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const productId = idSchema.parse(param(req.params.productId));
    await prisma.$transaction(async tx => {
      await tx.favorite.deleteMany({ where: { userId: user.id, productId } });
      await tx.storeInterestSignal.deleteMany({ where: { userId: user.id, productId, type: 'FAVORITE' } });
    });
    res.status(204).send();
  }));

  app.post('/api/wholesale/apply', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const note = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body).note;
    const application = await prisma.wholesaleApplication.upsert({ where: { userId: user.id }, update: { note, status: WholesaleStatus.PENDING }, create: { userId: user.id, note } });
    await audit(user.id, 'WHOLESALE_APPLICATION_SUBMITTED', 'WholesaleApplication', application.id);
    res.status(201).json(application);
  }));
  app.get('/api/wholesale/me', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string };
    res.json(await prisma.wholesaleApplication.findUnique({ where: { userId: user.id } }));
  }));
  app.get('/api/products/:productId/wholesale-prices', run(async (req, res) => {
    const productId = idSchema.parse(param(req.params.productId));
    const product = await prisma.product.findFirst({ where: { id: productId, status: ProductStatus.APPROVED, wholesaleEnabled: true }, include: { wholesaleTiers: { orderBy: { minQuantity: 'asc' } } } });
    if (!product) return res.status(404).json({ error: 'Wholesale product not found' });
    const user = await currentUser(req);
    const approved = user ? await prisma.wholesaleApplication.findFirst({ where: { userId: user.id, status: WholesaleStatus.APPROVED } }) : null;
    if (!approved) return res.status(403).json({ error: 'Approved wholesale buyer required' });
    res.json({ productId, minimum: product.wholesaleMinQuantity, packSize: product.wholesalePackSize, tiers: product.wholesaleTiers });
  }));

  app.post('/api/affiliate/apply', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    if (!settings?.affiliateEnabled) return res.status(409).json({ error: 'The affiliate program is not currently accepting applications' });
    const input = z.object({ termsAccepted: z.literal(true) }).parse(req.body);
    const existing = await prisma.affiliateProfile.findUnique({ where: { userId: user.id } });
    const profile = existing ?? await prisma.affiliateProfile.create({ data: { userId: user.id, referralCode: generatedReferralCode(), termsAcceptedAt: new Date() } });
    if (existing && !existing.termsAcceptedAt) await prisma.affiliateProfile.update({ where: { id: existing.id }, data: { termsAcceptedAt: new Date() } });
    await audit(user.id, 'AFFILIATE_APPLICATION_SUBMITTED', 'AffiliateProfile', profile.id, input);
    res.status(201).json({ id: profile.id, status: profile.status, referralCode: profile.status === AffiliateStatus.APPROVED ? profile.referralCode : null });
  }));
  app.get('/api/affiliate/me', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string };
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId: user.id }, include: { links: { orderBy: { createdAt: 'desc' }, take: 100 }, clicks: { select: { id: true, clickedAt: true, expiresAt: true, convertedAt: true }, orderBy: { clickedAt: 'desc' }, take: 100 }, commissions: { orderBy: { createdAt: 'desc' }, take: 100 }, payouts: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!profile) return res.json(null);
    const [clickCount, attributedOrders] = await Promise.all([prisma.affiliateClick.count({ where: { affiliateId: profile.id } }), prisma.affiliateClick.count({ where: { affiliateId: profile.id, convertedAt: { not: null } } })]);
    const summary = profile.commissions.reduce((result, item) => { result[item.status] = (result[item.status] ?? 0) + item.amountMinor; return result; }, {} as Record<string, number>);
    res.json({ ...profile, referralCode: profile.status === AffiliateStatus.APPROVED ? profile.referralCode : null, summary: { clicks: clickCount, attributedOrders, commissions: summary } });
  }));
  app.post('/api/affiliate/links', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ targetPath: z.string().min(1).max(500).optional(), productId: z.string().cuid().optional(), sellerId: z.string().cuid().optional() }).refine(value => Boolean(value.productId) !== Boolean(value.sellerId), { message: 'Set exactly one product or seller target' }).parse(req.body);
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId: user.id } });
    if (!profile || profile.status !== AffiliateStatus.APPROVED || !profile.termsAcceptedAt) return res.status(403).json({ error: 'Approved affiliate required' });
    const product = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: 'APPROVED' } }] } }) : null;
    const seller = input.sellerId ? await prisma.seller.findFirst({ where: { id: input.sellerId, status: 'APPROVED' }, include: { store: true } }) : null;
    if (input.productId && !product) return res.status(404).json({ error: 'Product not found' });
    if (input.sellerId && !seller) return res.status(404).json({ error: 'Seller not found' });
    if (seller?.store) await assertStoreAffiliateEligible(seller.store.id);
    if (product?.sellerId) {
      const productStore = await prisma.store.findUnique({ where: { sellerId: product.sellerId }, select: { id: true } });
      if (!productStore) return res.status(404).json({ error: 'Store not found' });
      await assertStoreAffiliateEligible(productStore.id);
    }
    const canonicalPath = product ? `/products/${product.slug}` : `/stores/${seller!.id}`;
    const targetPath = input.targetPath ? safeInternalPath(input.targetPath) : canonicalPath;
    if (product && targetPath !== canonicalPath) return res.status(400).json({ error: 'Product links must use the canonical product path' });
    const link = await prisma.affiliateLink.create({ data: { affiliateId: profile.id, productId: input.productId, sellerId: input.sellerId, targetPath, code: `${profile.referralCode}-${crypto.randomBytes(5).toString('hex')}` } });
    const href = `${env.SITE_URL}/r/${link.code}`;
    const label = escapeHtmlAttribute(product?.name ?? seller?.store?.name ?? 'Marketplace store');
    res.status(201).json({ id: link.id, code: link.code, targetPath: link.targetPath, trackingUrl: href, htmlLink: `<a href="${escapeHtmlAttribute(href)}" rel="nofollow sponsored">View ${label}</a>`, htmlCard: `<article><a href="${escapeHtmlAttribute(href)}" rel="nofollow sponsored"><strong>${label}</strong></a></article>` });
  }));
  app.get('/r/:code', run(async (req, res) => {
    if (!['1', 'true', 'yes'].includes(String(req.query.consent ?? '').toLowerCase())) return res.status(400).send('Affiliate consent is required before tracking.');
    const link = await prisma.affiliateLink.findUnique({ where: { code: param(req.params.code) }, include: { affiliate: true } });
    const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    if (!settings?.affiliateEnabled || !link || link.affiliate.status !== AffiliateStatus.APPROVED) return res.status(404).send('Referral link not found');
    await assertAffiliateLinkStoreEligible(link);
    const token = signedReferralToken(env.AFFILIATE_SIGNING_SECRET ?? env.PASSWORD_PEPPER);
    const expiresAt = new Date(Date.now() + settings.affiliateAttributionWindowDays * 86400000);
    const visitorKey = String(req.query.visitorKey ?? '');
    await prisma.affiliateClick.create({ data: { affiliateId: link.affiliateId, linkId: link.id, productId: link.productId, tokenHash: referralTokenHash(token), ipHash: crypto.createHash('sha256').update(req.ip ?? 'unknown').digest('hex'), visitorKeyHash: visitorKey ? referralTokenHash(visitorKey) : null, consentGivenAt: new Date(), expiresAt } });
    res.cookie('affiliate_attribution', token, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', maxAge: settings.affiliateAttributionWindowDays * 86400000, path: '/' });
    res.redirect(302, link.targetPath);
  }));
  app.post('/api/affiliate/clicks/:code', run(async (req, res) => {
    const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    if (!settings?.affiliateEnabled) return res.status(409).json({ error: 'Affiliate program is disabled' });
    const code = param(req.params.code);
    const link = await prisma.affiliateLink.findUnique({ where: { code }, include: { affiliate: true } });
    if (!link || link.affiliate.status !== AffiliateStatus.APPROVED) return res.status(404).json({ error: 'Referral link not found' });
    await assertAffiliateLinkStoreEligible(link);
    const input = z.object({ consent: z.literal(true), visitorKey: z.string().min(16).max(200).optional() }).parse(req.body);
    const token = signedReferralToken(env.AFFILIATE_SIGNING_SECRET ?? env.PASSWORD_PEPPER);
    const ipHash = crypto.createHash('sha256').update(req.ip ?? 'unknown').digest('hex');
    const expiresAt = new Date(Date.now() + settings.affiliateAttributionWindowDays * 86400000);
    await prisma.affiliateClick.create({ data: { affiliateId: link.affiliateId, linkId: link.id, productId: link.productId, tokenHash: referralTokenHash(token), ipHash, visitorKeyHash: input.visitorKey ? referralTokenHash(input.visitorKey) : null, consentGivenAt: new Date(), expiresAt } });
    res.cookie('affiliate_attribution', token, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', maxAge: settings.affiliateAttributionWindowDays * 86400000, path: '/' });
    res.json({ token, targetPath: link.targetPath, expiresAt });
  }));
  app.get('/api/affiliate/commissions', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string };
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId: user.id } });
    if (!profile) return res.status(404).json({ error: 'Affiliate profile not found' });
    res.json(await prisma.commissionLedger.findMany({ where: { affiliateId: profile.id }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, amountMinor: true, currency: true, status: true, entryType: true, eligibleBaseMinor: true, ruleName: true, createdAt: true, reason: true } }));
  }));
  app.post('/api/affiliate/payouts', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ amountMinor: z.number().int().positive(), currency: z.string().length(3).transform(value => value.toUpperCase()), method: z.string().trim().min(2).max(40) }).parse(req.body);
    const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    if (!settings?.affiliateEnabled || !settings.affiliateFundingConfigured) return res.status(409).json({ error: 'Affiliate funding and payout policy are not configured' });
    if (input.amountMinor < settings.affiliateMinimumPayoutMinor) return res.status(409).json({ error: 'Minimum payout threshold has not been reached' });
    const profile = await prisma.affiliateProfile.findUnique({ where: { userId: user.id }, include: { commissions: { where: { status: CommissionStatus.PAYABLE }, include: { payoutItems: true } } } });
    if (!profile || profile.status !== AffiliateStatus.APPROVED) return res.status(403).json({ error: 'Approved affiliate required' });
    const payable = profile.commissions.filter(x => x.currency === input.currency).reduce((sum, x) => sum + x.amountMinor - x.payoutItems.reduce((s, item) => s + item.amountMinor, 0), 0);
    if (input.amountMinor > payable) return res.status(409).json({ error: 'Requested payout exceeds payable ledger balance' });
    const payout = await prisma.$transaction(async tx => {
      const created = await tx.affiliatePayout.create({ data: { affiliateId: profile.id, amountMinor: input.amountMinor, currency: input.currency, method: input.method } });
      let remaining = input.amountMinor;
      for (const commission of profile.commissions.filter(x => x.currency === input.currency)) {
        const available = commission.amountMinor - commission.payoutItems.reduce((s, item) => s + item.amountMinor, 0);
        const allocation = Math.min(available, remaining);
        if (allocation > 0) { await tx.affiliatePayoutItem.create({ data: { payoutId: created.id, commissionId: commission.id, amountMinor: allocation } }); remaining -= allocation; }
        if (!remaining) break;
      }
      return created;
    });
    await audit(user.id, 'AFFILIATE_PAYOUT_REQUESTED', 'AffiliatePayout', payout.id, { amountMinor: input.amountMinor, currency: input.currency });
    res.status(201).json(payout);
  }));

  app.get('/api/notifications', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const page = Math.max(1, Number(req.query.page) || 1);
    res.json(await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50 }));
  }));
  app.post('/api/notifications/:id/read', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const notification = await prisma.notification.updateMany({ where: { id: param(req.params.id), userId: user.id }, data: { readAt: new Date() } });
    if (!notification.count) return res.status(404).json({ error: 'Notification not found' });
    res.status(204).send();
  }));
  app.patch('/api/notification-preferences', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ channel: z.enum(['IN_APP', 'EMAIL', 'WEB_PUSH', 'ANDROID_PUSH']), category: z.string().trim().min(2).max(80), enabled: z.boolean() }).parse(req.body);
    res.json(await prisma.notificationPreference.upsert({ where: { userId_channel_category: { userId: user.id, channel: input.channel, category: input.category } }, update: { enabled: input.enabled }, create: { userId: user.id, ...input } }));
  }));
  app.post('/api/push/subscriptions', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ endpoint: z.string().url().max(2000), p256dh: z.string().min(10).max(300), auth: z.string().min(5).max(300), expiresAt: z.string().datetime().optional() }).parse(req.body);
    res.status(201).json(await prisma.pushSubscription.upsert({ where: { endpoint: input.endpoint }, update: { userId: user.id, p256dh: input.p256dh, auth: input.auth, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }, create: { userId: user.id, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } }));
  }));

  app.post('/api/conversations', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ sellerId: z.string().cuid(), productId: z.string().cuid().optional(), orderId: z.string().cuid().optional() }).parse(req.body);
    const seller = await prisma.seller.findFirst({ where: { id: input.sellerId, status: 'APPROVED' } });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (input.productId && !(await prisma.product.findFirst({ where: { id: input.productId, sellerId: seller.id, status: ProductStatus.APPROVED } }))) return res.status(404).json({ error: 'Product not found for seller' });
    res.status(201).json(await prisma.conversation.create({ data: { buyerId: user.id, sellerId: seller.id, productId: input.productId, orderId: input.orderId } }));
  }));
  app.post('/api/products/:productId/contact-seller', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const productId = idSchema.parse(param(req.params.productId));
    const input = z.object({ body: z.string().trim().min(5).max(2000) }).parse(req.body);
    const product = await prisma.product.findFirst({
      where: { id: productId, status: ProductStatus.APPROVED, seller: { status: SellerStatus.APPROVED } },
      select: { id: true, name: true, sellerId: true, seller: { select: { id: true, userId: true, status: true } } }
    });
    const seller = product?.seller;
    if (!product || !product.sellerId || !seller) return res.status(404).json({ error: 'This product is not currently available from an independent seller.' });
    if (seller.userId === user.id) return res.status(403).json({ error: 'You cannot contact yourself about your own listing.' });

    const result = await prisma.$transaction(async tx => {
      const existing = await tx.conversation.findFirst({
        where: { buyerId: user.id, sellerId: product.sellerId!, productId: product.id, status: 'OPEN' },
        orderBy: { updatedAt: 'desc' },
        select: { id: true }
      });
      const conversation = existing ?? await tx.conversation.create({ data: { buyerId: user.id, sellerId: product.sellerId!, productId: product.id } });
      const message = await tx.message.create({ data: { conversationId: conversation.id, senderId: user.id, body: input.body } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      await createUserNotification(tx, {
        userId: seller.userId,
        eventType: 'NEW_PRODUCT_INQUIRY',
        title: 'New product inquiry',
        body: `A buyer sent you a message about ${product.name}.`,
        link: '/dashboard?mode=seller&tab=messages',
        payloadJson: { conversationId: conversation.id, productId: product.id }
      }, 'support');
      return { conversationId: conversation.id, messageId: message.id };
    });
    res.status(201).json(result);
  }));
  app.get('/api/conversations', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string; sellerId?: string };
    res.json(await prisma.conversation.findMany({ where: { OR: [{ buyerId: user.id }, ...(user.sellerId ? [{ sellerId: user.sellerId }] : [])] }, include: { messages: { orderBy: { sentAt: 'desc' }, take: 1 }, product: true }, orderBy: { updatedAt: 'desc' }, take: 100 }));
  }));
  app.get('/api/campaigns/active', run(async (req, res) => {
    const placement = z.string().trim().min(1).max(80).parse(req.query.placement ?? 'home');
    const now = new Date();
    const campaigns = await prisma.marketingCampaign.findMany({ where: { placements: { has: placement }, OR: [{ status: 'PUBLISHED', OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { status: 'SCHEDULED', startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] }, include: { media: { where: { mediaAsset: { uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED } }, orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, detectedMime: true } } } } }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }], take: 20 });
    res.set('Cache-Control', 'no-store').json(campaigns.map(({ media, ...campaign }) => ({ ...campaign, media: media.map(item => ({ id: item.mediaAssetId, kind: item.mediaAsset.kind, position: item.position, href: item.destinationUrl, altText: item.altText, buttonLabel: item.buttonLabel, url: `/content-media/${encodeURIComponent(item.mediaAssetId)}` })) })));
  }));
  app.get('/api/admin/campaigns', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (_req, res) => {
    const campaigns = await prisma.marketingCampaign.findMany({ include: { media: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } } }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }], take: 100 });
    res.json(campaigns.map(({ media, ...campaign }) => ({ ...campaign, media: media.map(item => ({ id: item.mediaAssetId, kind: item.mediaAsset.kind, position: item.position, href: item.destinationUrl, altText: item.altText, buttonLabel: item.buttonLabel, originalName: item.mediaAsset.originalName, sizeBytes: item.mediaAsset.sizeBytes, detectedMime: item.mediaAsset.detectedMime, scanStatus: item.mediaAsset.scanStatus, scanErrorCode: item.mediaAsset.scanErrorCode, uploadStatus: item.mediaAsset.uploadStatus, previewUrl: `/api/admin/campaigns/${encodeURIComponent(campaign.id)}/media/${encodeURIComponent(item.mediaAssetId)}/preview` })) })));
  }));
  app.post('/api/admin/campaigns', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ name: z.string().trim().min(2).max(160), placements: z.array(z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/i)).min(1).max(20), contentJson: z.record(z.string(), z.unknown()), priority: z.number().int().min(-1000).max(1000).default(0), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const serialized = JSON.stringify(input.contentJson);
    if (serialized.length > 16_000 || /<\/?script|javascript:|on[a-z]+\s*=/i.test(serialized)) return res.status(400).json({ error: 'Campaign content is too large or contains executable content' });
    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) return res.status(400).json({ error: 'Campaign end must be later than its start' });
    if (typeof input.contentJson.ctaPath === 'string') {
      try { safeInternalPath(input.contentJson.ctaPath); } catch { return res.status(400).json({ error: 'Campaign links must use a safe internal path' }); }
    }
    const campaign = await prisma.$transaction(async tx => {
      const created = await tx.marketingCampaign.create({ data: { name: input.name, placements: [...new Set(input.placements)], contentJson: input.contentJson as Prisma.InputJsonValue, priority: input.priority, startsAt, endsAt, createdById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETING_CAMPAIGN_CREATED', entity: 'MarketingCampaign', entityId: created.id, metadata: { reason: input.reason, placements: created.placements, priority: created.priority } } });
      return created;
    });
    res.status(201).json(campaign);
  }));
  app.patch('/api/admin/campaigns/:id', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ name: z.string().trim().min(2).max(160).optional(), placements: z.array(z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/i)).min(1).max(20).optional(), contentJson: z.record(z.string(), z.unknown()).optional(), status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'PAUSED', 'ARCHIVED']).optional(), priority: z.number().int().min(-1000).max(1000).optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), reason: z.string().trim().min(5).max(500) }).parse(req.body);
    if (input.contentJson) {
      const serialized = JSON.stringify(input.contentJson);
      if (serialized.length > 16_000 || /<\/?script|javascript:|on[a-z]+\s*=/i.test(serialized)) return res.status(400).json({ error: 'Campaign content is too large or contains executable content' });
      if (typeof input.contentJson.ctaPath === 'string') {
        try { safeInternalPath(input.contentJson.ctaPath); } catch { return res.status(400).json({ error: 'Campaign links must use a safe internal path' }); }
      }
    }
    const result = await prisma.$transaction(async tx => {
      const existing = await tx.marketingCampaign.findUnique({ where: { id: param(req.params.id) } });
      if (!existing) return { error: 'Campaign not found' as const };
      if (existing.status === 'ARCHIVED') return { error: 'Archived campaigns are read-only' as const };
      const startsAt = input.startsAt === undefined ? existing.startsAt : input.startsAt ? new Date(input.startsAt) : null;
      const endsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt ? new Date(input.endsAt) : null;
      const status = input.status ?? existing.status;
      if (startsAt && endsAt && endsAt <= startsAt) return { error: 'Campaign end must be later than its start' as const };
      const now = new Date();
      if (status === 'SCHEDULED' && !startsAt) return { error: 'Scheduled campaigns require a start time' as const };
      if (status === 'SCHEDULED' && startsAt && startsAt <= now && (existing.status !== 'SCHEDULED' || input.startsAt !== undefined)) return { error: 'New schedules require a future start time' as const };
      if (status === 'PUBLISHED' && ((startsAt && startsAt > now) || (endsAt && endsAt <= now))) return { error: 'Campaign is outside its publishing window; schedule it or adjust its dates' as const };
      if (status === 'PUBLISHED' || status === 'SCHEDULED') {
        const media = await tx.marketingCampaignMedia.findMany({ where: { campaignId: existing.id }, include: { mediaAsset: { select: { kind: true, scanStatus: true, uploadStatus: true } } } });
        const mediaFailure = campaignMediaFailure(media.map(item => ({ kind: item.mediaAsset.kind, scanStatus: item.mediaAsset.scanStatus, uploadStatus: item.mediaAsset.uploadStatus, destinationUrl: item.destinationUrl, buttonLabel: item.buttonLabel })));
        if (mediaFailure) return { error: mediaFailure as string };
      }
      const { reason, ...fields } = input;
      const updated = await tx.marketingCampaign.update({ where: { id: existing.id }, data: { ...fields, placements: input.placements ? [...new Set(input.placements)] : undefined, contentJson: input.contentJson as Prisma.InputJsonValue | undefined, startsAt, endsAt } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETING_CAMPAIGN_UPDATED', entity: 'MarketingCampaign', entityId: updated.id, metadata: { reason, previousStatus: existing.status, status: updated.status } } });
      return { campaign: updated } as const;
    });
    if ('error' in result) return res.status(result.error === 'Campaign not found' ? 404 : 400).json({ error: result.error });
    res.json(result.campaign);
  }));
  app.get('/api/admin/affiliate-rules', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.affiliateCommissionRule.findMany({ orderBy: { effectiveFrom: 'desc' }, take: 100 }))));
  app.post('/api/admin/affiliate-rules', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ name: z.string().trim().min(2).max(120), basisPoints: z.number().int().min(0).max(10000).optional(), fixedMinor: z.number().int().nonnegative().optional(), currency: z.string().length(3).transform(value => value.toUpperCase()), productId: z.string().cuid().optional(), categoryId: z.string().cuid().optional(), effectiveFrom: z.string().datetime(), effectiveTo: z.string().datetime().optional() }).refine(value => (value.basisPoints !== undefined) !== (value.fixedMinor !== undefined), { message: 'Set exactly one commission amount rule' }).refine(value => !(value.productId && value.categoryId), { message: 'A rule can target a product or category, not both' }).parse(req.body);
    const rule = await prisma.affiliateCommissionRule.create({ data: { ...input, effectiveFrom: new Date(input.effectiveFrom), effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null } });
    await audit(user.id, 'AFFILIATE_COMMISSION_RULE_CREATED', 'AffiliateCommissionRule', rule.id);
    res.status(201).json(rule);
  }));
  app.get('/api/admin/wholesale', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.wholesaleApplication.findMany({ include: { user: { select: { email: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));
  app.post('/api/ai/search', run(async (req, res) => {
    const query = z.object({ q: z.string().trim().min(1).max(200) }).parse(req.body).q;
    const products = await prisma.product.findMany({ where: { status: ProductStatus.APPROVED, OR: [{ name: { contains: query, mode: 'insensitive' } }, { description: { contains: query, mode: 'insensitive' } }] }, include: { inventory: true }, take: 30 });
    res.json({ mode: 'deterministic-fallback', notice: 'AI search is not configured; results use database text matching.', products });
  }));
  app.get('/api/admin/affiliate-settings', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    res.json(settings ?? { affiliateEnabled: false, affiliateFundingConfigured: false, affiliateAttributionRule: AffiliateAttributionRule.LAST_VALID_CLICK, affiliateAttributionWindowDays: 30, affiliateMinimumPayoutMinor: 0 });
  }));
  app.patch('/api/admin/affiliate-settings', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ affiliateEnabled: z.boolean().optional(), affiliateFundingConfigured: z.boolean().optional(), affiliateAttributionRule: z.nativeEnum(AffiliateAttributionRule).optional(), affiliateAttributionWindowDays: z.number().int().min(1).max(365).optional(), affiliateMinimumPayoutMinor: z.number().int().nonnegative().optional(), reason: z.string().trim().max(500).optional() }).parse(req.body);
    const old = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    const data = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'reason' && value !== undefined));
    const updated = await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: data, create: { id: 'default', ...data } });
    await audit(user.id, 'AFFILIATE_SETTINGS_CHANGED', 'MarketplaceSettings', 'default', { old: { enabled: old?.affiliateEnabled, fundingConfigured: old?.affiliateFundingConfigured, attributionRule: old?.affiliateAttributionRule, windowDays: old?.affiliateAttributionWindowDays, minimumPayoutMinor: old?.affiliateMinimumPayoutMinor }, new: data, reason: input.reason });
    res.json(updated);
  }));
  app.get('/api/admin/affiliates', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.affiliateProfile.findMany({ include: { user: { select: { email: true, name: true } }, _count: { select: { clicks: true, commissions: true, payouts: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));
  app.patch('/api/admin/affiliates/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(AffiliateStatus), reason: z.string().trim().max(500).optional() }).parse(req.body); const profile = await prisma.affiliateProfile.update({ where: { id: param(req.params.id) }, data: { status: input.status, reviewNote: input.reason, reviewedById: user.id, reviewedAt: new Date() } }); await audit(user.id, `AFFILIATE_${input.status}`, 'AffiliateProfile', profile.id, { reason: input.reason }); res.json(profile); }));
  app.patch('/api/admin/affiliate-commissions/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.enum(['APPROVED', 'PAYABLE', 'REVERSED']), reason: z.string().trim().max(500).optional() }).parse(req.body); const entry = await prisma.commissionLedger.update({ where: { id: param(req.params.id) }, data: { status: input.status as CommissionStatus, reason: input.reason } }); await audit(user.id, `AFFILIATE_COMMISSION_${input.status}`, 'CommissionLedger', entry.id, { reason: input.reason }); res.json(entry); }));
  app.get('/api/admin/affiliate-payouts', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.affiliatePayout.findMany({ include: { affiliate: { include: { user: { select: { email: true, name: true } } } }, items: true }, orderBy: { createdAt: 'desc' }, take: 100 }))));
  app.patch('/api/admin/affiliate-payouts/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ status: z.nativeEnum(AffiliatePayoutStatus), reference: z.string().trim().max(200).optional(), reviewNote: z.string().trim().max(500).optional() }).parse(req.body);
    const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
    if (input.status === AffiliatePayoutStatus.PAID && (!settings?.affiliateFundingConfigured || !input.reference)) return res.status(409).json({ error: 'A configured funding policy and confirmed payout reference are required before marking paid' });
    const existing = await prisma.affiliatePayout.findUnique({ where: { id: param(req.params.id) }, include: { items: true } });
    if (!existing) return res.status(404).json({ error: 'Payout not found' });
    const payout = await prisma.$transaction(async tx => {
      const updated = await tx.affiliatePayout.update({ where: { id: existing.id }, data: { status: input.status, reference: input.reference, reviewNote: input.reviewNote, reviewedById: user.id, reviewedAt: new Date(), ...(input.status === AffiliatePayoutStatus.PAID ? { paidAt: new Date() } : {}) } });
      if (input.status === AffiliatePayoutStatus.PAID) for (const item of existing.items) await tx.commissionLedger.update({ where: { id: item.commissionId }, data: { status: CommissionStatus.PAID } });
      return updated;
    });
    await audit(user.id, `AFFILIATE_PAYOUT_${input.status}`, 'AffiliatePayout', payout.id, { reference: input.reference, reviewNote: input.reviewNote });
    res.json(payout);
  }));
  app.post('/api/admin/affiliate-adjustments', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const input = z.object({ orderId: z.string().cuid(), orderItemId: z.string().cuid().optional(), type: z.nativeEnum(AffiliateAdjustmentType), quantity: z.number().int().positive().optional(), amountMinor: z.number().int().positive().optional(), idempotencyKey: z.string().trim().min(8).max(200), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    const result = await reverseAffiliateForOrder(input.orderId, { ...input, createdById: user.id });
    await audit(user.id, 'AFFILIATE_ADJUSTMENT_CREATED', 'ParentOrder', input.orderId, { type: input.type, reversed: result.reversed, reason: input.reason });
    res.status(201).json(result);
  }));
  app.patch('/api/admin/wholesale/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.nativeEnum(WholesaleStatus), reason: z.string().trim().max(500).optional() }).parse(req.body); const application = await prisma.wholesaleApplication.update({ where: { id: param(req.params.id) }, data: { status: input.status, reviewedById: user.id, reviewedAt: new Date() } }); await audit(user.id, `WHOLESALE_${input.status}`, 'WholesaleApplication', application.id, { reason: input.reason }); res.json(application); }));
  app.patch('/api/admin/affiliate-payouts/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => { const user = res.locals.user as { id: string }; const input = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'PAID']), reference: z.string().trim().max(200).optional() }).parse(req.body); const payout = await prisma.affiliatePayout.update({ where: { id: param(req.params.id) }, data: { status: input.status, reference: input.reference, reviewedById: user.id, reviewedAt: new Date(), ...(input.status === 'PAID' ? { paidAt: new Date() } : {}) } }); await audit(user.id, `AFFILIATE_PAYOUT_${input.status}`, 'AffiliatePayout', payout.id, { reference: input.reference }); res.json(payout); }));
}
