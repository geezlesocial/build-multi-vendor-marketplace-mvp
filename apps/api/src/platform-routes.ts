import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import { MediaKind, MediaScanStatus, OrderStatus, PaymentMethod, PaymentStatus, PayoutMethodStatus, PayoutMethodType, ProductStatus, Role, SellerPayoutLedgerType, SellerPayoutStatus, SellerStatus, Prisma } from '@prisma/client';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { env } from './config.js';
import { sellerPayoutConnectorAllowed, storeEntitlements } from './store-plan-domain.js';
import { authorizedBrandingStore } from './store-branding-access.js';
import { brandingSchema, encryptPayoutDetails, maskIdentifier, payoutMethodEnabled, payoutMethodSchema, payoutStatusTransitionAllowed, platformSettingsSchema, reservedStoreSlug, safePayoutMethod, storeSettingsSchema, storeSlugFromName, storeThemeSchema, taxonomySchema } from './platform-domain.js';
import { payoutEligibilityFailure, remainingSaleMinor } from './payout-eligibility.js';
import { enabledMarketplaceLanguages } from './marketplace-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const admin = [Role.ADMIN];
const sellerRoles = [Role.SELLER, Role.ADMIN];
const storeBrandingRoles = [Role.SELLER, Role.CASHIER, Role.ADMIN];
const inputJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const STORE_NAME_CHANGE_LIMIT = 3;
const availabilityInput = z.object({
  languages: z.array(z.enum(['en', 'fil'])).min(1).max(2).refine(languages => languages.includes('en'), 'English must remain enabled as the platform fallback.'),
  reason: z.string().trim().min(5).max(500)
}).strict();

function storeNameChangeWindow(now = new Date()) {
  return {
    startsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  };
}

async function storeNameChangeUsage(db: Prisma.TransactionClient | typeof prisma, storeId: string, now = new Date()) {
  const window = storeNameChangeWindow(now);
  const used = await db.auditLog.count({
    where: {
      entity: 'Store', entityId: storeId, createdAt: { gte: window.startsAt },
      OR: [
        { action: 'SELLER_STORE_NAME_CHANGED' },
        { action: 'SELLER_STORE_SETTINGS_SAVED', metadata: { path: ['nameChanged'], equals: true } }
      ]
    }
  });
  return { limit: STORE_NAME_CHANGE_LIMIT, used, remaining: Math.max(0, STORE_NAME_CHANGE_LIMIT - used), resetsAt: window.resetsAt.toISOString() };
}

function user(res: Response) { return res.locals.user as { id: string; role: Role; sellerId?: string; platformPermissions?: string[] }; }
async function settings() {
  return prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
}
async function lockSellerOrdersForPayout(tx: Prisma.TransactionClient, sellerOrderIds: string[]) {
  const orders = await tx.sellerOrder.findMany({ where: { id: { in: sellerOrderIds } }, select: { id: true, parentId: true } });
  for (const parentId of [...new Set(orders.map(order => order.parentId))].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${parentId} FOR UPDATE`;
  }
  for (const orderId of orders.map(order => order.id).sort()) {
    await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${orderId} FOR UPDATE`;
  }
}
async function lockPayoutOrders(tx: Prisma.TransactionClient, payoutId: string) {
  const links = await tx.sellerPayoutItem.findMany({
    where: { payoutId },
    select: { ledger: { select: { sellerOrder: { select: { id: true } } } } }
  });
  await lockSellerOrdersForPayout(tx, links.flatMap(link => link.ledger.sellerOrder ? [link.ledger.sellerOrder.id] : []));
}
async function refundedMinorByOrderItem(parentOrderIds: string[], db: typeof prisma | Prisma.TransactionClient) {
  const result = new Map<string, number>();
  if (!parentOrderIds.length) return result;
  const reviews = await db.sellerCommissionReviewEvent.findMany({
    where: { parentOrderId: { in: parentOrderIds }, status: 'POSTED' },
    select: { allocationJson: true }
  });
  for (const review of reviews) {
    if (!Array.isArray(review.allocationJson)) throw fail(409, 'A posted refund allocation is malformed; payout requires finance review.');
    for (const allocation of review.allocationJson) {
      if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) throw fail(409, 'A posted refund allocation is malformed; payout requires finance review.');
      const row = allocation as Record<string, unknown>;
      if (typeof row.orderItemId !== 'string' || !Number.isSafeInteger(row.refundMinor) || Number(row.refundMinor) <= 0) throw fail(409, 'A posted refund allocation is malformed; payout requires finance review.');
      const next = (result.get(row.orderItemId) ?? 0) + Number(row.refundMinor);
      if (!Number.isSafeInteger(next)) throw fail(409, 'Refund allocations exceed the supported integer amount range.');
      result.set(row.orderItemId, next);
    }
  }
  return result;
}
async function assertPayoutItemsEligible(payoutId: string, holdDays: number, db: typeof prisma | Prisma.TransactionClient = prisma) {
  const items = await db.sellerPayoutItem.findMany({
    where: { payoutId },
    include: {
      ledger: {
        include: {
          sellerOrder: {
            include: {
              parent: { include: { payment: true } }
            }
          }
        }
      }
    }
  });
  if (!items.length) throw fail(409, 'Payout has no linked sale ledger entries.');
  const sellerOrderIds = [...new Set(items.flatMap(item => item.ledger.sellerOrder ? [item.ledger.sellerOrder.id] : []))];
  const activeCases = sellerOrderIds.length ? await db.$queryRaw<Array<{ sellerOrderId: string }>>`SELECT DISTINCT "sellerOrderId" FROM "OrderResolutionCase" WHERE "sellerOrderId" = ANY(${sellerOrderIds}::text[]) AND "status" IN ('OPEN', 'UNDER_REVIEW', 'REFUND_APPROVED')` : [];
  const activeCaseOrderIds = new Set(activeCases.map(item => item.sellerOrderId));
  const parentOrderIds = [...new Set(items.flatMap(item => item.ledger.sellerOrder ? [item.ledger.sellerOrder.parent.id] : []))];
  const pendingReviews = await db.sellerCommissionReviewEvent.findMany({ where: { parentOrderId: { in: parentOrderIds }, status: 'NEEDS_ALLOCATION' }, select: { parentOrderId: true } });
  const pendingParentIds = new Set(pendingReviews.map(review => review.parentOrderId));
  const refundsByItem = await refundedMinorByOrderItem(parentOrderIds, db);
  for (const item of items) {
    const order = item.ledger.sellerOrder;
    const payment = order?.parent.payment;
    if (!order) throw fail(409, 'Payout item is not linked to a seller order.');
    if (activeCaseOrderIds.has(order.id)) throw fail(409, 'Seller payout is blocked while a buyer order case is unresolved.');
    const reason = payoutEligibilityFailure({ receivedAt: order.receivedAt, status: order.status, payment: payment ? { status: payment.status, method: payment.method } : null, refundReviewPending: pendingParentIds.has(order.parent.id) }, holdDays);
    if (reason) throw fail(409, reason);
    if (!item.ledger.orderItemId) throw fail(409, 'Payout item is not linked to an order item.');
    const availableMinor = remainingSaleMinor(item.ledger.amountMinor, refundsByItem.get(item.ledger.orderItemId) ?? 0);
    if (item.amountMinor > availableMinor) throw fail(409, 'A reconciled refund changed the available payout amount. Reject and recreate this payout after reviewing the updated balance.');
  }
}
async function mediaCheck(ids: Array<string | null | undefined>, publish: boolean, storeId: string | null = null, db: typeof prisma | Prisma.TransactionClient = prisma) {
  const clean = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!clean.length) return;
  const assets = await db.mediaAsset.findMany({ where: { id: { in: clean }, storeId, kind: MediaKind.IMAGE, uploadStatus: 'COMPLETE' }, select: { id: true, scanStatus: true } });
  if (assets.length !== clean.length) throw fail(400, 'Referenced media asset does not exist');
  if (assets.some(asset => asset.scanStatus === MediaScanStatus.REJECTED)) throw fail(409, 'Rejected branding or theme media cannot be used');
  if (publish && assets.some(asset => asset.scanStatus !== MediaScanStatus.APPROVED)) throw fail(409, 'Branding or theme media must be approved before publishing');
}
function publicBranding(value: unknown) {
  const parsed = brandingSchema.safeParse(value);
  return parsed.success ? parsed.data : brandingSchema.parse({ platformName: 'Market Lane', shortName: 'Market Lane', description: '', seoDescription: '', tagline: '' });
}
async function assertCategoryDepth(parentId: string | null | undefined, categoryId?: string) {
  let depth = 1;
  let current = parentId ? await prisma.category.findUnique({ where: { id: parentId }, select: { id: true, parentId: true } }) : null;
  while (current) {
    if (current.id === categoryId) throw fail(400, 'Category parent would create a cycle');
    depth += 1;
    if (depth > 3) throw fail(400, 'Category nesting is limited to three levels');
    current = current.parentId ? await prisma.category.findUnique({ where: { id: current.parentId }, select: { id: true, parentId: true } }) : null;
  }
}
function settingUpdateData(input: z.infer<typeof platformSettingsSchema>) {
  const { reason: _reason, ...data } = input;
  return data;
}
function providerMethodConfigured(type: string) {
  if (type === PayoutMethodType.STRIPE_CONNECT) return Boolean(env.STRIPE_SECRET_KEY);
  if (type === PayoutMethodType.PAYPAL_PAYOUTS) return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  return false;
}

export function registerPlatformRoutes(app: Express) {
  app.get('/api/platform/branding', run(async (_req, res) => {
    const record = await prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } });
    res.json(publicBranding(record?.publishedJson));
  }));

  app.get('/api/admin/platform/branding', requireAuth, requireRole(...admin), run(async (_req, res) => {
    const record = await prisma.platformBranding.findUnique({ where: { id: 'default' } });
    res.json(record ?? { id: 'default', draftJson: publicBranding(null), publishedJson: null, draftVersion: 1, publishedVersion: null });
  }));
  app.put('/api/admin/platform/branding', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const input = brandingSchema.parse(req.body);
    await mediaCheck([input.logoMediaId, input.alternateLogoMediaId, input.faviconMediaId, input.defaultAvatarMediaId, input.socialImageMediaId], false);
    const updated = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(127945, 1)`;
      const current = await tx.platformBranding.findUnique({ where: { id: 'default' }, select: { draftVersion: true } });
      const version = (current?.draftVersion ?? 0) + 1;
      const next = await tx.platformBranding.upsert({ where: { id: 'default' }, update: { draftJson: inputJson(input), draftVersion: version, updatedById: actor.id }, create: { id: 'default', draftJson: inputJson(input), draftVersion: version, updatedById: actor.id } });
      await tx.platformBrandingRevision.create({ data: { brandingId: next.id, version, brandingJson: inputJson(input), editorId: actor.id, changeNote: typeof req.body.changeNote === 'string' ? req.body.changeNote.slice(0, 500) : undefined } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'PLATFORM_BRANDING_DRAFT_SAVED', entity: 'PlatformBranding', entityId: next.id, metadata: { version } } });
      return next;
    });
    res.json(updated);
  }));
  app.post('/api/admin/platform/branding/publish', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const published = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(127945, 1)`;
      const current = await tx.platformBranding.findUnique({ where: { id: 'default' } });
      if (!current) throw fail(404, 'Branding draft not found');
      const draft = brandingSchema.parse(current.draftJson);
      await mediaCheck([draft.logoMediaId, draft.alternateLogoMediaId, draft.faviconMediaId, draft.defaultAvatarMediaId, draft.socialImageMediaId], true, null, tx);
      const updated = await tx.platformBranding.update({ where: { id: current.id }, data: { publishedJson: inputJson(draft), publishedVersion: current.draftVersion, publishedAt: new Date(), updatedById: actor.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'PLATFORM_BRANDING_PUBLISHED', entity: 'PlatformBranding', entityId: updated.id, metadata: { version: current.draftVersion } } });
      return updated;
    });
    res.json(published);
  }));
  app.get('/api/admin/platform/branding/revisions', requireAuth, requireRole(...admin), run(async (_req, res) => res.json(await prisma.platformBrandingRevision.findMany({ orderBy: { version: 'desc' }, include: { editor: { select: { id: true, email: true, name: true } } }, take: 50 }))));
  app.post('/api/admin/platform/branding/rollback/:version', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const version = Number(param(req.params.version));
    if (!Number.isInteger(version) || version < 1) throw fail(400, 'Invalid branding revision');
    const revision = await prisma.platformBrandingRevision.findUnique({ where: { brandingId_version: { brandingId: 'default', version } } });
    if (!revision) throw fail(404, 'Branding revision not found');
    const current = await prisma.platformBranding.findUnique({ where: { id: 'default' } });
    const nextVersion = (current?.draftVersion ?? 0) + 1;
    const updated = await prisma.$transaction(async tx => {
      const brandingJson = inputJson(revision.brandingJson);
      const record = await tx.platformBranding.upsert({ where: { id: 'default' }, update: { draftJson: brandingJson, draftVersion: nextVersion, updatedById: actor.id }, create: { id: 'default', draftJson: brandingJson, draftVersion: nextVersion, updatedById: actor.id } });
      await tx.platformBrandingRevision.create({ data: { brandingId: record.id, version: nextVersion, brandingJson, editorId: actor.id, changeNote: `Rolled back to revision ${version}` } });
      return record;
    });
    await audit(actor.id, 'PLATFORM_BRANDING_ROLLBACK', 'PlatformBranding', 'default', { fromVersion: version, newDraftVersion: nextVersion });
    res.json(updated);
  }));

  app.get('/api/admin/platform/settings', requireAuth, requireRole(...admin), run(async (_req, res) => {
    const actor = user(res);
    const current = await settings();
    if (actor.role !== Role.PLATFORM_STAFF) return res.json(current);
    const grants = new Set(actor.platformPermissions ?? []);
    res.json({
      ...(grants.has('MARKETPLACE') ? { sellerShippingEnabled: current.sellerShippingEnabled, sellerApprovalPolicy: current.sellerApprovalPolicy, productApprovalPolicy: current.productApprovalPolicy } : {}),
      ...(grants.has('PAYMENTS') ? { sellerPayoutsEnabled: current.sellerPayoutsEnabled, payoutFundingConfigured: current.payoutFundingConfigured, manualBankPayoutsEnabled: current.manualBankPayoutsEnabled, manualEwalletPayoutsEnabled: current.manualEwalletPayoutsEnabled, stripeConnectPayoutsEnabled: current.stripeConnectPayoutsEnabled, paypalPayoutsEnabled: current.paypalPayoutsEnabled, payoutHoldDays: current.payoutHoldDays, payoutMinimumMinor: current.payoutMinimumMinor } : {})
    });
  }));
  app.get('/api/admin/platform/availability', requireAuth, requireRole(...admin), run(async (_req, res) => {
    const [marketplace, availableDisplayCurrencies] = await Promise.all([
      settings(),
      (await import('./currency-routes.js')).availableGlobalDisplayCurrencies()
    ]);
    const languages = enabledMarketplaceLanguages(marketplace.enabledLanguages);
    res.json({
      languages,
      supportedLanguages: ['en', 'fil'],
      baseCurrency: env.CURRENCY,
      availableDisplayCurrencies,
      fxRatesConfigured: availableDisplayCurrencies.length > 1,
      automaticFxEnabled: env.FX_REFERENCE_FETCH_ENABLED,
      note: availableDisplayCurrencies.length > 1
        ? 'Display estimates use currently fresh automatic rates or administrator-approved manual rates. Checkout and settlement stay in the platform base currency.'
        : 'No foreign display rates are currently available. Add a verified manual rate or enable the automatic reference-rate integration; checkout remains in the base currency.'
    });
  }));
  app.patch('/api/admin/platform/availability', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const input = availabilityInput.parse(req.body);
    const languages = enabledMarketplaceLanguages(input.languages);
    const updated = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(127945, 17)`;
      const current = await tx.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { enabledLanguages: true } });
      const previousLanguages = enabledMarketplaceLanguages(current?.enabledLanguages);
      const record = await tx.marketplaceSettings.upsert({
        where: { id: 'default' }, update: { enabledLanguages: languages },
        create: { id: 'default', enabledLanguages: languages }
      });
      await tx.auditLog.create({ data: {
        actorId: actor.id,
        action: 'PLATFORM_LANGUAGES_CHANGED',
        entity: 'MarketplaceSettings',
        entityId: 'default',
        metadata: { previousLanguages, enabledLanguages: languages, reason: input.reason }
      } });
      return record;
    });
    const availableDisplayCurrencies = await (await import('./currency-routes.js')).availableGlobalDisplayCurrencies();
    res.json({ languages: enabledMarketplaceLanguages(updated.enabledLanguages), supportedLanguages: ['en', 'fil'], baseCurrency: env.CURRENCY, availableDisplayCurrencies, fxRatesConfigured: availableDisplayCurrencies.length > 1, automaticFxEnabled: env.FX_REFERENCE_FETCH_ENABLED, note: availableDisplayCurrencies.length > 1
      ? 'Display estimates use currently fresh automatic rates or administrator-approved manual rates. Checkout and settlement stay in the platform base currency.'
      : 'No foreign display rates are currently available. Add a verified manual rate or enable the automatic reference-rate integration; checkout remains in the base currency.' });
  }));
  app.patch('/api/admin/platform/settings', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const input = platformSettingsSchema.parse(req.body);
    const old = await settings();
    const data = settingUpdateData(input);
    if (input.sellerPayoutsEnabled && !input.payoutFundingConfigured && !old.payoutFundingConfigured) throw fail(409, 'Configure the seller payout funding policy before enabling payouts');
    const updated = await prisma.marketplaceSettings.update({ where: { id: 'default' }, data });
    await audit(actor.id, 'PLATFORM_SETTINGS_CHANGED', 'MarketplaceSettings', 'default', { old: { sellerShippingEnabled: old.sellerShippingEnabled, codMaxMinor: old.codMaxMinor, sellerApprovalPolicy: old.sellerApprovalPolicy, productApprovalPolicy: old.productApprovalPolicy, sellerPayoutsEnabled: old.sellerPayoutsEnabled, payoutFundingConfigured: old.payoutFundingConfigured, payoutHoldDays: old.payoutHoldDays, payoutMinimumMinor: old.payoutMinimumMinor }, new: data, reason: input.reason });
    res.json(updated);
  }));

  app.get('/api/admin/vendors', requireAuth, requireRole(...admin), run(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)));
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' && Object.values(SellerStatus).includes(req.query.status as SellerStatus) ? req.query.status as SellerStatus : undefined;
    const where: Prisma.SellerWhereInput = { ...(status ? { status } : {}), ...(q ? { OR: [{ user: { name: { contains: q, mode: 'insensitive' } } }, { user: { email: { contains: q, mode: 'insensitive' } } }, { store: { name: { contains: q, mode: 'insensitive' } } }] } : {}) };
    const [items, total] = await Promise.all([prisma.seller.findMany({ where, include: { user: { select: { id: true, name: true, email: true, createdAt: true } }, store: { select: { id: true, name: true, slug: true } }, _count: { select: { products: true, orders: true } } }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.seller.count({ where })]);
    res.json({ items, total, page, pageSize });
  }));
  app.post('/api/admin/sellers/:id/notes', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const note = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body); const seller = await prisma.seller.findUnique({ where: { id: param(req.params.id) }, select: { id: true } }); if (!seller) return res.status(404).json({ error: 'Seller not found' }); const result = await prisma.sellerAdminNote.create({ data: { sellerId: seller.id, authorId: actor.id, note: note.note } }); await audit(actor.id, 'SELLER_ADMIN_NOTE_CREATED', 'Seller', seller.id, { noteId: result.id }); res.status(201).json(result); }));
  app.get('/api/admin/sellers/:id/moderation-history', requireAuth, requireRole(...admin), run(async (req, res) => res.json(await prisma.sellerModerationEvent.findMany({ where: { sellerId: param(req.params.id) }, include: { actor: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }))));
  app.patch('/api/admin/sellers/:id/store', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res); const input = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).optional(), slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional() }).strict().parse(req.body);
    const seller = await prisma.seller.findUnique({ where: { id: param(req.params.id) }, include: { store: true } }); if (!seller?.store) return res.status(404).json({ error: 'Store not found' });
    const nextSlug = input.name !== undefined ? storeSlugFromName(input.name) : input.slug;
    if (input.name !== undefined && !nextSlug) throw fail(400, 'Store name must produce a valid public URL');
    if (nextSlug && reservedStoreSlug(nextSlug)) throw fail(400, 'That store slug is reserved');
    if (nextSlug && nextSlug !== seller.store.slug && await prisma.store.findFirst({ where: { slug: nextSlug, id: { not: seller.store.id } } })) throw fail(409, 'Store URL is already in use; choose a different store name');
    if (nextSlug && nextSlug !== seller.store.slug && await prisma.slugRedirect.findUnique({ where: { fromPath: `/store/${nextSlug}` } })) throw fail(409, 'That store URL is reserved by an existing redirect; choose a different store name');
    const updated = await prisma.$transaction(async tx => {
      const store = await tx.store.update({ where: { id: seller.store!.id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(nextSlug ? { slug: nextSlug } : {}) } });
      if (nextSlug && nextSlug !== seller.store!.slug) { await tx.slugRedirect.updateMany({ where: { destinationPath: `/store/${seller.store!.slug}` }, data: { destinationPath: `/store/${nextSlug}` } }); await tx.slugRedirect.upsert({ where: { fromPath: `/store/${seller.store!.slug}` }, update: { destinationPath: `/store/${nextSlug}`, statusCode: 301, createdById: actor.id }, create: { fromPath: `/store/${seller.store!.slug}`, destinationPath: `/store/${nextSlug}`, statusCode: 301, createdById: actor.id } }); }
      return store;
    });
    await audit(actor.id, 'SELLER_STORE_UPDATED', 'Store', updated.id, { sellerId: seller.id, changed: Object.keys(input), slug: updated.slug }); res.json(updated);
  }));

  app.get('/api/admin/categories', requireAuth, requireRole(...admin), run(async (_req, res) => res.json(await prisma.category.findMany({ include: { parent: true, _count: { select: { products: true, children: true } } }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }))));
  app.post('/api/admin/categories', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const input = taxonomySchema.parse(req.body); await assertCategoryDepth(input.parentId); const created = await prisma.category.create({ data: input }); await audit(actor.id, 'CATEGORY_CREATED', 'Category', created.id, { name: created.name }); res.status(201).json(created); }));
  app.patch('/api/admin/categories/:id', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const input = taxonomySchema.partial().parse(req.body); const existing = await prisma.category.findUnique({ where: { id: param(req.params.id) } }); if (!existing) return res.status(404).json({ error: 'Category not found' }); await assertCategoryDepth(input.parentId ?? existing.parentId, existing.id); if (input.slug && await prisma.category.findFirst({ where: { slug: input.slug, id: { not: existing.id } } })) throw fail(409, 'Category slug is already in use'); const updated = await prisma.category.update({ where: { id: existing.id }, data: input }); await audit(actor.id, 'CATEGORY_UPDATED', 'Category', updated.id, { changed: Object.keys(input) }); res.json(updated); }));
  app.delete('/api/admin/categories/:id', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const existing = await prisma.category.findUnique({ where: { id: param(req.params.id) }, include: { _count: { select: { products: true, children: true, catalogFeatures: true, childCategorySuggestions: true, featureSuggestions: true } } } }); if (!existing) return res.status(404).json({ error: 'Category not found' }); if (existing._count.products || existing._count.children || existing._count.catalogFeatures || existing._count.childCategorySuggestions || existing._count.featureSuggestions) throw fail(409, 'Reassign or archive referenced products, features, child categories, or suggestions before deletion'); await prisma.category.delete({ where: { id: existing.id } }); await audit(actor.id, 'CATEGORY_DELETED', 'Category', existing.id); res.status(204).send(); }));
  app.get('/api/admin/brands', requireAuth, requireRole(...admin), run(async (_req, res) => res.json(await prisma.brand.findMany({ include: { _count: { select: { products: true } } }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }))));
  app.post('/api/admin/brands', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const input = taxonomySchema.omit({ parentId: true }).parse(req.body); const created = await prisma.brand.create({ data: input }); await audit(actor.id, 'BRAND_CREATED', 'Brand', created.id, { name: created.name }); res.status(201).json(created); }));
  app.patch('/api/admin/brands/:id', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const input = taxonomySchema.omit({ parentId: true }).partial().parse(req.body); const existing = await prisma.brand.findUnique({ where: { id: param(req.params.id) } }); if (!existing) return res.status(404).json({ error: 'Brand not found' }); const conflict = input.slug ? await prisma.brand.findFirst({ where: { slug: input.slug, id: { not: existing.id } } }) : null; if (conflict) throw fail(409, 'Brand slug is already in use'); const updated = await prisma.brand.update({ where: { id: existing.id }, data: input }); await audit(actor.id, 'BRAND_UPDATED', 'Brand', updated.id, { changed: Object.keys(input) }); res.json(updated); }));
  app.delete('/api/admin/brands/:id', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const existing = await prisma.brand.findUnique({ where: { id: param(req.params.id) }, include: { _count: { select: { products: true } } } }); if (!existing) return res.status(404).json({ error: 'Brand not found' }); if (existing._count.products) throw fail(409, 'Reassign or archive products before deleting a referenced brand'); await prisma.brand.delete({ where: { id: existing.id } }); await audit(actor.id, 'BRAND_DELETED', 'Brand', existing.id); res.status(204).send(); }));

  app.get('/api/seller/store-branding/staff', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const seller = await prisma.seller.findFirst({ where: { id: actor.sellerId, userId: actor.id }, select: { id: true } });
    if (!seller) throw fail(403, 'Only the Store owner can manage branding permissions.');
    res.json(await prisma.sellerStaff.findMany({ where: { sellerId: seller.id }, orderBy: { id: 'asc' }, select: { id: true, userId: true, canManageStoreBranding: true, canManageShipping: true, canManageCurrency: true, user: { select: { name: true, email: true } } } }));
  }));
  app.patch('/api/seller/store-branding/staff/:userId', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const seller = await prisma.seller.findFirst({ where: { id: actor.sellerId, userId: actor.id }, select: { id: true } });
    if (!seller) throw fail(403, 'Only the Store owner can manage branding permissions.');
    const input = z.object({ canManageStoreBranding: z.boolean().optional(), canManageShipping: z.boolean().optional(), canManageCurrency: z.boolean().optional() }).strict().refine(value => value.canManageStoreBranding !== undefined || value.canManageShipping !== undefined || value.canManageCurrency !== undefined).parse(req.body);
    const membership = await prisma.sellerStaff.findFirst({ where: { sellerId: seller.id, userId: param(req.params.userId) } });
    if (!membership) return res.status(404).json({ error: 'Staff member not found for this Store.' });
    const updated = await prisma.$transaction(async tx => {
      const staff = await tx.sellerStaff.update({ where: { id: membership.id }, data: input });
      if (input.canManageStoreBranding !== undefined) await tx.auditLog.create({ data: { actorId: actor.id, action: input.canManageStoreBranding ? 'STORE_BRANDING_STAFF_AUTHORIZED' : 'STORE_BRANDING_STAFF_REVOKED', entity: 'SellerStaff', entityId: staff.id, metadata: { sellerId: seller.id, permission: 'canManageStoreBranding' } } });
      if (input.canManageShipping !== undefined) await tx.auditLog.create({ data: { actorId: actor.id, action: input.canManageShipping ? 'SELLER_SHIPPING_STAFF_AUTHORIZED' : 'SELLER_SHIPPING_STAFF_REVOKED', entity: 'SellerStaff', entityId: staff.id, metadata: { sellerId: seller.id, permission: 'canManageShipping' } } });
      if (input.canManageCurrency !== undefined) await tx.auditLog.create({ data: { actorId: actor.id, action: input.canManageCurrency ? 'STORE_CURRENCY_STAFF_AUTHORIZED' : 'STORE_CURRENCY_STAFF_REVOKED', entity: 'SellerStaff', entityId: staff.id, metadata: { sellerId: seller.id, permission: 'canManageCurrency' } } });
      return staff;
    });
    res.json({ userId: updated.userId, canManageStoreBranding: updated.canManageStoreBranding, canManageShipping: updated.canManageShipping, canManageCurrency: updated.canManageCurrency });
  }));
  app.get('/api/seller/store-theme', requireAuth, requireRole(...storeBrandingRoles), run(async (_req, res) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const store = await authorizedBrandingStore(actor);
    if (!store) throw fail(403, 'Approved Store owner or authorized branding staff required');
    const nameChanges = actor.role === Role.ADMIN && store.isPlatformStore
      ? { limit: null, used: 0, remaining: null, resetsAt: null, unlimited: true }
      : { ...await storeNameChangeUsage(prisma, store.id), unlimited: false };
    res.json({ storeId: store.id, name: store.name, slug: store.slug, publicPath: `/store/${store.slug}`, draft: store.themeDraftJson ?? store.themePublishedJson ?? storeThemeSchema.parse({}), published: store.themePublishedJson, publishedAt: store.themePublishedAt, nameChanges });
  }));
  app.put('/api/seller/store-theme', requireAuth, requireRole(...storeBrandingRoles), run(async (req, res) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const store = await authorizedBrandingStore(actor);
    if (!store) throw fail(404, 'Store not found');
    const input = storeSettingsSchema.parse(req.body);
    const { name, ...theme } = input;
    const nextName = name ?? store.name;
    const nextSlug = name === undefined ? store.slug : storeSlugFromName(nextName);
    if (!nextSlug) throw fail(400, 'Store name must produce a valid public URL');
    if (reservedStoreSlug(nextSlug)) throw fail(400, 'That store name produces a reserved public URL');
    if (nextSlug !== store.slug && await prisma.store.findFirst({ where: { slug: nextSlug, id: { not: store.id } } })) throw fail(409, 'Store URL is already in use; choose a different store name');
    if (nextSlug !== store.slug && await prisma.slugRedirect.findUnique({ where: { fromPath: `/store/${nextSlug}` } })) throw fail(409, 'That store URL is reserved by an existing redirect; choose a different store name');
    await mediaCheck([theme.logoMediaId, theme.faviconMediaId, theme.bannerMediaId], false, store.id);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const current = await tx.store.findUnique({ where: { id: store.id } });
      if (!current) throw fail(404, 'Store not found');
      await mediaCheck([theme.logoMediaId, theme.faviconMediaId, theme.bannerMediaId], false, store.id, tx);
      const nameChanged = current.name !== nextName;
      const platformAdmin = actor.role === Role.ADMIN && current.isPlatformStore;
      if (nameChanged && !platformAdmin) {
        const nameChanges = await storeNameChangeUsage(tx, current.id);
        if (nameChanges.remaining === 0) return { denied: 'storeNameLimit' as const, nameChanges };
      }
      const priorTheme = storeThemeSchema.safeParse(current.themeDraftJson ?? {});
      const prior = priorTheme.success ? priorTheme.data : storeThemeSchema.parse({});
      const entitlements = await storeEntitlements(tx, store.id);
      if (!entitlements.allowedThemes.includes(theme.themePreset) && theme.themePreset !== prior.themePreset) return { denied: 'themePreset' as const };
      if (!entitlements.mobileTemplates.includes(theme.mobileTemplate) && theme.mobileTemplate !== prior.mobileTemplate) return { denied: 'mobileTemplate' as const };

      const updated = await tx.store.update({ where: { id: store.id }, data: { name: nextName, ...(nextSlug !== current.slug ? { slug: nextSlug } : {}), themeDraftJson: inputJson(theme) } });
      const latest = await tx.storeThemeRevision.findFirst({ where: { storeId: store.id }, orderBy: { version: 'desc' }, select: { version: true } });
      await tx.storeThemeRevision.create({ data: { storeId: store.id, version: (latest?.version ?? 0) + 1, themeJson: inputJson(theme), editorId: actor.id, changeNote: typeof req.body.changeNote === 'string' ? req.body.changeNote.slice(0, 500) : undefined } });
      if (nextSlug !== current.slug) {
        await tx.slugRedirect.updateMany({ where: { destinationPath: `/store/${current.slug}` }, data: { destinationPath: `/store/${nextSlug}` } });
        await tx.slugRedirect.upsert({ where: { fromPath: `/store/${current.slug}` }, update: { destinationPath: `/store/${nextSlug}`, statusCode: 301, createdById: actor.id }, create: { fromPath: `/store/${current.slug}`, destinationPath: `/store/${nextSlug}`, statusCode: 301, createdById: actor.id } });
      }
      await tx.auditLog.create({ data: { actorId: actor.id, action: nameChanged ? (platformAdmin ? 'PLATFORM_OFFICIAL_STORE_RENAMED' : 'SELLER_STORE_NAME_CHANGED') : 'SELLER_STORE_SETTINGS_SAVED', entity: 'Store', entityId: updated.id, metadata: inputJson({ oldName: current.name, newName: updated.name, oldSlug: current.slug, newSlug: updated.slug, nameChanged, themePreset: theme.themePreset, mobileTemplate: theme.mobileTemplate }) } });
      return { updated };
    });
    if ('denied' in result) {
      if (result.denied === 'storeNameLimit') return res.status(429).json({ code: 'STORE_NAME_CHANGE_LIMIT_REACHED', error: `You have used all ${STORE_NAME_CHANGE_LIMIT} Store name changes for this month. The limit resets on ${new Date(result.nameChanges.resetsAt).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })} (UTC).`, nameChanges: result.nameChanges });
      return res.status(409).json({ code: 'PLAN_ENTITLEMENT_REQUIRED', entitlement: result.denied, upgradeRequired: true, error: `This Store plan does not include the selected ${result.denied === 'themePreset' ? 'theme' : 'mobile template'}.`, planUrl: '/seller/plan' });
    }
    res.json({ ...result.updated, publicPath: `/store/${result.updated.slug}` });
  }));
  app.post('/api/seller/store-theme/publish', requireAuth, requireRole(...storeBrandingRoles), run(async (_req, res) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const store = await authorizedBrandingStore(actor);
    if (!store || !store.themeDraftJson) throw fail(404, 'Store theme draft not found');
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const current = await tx.store.findUnique({ where: { id: store.id } });
      if (!current?.themeDraftJson) throw fail(404, 'Store theme draft not found');
      const theme = storeThemeSchema.parse(current.themeDraftJson);
      await mediaCheck([theme.logoMediaId, theme.faviconMediaId, theme.bannerMediaId], true, store.id, tx);
      const priorPublished = storeThemeSchema.safeParse(current.themePublishedJson ?? {});
      const prior = priorPublished.success ? priorPublished.data : storeThemeSchema.parse({});
      const entitlements = await storeEntitlements(tx, store.id);
      if (!entitlements.allowedThemes.includes(theme.themePreset) && theme.themePreset !== prior.themePreset) return { denied: 'themePreset' as const };
      if (!entitlements.mobileTemplates.includes(theme.mobileTemplate) && theme.mobileTemplate !== prior.mobileTemplate) return { denied: 'mobileTemplate' as const };
      const updated = await tx.store.update({ where: { id: store.id }, data: { themePublishedJson: inputJson(theme), themePublishedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'STORE_THEME_PUBLISHED', entity: 'Store', entityId: updated.id } });
      return { updated };
    });
    if ('denied' in result) return res.status(409).json({ code: 'PLAN_ENTITLEMENT_REQUIRED', entitlement: result.denied, upgradeRequired: true, error: `This Store plan does not include the selected ${result.denied === 'themePreset' ? 'theme' : 'mobile template'}.`, planUrl: '/seller/plan' });
    res.json(result.updated);
  }));
  app.get('/api/stores/:slug', run(async (req, res) => { const slug = param(req.params.slug); const store = await prisma.store.findFirst({ where: { slug, seller: { status: SellerStatus.APPROVED } }, include: { seller: { select: { products: { where: { status: ProductStatus.APPROVED }, include: { category: true, brand: true, featureAssignments: { include: { feature: true } }, inventory: true, images: true, mediaAttachments: { where: { mediaAsset: { uploadStatus: 'COMPLETE', scanStatus: 'APPROVED' } }, orderBy: { position: 'asc' }, include: { mediaAsset: { select: { id: true, kind: true, detectedMime: true, originalName: true } } } }, variants: { where: { status: ProductStatus.APPROVED }, orderBy: { name: 'asc' } } }, orderBy: { createdAt: 'desc' } } } } } }); if (!store) { const redirect = await prisma.slugRedirect.findUnique({ where: { fromPath: `/store/${slug}` } }); if (redirect) return res.json({ redirectTo: redirect.destinationPath, statusCode: redirect.statusCode }); return res.status(404).json({ error: 'Store not found' }); } const theme = storeThemeSchema.safeParse(store.themePublishedJson ?? {}); const publishedTheme = theme.success ? theme.data : storeThemeSchema.parse({}); res.json({ storeId: store.id, name: store.name, slug: store.slug, publicPath: `/store/${store.slug}`, theme: publishedTheme, publishedAt: store.themePublishedAt, products: store.seller.products.map(product => ({ id: product.id, name: product.name, slug: product.slug, description: product.description, priceMinor: product.priceMinor, salePriceMinor: product.salePriceMinor, currency: product.currency, wholesaleEnabled: product.wholesaleEnabled, wholesaleMinQuantity: product.wholesaleMinQuantity, wholesaleMaxQuantity: product.wholesaleMaxQuantity, availableStock: product.inventory?.quantity ?? 0, category: product.category ? { name: product.category.name, slug: product.category.slug } : null, brand: product.brand ? { name: product.brand.name, slug: product.brand.slug } : null, color: product.color, features: product.featureAssignments.map(item => ({ id: item.feature.id, name: item.feature.name })), images: product.images.map(image => ({ url: image.url, alt: image.alt })), mediaAttachments: product.mediaAttachments.map(({ mediaAsset, ...attachment }) => ({ ...attachment, kind: mediaAsset.kind, originalName: mediaAsset.originalName, detectedMime: mediaAsset.detectedMime, url: `/content-media/${encodeURIComponent(mediaAsset.id)}` })), variants: product.variants.map(variant => ({ id: variant.id, name: variant.name, priceMinor: variant.priceMinor, currency: variant.currency, stock: variant.stock })) })) }); }));
  app.get('/api/stores/:slug/theme', run(async (req, res) => { const store = await prisma.store.findFirst({ where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } }, include: { seller: true } }); if (!store || !store.themePublishedJson) return res.status(404).json({ error: 'Store theme not found' }); res.json({ storeId: store.id, slug: store.slug, theme: store.themePublishedJson, publishedAt: store.themePublishedAt }); }));

  app.get('/api/seller/payout-methods', requireAuth, requireRole(...sellerRoles), run(async (_req, res) => { const actor = user(res); if (!actor.sellerId) throw fail(403, 'Seller scope required'); const methods = await prisma.sellerPayoutMethod.findMany({ where: { sellerId: actor.sellerId }, orderBy: { createdAt: 'desc' } }); res.json(methods.map(safePayoutMethod)); }));
  app.post('/api/seller/payout-methods', requireAuth, requireRole(...sellerRoles), run(async (req, res, next) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const input = payoutMethodSchema.parse(req.body);
    if (input.type !== PayoutMethodType.STRIPE_CONNECT && input.type !== PayoutMethodType.PAYPAL_PAYOUTS) return next();
    const seller = await prisma.seller.findUnique({ where: { id: actor.sellerId }, include: { store: true } });
    if (!seller || seller.status !== SellerStatus.APPROVED || !seller.store) throw fail(403, 'Approved seller with a Store required');
    const entitlements = await storeEntitlements(prisma, seller.store.id);
    if (!sellerPayoutConnectorAllowed(input.type, entitlements)) return res.status(409).json({ code: 'PLAN_ENTITLEMENT_REQUIRED', entitlement: 'sellerManagedPaymentsEnabled', error: 'This plan does not include seller-owned payment accounts or this payment connector.', planUrl: '/seller/plan' });
    return next();
  }));
  app.post('/api/seller/payout-methods', requireAuth, requireRole(...sellerRoles), run(async (req, res) => { const actor = user(res); if (!actor.sellerId) throw fail(403, 'Seller scope required'); const seller = await prisma.seller.findUnique({ where: { id: actor.sellerId }, select: { status: true } }); if (!seller || seller.status !== SellerStatus.APPROVED) throw fail(403, 'Approved seller required'); const input = payoutMethodSchema.parse(req.body); const setting = await settings(); if (!payoutMethodEnabled(input.type, setting)) throw fail(409, 'This payout method is disabled by the platform'); if (input.type.startsWith('MANUAL_') && !input.identifier) throw fail(400, 'An account identifier is required for manual payout methods'); const providerReady = providerMethodConfigured(input.type); const method = await prisma.$transaction(async tx => { const saved = await tx.sellerPayoutMethod.upsert({ where: { sellerId_type: { sellerId: actor.sellerId!, type: input.type as PayoutMethodType } }, update: { country: input.country, currency: input.currency, label: input.label, maskedIdentifier: input.identifier ? maskIdentifier(input.identifier) : null, encryptedDetails: input.details ? encryptPayoutDetails(input.details) : undefined, status: input.type.startsWith('MANUAL_') ? PayoutMethodStatus.READY : providerReady ? PayoutMethodStatus.ACTION_REQUIRED : PayoutMethodStatus.DISABLED, providerStatus: providerReady ? 'configured' : 'provider credentials unavailable', createdById: actor.id }, create: { sellerId: actor.sellerId!, type: input.type as PayoutMethodType, country: input.country, currency: input.currency, label: input.label, maskedIdentifier: input.identifier ? maskIdentifier(input.identifier) : null, encryptedDetails: input.details ? encryptPayoutDetails(input.details) : undefined, status: input.type.startsWith('MANUAL_') ? PayoutMethodStatus.READY : providerReady ? PayoutMethodStatus.ACTION_REQUIRED : PayoutMethodStatus.DISABLED, providerStatus: providerReady ? 'configured' : 'provider credentials unavailable', createdById: actor.id } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'SELLER_PAYOUT_METHOD_SAVED', entity: 'SellerPayoutMethod', entityId: saved.id, metadata: { type: input.type, country: input.country, currency: input.currency } } }); return saved; }); res.status(201).json(safePayoutMethod(method)); }));
  app.delete('/api/seller/payout-methods/:id', requireAuth, requireRole(...sellerRoles), run(async (req, res) => { const actor = user(res); if (!actor.sellerId) throw fail(403, 'Seller scope required'); const method = await prisma.sellerPayoutMethod.findFirst({ where: { id: param(req.params.id), sellerId: actor.sellerId } }); if (!method) return res.status(404).json({ error: 'Payout method not found' }); await prisma.sellerPayoutMethod.update({ where: { id: method.id }, data: { status: PayoutMethodStatus.DISABLED, isDefault: false } }); await audit(actor.id, 'SELLER_PAYOUT_METHOD_DISABLED', 'SellerPayoutMethod', method.id); res.status(204).send(); }));
  app.get('/api/seller/payouts', requireAuth, requireRole(...sellerRoles), run(async (_req, res) => { const actor = user(res); if (!actor.sellerId) throw fail(403, 'Seller scope required'); res.json(await prisma.sellerPayout.findMany({ where: { sellerId: actor.sellerId }, include: { payoutMethod: { select: { type: true, maskedIdentifier: true } }, items: true }, orderBy: { createdAt: 'desc' } })); }));

  app.post('/api/admin/payout-ledger/reconcile-seller-order/:id', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const setting = await settings();
    if (!setting.sellerPayoutsEnabled || !setting.payoutFundingConfigured) throw fail(409, 'Seller payout funding is not configured and enabled');
    const orderId = param(req.params.id);
    const initial = await prisma.sellerOrder.findUnique({ where: { id: orderId }, select: { id: true, parentId: true } });
    if (!initial) throw fail(404, 'Seller order not found');
    const entries = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.id} FOR UPDATE`;
      const order = await tx.sellerOrder.findUnique({ where: { id: initial.id }, include: { seller: true, parent: { include: { payment: true } }, items: true } });
      if (!order?.seller || order.parent.payment?.status !== PaymentStatus.PAID || (order.parent.payment.method !== PaymentMethod.STRIPE && order.parent.payment.method !== PaymentMethod.PAYPAL)) throw fail(409, 'Only settled online payments can enter seller payout funding. COD and POS are not platform-held funds.');
      if (!order.receivedAt) throw fail(409, 'Buyer receipt confirmation is required before seller proceeds become payout-eligible.');
      if (order.status === 'CANCELLED') throw fail(409, 'Cancelled seller orders cannot fund payouts.');
      return Promise.all(order.items.map(item => tx.sellerPayoutLedgerEntry.upsert({
        where: { idempotencyKey: `sale-funding:${item.id}` },
        update: {},
        create: { sellerId: order.seller!.id, sellerOrderId: order.id, orderItemId: item.id, type: SellerPayoutLedgerType.SALE_FUNDING, amountMinor: Math.max(0, item.unitPriceMinor * item.quantity - item.discountMinor), currency: order.parent.currency, idempotencyKey: `sale-funding:${item.id}`, description: `Buyer-confirmed funding for order item ${item.id}`, createdById: actor.id }
      })));
    });
    await audit(actor.id, 'SELLER_PAYOUT_LEDGER_FUNDED', 'SellerOrder', initial.id, { entryCount: entries.length, buyerReceiptRequired: true });
    res.status(201).json(entries);
  }));
  app.post('/api/seller/payouts/request', requireAuth, requireRole(...sellerRoles), run(async (req, res) => {
    const actor = user(res);
    if (!actor.sellerId) throw fail(403, 'Seller scope required');
    const input = z.object({ payoutMethodId: z.string().min(1).max(80) }).strict().parse(req.body);
    const setting = await settings();
    if (!setting.sellerPayoutsEnabled || !setting.payoutFundingConfigured) throw fail(409, 'Seller payout funding is not configured and enabled');
    const method = await prisma.sellerPayoutMethod.findFirst({ where: { id: input.payoutMethodId, sellerId: actor.sellerId, status: PayoutMethodStatus.READY } });
    if (!method) throw fail(409, 'A ready payout method for this seller is required');
    const payout = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Seller" WHERE "id" = ${actor.sellerId} FOR UPDATE`;
      const cutoff = new Date(Date.now() - setting.payoutHoldDays * 86_400_000);
      const eligibleWhere: Prisma.SellerPayoutLedgerEntryWhereInput = {
        sellerId: actor.sellerId,
        currency: method.currency,
        type: SellerPayoutLedgerType.SALE_FUNDING,
        amountMinor: { gt: 0 },
        payoutItems: { none: {} },
        sellerOrder: {
          is: {
            receivedAt: { lte: cutoff },
            status: { not: OrderStatus.CANCELLED },
            parent: {
              is: {
                payment: {
                  is: {
                    status: PaymentStatus.PAID,
                    method: { in: [PaymentMethod.STRIPE, PaymentMethod.PAYPAL] }
                  }
                },
                commissionReviewEvents: { none: { status: 'NEEDS_ALLOCATION' } }
              }
            }
          }
        }
      };
      const candidates = await tx.sellerPayoutLedgerEntry.findMany({ where: eligibleWhere, select: { sellerOrder: { select: { id: true } } } });
      const candidateOrderIds = candidates.flatMap(entry => entry.sellerOrder ? [entry.sellerOrder.id] : []);
      await lockSellerOrdersForPayout(tx, candidateOrderIds);
      const openCaseOrders = candidateOrderIds.length ? await tx.$queryRaw<Array<{ sellerOrderId: string }>>`SELECT DISTINCT "sellerOrderId" FROM "OrderResolutionCase" WHERE "sellerOrderId" = ANY(${candidateOrderIds}::text[]) AND "status" IN ('OPEN', 'UNDER_REVIEW', 'REFUND_APPROVED')` : [];
      const openCaseOrderIds = new Set(openCaseOrders.map(item => item.sellerOrderId));
      const entries = await tx.sellerPayoutLedgerEntry.findMany({ where: eligibleWhere, include: { sellerOrder: { select: { parentId: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const eligibleEntries = entries.filter(entry => !openCaseOrderIds.has(entry.sellerOrderId ?? ''));
      const parentOrderIds = [...new Set(eligibleEntries.flatMap(entry => entry.sellerOrder ? [entry.sellerOrder.parentId] : []))];
      const refundsByItem = await refundedMinorByOrderItem(parentOrderIds, tx);
      const payableEntries = eligibleEntries.map(entry => ({ ...entry, payoutAmountMinor: entry.orderItemId ? remainingSaleMinor(entry.amountMinor, refundsByItem.get(entry.orderItemId) ?? 0) : 0 })).filter(entry => entry.payoutAmountMinor > 0);
      const amount = payableEntries.reduce((sum, item) => sum + item.payoutAmountMinor, 0);
      if (!payableEntries.length || amount < setting.payoutMinimumMinor) throw fail(409, 'No buyer-confirmed online proceeds remain available after refunds and the configured hold period.');
      const currency = method.currency;
      const created = await tx.sellerPayout.create({ data: {
        sellerId: actor.sellerId!, payoutMethodId: method.id, amountMinor: amount, currency,
        status: SellerPayoutStatus.REQUESTED, requestedById: actor.id,
        idempotencyKey: `seller-payout:${actor.sellerId}:${payableEntries.map(entry => `${entry.id}:${entry.payoutAmountMinor}`).join(',')}`
      } });
      await tx.sellerPayoutItem.createMany({ data: payableEntries.map(entry => ({ payoutId: created.id, ledgerId: entry.id, amountMinor: entry.payoutAmountMinor })) });
      return { payout: created, amount, currency };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    await audit(actor.id, 'SELLER_PAYOUT_REQUESTED', 'SellerPayout', payout.payout.id, { amountMinor: payout.amount, currency: payout.currency, buyerReceiptRequired: true });
    res.status(201).json(payout.payout);
  }));
  app.get('/api/admin/payouts', requireAuth, requireRole(...admin), run(async (req, res) => { const status = typeof req.query.status === 'string' && Object.values(SellerPayoutStatus).includes(req.query.status as SellerPayoutStatus) ? req.query.status as SellerPayoutStatus : undefined; res.json(await prisma.sellerPayout.findMany({ where: status ? { status } : undefined, include: { seller: { include: { user: { select: { email: true, name: true } }, store: { select: { name: true, slug: true } } } }, payoutMethod: { select: { type: true, maskedIdentifier: true, country: true, currency: true } }, items: true }, orderBy: { createdAt: 'desc' }, take: 200 })); }));
  app.post('/api/admin/payouts/:id/approve', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const setting = await settings();
    const payoutId = param(req.params.id);
    const updated = await prisma.$transaction(async tx => {
      const payout = await tx.sellerPayout.findUnique({ where: { id: payoutId } });
      if (!payout) throw fail(404, 'Payout not found');
      if (!payoutStatusTransitionAllowed(payout.status, SellerPayoutStatus.APPROVED)) throw fail(409, `Cannot approve payout in ${payout.status} state`);
      await lockPayoutOrders(tx, payout.id);
      await assertPayoutItemsEligible(payout.id, setting.payoutHoldDays, tx);
      return tx.sellerPayout.update({ where: { id: payout.id }, data: { status: SellerPayoutStatus.APPROVED, reviewedById: actor.id, reviewedAt: new Date() } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    await audit(actor.id, 'SELLER_PAYOUT_APPROVED', 'SellerPayout', updated.id, { buyerReceiptAndHoldRechecked: true });
    res.json(updated);
  }));
  app.post('/api/admin/payouts/:id/reject', requireAuth, requireRole(...admin), run(async (req, res) => { const actor = user(res); const input = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body); const payout = await prisma.sellerPayout.findUnique({ where: { id: param(req.params.id) } }); if (!payout) return res.status(404).json({ error: 'Payout not found' }); if (!payoutStatusTransitionAllowed(payout.status, SellerPayoutStatus.REJECTED)) throw fail(409, `Cannot reject payout in ${payout.status} state`); const updated = await prisma.sellerPayout.update({ where: { id: payout.id }, data: { status: SellerPayoutStatus.REJECTED, reviewedById: actor.id, reviewedAt: new Date(), failureReason: input.reason } }); await audit(actor.id, 'SELLER_PAYOUT_REJECTED', 'SellerPayout', updated.id, { reason: input.reason }); res.json(updated); }));
  app.post('/api/admin/payouts/:id/mark-paid', requireAuth, requireRole(...admin), run(async (req, res) => {
    const actor = user(res);
    const input = z.object({ reference: z.string().trim().min(1).max(200), evidenceNote: z.string().trim().min(1).max(1000) }).strict().parse(req.body);
    const setting = await settings();
    const payoutId = param(req.params.id);
    const updated = await prisma.$transaction(async tx => {
      const payout = await tx.sellerPayout.findFirst({ where: { id: payoutId, payoutMethod: { type: { in: [PayoutMethodType.MANUAL_BANK, PayoutMethodType.MANUAL_EWALLET] } } } });
      if (!payout) throw fail(404, 'Manual payout not found');
      if (!payoutStatusTransitionAllowed(payout.status, SellerPayoutStatus.PAID) && payout.status !== SellerPayoutStatus.APPROVED) throw fail(409, `Cannot mark payout in ${payout.status} state as paid`);
      await lockPayoutOrders(tx, payout.id);
      await assertPayoutItemsEligible(payout.id, setting.payoutHoldDays, tx);
      return tx.sellerPayout.update({ where: { id: payout.id }, data: { status: SellerPayoutStatus.PAID, reviewedById: actor.id, reviewedAt: new Date(), paidAt: new Date(), manualReference: input.reference, evidenceNote: input.evidenceNote } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    await audit(actor.id, 'SELLER_PAYOUT_MARKED_PAID', 'SellerPayout', updated.id, { reference: input.reference, buyerReceiptAndHoldRechecked: true });
    res.json(updated);
  }));
  app.get('/api/admin/payout-readiness', requireAuth, requireRole(...admin), run(async (_req, res) => { const setting = await settings(); res.json({ enabled: setting.sellerPayoutsEnabled, fundingConfigured: setting.payoutFundingConfigured, methods: { manualBank: setting.manualBankPayoutsEnabled, manualEwallet: setting.manualEwalletPayoutsEnabled, stripeConnect: setting.stripeConnectPayoutsEnabled && Boolean(env.STRIPE_SECRET_KEY), paypalPayouts: setting.paypalPayoutsEnabled && Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) }, warning: 'Checkout funds remain platform funds. No seller payout is created until the owner configures and enables a funding policy.' }); }));
}
