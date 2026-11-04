import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { Prisma, ProductStatus, ReferralSource, Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { availableGlobalDisplayCurrencies } from './currency-routes.js';
import { onboardingCompletionBlock, onboardingCompletionSchema } from './onboarding-domain.js';
import { defaultOnboardingExperience, onboardingExperienceSchema } from './onboarding-experience-domain.js';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string; role: Role };
const storeIdSchema = z.string().cuid();

const eligibleProductWhere: Prisma.ProductWhereInput = {
  status: ProductStatus.APPROVED,
  inventory: { quantity: { gt: 0 } }
};

const approvedActiveSellerWhere: Prisma.SellerWhereInput = {
  status: SellerStatus.APPROVED,
  user: { accountStatus: 'ACTIVE' }
};

const officialStoreWhere: Prisma.StoreWhereInput = {
  isPlatformStore: true,
  seller: approvedActiveSellerWhere
};

const independentEligibleStoreWhere: Prisma.StoreWhereInput = {
  isPlatformStore: false,
  seller: {
    ...approvedActiveSellerWhere,
    products: { some: eligibleProductWhere }
  }
};

const eligibleStoreWhere: Prisma.StoreWhereInput = {
  OR: [officialStoreWhere, independentEligibleStoreWhere]
};

const onboardingStoreSelect = (userId: string) => ({
    id: true,
    name: true,
    slug: true,
    description: true,
    isPlatformStore: true,
    logoMediaId: true,
    logoMedia: { select: { uploadStatus: true, scanStatus: true } },
    follows: { where: { userId }, select: { userId: true } },
    _count: { select: { follows: true } },
    seller: {
      select: {
        products: {
          where: eligibleProductWhere,
          select: { category: { select: { name: true } } },
          take: 8
        }
      }
    }
}) satisfies Prisma.StoreSelect;

async function currenciesForOnboarding() {
  const currentlyAvailable = await availableGlobalDisplayCurrencies();
  if (!currentlyAvailable.length) return [];
  const entries = await prisma.currencyCatalogEntry.findMany({
    where: { code: { in: currentlyAvailable }, active: true, displayEnabled: true },
    select: { code: true, name: true, symbol: true },
    orderBy: [{ region: 'asc' }, { name: 'asc' }]
  });
  return entries;
}

function publishedBrandAssets(value: unknown) {
  const branding = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mediaId = (item: unknown) => typeof item === 'string' && item.length <= 128 ? item : null;
  return {
    platformName: typeof branding.platformName === 'string' && branding.platformName.trim() ? branding.platformName.trim() : null,
    tagline: typeof branding.tagline === 'string' ? branding.tagline : '',
    logoMediaId: mediaId(branding.logoMediaId) ?? mediaId(branding.alternateLogoMediaId),
    bannerMediaId: mediaId(branding.socialImageMediaId)
  };
}

function memberOnboardingExperience(value: unknown, tagline = '') {
  const parsed = value ? onboardingExperienceSchema.safeParse(value).data : null;
  const experience = parsed ?? { ...defaultOnboardingExperience, welcome: { ...defaultOnboardingExperience.welcome, description: tagline.trim() || defaultOnboardingExperience.welcome.description } };
  return { ...experience, welcome: { ...experience.welcome, logoUrl: experience.welcome.logoMediaId ? `/content-media/${encodeURIComponent(experience.welcome.logoMediaId)}` : null, heroUrl: experience.welcome.heroMediaId ? `/content-media/${encodeURIComponent(experience.welcome.heroMediaId)}` : null } };
}

async function listEligibleStores(userId: string) {
  const officialStore = await prisma.store.findFirst({ where: officialStoreWhere, select: onboardingStoreSelect(userId) });
  const independentStores = await prisma.store.findMany({
    where: independentEligibleStoreWhere,
    select: onboardingStoreSelect(userId),
    orderBy: [{ follows: { _count: 'desc' } }, { name: 'asc' }],
    take: officialStore ? 7 : 8
  });
  const stores = officialStore ? [officialStore, ...independentStores] : independentStores;

  return stores.map(store => {
    const category = store.seller.products.find(product => product.category?.name)?.category?.name ?? null;
    const logoMediaId = store.logoMedia && store.logoMedia.uploadStatus === 'COMPLETE' && store.logoMedia.scanStatus === 'APPROVED' ? store.logoMediaId : null;
    return {
      id: store.id,
      name: store.name,
      slug: store.slug,
      description: store.description,
      isOfficial: store.isPlatformStore,
      category,
      logoUrl: logoMediaId ? `/content-media/${encodeURIComponent(logoMediaId)}` : null,
      following: store.follows.length > 0,
      followerCount: store._count.follows
    };
  });
}

async function eligibleFollowStoreIds(tx: Prisma.TransactionClient, userId: string) {
  const independentRows = await tx.$queryRaw<Array<{ storeId: string }>>`
    SELECT s."id" AS "storeId"
    FROM "StoreFollow" AS f
    JOIN "Store" AS s ON s."id" = f."storeId"
    JOIN "Seller" AS seller ON seller."id" = s."sellerId"
    JOIN "User" AS owner ON owner."id" = seller."userId"
    JOIN "Product" AS p ON p."sellerId" = seller."id" AND p."status" = 'APPROVED'::"ProductStatus"
    JOIN "Inventory" AS inventory ON inventory."productId" = p."id" AND inventory."quantity" > 0
    WHERE f."userId" = ${userId}
      AND s."isPlatformStore" = FALSE
      AND seller."status" = 'APPROVED'::"SellerStatus"
      AND owner."accountStatus" = 'ACTIVE'
    FOR SHARE OF f, s, seller, owner, p, inventory
  `;
  const officialRows = await tx.$queryRaw<Array<{ storeId: string }>>`
    SELECT s."id" AS "storeId"
    FROM "StoreFollow" AS f
    JOIN "Store" AS s ON s."id" = f."storeId"
    JOIN "Seller" AS seller ON seller."id" = s."sellerId"
    JOIN "User" AS owner ON owner."id" = seller."userId"
    WHERE f."userId" = ${userId}
      AND s."isPlatformStore" = TRUE
      AND seller."status" = 'APPROVED'::"SellerStatus"
      AND owner."accountStatus" = 'ACTIVE'
    FOR SHARE OF f, s, seller, owner
  `;
  return [...new Set([...independentRows, ...officialRows].map(row => row.storeId))];
}

export function registerOnboardingRoutes(app: Express) {
  app.get('/api/onboarding', requireAuth, run(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.view === 'experience') {
      const [branding, onboardingExperience] = await Promise.all([
        prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } }),
        prisma.onboardingExperience.findUnique({ where: { id: 'default' }, select: { publishedJson: true } })
      ]);
      const brand = publishedBrandAssets(branding?.publishedJson);
      return res.json({ experience: memberOnboardingExperience(onboardingExperience?.publishedJson, brand.tagline) });
    }
    const userId = actor(res).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, avatarMediaId: true, onboardingCompletedAt: true, referralSource: true, referralOther: true, preference: { select: { displayCurrency: true } } }
    });
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (user.onboardingCompletedAt) return res.json({ completed: true, completedAt: user.onboardingCompletedAt });

    const [stores, eligibleStoreCount, currencies, branding, onboardingExperience] = await Promise.all([
      listEligibleStores(userId),
      prisma.store.count({ where: eligibleStoreWhere }),
      currenciesForOnboarding(),
      prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } }),
      prisma.onboardingExperience.findUnique({ where: { id: 'default' }, select: { publishedJson: true } })
    ]);
    const currentCurrency = user.preference?.displayCurrency;
    const defaultCurrency = currencies.some(currency => currency.code === currentCurrency)
      ? currentCurrency!
      : currencies.some(currency => currency.code === env.CURRENCY)
        ? env.CURRENCY
        : currencies[0]?.code ?? '';
    const brand = publishedBrandAssets(branding?.publishedJson);
    const experience = memberOnboardingExperience(onboardingExperience?.publishedJson, brand.tagline);

    res.json({
      completed: false,
      account: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarMediaId ? '/api/account/avatar' : null },
      brand: { ...brand, logoUrl: brand.logoMediaId ? `/content-media/${encodeURIComponent(brand.logoMediaId)}` : null, bannerUrl: brand.bannerMediaId ? `/content-media/${encodeURIComponent(brand.bannerMediaId)}` : null },
      experience,
      stores,
      eligibleStoreCount,
      minimumStores: 2,
      currencies,
      baseCurrency: env.CURRENCY,
      defaultCurrency,
      currencyError: currencies.length ? null : 'No currencies are currently enabled for marketplace display. Please ask an administrator to review Currency catalog & FX settings.',
      referralSource: user.referralSource,
      referralOther: user.referralOther
    });
  }));

  app.post('/api/onboarding/stores/:storeId/follow', requireAuth, run(async (req, res) => {
    const userId = actor(res).id;
    z.object({}).strict().parse(req.body ?? {});
    const storeId = storeIdSchema.parse(Array.isArray(req.params.storeId) ? req.params.storeId[0] : req.params.storeId);
    const eligible = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const store = await tx.store.findFirst({ where: { id: storeId, ...eligibleStoreWhere }, select: { id: true } });
      if (!store) return false;
      await tx.storeFollow.createMany({ data: [{ userId, storeId }], skipDuplicates: true });
      return true;
    });
    if (!eligible) return res.status(404).json({ error: 'This store is not currently eligible to be followed.' });
    res.json({ storeId, following: true });
  }));

  app.delete('/api/onboarding/stores/:storeId/follow', requireAuth, run(async (req, res) => {
    const userId = actor(res).id;
    const storeId = storeIdSchema.parse(Array.isArray(req.params.storeId) ? req.params.storeId[0] : req.params.storeId);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      await tx.storeFollow.deleteMany({ where: { userId, storeId } });
    });
    res.json({ storeId, following: false });
  }));

  app.post('/api/onboarding/complete', requireAuth, run(async (req, res) => {
    const userId = actor(res).id;
    const input = onboardingCompletionSchema.parse(req.body);
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { onboardingCompletedAt: true } });
    if (!current) return res.status(401).json({ error: 'Authentication required.' });
    if (current.onboardingCompletedAt) return res.json({ completed: true, alreadyCompleted: true, completedAt: current.onboardingCompletedAt });

    const allowedCurrencies = await currenciesForOnboarding();
    if (!allowedCurrencies.some(currency => currency.code === input.displayCurrency)) {
      return res.status(409).json({ error: 'That currency is no longer enabled for marketplace display. Refresh and choose an available currency.', code: 'ONBOARDING_CURRENCY_UNAVAILABLE' });
    }

    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { onboardingCompletedAt: true, referralSource: true, referralOther: true } });
      if (!user) return { completed: false as const, status: 401, error: 'Authentication required.' };
      if (user.onboardingCompletedAt) return { completed: true as const, alreadyCompleted: true, completedAt: user.onboardingCompletedAt };

      const lockedCurrency = await tx.$queryRaw<Array<{ code: string }>>`
        SELECT "code" FROM "CurrencyCatalogEntry"
        WHERE "code" = ${input.displayCurrency} AND "active" = TRUE AND "displayEnabled" = TRUE
        FOR SHARE
      `;
      if (!lockedCurrency.length) return { completed: false as const, status: 409, error: 'That currency is no longer enabled for marketplace display. Refresh and choose an available currency.', code: 'ONBOARDING_CURRENCY_UNAVAILABLE' };

      const storeIds = await eligibleFollowStoreIds(tx, userId);
      const block = onboardingCompletionBlock({ eligibleFollowCount: storeIds.length, currencyAvailable: true });
      if (block) return { completed: false as const, status: 409, ...block };

      await tx.userPreference.upsert({
        where: { userId },
        update: { displayCurrency: input.displayCurrency },
        create: { userId, displayCurrency: input.displayCurrency }
      });
      const completedAt = new Date();
      const referralSource = user.referralSource ?? input.referralSource as ReferralSource;
      const referralOther = user.referralSource ? user.referralOther : input.referralSource === 'OTHER' ? input.referralOther ?? null : null;
      await tx.user.update({
        where: { id: userId },
        data: { onboardingCompletedAt: completedAt, referralSource, referralOther }
      });
      await tx.auditLog.create({ data: { actorId: userId, action: 'USER_ONBOARDING_COMPLETED', entity: 'User', entityId: userId, metadata: { followedStoreCount: storeIds.length, displayCurrency: input.displayCurrency, referralSource } } });
      return { completed: true as const, alreadyCompleted: false, completedAt };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 15_000 });

    if (!result.completed) return res.status(result.status).json({ error: result.error, ...('code' in result ? { code: result.code } : {}) });
    res.json(result);
  }));

  app.get('/api/admin/onboarding/readiness', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [eligibleStoreCount, currencies, pendingAccountCount] = await Promise.all([
      prisma.store.count({ where: eligibleStoreWhere }),
      currenciesForOnboarding(),
      prisma.user.count({ where: { onboardingCompletedAt: null } })
    ]);
    res.json({ eligibleStoreCount, minimumStores: 2, ready: eligibleStoreCount >= 2 && currencies.length > 0, availableCurrencyCount: currencies.length, pendingAccountCount });
  }));
}
