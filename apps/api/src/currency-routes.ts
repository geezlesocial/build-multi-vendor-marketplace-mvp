import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { Prisma, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { convertMinorExact, FrankfurterRateAdapter, isRateFresh, parseRate } from './currency-domain.js';
import { assertShippingSelectionsMatch, buildSellerShippingQuote, verifyCheckoutShippingQuote, type ShippingCartRecord } from './shipping-routes.js';
import { addressSchema } from './validation.js';
import { effectiveProductPriceMinor, effectiveUnitPriceMinor } from './product-pricing.js';
import { resolveCartProductDiscount } from './product-discount-routes.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const manualRateInput = z.object({ baseCurrency: z.string().length(3).transform(value => value.toUpperCase()), quoteCurrency: z.string().length(3).transform(value => value.toUpperCase()), rate: z.string().max(32), effectiveFrom: z.string().datetime(), reason: z.string().trim().min(5).max(500) }).strict();
const commissionPageInput = z.object({ limit: z.coerce.number().int().min(1).max(200).default(200), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) });

function fail(statusCode: number, message: string, code?: string) { return Object.assign(new Error(message), { statusCode, code }); }

async function currencyManager(user: ReturnType<typeof actor>) {
  if (!user.sellerId) throw fail(403, 'Seller Store scope is required.');
  const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
  if (!seller?.store) throw fail(403, 'An approved Store is required.');
  if (user.role === Role.ADMIN && seller.store.isPlatformStore) return seller;
  if (seller.userId !== user.id) {
    const permission = await prisma.sellerStaff.findFirst({ where: { sellerId: seller.id, userId: user.id, canManageCurrency: true }, select: { id: true } });
    if (!permission) throw fail(403, 'The Store owner has not granted currency-management permission.');
  }
  return seller;
}

export async function latestDisplayRate(baseCurrency: string, quoteCurrency: string, storeId?: string, now = new Date()) {
  if (baseCurrency === quoteCurrency) return { rate: '1', provider: 'IDENTITY', sourceDate: now.toISOString().slice(0, 10), fetchedAt: now.toISOString(), freshness: 'fresh' as const };
  const manual = await prisma.manualExchangeRateVersion.findFirst({ where: {
    baseCurrency, quoteCurrency, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    ...(storeId ? { storeId } : { storeId: null })
  }, orderBy: [{ version: 'desc' }, { effectiveFrom: 'desc' }] });
  if (manual) return { rate: manual.rate.toString(), provider: 'MANUAL', sourceDate: manual.effectiveFrom.toISOString().slice(0, 10), fetchedAt: manual.createdAt.toISOString(), freshness: 'manual' as const };
  if (storeId) {
    const globalManual = await prisma.manualExchangeRateVersion.findFirst({ where: { storeId: null, baseCurrency, quoteCurrency, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, orderBy: [{ version: 'desc' }, { effectiveFrom: 'desc' }] });
    if (globalManual) return { rate: globalManual.rate.toString(), provider: 'MANUAL', sourceDate: globalManual.effectiveFrom.toISOString().slice(0, 10), fetchedAt: globalManual.createdAt.toISOString(), freshness: 'manual' as const };
  }
  const automatic = await prisma.exchangeRateSnapshot.findFirst({ where: { baseCurrency, quoteCurrency }, orderBy: [{ sourceDate: 'desc' }, { fetchedAt: 'desc' }] });
  if (!automatic) return null;
  const fresh = isRateFresh(automatic.fetchedAt, now, env.FX_REFERENCE_MAX_AGE_HOURS * 60 * 60 * 1000, automatic.sourceDate);
  return { rate: automatic.rate.toString(), provider: automatic.provider, sourceDate: automatic.sourceDate.toISOString().slice(0, 10), fetchedAt: automatic.fetchedAt.toISOString(), freshness: fresh ? 'fresh' as const : 'stale' as const };
}

export async function availableGlobalDisplayCurrencies() {
  const entries = await prisma.currencyCatalogEntry.findMany({ where: { active: true, displayEnabled: true }, orderBy: [{ region: 'asc' }, { name: 'asc' }] });
  const allowed: string[] = [];
  for (const entry of entries) {
    if (entry.code === env.CURRENCY) { allowed.push(entry.code); continue; }
    const rate = await latestDisplayRate(env.CURRENCY, entry.code);
    if (rate && rate.freshness !== 'stale') allowed.push(entry.code);
  }
  if (!allowed.includes(env.CURRENCY)) allowed.unshift(env.CURRENCY);
  return allowed;
}

async function writeManualRate(input: z.infer<typeof manualRateInput>, actorId: string, storeId: string | null) {
  const parsed = parseRate(input.rate);
  if (input.baseCurrency === input.quoteCurrency) throw fail(400, 'A manual rate must use two different currencies.');
  const [base, quote] = await Promise.all([
    prisma.currencyCatalogEntry.findFirst({ where: { code: input.baseCurrency, active: true } }),
    prisma.currencyCatalogEntry.findFirst({ where: { code: input.quoteCurrency, active: true, displayEnabled: true } })
  ]);
  if (!base || !quote) throw fail(400, 'Both currencies must be active, and the quote currency must be allowed for display.');
  const effectiveFrom = new Date(input.effectiveFrom);
  const id = await prisma.$transaction(async tx => {
    const lockKey = `manual-fx:${storeId ?? 'global'}:${input.baseCurrency}:${input.quoteCurrency}`;
    await tx.$queryRaw<Array<{ acquired: number }>>`
      WITH advisory_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)
      )
      SELECT 1::int AS acquired FROM advisory_lock
    `;
    const latest = await tx.manualExchangeRateVersion.findFirst({ where: { storeId, baseCurrency: input.baseCurrency, quoteCurrency: input.quoteCurrency }, orderBy: { version: 'desc' } });
    if (latest && effectiveFrom <= latest.effectiveFrom) throw fail(409, 'A new rate must have a later effective time than the previous version.');
    if (latest && !latest.effectiveUntil) await tx.manualExchangeRateVersion.update({ where: { id: latest.id }, data: { effectiveUntil: effectiveFrom } });
    const created = await tx.manualExchangeRateVersion.create({ data: {
      storeId, version: (latest?.version ?? 0) + 1, baseCurrency: input.baseCurrency,
      quoteCurrency: input.quoteCurrency, rate: new Prisma.Decimal(parsed.numerator.toString()).dividedBy(parsed.denominator.toString()),
      effectiveFrom, reason: input.reason, createdById: actorId
    } });
    await tx.auditLog.create({ data: { actorId, action: 'MANUAL_FX_RATE_VERSION_CREATED', entity: 'ManualExchangeRateVersion', entityId: created.id, metadata: { storeId, version: created.version, baseCurrency: created.baseCurrency, quoteCurrency: created.quoteCurrency, rate: created.rate.toString(), effectiveFrom: effectiveFrom.toISOString(), reason: input.reason } } });
    return created.id;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return prisma.manualExchangeRateVersion.findUniqueOrThrow({ where: { id } });
}

export function registerCurrencyRoutes(app: Express) {
  app.get('/api/currencies', run(async (_req, res) => {
    const entries = await prisma.currencyCatalogEntry.findMany({ where: { active: true }, orderBy: [{ region: 'asc' }, { name: 'asc' }] });
    res.json({ baseCurrency: env.CURRENCY, currencies: entries.map(entry => ({ ...entry, checkoutEnabled: entry.code === env.CURRENCY && entry.checkoutEnabled, subscriptionEnabled: false })) });
  }));

  app.get('/api/currency/cart-options', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const cart = await prisma.cart.findUnique({
      where: { userId: user.id },
      include: {
        items: {
          include: {
            variant: true,
            product: {
              include: {
                seller: {
                  include: {
                    store: {
                      include: { currencyOffers: { where: { displayEnabled: true } } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
    const entries = await prisma.currencyCatalogEntry.findMany({ where: { active: true, displayEnabled: true }, orderBy: [{ region: 'asc' }, { name: 'asc' }] });
    const lines = cart?.items ?? [];
    const chargeCurrency = await prisma.currencyCatalogEntry.findFirst({ where: { code: env.CURRENCY, active: true, checkoutEnabled: true }, select: { code: true } });
    const checkoutCompatible = Boolean(chargeCurrency) && lines.every(item => {
      const store = item.product.seller?.store;
      return (item.variant?.currency ?? item.product.currency) === env.CURRENCY
        && (!item.product.sellerId || (store?.baseCurrency === env.CURRENCY && store.currencyOffers.some(offer => offer.currency === env.CURRENCY && offer.checkoutEnabled)));
    });
    const displayCurrencies = [] as { code: string; name: string; symbol: string; minorUnitExponent: number }[];
    for (const candidate of entries) {
      let supported = true;
      for (const item of lines) {
        const store = item.product.seller?.store;
        const sourceCurrency = item.variant?.currency ?? item.product.currency;
        if (!store) {
          if (candidate.code !== env.CURRENCY) { supported = false; break; }
          continue;
        }
        const offered = candidate.code === store.baseCurrency || store.currencyOffers.some(offer => offer.currency === candidate.code);
        const rate = offered ? await latestDisplayRate(sourceCurrency, candidate.code, store.id) : null;
        if (!rate || rate.freshness === 'stale') { supported = false; break; }
      }
      if (supported) displayCurrencies.push({ code: candidate.code, name: candidate.name, symbol: candidate.symbol, minorUnitExponent: candidate.minorUnitExponent });
    }
    res.json({ checkoutCurrency: env.CURRENCY, checkoutCompatible, checkoutCurrencies: checkoutCompatible ? [env.CURRENCY] : [], displayCurrencies, error: checkoutCompatible ? null : 'The cart contains a listing currency that the configured buyer payment methods cannot charge. The cart is preserved; contact the Store or choose compatible items.' });
  }));

  app.post('/api/currency/cart-estimate', requireAuth, run(async (req, res) => {
    const input = z.object({ displayCurrency: z.string().length(3).transform(value => value.toUpperCase()), address: addressSchema.optional(), shippingQuoteToken: z.string().min(20).max(8000).optional(), discountCode: z.string().trim().min(3).max(64).optional() }).strict().parse(req.body);
    const user = actor(res);
    const cart = await prisma.cart.findUnique({
      where: { userId: user.id },
      include: {
        items: {
          include: {
            variant: true,
            product: { include: { productType: true, seller: { include: { store: { include: { currencyOffers: true } } } } } }
          }
        }
      }
    });
    if (!cart?.items.length) return res.status(409).json({ error: 'Your cart is empty.' });
    const appliedDiscount = input.discountCode ? await resolveCartProductDiscount(prisma, input.discountCode, cart.items) : null;
    if (appliedDiscount && appliedDiscount.discount.currency !== env.CURRENCY) return res.status(409).json({ error: `This discount is in ${appliedDiscount.discount.currency} and cannot be charged in ${env.CURRENCY}.` });
    const discountAllocations = new Map((appliedDiscount?.quote.allocations ?? []).map(item => [item.cartItemId, item.discountMinor]));
    const target = await prisma.currencyCatalogEntry.findFirst({ where: { code: input.displayCurrency, active: true, displayEnabled: true } });
    if (!target) return res.status(409).json({ error: 'This currency is not enabled for display.' });
    const sourceCurrencies = new Set<string>();
    for (const item of cart.items) {
      const source = item.variant?.currency ?? item.product.currency;
      if (source !== env.CURRENCY) return res.status(409).json({ error: `Checkout remains in ${env.CURRENCY}; ${item.product.name} is listed in unsupported charge currency ${source}. The cart is preserved.` });
      if (item.variant && item.variant.currency !== item.product.currency) return res.status(409).json({ error: `The selected variant currency for ${item.product.name} no longer matches the listing.` });
      const store = item.product.seller?.store;
      if (item.product.sellerId && (!store || store.baseCurrency !== item.product.currency)) return res.status(409).json({ error: `Store currency settings do not match ${item.product.name}.` });
      if (store && input.displayCurrency !== store.baseCurrency && !store.currencyOffers.some(offer => offer.currency === input.displayCurrency && offer.displayEnabled)) return res.status(409).json({ error: `${store.name} does not offer ${input.displayCurrency} for display.` });
      if (!store && input.displayCurrency !== env.CURRENCY) return res.status(409).json({ error: `Platform products are displayed in ${env.CURRENCY}.` });
      sourceCurrencies.add(source);
    }
    const exponentRows = await prisma.currencyCatalogEntry.findMany({ where: { code: { in: [...sourceCurrencies, input.displayCurrency] }, active: true }, select: { code: true, minorUnitExponent: true } });
    const exponents = new Map(exponentRows.map(row => [row.code, row.minorUnitExponent]));
    const snapshots: Record<string, unknown>[] = [];
    let displayMerchandiseMinor = 0;
    for (const item of cart.items) {
      const store = item.product.seller?.store;
      const sourceCurrency = item.variant?.currency ?? item.product.currency;
      const baseMinor = effectiveUnitPriceMinor(item) * item.quantity - (discountAllocations.get(item.id) ?? 0);
      const rate = await latestDisplayRate(sourceCurrency, input.displayCurrency, store?.id);
      const sourceExponent = exponents.get(sourceCurrency);
      if (!rate || rate.freshness === 'stale' || sourceExponent === undefined) return res.status(409).json({ error: `No current reference rate is available for ${sourceCurrency}/${input.displayCurrency}; no estimate is shown.` });
      const estimatedAmountMinorBig = convertMinorExact(BigInt(baseMinor), rate.rate, sourceExponent, target.minorUnitExponent);
      if (estimatedAmountMinorBig > 2_147_483_647n) return res.status(409).json({ error: 'The display estimate exceeds the supported amount range.' });
      const estimatedAmountMinor = Number(estimatedAmountMinorBig);
      displayMerchandiseMinor += estimatedAmountMinor;
      snapshots.push({ productId: item.productId, quantity: item.quantity, sourceAmountMinor: baseMinor, sourceCurrency, estimatedAmountMinor, targetCurrency: input.displayCurrency, rate: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, rounding: 'HALF_UP', purpose: 'DISPLAY_ESTIMATE_ONLY' });
    }
    const shippingItems = cart.items.filter(item => item.product.productType.requiresShipping);
    const sellerIds = [...new Set(shippingItems.map(item => item.product.sellerId).filter((id): id is string => Boolean(id)))];
    let chargeShippingMinor = 0;
    let displayShippingMinor = 0;
    const shippingSnapshots: Record<string, unknown>[] = [];
    if (sellerIds.length) {
      if (!input.address || !input.shippingQuoteToken) return res.status(409).json({ error: 'Calculate shipping before viewing a complete converted order estimate.' });
      const verified = verifyCheckoutShippingQuote({ token: input.shippingQuoteToken, userId: user.id, address: input.address, items: shippingItems as ShippingCartRecord[] });
      const selections = Object.fromEntries(verified.selections.map(selection => [selection.sellerId, selection.serviceId]));
      const current = await prisma.$transaction(tx => buildSellerShippingQuote(tx, user.id, input.address!, shippingItems as ShippingCartRecord[], selections));
      assertShippingSelectionsMatch(verified, current.shipments.map(shipment => shipment.selected));
      chargeShippingMinor = current.shippingTotalMinor;
      for (const shipment of current.shipments) {
        const sellerItems = cart.items.filter(item => item.product.sellerId === shipment.sellerId);
        const store = sellerItems[0]?.product.seller?.store;
        if (store && input.displayCurrency !== store.baseCurrency && !store.currencyOffers.some(offer => offer.currency === input.displayCurrency && offer.displayEnabled)) return res.status(409).json({ error: `${store.name} does not offer ${input.displayCurrency} for shipping display.` });
        const rate = await latestDisplayRate(env.CURRENCY, input.displayCurrency, store?.id);
        const sourceExponent = exponents.get(env.CURRENCY);
        if (!rate || rate.freshness === 'stale' || sourceExponent === undefined) return res.status(409).json({ error: `No current shipping estimate rate is available for ${env.CURRENCY}/${input.displayCurrency}.` });
        const estimate = convertMinorExact(BigInt(shipment.selected.shippingMinor), rate.rate, sourceExponent, target.minorUnitExponent);
        if (estimate > 2_147_483_647n) return res.status(409).json({ error: 'The shipping estimate exceeds the supported amount range.' });
        displayShippingMinor += Number(estimate);
        shippingSnapshots.push({ storeId: store?.id, serviceId: shipment.selected.serviceId, sourceAmountMinor: shipment.selected.shippingMinor, sourceCurrency: env.CURRENCY, estimatedAmountMinor: Number(estimate), targetCurrency: input.displayCurrency, rate: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, rounding: 'HALF_UP', purpose: 'DISPLAY_ESTIMATE_ONLY' });
      }
    }
    res.json({ displayCurrency: input.displayCurrency, displayMerchandiseMinor, displayShippingMinor, displayTotalMinor: displayMerchandiseMinor + displayShippingMinor, chargeCurrency: env.CURRENCY, chargeMerchandiseMinor: cart.items.reduce((sum, item) => sum + effectiveUnitPriceMinor(item) * item.quantity, 0) - (appliedDiscount?.quote.discountMinor ?? 0), discountMinor: appliedDiscount?.quote.discountMinor ?? 0, chargeShippingMinor, rates: snapshots, shippingRates: shippingSnapshots, note: `Reference-rate estimate only. Actual order and provider charge remain in ${env.CURRENCY}; final provider conversion, if any, is authoritative.` });
  }));

  app.get('/api/stores/:slug/currencies', run(async (req, res) => {
    const store = await prisma.store.findFirst({ where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } }, include: { currencyOffers: { where: { displayEnabled: true }, include: { currencyEntry: true } } } });
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const entries = [
      await prisma.currencyCatalogEntry.findUnique({ where: { code: store.baseCurrency } }),
      ...store.currencyOffers.map(offer => offer.currencyEntry)
    ].filter((entry, index, all) => entry && all.findIndex(item => item?.code === entry.code) === index);
    const currencies = await Promise.all(entries.map(async entry => {
      const rate = await latestDisplayRate(store.baseCurrency, entry!.code, store.id);
      const usable = rate !== null && rate.freshness !== 'stale';
      const storeCheckoutOffer = store.currencyOffers.some(offer => offer.currency === entry!.code && offer.checkoutEnabled);
      return { code: entry!.code, name: entry!.name, symbol: entry!.symbol, minorUnitExponent: entry!.minorUnitExponent, baseCurrency: store.baseCurrency, displayAvailable: usable, checkoutAvailable: store.baseCurrency === env.CURRENCY && entry!.code === env.CURRENCY && entry!.active && entry!.checkoutEnabled && storeCheckoutOffer, rate: usable ? rate : null };
    }));
    res.json({ store: { slug: store.slug, name: store.name }, baseCurrency: store.baseCurrency, currencies });
  }));

  app.get('/api/stores/:slug/currency-preview', run(async (req, res) => {
    const currency = String(req.query.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Choose a valid display currency.' });
    const store = await prisma.store.findFirst({
      where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } },
      include: { currencyOffers: { where: { displayEnabled: true } }, seller: { include: { products: { where: { status: ProductStatus.APPROVED }, select: { id: true, priceMinor: true, salePriceMinor: true, currency: true } } } } }
    });
    if (!store) return res.status(404).json({ error: 'Store not found.' });
    if (currency !== store.baseCurrency && !store.currencyOffers.some(offer => offer.currency === currency)) return res.status(409).json({ error: 'This Store has not offered that display currency.' });
    const target = await prisma.currencyCatalogEntry.findFirst({ where: { code: currency, ...(currency === store.baseCurrency ? {} : { active: true, displayEnabled: true }) } });
    if (!target) return res.status(409).json({ error: 'This currency is not enabled for display.' });
    const currencies = await prisma.currencyCatalogEntry.findMany({ where: { code: { in: [...new Set([store.baseCurrency, ...store.seller.products.map(product => product.currency)])] }, active: true }, select: { code: true, minorUnitExponent: true } });
    const exponent = new Map(currencies.map(entry => [entry.code, entry.minorUnitExponent]));
    const estimates = [];
    for (const product of store.seller.products) {
      const sourceExponent = exponent.get(product.currency);
      if (sourceExponent === undefined) return res.status(409).json({ error: `Currency ${product.currency} is unavailable for this Store's display estimate.` });
      const rate = await latestDisplayRate(product.currency, currency, store.id);
      if (!rate || rate.freshness === 'stale') return res.status(409).json({ error: `A current reference rate is unavailable for ${product.currency}/${currency}. No estimate is shown.` });
      const originalAmountMinor = effectiveProductPriceMinor(product);
      const amount = convertMinorExact(BigInt(originalAmountMinor), rate.rate, sourceExponent, target.minorUnitExponent);
      if (amount > 2_147_483_647n) return res.status(409).json({ error: 'The converted display estimate exceeds the supported range.' });
      estimates.push({ productId: product.id, originalAmountMinor, originalCurrency: product.currency, estimatedAmountMinor: Number(amount), currency, rate: { base: product.currency, quote: currency, value: rate.rate, provider: rate.provider, sourceDate: rate.sourceDate, fetchedAt: rate.fetchedAt, freshness: rate.freshness, estimateOnly: true } });
    }
    res.json({ store: { slug: store.slug, name: store.name }, currency, note: 'Reference-rate display estimate only; checkout and payment use the configured platform charge currency.', items: estimates });
  }));

  app.get('/api/admin/currencies', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const currencies = await prisma.currencyCatalogEntry.findMany({ orderBy: [{ region: 'asc' }, { code: 'asc' }] });
    res.json({ currencies: currencies.map(entry => ({ ...entry, checkoutEnabled: entry.code === env.CURRENCY && entry.checkoutEnabled, subscriptionEnabled: false })), referenceRefreshEnabled: env.FX_REFERENCE_FETCH_ENABLED, baseCurrency: env.CURRENCY, subscriptionBillingEnabled: false });
  }));

  app.patch('/api/admin/currencies/:code', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const code = param(req.params.code).toUpperCase();
    const input = z.object({ active: z.boolean().optional(), displayEnabled: z.boolean().optional(), storePricingEnabled: z.boolean().optional(), checkoutEnabled: z.boolean().optional(), subscriptionEnabled: z.boolean().optional(), reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    if (input.checkoutEnabled === true) return res.status(409).json({ error: code === env.CURRENCY ? 'Checkout remains limited to the platform currency; provider readiness has not approved a capability change.' : 'No configured buyer payment adapter is verified for this charge currency.' });
    if (input.subscriptionEnabled === true) return res.status(409).json({ error: 'Store subscription checkout remains disabled.' });
    const old = await prisma.currencyCatalogEntry.findUnique({ where: { code } });
    if (!old) return res.status(404).json({ error: 'Currency not found.' });
    const updated = await prisma.$transaction(async tx => {
      const row = await tx.currencyCatalogEntry.update({ where: { code }, data: {
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.displayEnabled !== undefined ? { displayEnabled: input.displayEnabled } : {}),
        ...(input.storePricingEnabled !== undefined ? { storePricingEnabled: input.storePricingEnabled } : {}),
        ...(input.checkoutEnabled === false ? { checkoutEnabled: false } : {}),
        ...(input.subscriptionEnabled === false ? { subscriptionEnabled: false } : {})
      } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'CURRENCY_CAPABILITIES_CHANGED', entity: 'CurrencyCatalogEntry', entityId: code, metadata: { old: { active: old.active, displayEnabled: old.displayEnabled, storePricingEnabled: old.storePricingEnabled, checkoutEnabled: old.checkoutEnabled, subscriptionEnabled: old.subscriptionEnabled }, new: { active: row.active, displayEnabled: row.displayEnabled, storePricingEnabled: row.storePricingEnabled, checkoutEnabled: row.checkoutEnabled, subscriptionEnabled: row.subscriptionEnabled }, reason: input.reason } } });
      return row;
    });
    res.json({ ...updated, checkoutEnabled: updated.code === env.CURRENCY && updated.checkoutEnabled, subscriptionEnabled: false });
  }));

  app.post('/api/admin/fx/refresh', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    if (!env.FX_REFERENCE_FETCH_ENABLED) return res.status(503).json({ error: 'Automatic reference-rate refresh is disabled by deployment configuration.' });
    const entries = await prisma.currencyCatalogEntry.findMany({ where: { active: true, displayEnabled: true }, select: { code: true } });
    const quotes = entries.map(entry => entry.code).filter(code => code !== env.CURRENCY);
    const rates = await new FrankfurterRateAdapter(env.FX_REFERENCE_API_BASE_URL).fetchRates(env.CURRENCY, quotes);
    const created = await prisma.$transaction(async tx => {
      let count = 0;
      for (const item of rates) {
        const result = await tx.exchangeRateSnapshot.createMany({ data: [{ baseCurrency: item.base, quoteCurrency: item.quote, rate: item.rate, provider: 'frankfurter', sourceDate: new Date(`${item.sourceDate}T00:00:00.000Z`) }], skipDuplicates: true });
        count += result.count;
      }
      await tx.auditLog.create({ data: { actorId: actor(res).id, action: 'REFERENCE_FX_REFRESHED', entity: 'ExchangeRateSnapshot', metadata: { requested: quotes.length, returned: rates.length, inserted: count, provider: 'frankfurter' } } });
      return count;
    });
    res.json({ provider: 'frankfurter', requested: quotes.length, returned: rates.length, inserted: created, note: 'Daily reference estimates only; not payment or settlement rates.' });
  }));

  app.post('/api/admin/fx/manual-rates', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const input = manualRateInput.parse(req.body);
    res.status(201).json(await writeManualRate(input, actor(res).id, null));
  }));

  app.get('/api/seller/store/currency-settings', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (_req, res) => {
    const seller = await currencyManager(actor(res));
    const [catalog, offers, manualRates, productCount, historicalOrders] = await Promise.all([
      prisma.currencyCatalogEntry.findMany({ where: { active: true }, orderBy: [{ region: 'asc' }, { name: 'asc' }] }),
      prisma.storeCurrencyOffer.findMany({ where: { storeId: seller.store!.id }, orderBy: { currency: 'asc' } }),
      prisma.manualExchangeRateVersion.findMany({ where: { storeId: seller.store!.id }, orderBy: [{ baseCurrency: 'asc' }, { quoteCurrency: 'asc' }, { version: 'desc' }], take: 100 }),
      prisma.product.count({ where: { sellerId: seller.id } }),
      prisma.sellerOrder.count({ where: { sellerId: seller.id } })
    ]);
    const rates = await Promise.all(catalog.map(async entry => ({ baseCurrency: seller.store!.baseCurrency, quoteCurrency: entry.code, rate: await latestDisplayRate(seller.store!.baseCurrency, entry.code, seller.store!.id) })));
    res.json({ store: { id: seller.store!.id, name: seller.store!.name, baseCurrency: seller.store!.baseCurrency }, offers, catalog, manualRates, rates, canChangeBaseCurrency: productCount === 0 && historicalOrders === 0, checkoutCurrency: env.CURRENCY, chargeCurrencyChangeAvailable: false });
  }));

  app.patch('/api/seller/store/currency-settings', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const user = actor(res);
    const seller = await currencyManager(user);
    const input = z.object({ baseCurrency: z.string().length(3).transform(value => value.toUpperCase()), displayCurrencies: z.array(z.string().length(3).transform(value => value.toUpperCase())).max(50), reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    if (new Set(input.displayCurrencies).size !== input.displayCurrencies.length) return res.status(400).json({ error: 'Each display currency may be listed only once.' });
    const currency = await prisma.currencyCatalogEntry.findFirst({ where: { code: input.baseCurrency, active: true, storePricingEnabled: true } });
    if (!currency) return res.status(409).json({ error: 'This currency is not enabled for Store pricing.' });
    const offers = await prisma.currencyCatalogEntry.findMany({ where: { code: { in: input.displayCurrencies }, active: true, displayEnabled: true } });
    if (offers.length !== input.displayCurrencies.length) return res.status(409).json({ error: 'One or more selected display currencies are not allowed by the platform.' });
    for (const offer of offers) {
      if (offer.code !== input.baseCurrency) {
        const currentRate = await latestDisplayRate(input.baseCurrency, offer.code, seller.store!.id);
        if (!currentRate || currentRate.freshness === 'stale') return res.status(409).json({ error: `No fresh automatic or manual reference rate is available for ${input.baseCurrency}/${offer.code}.` });
      }
    }
    const [productCount, historicalOrders] = await Promise.all([
      prisma.product.count({ where: { sellerId: seller.id, currency: { not: input.baseCurrency } } }),
      prisma.sellerOrder.count({ where: { sellerId: seller.id } })
    ]);
    if (seller.store!.baseCurrency !== input.baseCurrency && (productCount > 0 || historicalOrders > 0)) return res.status(409).json({ error: 'Store currency cannot change after prices or order history exist. Existing records are preserved.' });
    const before = { baseCurrency: seller.store!.baseCurrency, offers: await prisma.storeCurrencyOffer.findMany({ where: { storeId: seller.store!.id } }) };
    const updated = await prisma.$transaction(async tx => {
      await tx.store.update({ where: { id: seller.store!.id }, data: { baseCurrency: input.baseCurrency } });
      await tx.storeCurrencyOffer.deleteMany({ where: { storeId: seller.store!.id, currency: { notIn: input.displayCurrencies } } });
      for (const code of input.displayCurrencies) {
        const checkoutEnabled = input.baseCurrency === env.CURRENCY && code === env.CURRENCY && currency.checkoutEnabled;
        await tx.storeCurrencyOffer.upsert({ where: { storeId_currency: { storeId: seller.store!.id, currency: code } }, update: { displayEnabled: true, checkoutEnabled }, create: { storeId: seller.store!.id, currency: code, displayEnabled: true, checkoutEnabled } });
      }
      const store = await tx.store.findUniqueOrThrow({ where: { id: seller.store!.id }, include: { currencyOffers: true } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_CURRENCY_SETTINGS_CHANGED', entity: 'Store', entityId: store.id, metadata: { old: before, new: { baseCurrency: store.baseCurrency, offers: store.currencyOffers }, reason: input.reason } } });
      return store;
    });
    res.json({ store: { id: updated.id, name: updated.name, baseCurrency: updated.baseCurrency }, offers: updated.currencyOffers, checkoutCurrency: env.CURRENCY, checkoutAvailable: updated.baseCurrency === env.CURRENCY });
  }));

  app.post('/api/seller/store/fx-overrides', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const user = actor(res);
    const seller = await currencyManager(user);
    const input = manualRateInput.parse(req.body);
    if (input.baseCurrency !== seller.store!.baseCurrency) return res.status(409).json({ error: 'A Store manual display rate must start from the Store listing currency.' });
    const rate = await writeManualRate(input, user.id, seller.store!.id);
    res.status(201).json(rate);
  }));

  app.get('/api/seller/commissions', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
    if (!seller?.store) return res.status(403).json({ error: 'Approved Store required.' });
    const page = commissionPageInput.safeParse(req.query);
    if (!page.success) return res.status(400).json({ error: 'Commission page limit or offset is invalid.' });
    const now = new Date();
    const storePolicy = await prisma.sellerCommissionPolicyVersion.findFirst({ where: { storeId: seller.store.id, status: 'ACTIVE', effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, orderBy: { version: 'desc' } });
    const planAssignment = await prisma.storePlanAssignment.findFirst({ where: { storeId: seller.store.id, status: 'ACTIVE', effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' } });
    const planPolicy = !storePolicy && planAssignment ? await prisma.sellerCommissionPolicyVersion.findFirst({ where: { planVersionId: planAssignment.planVersionId, status: 'ACTIVE', effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] } }) : null;
    const where = { sellerId: seller.id };
    const [rows, totals] = await Promise.all([
      prisma.sellerCommissionLedgerEntry.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.data.offset, take: page.data.limit + 1, include: { sellerOrder: { select: { parentId: true } } } }),
      prisma.sellerCommissionLedgerEntry.groupBy({ by: ['currency'], where, _sum: { amountMinor: true }, orderBy: { currency: 'asc' } })
    ]);
    const entries = rows.slice(0, page.data.limit);
    res.json({ currentPolicy: storePolicy ?? planPolicy, policySource: storePolicy ? 'STORE' : planPolicy ? 'PLAN' : 'DEFAULT_ZERO', entries, page: { limit: page.data.limit, offset: page.data.offset, hasMore: rows.length > page.data.limit }, totals: totals.map(total => ({ currency: total.currency, amountMinor: total._sum.amountMinor ?? 0 })), payoutAvailable: false, note: 'Commission records are policy outcomes for review, not a funded seller payable or payout instruction.' });
  }));
}
