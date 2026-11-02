import crypto from 'node:crypto';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { MediaKind, MediaPurpose, MediaScanStatus, MediaStorageProvider, MediaUploadStatus, MarketplaceProductAdPlacement, MarketplaceProductAdStatus, Prisma, ProductStatus, Role, SellerStatus, WalletAccountStatus, WalletAccountType, WalletBalanceState, WalletLedgerEntryType, WalletLedgerStatus, WalletPostingDirection } from '@prisma/client';
import { z } from 'zod';
import sharp from 'sharp';
import { env } from './config.js';
import { localContentStorage, objectContentStorage } from './content-storage.js';
import type { ContentStorage } from './content-storage.js';
import { detectStoreMedia } from './store-media-routes.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { appendWalletAllocations, recordWalletStateTransition } from './wallet-ledger.js';
import { assertBalancedPostings } from './wallet-domain.js';
import { createRoleNotifications, createUserNotification } from './notification-delivery.js';
import { adCreatorFailure, adCreativeLimitFailure, MARKETPLACE_AD_PLACEMENTS, marketplaceAdDestination, marketplaceAdPricePerView, sellerAdProductFailure, validMarketplaceAdPlacements, type MarketplaceAdCreativeKind, type MarketplaceAdDestination, type MarketplaceAdRole } from './marketplace-ad-domain.js';
import { availableGlobalDisplayCurrencies, latestDisplayRate } from './currency-routes.js';
import { convertQuotedMinorToBaseMinor } from './store-buster-sponsored-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const jsonInput = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const storage: ContentStorage | null = objectContentStorage ?? (env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? localContentStorage : null);
const scanner: MalwareScanner | null = malwareScanner;
const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const publicLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const imageExtensions: Record<string, string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'] };
const videoExtensions: Record<string, string[]> = { 'video/mp4': ['mp4', 'm4v'], 'video/quicktime': ['mov'], 'video/webm': ['webm'], 'video/ogg': ['ogv', 'ogg'] };
const marketplaceAdBlogCss = `
.marketplace-ad-blog-slot{display:grid;gap:1rem;margin:2rem 0;padding:1.25rem;border:1px solid #d8e1d9;border-radius:1rem;background:#f7faf7;font:16px/1.5 system-ui,sans-serif;color:#19251f}
.marketplace-ad-blog-slot[hidden]{display:none}.marketplace-ad-blog-slot h2{margin:0;font-size:1.2rem}.marketplace-ad-blog-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:1rem}
.marketplace-ad-blog-card{overflow:hidden;border:1px solid #d8e1d9;border-radius:.8rem;background:#fff}.marketplace-ad-blog-card img,.marketplace-ad-blog-card video{display:block;width:100%;max-height:240px;object-fit:cover;background:#eaf0ea}.marketplace-ad-blog-card>div{padding:1rem}.marketplace-ad-blog-card p{margin:.5rem 0;color:#5d6c62}.marketplace-ad-blog-label{font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#b64c2e}.marketplace-ad-blog-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}.marketplace-ad-blog-actions a{display:inline-flex;padding:.55rem .8rem;border:1px solid #cbd8ce;border-radius:999px;color:#315d47;text-decoration:none;font-weight:650}.marketplace-ad-blog-actions a:first-child{background:#315d47;color:#fff}
@media(max-width:600px){.marketplace-ad-blog-slot{padding:1rem;margin:1.25rem 0}}
`;
const marketplaceAdBlogClient = `
(() => {
  const slots = Array.from(document.querySelectorAll('[data-marketplace-ad-placement="BLOG_POSTS"]'));
  if (!slots.length) return;
  const api = '/api/marketplace-ads';
  const token = () => document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1] || '';
  const request = (url, options) => fetch(url, { credentials: 'include', ...options, headers: { ...(options && options.body ? { 'Content-Type': 'application/json' } : {}), ...(token() ? { 'x-csrf-token': token() } : {}), ...((options && options.headers) || {}) } });
  const visible = (node, run) => {
    let done = false, timer;
    const mark = () => { if (done || document.visibilityState !== 'visible') return; done = true; run(); observer && observer.disconnect(); };
    const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5) && document.visibilityState === 'visible') { if (!timer) timer = setTimeout(mark, 1000); } else clear(); }, { threshold: .5 }) : null;
    if (observer) observer.observe(node);
    else timer = setTimeout(() => { const r=node.getBoundingClientRect(); if (r.width && r.height && r.bottom>0 && r.top<innerHeight) mark(); else clear(); }, 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') clear(); });
  };
  const link = (label, destination, ad, type) => { const a=document.createElement('a'); a.textContent=label; a.href=destination; a.rel='nofollow sponsored noopener'; a.addEventListener('click', event => { event.preventDefault(); request(api+'/'+encodeURIComponent(ad.id)+'/impression', { method:'POST', body:JSON.stringify({ impressionToken:ad.impressionToken }), keepalive:true }).then(() => request(api+'/'+encodeURIComponent(ad.id)+'/click', { method:'POST', body:JSON.stringify({ impressionToken:ad.impressionToken, destination:type }), keepalive:true })).then(r => r.ok ? r.json() : Promise.reject()).then(data => location.assign(data.destination)).catch(() => location.assign(destination)); }); return a; };
  request(api+'/featured?placement=BLOG_POSTS').then(r => r.ok ? r.json() : {items:[]}).then(data => {
    const items=Array.isArray(data.items) ? data.items : [];
    if (!items.length) return;
    slots.forEach(slot => {
      const grid=document.createElement('div'); grid.className='marketplace-ad-blog-grid';
      items.forEach(ad => {
        const card=document.createElement('article'); card.className='marketplace-ad-blog-card';
        const creative=(ad.creatives||[])[0];
        if (creative && creative.kind==='VIDEO') { const video=document.createElement('video'); video.src=creative.url; video.controls=true; video.playsInline=true; video.preload='metadata'; video.setAttribute('aria-label',ad.headline+' video'); card.append(video); }
        else { const image=document.createElement('img'); image.src=creative ? creative.url : (ad.product.image && ad.product.image.url) || ''; image.alt=ad.headline || ad.product.name; image.loading='lazy'; if(image.src) card.append(image); }
        const body=document.createElement('div'), label=document.createElement('p'), title=document.createElement('h3'), description=document.createElement('p'), actions=document.createElement('div');
        label.className='marketplace-ad-blog-label'; label.textContent='Sponsored · marketplace ad'; title.textContent=ad.headline; description.textContent=ad.description; actions.className='marketplace-ad-blog-actions';
        actions.append(link('View product','/products/'+encodeURIComponent(ad.product.id),ad,'PRODUCT'));
        if(ad.store && ad.store.slug) actions.append(link('Visit store','/store/'+encodeURIComponent(ad.store.slug),ad,'STORE'));
        if(ad.externalUrl && ad.externalUrl.toLowerCase().startsWith('https://')) actions.append(link('Visit advertiser',ad.externalUrl,ad,'EXTERNAL'));
        body.append(label,title,description,actions); card.append(body); grid.append(card);
        visible(card, () => request(api+'/'+encodeURIComponent(ad.id)+'/impression', { method:'POST', body:JSON.stringify({ impressionToken:ad.impressionToken }), keepalive:true }).catch(() => undefined));
      });
      slot.append(grid); slot.hidden=false;
    });
  }).catch(() => undefined);
})();
`;
type Actor = { id: string; role: Role; sellerId?: string };
const actor = (res: Response) => res.locals.user as Actor;

const draftSchema = z.object({
  productId: z.string().min(1).max(80),
  headline: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(1000),
  externalUrl: z.string().trim().max(2000).optional().nullable(),
  messageEnabled: z.boolean().default(true),
  placements: z.array(z.enum(MARKETPLACE_AD_PLACEMENTS)).min(1).max(MARKETPLACE_AD_PLACEMENTS.length).refine(validMarketplaceAdPlacements, 'Choose one or more unique supported ad placements.').default(['MARKETPLACE_HOME']),
  budgetMinor: z.number().int().positive().max(2_000_000_000),
  budgetCurrency: z.string().length(3).transform(value => value.toUpperCase()).optional(),
  durationDays: z.number().int().min(1).max(365)
}).strict();
const settingsSchema = z.object({
  enabled: z.boolean(),
  moderationRequired: z.literal(true),
  minimumBudgetMinor: z.number().int().positive().max(2_000_000_000),
  maximumBudgetMinor: z.number().int().positive().max(2_000_000_000),
  pricePerHundredViewsMinor: z.number().int().min(100).max(2_000_000_000).refine(value => value % 100 === 0, 'Price per 100 views must divide evenly into whole currency minor units.'),
  maxDurationDays: z.number().int().min(1).max(365),
  reason: z.string().trim().min(3).max(500)
}).strict()
  .refine(value => value.maximumBudgetMinor >= value.minimumBudgetMinor, 'Maximum ad budget must be at least the minimum.')
  .refine(value => value.minimumBudgetMinor >= value.pricePerHundredViewsMinor / 100, 'Minimum budget must cover at least one view.');

function safeExternalUrl(value: string | null | undefined) {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw fail(400, 'External destination must be a valid HTTPS link.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw fail(400, 'External destination must use HTTPS and cannot include credentials or a localhost host.');
  return url.toString();
}

async function adSettings() {
  return prisma.marketplaceProductAdSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
}

function configuredPricePerView(rateMinor: number) {
  const price = marketplaceAdPricePerView(rateMinor);
  if (price === null) throw fail(409, 'Marketplace ad view pricing is not configured safely. Ask an administrator to review the policy.');
  return price;
}

async function resolveMarketplaceAdBudget(inputMinor: number, inputCurrency: string) {
  const [base, quote] = await Promise.all([
    prisma.currencyCatalogEntry.findUnique({ where: { code: env.CURRENCY }, select: { code: true, minorUnitExponent: true, active: true } }),
    prisma.currencyCatalogEntry.findUnique({ where: { code: inputCurrency }, select: { code: true, minorUnitExponent: true, active: true, displayEnabled: true } })
  ]);
  if (!base?.active || !quote?.active || (inputCurrency !== env.CURRENCY && !quote.displayEnabled)) throw fail(409, 'The selected ad budget currency is not currently enabled for display by the platform. Choose another currency.');
  const identityTimestamp = new Date().toISOString();
  const rate = inputCurrency === env.CURRENCY
    ? { rate: '1', provider: 'IDENTITY', sourceDate: identityTimestamp.slice(0, 10), fetchedAt: identityTimestamp, freshness: 'fresh' as const }
    : await latestDisplayRate(env.CURRENCY, inputCurrency);
  if (!rate || rate.freshness === 'stale') throw fail(409, `A current ${env.CURRENCY}/${inputCurrency} reference rate is unavailable. Refresh platform FX rates before saving this budget.`);
  const platformMinor = inputCurrency === env.CURRENCY
    ? BigInt(inputMinor)
    : convertQuotedMinorToBaseMinor(BigInt(inputMinor), rate.rate, base.minorUnitExponent, quote.minorUnitExponent);
  if (platformMinor <= 0n || platformMinor > 2_000_000_000n) throw fail(400, 'The converted campaign budget is outside the supported platform-currency range.');
  return { platformMinor: Number(platformMinor), inputMinor, inputCurrency, fxRate: rate.rate, fxProvider: rate.provider, fxSourceDate: rate.sourceDate, fxFetchedAt: rate.fetchedAt };
}

async function marketplaceAdBudgetCurrencies(userId: string) {
  const [allowedCodes, preference] = await Promise.all([
    availableGlobalDisplayCurrencies(),
    prisma.userPreference.findUnique({ where: { userId }, select: { displayCurrency: true } })
  ]);
  const preferredCurrency = preference?.displayCurrency && allowedCodes.includes(preference.displayCurrency) ? preference.displayCurrency : env.CURRENCY;
  const entries = await prisma.currencyCatalogEntry.findMany({ where: { active: true, code: { in: [...new Set([env.CURRENCY, preferredCurrency])] } }, orderBy: [{ region: 'asc' }, { name: 'asc' }], select: { code: true, name: true, symbol: true, minorUnitExponent: true } });
  const resolved = await Promise.all(entries.map(async entry => {
    const rate = await latestDisplayRate(env.CURRENCY, entry.code);
    return rate && rate.freshness !== 'stale' ? { ...entry, platformToCurrencyRate: rate.rate } : null;
  }));
  const currencies = resolved.filter((item): item is NonNullable<typeof item> => item !== null);
  if (!currencies.some(item => item.code === env.CURRENCY)) {
    const base = await prisma.currencyCatalogEntry.findUnique({ where: { code: env.CURRENCY }, select: { code: true, name: true, symbol: true, minorUnitExponent: true } });
    currencies.unshift({ code: env.CURRENCY, name: base?.name ?? env.CURRENCY, symbol: base?.symbol ?? env.CURRENCY, minorUnitExponent: base?.minorUnitExponent ?? 2, platformToCurrencyRate: '1' });
  }
  const selectedCurrency = currencies.some(item => item.code === preferredCurrency) ? preferredCurrency : env.CURRENCY;
  return { currencies, preferredCurrency: selectedCurrency };
}

async function ensureWalletBalance(tx: Prisma.TransactionClient, accountId: string, currency: string) {
  return tx.walletBalance.upsert({ where: { accountId_currency: { accountId, currency } }, update: {}, create: { accountId, currency } });
}

async function eligibleProduct(productId: string, user: Actor) {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      status: ProductStatus.APPROVED,
      inventory: { quantity: { gt: 0 } },
      seller: { status: SellerStatus.APPROVED, store: { isNot: null } }
    },
    include: { inventory: true, seller: { include: { store: true } }, images: { orderBy: { id: 'asc' }, take: 1 }, category: { select: { name: true } } }
  });
  if (!product || !product.seller?.store) throw fail(409, 'Select an approved, in-stock marketplace product from an approved Store.');
  const ownershipFailure = sellerAdProductFailure(user.role as MarketplaceAdRole, user.sellerId, product.sellerId);
  if (ownershipFailure) throw fail(403, ownershipFailure);
  return product;
}

function assertAdCreator(user: Actor) {
  const reason = adCreatorFailure(user.role as MarketplaceAdRole);
  if (reason) throw fail(403, reason);
}

const publicMarketplaceAdInclude = {
  product: { include: { inventory: true, images: { take: 1 }, category: { select: { name: true } } } },
  store: { select: { id: true, name: true, slug: true } },
  creatives: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, scanStatus: true, uploadStatus: true } } } }
} satisfies Prisma.MarketplaceProductAdInclude;

type PublicMarketplaceAd = Prisma.MarketplaceProductAdGetPayload<{ include: typeof publicMarketplaceAdInclude }> & { impressionToken: string };

function publicAdShape(ad: PublicMarketplaceAd) {
  const creatives = ad.creatives.filter(creative => creative.mediaAsset.scanStatus === MediaScanStatus.APPROVED && creative.mediaAsset.uploadStatus === MediaUploadStatus.COMPLETE);
  return {
    id: ad.id,
    headline: ad.headline,
    description: ad.description,
    externalUrl: ad.externalUrl,
    messageEnabled: ad.messageEnabled,
    impressionToken: ad.impressionToken,
    product: {
      id: ad.product.id,
      name: ad.product.name,
      slug: ad.product.slug,
      description: ad.product.description,
      priceMinor: ad.product.priceMinor,
      salePriceMinor: ad.product.salePriceMinor,
      currency: ad.product.currency,
      availableStock: ad.product.inventory?.quantity ?? 0,
      category: ad.product.category?.name ?? null,
      image: ad.product.images?.[0] ?? null
    },
    store: ad.store ? { id: ad.store.id, name: ad.store.name, slug: ad.store.slug } : null,
    creatives: creatives.map(creative => ({ id: creative.mediaAsset.id, kind: creative.mediaAsset.kind, name: creative.mediaAsset.originalName, url: `/api/marketplace-ads/${encodeURIComponent(ad.id)}/media/${encodeURIComponent(creative.mediaAsset.id)}` }))
  };
}

async function releaseReserved(tx: Prisma.TransactionClient, ad: { id: string; ownerId: string; currency: string; reservedMinor: number }) {
  if (ad.reservedMinor <= 0) return;
  const account = await tx.walletAccount.findUnique({ where: { userId: ad.ownerId } });
  if (!account) throw fail(409, 'The advertiser wallet is unavailable; funds remain reserved for reconciliation.');
  await recordWalletStateTransition(tx, { accountId: account.id, currency: ad.currency, fromState: WalletBalanceState.HELD, toState: WalletBalanceState.AVAILABLE, amountMinor: ad.reservedMinor, referenceId: ad.id, idempotencyKey: `marketplace-ad:${ad.id}:release:${crypto.randomUUID()}` });
  await tx.marketplaceProductAd.update({ where: { id: ad.id }, data: { reservedMinor: 0 } });
}

export async function releaseExpiredMarketplaceAdBudgets() {
  const expired = await prisma.marketplaceProductAd.findMany({ where: { status: MarketplaceProductAdStatus.APPROVED, endsAt: { lte: new Date() }, reservedMinor: { gt: 0 } }, select: { id: true, ownerId: true, currency: true, reservedMinor: true }, take: 100 });
  for (const ad of expired) {
    await prisma.$transaction(async tx => {
      const current = await tx.marketplaceProductAd.findUnique({ where: { id: ad.id }, select: { id: true, ownerId: true, currency: true, status: true, endsAt: true, reservedMinor: true, spentMinor: true } });
      if (!current || current.status !== MarketplaceProductAdStatus.APPROVED || !current.endsAt || current.endsAt > new Date()) return;
      const claimed = await tx.marketplaceProductAd.updateMany({ where: { id: current.id, status: MarketplaceProductAdStatus.APPROVED, reservedMinor: current.reservedMinor, endsAt: { lte: new Date() } }, data: { status: MarketplaceProductAdStatus.COMPLETED } });
      if (claimed.count !== 1) return;
      await releaseReserved(tx, current);
      await tx.auditLog.create({ data: { action: 'MARKETPLACE_AD_BUDGET_EXPIRED', entity: 'MarketplaceProductAd', entityId: ad.id, metadata: jsonInput({ unspentReleasedMinor: current.reservedMinor, spentMinor: current.spentMinor, currency: current.currency }) } });
    });
  }
  await prisma.marketplaceProductAdImpression.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}

function rawUploadParser(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: 'application/octet-stream', limit: env.CONTENT_MAX_VIDEO_BYTES })(req, res, error => {
    if (!error) return next();
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: number }).status) : 400;
    return res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? 'File exceeds the configured upload limit.' : 'The upload could not be read.' });
  });
}

export function registerMarketplaceAdRoutes(app: Express) {
  app.get('/api/marketplace-ads/blog-placement.js', publicLimit, (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(marketplaceAdBlogClient);
  });
  app.get('/api/marketplace-ads/placement.css', publicLimit, (_req, res) => {
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(marketplaceAdBlogCss);
  });
  app.get('/api/marketplace-ads/settings', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await adSettings())));
  app.patch('/api/marketplace-ads/settings', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = settingsSchema.parse(req.body);
    const updated = await prisma.marketplaceProductAdSettings.upsert({ where: { id: 'default' }, update: { enabled: input.enabled, moderationRequired: true, minimumBudgetMinor: input.minimumBudgetMinor, maximumBudgetMinor: input.maximumBudgetMinor, pricePerHundredViewsMinor: input.pricePerHundredViewsMinor, maxDurationDays: input.maxDurationDays, updatedById: user.id }, create: { id: 'default', enabled: input.enabled, moderationRequired: true, minimumBudgetMinor: input.minimumBudgetMinor, maximumBudgetMinor: input.maximumBudgetMinor, pricePerHundredViewsMinor: input.pricePerHundredViewsMinor, maxDurationDays: input.maxDurationDays, updatedById: user.id } });
    await prisma.auditLog.create({ data: { actorId: user.id, action: 'MARKETPLACE_AD_SETTINGS_UPDATED', entity: 'MarketplaceProductAdSettings', entityId: 'default', metadata: jsonInput({ enabled: input.enabled, minimumBudgetMinor: input.minimumBudgetMinor, maximumBudgetMinor: input.maximumBudgetMinor, pricePerHundredViewsMinor: input.pricePerHundredViewsMinor, maxDurationDays: input.maxDurationDays, billingModel: 'CPV', moderationRequired: true, reason: input.reason }) } });
    res.json(updated);
  }));

  app.get('/api/marketplace-ads/config', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const [settings, account, currency, budgetOptions] = await Promise.all([
      adSettings(),
      prisma.walletAccount.findUnique({ where: { userId: user.id }, include: { balances: { where: { currency: env.CURRENCY } } } }),
      prisma.currencyCatalogEntry.findUnique({ where: { code: env.CURRENCY }, select: { minorUnitExponent: true } }),
      marketplaceAdBudgetCurrencies(user.id)
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ settings, currency: env.CURRENCY, minorUnitExponent: currency?.minorUnitExponent ?? 2, budgetCurrencies: budgetOptions.currencies, preferredCurrency: budgetOptions.preferredCurrency, wallet: account ? { status: account.status, walletId: account.walletId, availableMinor: account.balances[0]?.availableMinor ?? 0, heldMinor: account.balances[0]?.heldMinor ?? 0 } : null, moneyMovementEnabled: !env.MONEY_MOVEMENT_HARD_DISABLED });
  }));

  app.get('/api/marketplace-ads/mine', requireAuth, run(async (_req, res) => {
    const ads = await prisma.marketplaceProductAd.findMany({ where: { ownerId: actor(res).id }, include: { product: { select: { id: true, name: true, slug: true } }, store: { select: { id: true, name: true, slug: true } }, creatives: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, originalName: true, kind: true, scanStatus: true, uploadStatus: true } } } }, metrics: { orderBy: { day: 'desc' }, take: 30 } }, orderBy: { updatedAt: 'desc' }, take: 100 });
    res.json({ items: ads });
  }));

  app.get('/api/marketplace-ads/products', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const products = await prisma.product.findMany({ where: { status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } }, seller: { status: SellerStatus.APPROVED, store: { isNot: null } }, ...(user.role === Role.SELLER ? { sellerId: user.sellerId ?? '__missing_seller_identity__' } : {}) }, include: { inventory: true, seller: { include: { store: true } }, images: { take: 1 }, category: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 });
    res.json({ items: products.map(product => ({ id: product.id, name: product.name, slug: product.slug, priceMinor: product.priceMinor, currency: product.currency, availableStock: product.inventory?.quantity ?? 0, category: product.category?.name ?? null, store: product.seller?.store ? { id: product.seller.store.id, name: product.seller.store.name, slug: product.seller.store.slug } : null, image: product.images[0] ?? null })) });
  }));

  app.post('/api/marketplace-ads', requireAuth, run(async (req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const input = draftSchema.parse(req.body);
    const [profile, settings] = await Promise.all([prisma.user.findUnique({ where: { id: user.id }, select: { emailVerifiedAt: true } }), adSettings()]);
    if (!profile?.emailVerifiedAt) throw fail(403, 'Verify your email before creating a paid ad.');
    if (!settings.enabled) throw fail(409, 'Marketplace ads are not accepting campaigns at this time.');
    const budget = await resolveMarketplaceAdBudget(input.budgetMinor, input.budgetCurrency ?? env.CURRENCY);
    if (budget.platformMinor < settings.minimumBudgetMinor || budget.platformMinor > settings.maximumBudgetMinor || input.durationDays > settings.maxDurationDays || budget.platformMinor < configuredPricePerView(settings.pricePerHundredViewsMinor)) throw fail(400, `Budget or duration is outside the current marketplace ad limits (measured in ${env.CURRENCY}).`);
    const product = await eligibleProduct(input.productId, user);
    const ad = await prisma.marketplaceProductAd.create({ data: { ownerId: user.id, productId: product.id, storeId: product.seller!.store!.id, headline: input.headline, description: input.description, externalUrl: safeExternalUrl(input.externalUrl), messageEnabled: input.messageEnabled, placements: input.placements as MarketplaceProductAdPlacement[], currency: env.CURRENCY, budgetMinor: budget.platformMinor, budgetInputMinor: budget.inputMinor, budgetInputCurrency: budget.inputCurrency, budgetFxRate: budget.fxRate, durationDays: input.durationDays } });
    await prisma.auditLog.create({ data: { actorId: user.id, action: 'MARKETPLACE_AD_DRAFT_CREATED', entity: 'MarketplaceProductAd', entityId: ad.id, metadata: jsonInput({ productId: product.id, storeId: product.seller!.store!.id, placements: input.placements, budgetInputMinor: budget.inputMinor, budgetInputCurrency: budget.inputCurrency, budgetMinor: budget.platformMinor, currency: env.CURRENCY, fxRate: budget.fxRate, fxProvider: budget.fxProvider, fxSourceDate: budget.fxSourceDate, fxFetchedAt: budget.fxFetchedAt }) } });
    res.status(201).json(ad);
  }));

  app.patch('/api/marketplace-ads/:id', requireAuth, run(async (req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const input = draftSchema.partial().parse(req.body);
    if (!Object.keys(input).length) throw fail(400, 'Provide at least one ad field to update.');
    const current = await prisma.marketplaceProductAd.findFirst({ where: { id: param(req.params.id), ownerId: user.id } });
    if (!current || (current.status !== MarketplaceProductAdStatus.DRAFT && current.status !== MarketplaceProductAdStatus.REJECTED)) throw fail(404, 'Editable draft ad not found.');
    if (current.status === MarketplaceProductAdStatus.REJECTED && current.reservedMinor) throw fail(409, 'The rejected campaign still has reserved funds; contact support before editing.');
    const settings = await adSettings();
    const product = input.productId ? await eligibleProduct(input.productId, user) : null;
    const budgetChanged = input.budgetMinor !== undefined || input.budgetCurrency !== undefined;
    const budget = budgetChanged
      ? await resolveMarketplaceAdBudget(input.budgetMinor ?? current.budgetInputMinor ?? current.budgetMinor, input.budgetCurrency ?? current.budgetInputCurrency ?? current.currency)
      : null;
    const budgetMinor = budget?.platformMinor ?? current.budgetMinor;
    const durationDays = input.durationDays ?? current.durationDays;
    if (budgetMinor < settings.minimumBudgetMinor || budgetMinor > settings.maximumBudgetMinor || durationDays > settings.maxDurationDays || budgetMinor < configuredPricePerView(settings.pricePerHundredViewsMinor)) throw fail(400, `Budget or duration is outside the current marketplace ad limits (measured in ${env.CURRENCY}).`);
    const updated = await prisma.marketplaceProductAd.update({ where: { id: current.id }, data: { ...(input.productId ? { productId: input.productId, storeId: product?.seller?.store?.id } : {}), ...(input.headline !== undefined ? { headline: input.headline } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.externalUrl !== undefined ? { externalUrl: safeExternalUrl(input.externalUrl) } : {}), ...(input.messageEnabled !== undefined ? { messageEnabled: input.messageEnabled } : {}), ...(input.placements !== undefined ? { placements: input.placements as MarketplaceProductAdPlacement[] } : {}), ...(budget ? { budgetMinor: budget.platformMinor, currency: env.CURRENCY, budgetInputMinor: budget.inputMinor, budgetInputCurrency: budget.inputCurrency, budgetFxRate: budget.fxRate } : {}), durationDays, ...(current.status === MarketplaceProductAdStatus.REJECTED ? { status: MarketplaceProductAdStatus.DRAFT, reviewNote: null, reviewerId: null, reviewedAt: null } : {}) } });
    res.json(updated);
  }));

  app.post('/api/marketplace-ads/:id/creatives', uploadLimit, requireAuth, rawUploadParser, run(async (req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const adId = param(req.params.id);
    const ad = await prisma.marketplaceProductAd.findFirst({ where: { id: adId, ownerId: user.id, status: MarketplaceProductAdStatus.DRAFT } });
    if (!ad) throw fail(404, 'Editable ad draft not found.');
    if (!storage) throw fail(503, 'Ad media storage is not configured for this deployment.');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw fail(400, 'Choose a non-empty image or video.');
    let originalName: string;
    try { originalName = decodeURIComponent(req.get('x-file-name') ?? '').trim(); } catch { throw fail(400, 'The file name is invalid.'); }
    const claimedMime = (req.get('x-file-type') ?? '').trim().toLowerCase();
    if (!originalName || originalName.length > 255 || /[\r\n\0]/.test(originalName)) throw fail(400, 'The file name is invalid.');
    const extension = path.extname(path.basename(originalName)).slice(1).toLowerCase();
    if (!imageExtensions[claimedMime]?.includes(extension) && !videoExtensions[claimedMime]?.includes(extension)) throw fail(415, 'Choose a PNG, JPEG, WebP, GIF, MP4, MOV, WebM, or Ogg image/video.');
    const detected = detectStoreMedia(req.body, extension, claimedMime);
    if (detected.kind !== MediaKind.IMAGE && detected.kind !== MediaKind.VIDEO) throw fail(415, 'Only image and video creatives are accepted.');
    if (req.body.length > (detected.kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : env.CONTENT_MAX_VIDEO_BYTES)) throw fail(413, 'Creative exceeds the configured media size limit.');
    const existingKinds = await prisma.marketplaceProductAdCreative.findMany({ where: { adId }, include: { mediaAsset: { select: { kind: true } } } });
    const creativeFailure = adCreativeLimitFailure(existingKinds.map(item => item.mediaAsset.kind as MarketplaceAdCreativeKind), detected.kind as MarketplaceAdCreativeKind);
    if (creativeFailure) throw fail(409, creativeFailure);
    let bytes = req.body as Buffer;
    let mime = detected.mime;
    let ext = detected.extension;
    let width: number | undefined;
    let height: number | undefined;
    if (detected.kind === MediaKind.IMAGE) {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw fail(415, 'The selected image could not be decoded safely.');
      width = metadata.width; height = metadata.height; bytes = await image.rotate().webp({ quality: 86 }).toBuffer(); mime = 'image/webp'; ext = 'webp';
    }
    const mediaId = crypto.randomUUID();
    const storageKey = `marketplace-ads/${ad.id}/${mediaId}.${ext}`;
    let stored = false;
    let persisted = false;
    try {
      await storage.put(storageKey, bytes, mime); stored = true;
      const creative = await prisma.$transaction(async tx => {
        const asset = await tx.mediaAsset.create({ data: { id: mediaId, storageKey, originalName: path.basename(originalName), safeName: `${mediaId}.${ext}`, kind: detected.kind, detectedMime: mime, sizeBytes: bytes.length, width, height, checksum: crypto.createHash('sha256').update(bytes).digest('hex'), uploaderId: user.id, purpose: MediaPurpose.MARKETPLACE_AD, uploadStatus: MediaUploadStatus.COMPLETE, storageProvider: objectContentStorage ? MediaStorageProvider.OBJECT : MediaStorageProvider.LOCAL, scanStatus: MediaScanStatus.QUARANTINED } });
        const position = await tx.marketplaceProductAdCreative.count({ where: { adId } });
        const link = await tx.marketplaceProductAdCreative.create({ data: { adId, mediaAssetId: asset.id, position } });
        return { asset, link };
      });
      persisted = true;
      const result = await scanQuarantinedMedia({ assetId: mediaId, bytes, scanner, actorId: user.id }).catch(() => ({ scanStatus: MediaScanStatus.QUARANTINED, scanErrorCode: 'SCANNER_UNAVAILABLE' }));
      return res.status(result.scanStatus === MediaScanStatus.APPROVED ? 201 : 202).json({ id: creative.asset.id, creativeId: creative.link.id, kind: creative.asset.kind, originalName: creative.asset.originalName, scanStatus: result.scanStatus, url: result.scanStatus === MediaScanStatus.APPROVED ? `/api/marketplace-ads/${ad.id}/media/${mediaId}` : null, message: result.scanStatus === MediaScanStatus.APPROVED ? 'Creative scanned and ready.' : 'Creative is private until the safety scan approves it.' });
    } catch (error) {
      if (stored && !persisted) await storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }));

  app.delete('/api/marketplace-ads/:id/creatives/:assetId', requireAuth, run(async (req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const creative = await prisma.marketplaceProductAdCreative.findFirst({ where: { adId: param(req.params.id), ad: { ownerId: user.id, status: MarketplaceProductAdStatus.DRAFT }, mediaAssetId: param(req.params.assetId) }, include: { mediaAsset: true } });
    if (!creative || creative.mediaAsset.purpose !== MediaPurpose.MARKETPLACE_AD) return res.status(404).json({ error: 'Creative not found.' });
    await prisma.$transaction(async tx => {
      await tx.marketplaceProductAdCreative.delete({ where: { id: creative.id } });
      await tx.mediaAsset.deleteMany({ where: { id: creative.mediaAssetId, uploaderId: user.id, purpose: MediaPurpose.MARKETPLACE_AD } });
    });
    const source = creative.mediaAsset.storageProvider === MediaStorageProvider.OBJECT ? objectContentStorage : localContentStorage;
    await source?.remove(creative.mediaAsset.storageKey).catch(() => undefined);
    res.status(204).send();
  }));

  app.post('/api/marketplace-ads/:id/submit', requireAuth, run(async (req, res) => {
    const user = actor(res);
    assertAdCreator(user);
    const adId = param(req.params.id);
    const [profile, settings, ad] = await Promise.all([prisma.user.findUnique({ where: { id: user.id }, select: { emailVerifiedAt: true, walletAccount: true } }), adSettings(), prisma.marketplaceProductAd.findFirst({ where: { id: adId, ownerId: user.id }, include: { creatives: { include: { mediaAsset: { select: { purpose: true, kind: true, scanStatus: true, uploadStatus: true } } } } } })]);
    if (!profile?.emailVerifiedAt) throw fail(403, 'Verify your email before submitting a paid ad.');
    if (!settings.enabled || !settings.moderationRequired) throw fail(409, 'Marketplace ads are not accepting moderated submissions.');
    if (!ad || (ad.status !== MarketplaceProductAdStatus.DRAFT && ad.status !== MarketplaceProductAdStatus.REJECTED)) throw fail(404, 'Editable ad draft not found.');
    const budget = await resolveMarketplaceAdBudget(ad.budgetInputMinor ?? ad.budgetMinor, ad.budgetInputCurrency ?? ad.currency);
    if (budget.platformMinor < settings.minimumBudgetMinor || budget.platformMinor > settings.maximumBudgetMinor || ad.durationDays > settings.maxDurationDays || budget.platformMinor < configuredPricePerView(settings.pricePerHundredViewsMinor)) throw fail(409, `The converted budget or duration is outside the current ad limits measured in ${env.CURRENCY}. Edit the draft and retry.`);
    if (ad.creatives.length > 11 || ad.creatives.filter(item => item.mediaAsset.kind === MediaKind.IMAGE).length > 10 || ad.creatives.filter(item => item.mediaAsset.kind === MediaKind.VIDEO).length > 1 || ad.creatives.some(item => item.mediaAsset.purpose !== MediaPurpose.MARKETPLACE_AD || item.mediaAsset.scanStatus !== MediaScanStatus.APPROVED || item.mediaAsset.uploadStatus !== MediaUploadStatus.COMPLETE)) throw fail(409, 'Remove or retry any unapproved creative before submitting this ad.');
    await eligibleProduct(ad.productId, user);
    if (!profile.walletAccount || profile.walletAccount.status !== WalletAccountStatus.ACTIVE) throw fail(409, 'Activate an eWallet before submitting a paid ad.');
    if (env.MONEY_MOVEMENT_HARD_DISABLED) throw fail(409, 'Wallet-funded advertising is hard-disabled by server configuration.');
    const setting = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { walletEnabled: true, walletEmergencyPause: true } });
    if (!setting?.walletEnabled || setting.walletEmergencyPause) throw fail(409, 'Wallet-funded advertising is paused by platform policy.');
    const userBalance = await prisma.walletBalance.findUnique({ where: { accountId_currency: { accountId: profile.walletAccount.id, currency: env.CURRENCY } } });
    if (!userBalance || userBalance.availableMinor < budget.platformMinor) throw fail(409, `Add at least ${budget.platformMinor} ${env.CURRENCY} minor units to your wallet before submitting this ad.`);
    const submitted = await prisma.$transaction(async tx => {
      const fresh = await tx.marketplaceProductAd.findFirst({ where: { id: ad.id, ownerId: user.id, status: { in: [MarketplaceProductAdStatus.DRAFT, MarketplaceProductAdStatus.REJECTED] }, reservedMinor: 0 } });
      if (!fresh) throw fail(409, 'This ad draft changed. Refresh and retry.');
      if ((fresh.budgetInputMinor ?? fresh.budgetMinor) !== budget.inputMinor || (fresh.budgetInputCurrency ?? fresh.currency) !== budget.inputCurrency) throw fail(409, 'The draft budget changed while it was being submitted. Refresh and try again.');
      const submittedAt = new Date();
      const claimed = await tx.marketplaceProductAd.updateMany({ where: { id: fresh.id, ownerId: user.id, status: { in: [MarketplaceProductAdStatus.DRAFT, MarketplaceProductAdStatus.REJECTED] }, reservedMinor: 0 }, data: { status: MarketplaceProductAdStatus.PENDING_REVIEW, currency: env.CURRENCY, budgetMinor: budget.platformMinor, budgetInputMinor: budget.inputMinor, budgetInputCurrency: budget.inputCurrency, budgetFxRate: budget.fxRate, reservedMinor: budget.platformMinor, pricePerHundredViewsSnapshotMinor: settings.pricePerHundredViewsMinor, submittedAt, reviewNote: null } });
      if (claimed.count !== 1) throw fail(409, 'This ad was already submitted. Refresh to see its latest status.');
      await ensureWalletBalance(tx, profile.walletAccount!.id, env.CURRENCY);
      await recordWalletStateTransition(tx, { accountId: profile.walletAccount!.id, currency: env.CURRENCY, fromState: WalletBalanceState.AVAILABLE, toState: WalletBalanceState.HELD, amountMinor: budget.platformMinor, referenceId: fresh.id, idempotencyKey: `marketplace-ad:${fresh.id}:reserve:${submittedAt.getTime()}` });
      const result = await tx.marketplaceProductAd.findUniqueOrThrow({ where: { id: fresh.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETPLACE_AD_SUBMITTED', entity: 'MarketplaceProductAd', entityId: fresh.id, metadata: jsonInput({ budgetInputMinor: budget.inputMinor, budgetInputCurrency: budget.inputCurrency, budgetFxRate: budget.fxRate, budgetFxProvider: budget.fxProvider, budgetFxSourceDate: budget.fxSourceDate, budgetFxFetchedAt: budget.fxFetchedAt, budgetMinor: budget.platformMinor, currency: env.CURRENCY, productId: fresh.productId, pricePerHundredViewsMinor: settings.pricePerHundredViewsMinor, billingModel: 'CPV', heldFromWallet: true }) } });
      await createUserNotification(tx, { userId: user.id, eventType: 'MARKETPLACE_AD_SUBMITTED', title: 'Your ad is in review', body: `Your ${budget.platformMinor} ${env.CURRENCY} campaign budget is reserved while the marketplace reviews the ad.`, link: '/ads', payloadJson: { adId: fresh.id, status: MarketplaceProductAdStatus.PENDING_REVIEW } }, 'account');
      await createRoleNotifications(tx, Role.ADMIN, { eventType: 'MARKETPLACE_AD_REVIEW_REQUIRED', title: 'Marketplace ad needs review', body: 'A buyer or seller submitted a wallet-funded product ad for review.', link: '/admin/ads', payloadJson: { adId: fresh.id } }, 'account');
      return result;
    });
    res.json({ id: submitted.id, status: submitted.status, reservedMinor: submitted.reservedMinor, currency: submitted.currency, budgetInputMinor: submitted.budgetInputMinor, budgetInputCurrency: submitted.budgetInputCurrency, budgetFxRate: submitted.budgetFxRate, pricePerHundredViewsSnapshotMinor: submitted.pricePerHundredViewsSnapshotMinor, message: 'Ad submitted for moderation. Its entered currency was converted at the recorded reference rate; the platform-currency amount is held in your eWallet until spent or released.' });
  }));

  app.post('/api/marketplace-ads/:id/pause', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const ad = await prisma.marketplaceProductAd.findFirst({ where: { id: param(req.params.id), ownerId: user.id, status: MarketplaceProductAdStatus.APPROVED }, select: { id: true, ownerId: true, currency: true, reservedMinor: true } });
    if (!ad) throw fail(404, 'Running ad not found.');
    await prisma.$transaction(async tx => {
      const claimed = await tx.marketplaceProductAd.updateMany({ where: { id: ad.id, ownerId: user.id, status: MarketplaceProductAdStatus.APPROVED, reservedMinor: ad.reservedMinor }, data: { status: MarketplaceProductAdStatus.PAUSED } });
      if (claimed.count !== 1) throw fail(409, 'This campaign changed while it was being paused. Refresh and retry.');
      await releaseReserved(tx, ad);
      await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETPLACE_AD_PAUSED', entity: 'MarketplaceProductAd', entityId: ad.id, metadata: jsonInput({ releasedMinor: ad.reservedMinor, currency: ad.currency }) } });
    });
    res.json({ id: ad.id, status: MarketplaceProductAdStatus.PAUSED, releasedMinor: ad.reservedMinor });
  }));

  app.post('/api/marketplace-ads/:id/resume', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const [ad, settings, profile] = await Promise.all([prisma.marketplaceProductAd.findFirst({ where: { id: param(req.params.id), ownerId: user.id, status: MarketplaceProductAdStatus.PAUSED } }), adSettings(), prisma.user.findUnique({ where: { id: user.id }, select: { walletAccount: true, emailVerifiedAt: true } })]);
    if (!ad) throw fail(404, 'Paused ad not found.');
    if (!profile?.emailVerifiedAt || !settings.enabled || !profile.walletAccount || profile.walletAccount.status !== WalletAccountStatus.ACTIVE || env.MONEY_MOVEMENT_HARD_DISABLED) throw fail(409, 'This ad cannot resume until its account and wallet are eligible.');
    if (!ad.endsAt || ad.endsAt <= new Date()) throw fail(409, 'The scheduled campaign has expired. Create a new ad.');
    const remaining = Math.max(0, ad.budgetMinor - ad.spentMinor);
    const resumed = await prisma.$transaction(async tx => {
      const claimed = await tx.marketplaceProductAd.updateMany({ where: { id: ad.id, ownerId: user.id, status: MarketplaceProductAdStatus.PAUSED, reservedMinor: 0 }, data: { status: MarketplaceProductAdStatus.APPROVED } });
      if (claimed.count !== 1) throw fail(409, 'This ad changed while you were resuming it. Refresh and retry.');
      if (remaining) {
        await ensureWalletBalance(tx, profile.walletAccount!.id, ad.currency);
        await recordWalletStateTransition(tx, { accountId: profile.walletAccount!.id, currency: ad.currency, fromState: WalletBalanceState.AVAILABLE, toState: WalletBalanceState.HELD, amountMinor: remaining, referenceId: ad.id, idempotencyKey: `marketplace-ad:${ad.id}:resume:${ad.updatedAt.getTime()}` });
      }
      const updated = await tx.marketplaceProductAd.update({ where: { id: ad.id }, data: { reservedMinor: remaining } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETPLACE_AD_RESUMED', entity: 'MarketplaceProductAd', entityId: ad.id, metadata: jsonInput({ reservedMinor: remaining, currency: ad.currency }) } });
      return updated;
    });
    res.json({ id: resumed.id, status: resumed.status, reservedMinor: resumed.reservedMinor });
  }));

  app.delete('/api/marketplace-ads/:id', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const ad = await prisma.marketplaceProductAd.findFirst({ where: { id: param(req.params.id), ownerId: user.id, status: MarketplaceProductAdStatus.DRAFT }, include: { creatives: { include: { mediaAsset: { select: { id: true, storageKey: true, storageProvider: true } } } } } });
    if (!ad) throw fail(404, 'Draft ad not found. Submitted or approved ads cannot be deleted; pause an approved campaign to release its unused funds.');
    await prisma.$transaction(async tx => {
      await tx.marketplaceProductAdCreative.deleteMany({ where: { adId: ad.id } });
      await tx.marketplaceProductAd.delete({ where: { id: ad.id } });
      await tx.mediaAsset.deleteMany({ where: { id: { in: ad.creatives.map(item => item.mediaAsset.id) }, uploaderId: user.id, purpose: MediaPurpose.MARKETPLACE_AD } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETPLACE_AD_DRAFT_DELETED', entity: 'MarketplaceProductAd', entityId: ad.id } });
    });
    await Promise.all(ad.creatives.map(item => (item.mediaAsset.storageProvider === MediaStorageProvider.OBJECT ? objectContentStorage : localContentStorage)?.remove(item.mediaAsset.storageKey).catch(() => undefined)));
    res.status(204).send();
  }));

  app.get('/api/admin/marketplace-ads', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [items, settings, currency] = await Promise.all([
      prisma.marketplaceProductAd.findMany({ include: { owner: { select: { id: true, name: true, email: true, role: true } }, product: { select: { id: true, name: true, status: true, currency: true } }, store: { select: { id: true, name: true, slug: true } }, creatives: { orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, scanStatus: true, uploadStatus: true } } } }, metrics: { orderBy: { day: 'desc' }, take: 30 } }, orderBy: [{ status: 'asc' }, { submittedAt: 'desc' }], take: 200 }),
      adSettings(),
      prisma.currencyCatalogEntry.findUnique({ where: { code: env.CURRENCY }, select: { minorUnitExponent: true } })
    ]);
    res.json({ items, settings, currency: env.CURRENCY, minorUnitExponent: currency?.minorUnitExponent ?? 2 });
  }));

  app.get('/api/admin/marketplace-ads/:id/media/:assetId', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const creative = await prisma.marketplaceProductAdCreative.findFirst({ where: { adId: param(req.params.id), mediaAssetId: param(req.params.assetId) }, include: { mediaAsset: true } });
    const media = creative?.mediaAsset;
    if (!media || media.purpose !== MediaPurpose.MARKETPLACE_AD || media.scanStatus !== MediaScanStatus.APPROVED || media.uploadStatus !== MediaUploadStatus.COMPLETE) return res.status(404).json({ error: 'Approved ad preview not found.' });
    const source = media.storageProvider === MediaStorageProvider.OBJECT ? objectContentStorage : localContentStorage;
    if (!source) throw fail(503, 'Ad media storage is unavailable.');
    res.set({ 'Content-Type': media.detectedMime, 'Content-Length': String(media.sizeBytes), 'Content-Disposition': `inline; filename="${path.basename(media.safeName)}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    source.open(media.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));

  app.patch('/api/admin/marketplace-ads/:id/review', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'PAUSE']), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const current = await prisma.marketplaceProductAd.findUnique({
      where: { id: param(req.params.id) },
      include: { creatives: { include: { mediaAsset: { select: { kind: true, scanStatus: true, uploadStatus: true, purpose: true } } } } }
    });
    if (!current) throw fail(404, 'Marketplace ad not found.');
    if (input.decision === 'APPROVE') {
      if (current.status !== MarketplaceProductAdStatus.PENDING_REVIEW || current.reservedMinor !== current.budgetMinor || !current.creatives.every(item => item.mediaAsset.purpose === MediaPurpose.MARKETPLACE_AD && item.mediaAsset.scanStatus === MediaScanStatus.APPROVED && item.mediaAsset.uploadStatus === MediaUploadStatus.COMPLETE)) throw fail(409, 'Only fully funded, pending, safety-cleared ads can be approved.');
      const product = await eligibleProduct(current.productId, admin);
      const endsAt = new Date(Date.now() + current.durationDays * 86_400_000);
      const updated = await prisma.$transaction(async tx => {
        const ad = await tx.marketplaceProductAd.updateMany({ where: { id: current.id, status: MarketplaceProductAdStatus.PENDING_REVIEW }, data: { status: MarketplaceProductAdStatus.APPROVED, reviewerId: admin.id, reviewedAt: new Date(), reviewNote: input.reason, startsAt: new Date(), endsAt, storeId: product.seller!.store!.id } });
        if (ad.count !== 1) throw fail(409, 'Ad status changed during review. Refresh and retry.');
        const result = await tx.marketplaceProductAd.findUniqueOrThrow({ where: { id: current.id } });
        await tx.auditLog.create({ data: { actorId: admin.id, action: 'MARKETPLACE_AD_APPROVED', entity: 'MarketplaceProductAd', entityId: current.id, metadata: jsonInput({ reason: input.reason, startsAt: result.startsAt, endsAt: result.endsAt }) } });
        return result;
      });
      return res.json(updated);
    }
    if (input.decision === 'REJECT' && current.status !== MarketplaceProductAdStatus.PENDING_REVIEW) throw fail(409, 'Only a pending campaign can be rejected.');
    if (input.decision === 'PAUSE' && current.status !== MarketplaceProductAdStatus.APPROVED) throw fail(409, 'Only an active campaign can be paused.');
    const status = input.decision === 'REJECT' ? MarketplaceProductAdStatus.REJECTED : MarketplaceProductAdStatus.PAUSED;
    await prisma.$transaction(async tx => {
      const claimed = await tx.marketplaceProductAd.updateMany({ where: { id: current.id, status: input.decision === 'REJECT' ? MarketplaceProductAdStatus.PENDING_REVIEW : MarketplaceProductAdStatus.APPROVED, reservedMinor: current.reservedMinor }, data: { status, reviewerId: admin.id, reviewedAt: new Date(), reviewNote: input.reason } });
      if (claimed.count !== 1) throw fail(409, 'Ad status changed during review. Refresh and retry.');
      await releaseReserved(tx, current);
      await tx.auditLog.create({ data: { actorId: admin.id, action: input.decision === 'REJECT' ? 'MARKETPLACE_AD_REJECTED' : 'MARKETPLACE_AD_ADMIN_PAUSED', entity: 'MarketplaceProductAd', entityId: current.id, metadata: jsonInput({ reason: input.reason, releasedMinor: current.reservedMinor, currency: current.currency }) } });
      if (input.decision !== 'PAUSE') await createUserNotification(tx, { userId: current.ownerId, eventType: input.decision === 'REJECT' ? 'MARKETPLACE_AD_REJECTED' : 'MARKETPLACE_AD_APPROVED', title: input.decision === 'REJECT' ? 'Your ad needs changes' : 'Your ad is approved', body: input.decision === 'REJECT' ? `The reviewer shared this note: ${input.reason}` : 'Your product ad is now published on the marketplace.', link: '/ads', payloadJson: { adId: current.id, status, reason: input.reason } }, 'account');
    });
    res.json({ id: current.id, status, releasedMinor: current.reservedMinor });
  }));

  app.get('/api/marketplace-ads/featured', publicLimit, run(async (req, res) => {
    const placement = z.enum(MARKETPLACE_AD_PLACEMENTS).default('MARKETPLACE_HOME').parse(req.query.placement) as MarketplaceProductAdPlacement;
    const settings = await adSettings();
    if (!settings.enabled) return res.json({ items: [] });
    const now = new Date();
    const ads = await prisma.marketplaceProductAd.findMany({ where: { placements: { has: placement }, status: MarketplaceProductAdStatus.APPROVED, startsAt: { lte: now }, endsAt: { gt: now }, reservedMinor: { gt: 0 }, product: { status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } }, seller: { status: SellerStatus.APPROVED, store: { isNot: null } } } }, include: publicMarketplaceAdInclude, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 6 });
    const items = await Promise.all(ads.map(async ad => {
      const impressionToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(impressionToken).digest('hex');
      await prisma.marketplaceProductAdImpression.create({ data: { adId: ad.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return publicAdShape({ ...ad, impressionToken });
    }));
    res.set('Cache-Control', 'private, no-store');
    res.json({ items });
  }));

  app.post('/api/marketplace-ads/:id/impression', publicLimit, run(async (req, res) => {
    const input = z.object({ impressionToken: z.string().min(32).max(128) }).strict().parse(req.body);
    const tokenHash = crypto.createHash('sha256').update(input.impressionToken).digest('hex');
    const now = new Date();
    const result = await prisma.$transaction(async tx => {
      const observed = await tx.marketplaceProductAdImpression.updateMany({ where: { adId: param(req.params.id), tokenHash, clickedAt: null, observedAt: null, expiresAt: { gt: now }, ad: { status: MarketplaceProductAdStatus.APPROVED, startsAt: { lte: now }, endsAt: { gt: now }, product: { status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } }, seller: { status: SellerStatus.APPROVED } } } }, data: { observedAt: now } });
      if (observed.count !== 1) return { claimed: false as const };

      // Serialize billing by campaign so parallel impressions always calculate the final view
      // and remaining reserve from the latest committed values.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MarketplaceProductAd" WHERE "id" = ${param(req.params.id)} FOR UPDATE`;
      if (locked.length !== 1) throw fail(409, 'This ad is no longer available.');
      const ad = await tx.marketplaceProductAd.findUnique({ where: { id: param(req.params.id) }, include: { product: { select: { id: true, status: true, inventory: { select: { quantity: true } }, seller: { select: { status: true } } } } } });
      const pricePerViewMinor = ad ? marketplaceAdPricePerView(ad.pricePerHundredViewsSnapshotMinor) : null;
      if (!ad || ad.status !== MarketplaceProductAdStatus.APPROVED || !ad.startsAt || ad.startsAt > now || !ad.endsAt || ad.endsAt <= now || ad.product.status !== ProductStatus.APPROVED || (ad.product.inventory?.quantity ?? 0) <= 0 || ad.product.seller?.status !== SellerStatus.APPROVED) throw fail(409, 'This ad is no longer eligible for a view.');
      if (!pricePerViewMinor) throw fail(409, 'This campaign has an invalid view-billing rate and has been blocked for reconciliation.');
      if (ad.reservedMinor < pricePerViewMinor || ad.spentMinor > ad.budgetMinor - pricePerViewMinor) throw fail(409, 'This ad has no remaining prepaid view budget.');

      const account = await tx.walletAccount.findUnique({ where: { userId: ad.ownerId } });
      if (!account || account.status !== WalletAccountStatus.ACTIVE) throw fail(409, 'This ad is paused pending account review.');
      const nextReserved = ad.reservedMinor - pricePerViewMinor;
      const completes = nextReserved < pricePerViewMinor;
      const claimedAd = await tx.marketplaceProductAd.updateMany({ where: { id: ad.id, status: MarketplaceProductAdStatus.APPROVED, reservedMinor: { gte: pricePerViewMinor }, spentMinor: { lte: ad.budgetMinor - pricePerViewMinor } }, data: { reservedMinor: { decrement: pricePerViewMinor }, spentMinor: { increment: pricePerViewMinor }, ...(completes ? { status: MarketplaceProductAdStatus.COMPLETED } : {}) } });
      if (claimedAd.count !== 1) throw fail(409, 'This ad has no remaining prepaid view budget.');

      const ownerBalance = await tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: account.id, currency: ad.currency } } });
      if (!ownerBalance) throw fail(409, 'Ad wallet reserve is unavailable for reconciliation.');
      const held = await tx.walletBalance.updateMany({ where: { id: ownerBalance.id, heldMinor: { gte: pricePerViewMinor } }, data: { heldMinor: { decrement: pricePerViewMinor } } });
      if (held.count !== 1) throw fail(409, 'Ad wallet reserve is unavailable for reconciliation.');
      if (completes && nextReserved > 0) await releaseReserved(tx, { id: ad.id, ownerId: ad.ownerId, currency: ad.currency, reservedMinor: nextReserved });

      const revenueAccount = await tx.walletAccount.upsert({ where: { id: 'marketplace-ad-revenue' }, update: {}, create: { id: 'marketplace-ad-revenue', type: WalletAccountType.TREASURY, status: WalletAccountStatus.ACTIVE } });
      const revenueBalance = await ensureWalletBalance(tx, revenueAccount.id, ad.currency);
      await tx.walletBalance.update({ where: { id: revenueBalance.id }, data: { availableMinor: { increment: pricePerViewMinor } } });
      const impression = await tx.marketplaceProductAdImpression.findUniqueOrThrow({ where: { tokenHash }, select: { id: true } });
      const ledger = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: `marketplace-ad-view:${impression.id}`, entryType: WalletLedgerEntryType.ADJUSTMENT, status: WalletLedgerStatus.POSTED, currency: ad.currency, referenceType: 'MARKETPLACE_AD_VIEW', referenceId: ad.id, metadataJson: jsonInput({ pricePerHundredViewsMinor: ad.pricePerHundredViewsSnapshotMinor, pricePerViewMinor, billingModel: 'CPV' }) } });
      const postings = [{ transactionId: ledger.id, accountId: account.id, direction: WalletPostingDirection.CREDIT, amountMinor: pricePerViewMinor, currency: ad.currency }, { transactionId: ledger.id, accountId: revenueAccount.id, direction: WalletPostingDirection.DEBIT, amountMinor: pricePerViewMinor, currency: ad.currency }];
      assertBalancedPostings(postings.map(({ direction, amountMinor, currency }) => ({ direction, amountMinor, currency })));
      await tx.walletLedgerPosting.createMany({ data: postings });
      await appendWalletAllocations(tx, [
        { accountId: account.id, transactionId: ledger.id, currency: ad.currency, state: WalletBalanceState.HELD, deltaMinor: -pricePerViewMinor, idempotencyKey: `marketplace-ad-view:${impression.id}:held`, referenceType: 'MARKETPLACE_AD_VIEW', referenceId: ad.id },
        { accountId: revenueAccount.id, transactionId: ledger.id, currency: ad.currency, state: WalletBalanceState.AVAILABLE, deltaMinor: pricePerViewMinor, idempotencyKey: `marketplace-ad-view:${impression.id}:revenue`, referenceType: 'MARKETPLACE_AD_VIEW', referenceId: ad.id }
      ]);
      const day = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
      await tx.marketplaceProductAdDailyMetric.upsert({ where: { adId_day: { adId: ad.id, day } }, update: { impressions: { increment: 1 }, spendMinor: { increment: pricePerViewMinor } }, create: { adId: ad.id, day, impressions: 1, spendMinor: pricePerViewMinor } });
      if (completes) await createUserNotification(tx, { userId: ad.ownerId, eventType: 'MARKETPLACE_AD_BUDGET_SPENT', title: 'Your ad budget has been used', body: 'Your campaign finished after its prepaid view budget was spent. Create another campaign whenever you are ready.', link: '/ads', payloadJson: { adId: ad.id, spentMinor: ad.spentMinor + pricePerViewMinor, currency: ad.currency } }, 'account');
      return { claimed: true as const, status: completes ? MarketplaceProductAdStatus.COMPLETED : MarketplaceProductAdStatus.APPROVED, chargedMinor: pricePerViewMinor };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (result.claimed) return res.status(201).json({ recorded: true, chargedMinor: result.chargedMinor, status: result.status });
    const existing = await prisma.marketplaceProductAdImpression.findFirst({ where: { adId: param(req.params.id), tokenHash, observedAt: { not: null }, expiresAt: { gt: now } }, select: { id: true } });
    if (existing) return res.json({ recorded: true, alreadyRecorded: true });
    res.status(404).json({ error: 'Ad impression token is unavailable.' });
  }));

  app.post('/api/marketplace-ads/:id/click', publicLimit, run(async (req, res) => {
    const input = z.object({ impressionToken: z.string().min(32).max(128), destination: z.enum(['PRODUCT', 'STORE', 'EXTERNAL']).default('PRODUCT') }).strict().parse(req.body);
    const tokenHash = crypto.createHash('sha256').update(input.impressionToken).digest('hex');
    const clicked = await prisma.$transaction(async tx => {
      const impression = await tx.marketplaceProductAdImpression.findUnique({ where: { tokenHash } });
      if (!impression || impression.adId !== param(req.params.id) || impression.expiresAt <= new Date() || impression.clickedAt || !impression.observedAt) throw fail(409, 'This ad link is expired or has not been visibly shown. Refresh the marketplace and try again.');
      const clickClaim = await tx.marketplaceProductAdImpression.updateMany({ where: { id: impression.id, clickedAt: null, observedAt: { not: null }, expiresAt: { gt: new Date() } }, data: { clickedAt: new Date() } });
      if (clickClaim.count !== 1) throw fail(409, 'This ad link has already been used. Refresh the marketplace and try again.');
      const ad = await tx.marketplaceProductAd.findUnique({ where: { id: impression.adId }, include: { product: { select: { id: true, status: true, inventory: { select: { quantity: true } }, seller: { select: { status: true } } } }, store: { select: { slug: true } } } });
      if (!ad || (ad.status !== MarketplaceProductAdStatus.APPROVED && ad.status !== MarketplaceProductAdStatus.COMPLETED && ad.status !== MarketplaceProductAdStatus.PAUSED) || !ad.startsAt || !ad.endsAt || impression.observedAt < ad.startsAt || impression.observedAt >= ad.endsAt || ad.product.status !== ProductStatus.APPROVED || (ad.product.inventory?.quantity ?? 0) <= 0 || ad.product.seller?.status !== SellerStatus.APPROVED) throw fail(409, 'This ad is no longer available.');
      const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      await tx.marketplaceProductAdDailyMetric.upsert({ where: { adId_day: { adId: ad.id, day } }, update: { clicks: { increment: 1 } }, create: { adId: ad.id, day, clicks: 1 } });
      const destination = marketplaceAdDestination({ destination: input.destination as MarketplaceAdDestination, externalUrl: ad.externalUrl, storeSlug: ad.store?.slug ?? null, productId: ad.product.id });
      if (!destination) throw fail(409, 'This ad has no external destination.');
      return { destination, status: ad.status, adId: ad.id };
    });
    res.json(clicked);
  }));

  app.post('/api/marketplace-ads/:id/contact', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const ad = await prisma.marketplaceProductAd.findFirst({ where: { id: param(req.params.id), status: MarketplaceProductAdStatus.APPROVED, messageEnabled: true, startsAt: { lte: new Date() }, endsAt: { gt: new Date() } }, select: { id: true, ownerId: true, productId: true, storeId: true } });
    if (!ad || ad.ownerId === user.id) throw fail(404, 'Message contact is not available for this ad.');
    const owner = await prisma.user.findUnique({ where: { id: ad.ownerId }, select: { id: true, emailVerifiedAt: true, seller: { select: { id: true } } } });
    if (!owner?.emailVerifiedAt) throw fail(409, 'The ad owner cannot receive marketplace messages at this time.');
    const conversation = await prisma.conversation.upsert({
      where: { buyerId_directRecipientId_marketplaceProductAdId: { buyerId: user.id, directRecipientId: owner.id, marketplaceProductAdId: ad.id } },
      update: { updatedAt: new Date(), status: 'OPEN' },
      create: { buyerId: user.id, sellerId: owner.seller?.id ?? null, directRecipientId: owner.id, marketplaceProductAdId: ad.id, productId: ad.productId, status: 'OPEN' },
      select: { id: true }
    });
    res.status(201).json({ conversationId: conversation.id, productId: ad.productId, storeId: ad.storeId });
  }));

  app.get('/api/marketplace-ads/:id/media/:assetId', publicLimit, run(async (req, res) => {
    const creative = await prisma.marketplaceProductAdCreative.findFirst({ where: { adId: param(req.params.id), mediaAssetId: param(req.params.assetId), ad: { status: MarketplaceProductAdStatus.APPROVED, startsAt: { lte: new Date() }, endsAt: { gt: new Date() } } }, include: { mediaAsset: true } });
    const media = creative?.mediaAsset;
    if (!media || media.purpose !== MediaPurpose.MARKETPLACE_AD || media.scanStatus !== MediaScanStatus.APPROVED || media.uploadStatus !== MediaUploadStatus.COMPLETE) return res.status(404).json({ error: 'Ad creative not found.' });
    const source = media.storageProvider === MediaStorageProvider.OBJECT ? objectContentStorage : localContentStorage;
    if (!source) throw fail(503, 'Ad media storage is unavailable.');
    res.set({ 'Content-Type': media.detectedMime, 'Content-Length': String(media.sizeBytes), 'Content-Disposition': `inline; filename="${path.basename(media.safeName)}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' });
    source.open(media.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));

  app.get('/api/marketplace-ads/:id/creatives/:assetId/preview', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const creative = await prisma.marketplaceProductAdCreative.findFirst({ where: { adId: param(req.params.id), mediaAssetId: param(req.params.assetId), ad: { ownerId: user.id, status: MarketplaceProductAdStatus.DRAFT } }, include: { mediaAsset: true } });
    const media = creative?.mediaAsset;
    if (!media || media.purpose !== MediaPurpose.MARKETPLACE_AD || media.scanStatus !== MediaScanStatus.APPROVED || media.uploadStatus !== MediaUploadStatus.COMPLETE) return res.status(404).json({ error: 'Approved ad preview not found.' });
    const source = media.storageProvider === MediaStorageProvider.OBJECT ? objectContentStorage : localContentStorage;
    if (!source) throw fail(503, 'Ad media storage is unavailable.');
    res.set({ 'Content-Type': media.detectedMime, 'Content-Length': String(media.sizeBytes), 'Content-Disposition': `inline; filename="${path.basename(media.safeName)}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    source.open(media.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));
}
