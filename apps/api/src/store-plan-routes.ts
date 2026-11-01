import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { createHash } from 'node:crypto';
import { Prisma, Role, SellerStatus, StorePlanAssignmentStatus, StorePlanStatus, StorePlanVersionStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { asStorePlanEntitlements, dropshippingPlanBlock, effectiveStorePlan, sellerOwnedConnectionsPlanBlock, storeEntitlements, storePlanEntitlementsSchema } from './store-plan-domain.js';
import { formatMinorAmount, isFreePlan, planPricingInputSchema, resolvePlanPricing } from './store-plan-pricing.js';
import { env } from './config.js';
import { stripeStoreBillingProvider, storePlanBillingSandboxEnabled, stripeStoreBillingTermsSupported } from './stripe-store-billing.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const adminOnly = [Role.ADMIN];
const sellerRoles = [Role.SELLER, Role.CASHIER];
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const reason = z.string().trim().min(3).max(500);
const planKey = z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase plan key with hyphens');

const createPlanSchema = z.object({
  key: planKey,
  name: z.string().trim().min(2).max(100),
  entitlements: storePlanEntitlementsSchema,
  pricing: planPricingInputSchema.optional(),
  reason
}).strict();

const editPlanSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  entitlements: storePlanEntitlementsSchema.optional(),
  pricing: planPricingInputSchema.optional(),
  reason
}).strict().refine(input => input.name !== undefined || input.entitlements !== undefined || input.pricing !== undefined, 'Provide a name or a new plan version');

const assignmentSchema = z.object({ versionId: z.string().trim().min(1).max(80), reason }).strict();
const actionSchema = z.object({ reason }).strict();

async function planAudit(tx: Prisma.TransactionClient, actorId: string, action: string, entity: string, entityId: string, metadata: unknown) {
  await tx.auditLog.create({ data: { actorId, action, entity, entityId, metadata: json(metadata) } });
}

function versionData(name: string, entitlements: z.infer<typeof storePlanEntitlementsSchema>, pricing: z.infer<typeof planPricingInputSchema>) {
  let resolvedPricing: ReturnType<typeof resolvePlanPricing>;
  try { resolvedPricing = resolvePlanPricing(pricing); }
  catch (error) { throw fail(400, error instanceof Error ? error.message : 'Invalid pricing terms.'); }
  const providerPolicyBlock = sellerOwnedConnectionsPlanBlock(resolvedPricing, entitlements);
  if (providerPolicyBlock) throw fail(400, providerPolicyBlock);
  const dropshippingBlock = dropshippingPlanBlock(resolvedPricing, entitlements);
  if (dropshippingBlock) throw fail(400, dropshippingBlock);
  return {
    name,
    ...entitlements,
    ...resolvedPricing,
    allowedThemes: entitlements.allowedThemes,
    paymentConnectors: entitlements.paymentConnectors,
    mobileTemplates: entitlements.mobileTemplates
  };
}

function pricingInputFromVersion(version: {
  description: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number;
  annualDiscountPercent: number | null; defaultInterval: 'MONTHLY' | 'ANNUAL'; termIntervals: number | null;
  expirationBehavior: 'DOWNGRADE_TO_LEGACY' | 'SUSPEND_SELLER'; cancellationPolicy: 'CANCEL_ANYTIME' | 'CANCEL_AT_TERM_END';
  freeTrialDays: number; introPriceMinor: number | null; introDurationDays: number | null;
  effectiveFrom: Date | null; effectiveUntil: Date | null;
}) {
  const annualPriceMode = version.annualDiscountPercent !== null ? 'DISCOUNT' : version.annualPriceMinor === version.monthlyPriceMinor * 12 ? 'FULL' : 'FIXED';
  return planPricingInputSchema.parse({
    description: version.description,
    currency: version.currency,
    monthlyPrice: formatMinorAmount(version.monthlyPriceMinor),
    annualPriceMode,
    ...(annualPriceMode === 'FIXED' ? { annualPrice: formatMinorAmount(version.annualPriceMinor) } : {}),
    ...(annualPriceMode === 'DISCOUNT' ? { annualDiscountPercent: version.annualDiscountPercent! } : {}),
    defaultInterval: version.defaultInterval,
    termIntervals: version.termIntervals,
    expirationBehavior: version.expirationBehavior,
    cancellationPolicy: version.cancellationPolicy,
    freeTrialDays: version.freeTrialDays,
    ...(version.introPriceMinor !== null ? { introPrice: formatMinorAmount(version.introPriceMinor), introDurationDays: version.introDurationDays! } : {}),
    ...(version.effectiveFrom ? { effectiveFrom: version.effectiveFrom.toISOString() } : {}),
    ...(version.effectiveUntil ? { effectiveUntil: version.effectiveUntil.toISOString() } : {})
  });
}

export function registerStorePlanRoutes(app: Express) {
  app.get('/api/admin/store-plans', requireAuth, requireRole(...adminOnly), run(async (_req, res) => {
    const plans = await prisma.storePlan.findMany({
      include: { versions: { orderBy: { version: 'desc' }, include: { _count: { select: { assignments: true } } } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }]
    });
    res.json(plans);
  }));

  app.post('/api/admin/store-plans', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const user = actor(res);
    const input = createPlanSchema.parse(req.body);
    if (await prisma.storePlan.findUnique({ where: { key: input.key }, select: { id: true } })) return res.status(409).json({ error: 'A plan with that key already exists.' });
    const result = await prisma.$transaction(async tx => {
      const plan = await tx.storePlan.create({ data: { key: input.key, name: input.name, status: StorePlanStatus.DRAFT } });
      const pricing = input.pricing ?? planPricingInputSchema.parse({});
      const version = await tx.storePlanVersion.create({ data: { planId: plan.id, version: 1, createdById: user.id, ...versionData(plan.name, input.entitlements, pricing) } });
      await planAudit(tx, user.id, 'STORE_PLAN_CREATED', 'StorePlan', plan.id, { name: plan.name, key: plan.key, version: version.version, entitlements: input.entitlements, pricing, reason: input.reason });
      return { plan, version };
    });
    res.status(201).json(result);
  }));

  app.patch('/api/admin/store-plans/:id', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const user = actor(res);
    const planId = param(req.params.id);
    const input = editPlanSchema.parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "StorePlan" WHERE "id" = ${planId} FOR UPDATE`;
      const current = await tx.storePlan.findUnique({ where: { id: planId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
      if (!current) throw fail(404, 'Store plan not found.');
      if (current.key === 'legacy-compatible') throw fail(409, 'The compatibility baseline is system-managed and cannot be edited.');
      if (current.status === StorePlanStatus.RETIRED) throw fail(409, 'Retired plans cannot be edited; create a new plan instead.');
      const updated = input.name === undefined ? current : await tx.storePlan.update({ where: { id: current.id }, data: { name: input.name } });
      let version = current.versions[0] ?? null;
      if (input.name !== undefined || input.entitlements || input.pricing) {
        if (!version) throw fail(409, 'This plan has no version to copy. Create a new plan instead.');
        const nextVersion = (await tx.storePlanVersion.aggregate({ where: { planId }, _max: { version: true } }))._max.version ?? 0;
        const nextEntitlements = input.entitlements ?? asStorePlanEntitlements(version);
        const nextPricing = input.pricing ?? pricingInputFromVersion(version);
        version = await tx.storePlanVersion.create({ data: { planId, version: nextVersion + 1, createdById: user.id, ...versionData(input.name ?? version.name, nextEntitlements, nextPricing) } });
      }
      await planAudit(tx, user.id, 'STORE_PLAN_EDITED', 'StorePlan', planId, {
        oldName: current.name,
        newName: updated.name,
        newDraftVersion: input.entitlements ? version?.version : null,
        entitlements: input.entitlements ?? null,
        pricing: input.pricing ?? null,
        reason: input.reason
      });
      return { plan: updated, version };
    });
    res.json(result);
  }));

  app.post('/api/admin/store-plans/:id/activate', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const user = actor(res);
    const planId = param(req.params.id);
    const input = z.object({ versionId: z.string().trim().min(1).max(80), reason }).strict().parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "StorePlan" WHERE "id" = ${planId} FOR UPDATE`;
      const plan = await tx.storePlan.findUnique({ where: { id: planId } });
      if (!plan) throw fail(404, 'Store plan not found.');
      if (plan.status === StorePlanStatus.RETIRED) throw fail(409, 'Retired plans cannot be activated. Create a replacement plan.');
      const target = await tx.storePlanVersion.findFirst({ where: { id: input.versionId, planId } });
      if (!target) throw fail(404, 'Draft plan version not found.');
      if (target.status === StorePlanVersionStatus.ACTIVE) return { plan, version: target, alreadyActive: true };
      if (target.status !== StorePlanVersionStatus.DRAFT) throw fail(409, 'Only a draft plan version can be activated.');
      await tx.storePlanVersion.updateMany({ where: { planId, status: StorePlanVersionStatus.ACTIVE }, data: { status: StorePlanVersionStatus.SUPERSEDED } });
      const now = new Date();
      const effectiveFrom = target.effectiveFrom ?? now;
      if (target.effectiveUntil && (target.effectiveUntil <= now || target.effectiveUntil <= effectiveFrom)) throw fail(409, 'The plan version end date has passed or is before its effective start.');
      const version = await tx.storePlanVersion.update({ where: { id: target.id }, data: { status: StorePlanVersionStatus.ACTIVE, activatedAt: now, effectiveFrom } });
      const updatedPlan = await tx.storePlan.update({ where: { id: planId }, data: { status: StorePlanStatus.ACTIVE } });
      await planAudit(tx, user.id, 'STORE_PLAN_VERSION_ACTIVATED', 'StorePlanVersion', version.id, { planId, version: version.version, effectiveFrom: version.effectiveFrom, effectiveUntil: version.effectiveUntil, reason: input.reason });
      return { plan: updatedPlan, version, alreadyActive: false };
    });
    res.json(result);
  }));

  app.post('/api/admin/store-plans/:id/retire', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const user = actor(res);
    const planId = param(req.params.id);
    const input = actionSchema.parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "StorePlan" WHERE "id" = ${planId} FOR UPDATE`;
      const plan = await tx.storePlan.findUnique({ where: { id: planId } });
      if (!plan) throw fail(404, 'Store plan not found.');
      if (plan.key === 'legacy-compatible') throw fail(409, 'The compatibility baseline cannot be retired.');
      if (plan.status === StorePlanStatus.RETIRED) return plan;
      const updated = await tx.storePlan.update({ where: { id: planId }, data: { status: StorePlanStatus.RETIRED } });
      await planAudit(tx, user.id, 'STORE_PLAN_RETIRED', 'StorePlan', planId, { oldStatus: plan.status, newStatus: updated.status, reason: input.reason });
      return updated;
    });
    res.json(result);
  }));

  app.get('/api/admin/store-plan-stores', requireAuth, requireRole(...adminOnly), run(async (_req, res) => {
    const stores = await prisma.store.findMany({
      select: { id: true, name: true, slug: true, seller: { select: { id: true, status: true, user: { select: { name: true, email: true } }, _count: { select: { products: true, staff: true } } } } },
      orderBy: { name: 'asc' },
      take: 500
    });
    res.json(stores);
  }));

  app.get('/api/admin/store-plan-stores/:storeId/assignments', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const storeId = param(req.params.storeId);
    if (!await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } })) return res.status(404).json({ error: 'Store not found.' });
    const assignments = await prisma.storePlanAssignment.findMany({
      where: { storeId },
      include: { planVersion: { include: { plan: true } }, assignedBy: { select: { id: true, name: true, email: true } } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }]
    });
    res.json(assignments);
  }));

  app.post('/api/admin/store-plan-stores/:storeId/assignments', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const user = actor(res);
    const storeId = param(req.params.storeId);
    const input = assignmentSchema.parse(req.body);
    const result = await prisma.$transaction(async tx => {
      const versionPeek = await tx.storePlanVersion.findUnique({ where: { id: input.versionId }, select: { planId: true } });
      if (!versionPeek) throw fail(404, 'Plan version not found.');
      // Lock parent then tenant, matching plan activation and all Store-scoped quota writes.
      await tx.$queryRaw`SELECT "id" FROM "StorePlan" WHERE "id" = ${versionPeek.planId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${storeId} FOR UPDATE`;
      const [store, version] = await Promise.all([
        tx.store.findUnique({ where: { id: storeId }, include: { seller: { include: { _count: { select: { staff: true, products: true } } } } } }),
        tx.storePlanVersion.findUnique({ where: { id: input.versionId }, include: { plan: true } })
      ]);
      if (!store) throw fail(404, 'Store not found.');
      if (!version || version.plan.status !== StorePlanStatus.ACTIVE || version.status !== StorePlanVersionStatus.ACTIVE) throw fail(409, 'Only an active version of an active plan can be assigned.');
      const now = new Date();
      if ((version.effectiveFrom && version.effectiveFrom > now) || (version.effectiveUntil && version.effectiveUntil <= now)) throw fail(409, 'This plan version is outside its effective date range.');
      if (!isFreePlan(version)) throw fail(409, 'Paid plan entitlements cannot be assigned manually while subscription billing is disabled.');
      const storeUsage = await tx.store.count({ where: { sellerId: store.sellerId } });
      const vendorUsage = 1; // Store currently has exactly one Seller owner by schema.
      if (storeUsage > version.storeLimit || vendorUsage > version.vendorLimit) throw fail(409, 'This plan is below the Store or vendor count already in use. Existing access was not changed.');

      const current = await tx.storePlanAssignment.findFirst({ where: { storeId, status: StorePlanAssignmentStatus.ACTIVE, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' } });
      if (current?.planVersionId === version.id) return { assignment: current, alreadyAssigned: true };
      const effectiveFrom = new Date(Math.max(Date.now(), (current?.effectiveFrom.getTime() ?? 0) + 1));
      if (current) await tx.storePlanAssignment.update({ where: { id: current.id }, data: { status: StorePlanAssignmentStatus.SUPERSEDED, effectiveUntil: effectiveFrom } });
      await tx.storePlanAssignment.updateMany({ where: { storeId, status: StorePlanAssignmentStatus.ACTIVE, effectiveUntil: { lte: effectiveFrom } }, data: { status: StorePlanAssignmentStatus.EXPIRED } });
      const assignment = await tx.storePlanAssignment.create({ data: { storeId, planVersionId: version.id, status: StorePlanAssignmentStatus.ACTIVE, source: 'ADMIN', assignedById: user.id, effectiveFrom, reason: input.reason } });
      await planAudit(tx, user.id, 'STORE_PLAN_ASSIGNED', 'Store', storeId, {
        previousAssignmentId: current?.id ?? null,
        previousPlanVersionId: current?.planVersionId ?? null,
        planVersionId: version.id,
        planName: version.plan.name,
        planVersion: version.version,
        storeUsage,
        vendorUsage,
        existingStaffSeats: store.seller._count.staff,
        existingProducts: store.seller._count.products,
        reason: input.reason
      });
      return { assignment: await tx.storePlanAssignment.findUnique({ where: { id: assignment.id }, include: { planVersion: { include: { plan: true } } } }), alreadyAssigned: false };
    });
    res.status(result.alreadyAssigned ? 200 : 201).json(result);
  }));

  app.get('/api/seller/plan', requireAuth, requireRole(...sellerRoles), run(async (_req, res) => {
    const user = actor(res);
    if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, include: { store: true, _count: { select: { staff: true, products: true } } } });
    if (!seller?.store) return res.status(404).json({ error: 'The approved seller Store is unavailable.' });
    const [effective, productCount, storeCount, blogPostCount, contentPageCount, mediaBytes] = await Promise.all([
      effectiveStorePlan(prisma, seller.store.id),
      prisma.product.count({ where: { sellerId: seller.id, status: { not: 'ARCHIVED' } } }),
      prisma.store.count({ where: { sellerId: seller.id } }),
      prisma.blogPost.count({ where: { storeId: seller.store.id, status: { not: 'ARCHIVED' } } }),
      prisma.contentPage.count({ where: { storeId: seller.store.id, status: { not: 'ARCHIVED' } } }),
      prisma.mediaAsset.aggregate({ where: { storeId: seller.store.id, uploadStatus: { not: 'FAILED' } }, _sum: { sizeBytes: true } })
    ]);
    const adminOverride = user.role === Role.ADMIN && seller.store.isPlatformStore;
    const entitlements = await storeEntitlements(prisma, seller.store.id, effective.version);
    res.json({
      adminOverride,
      store: { id: seller.store.id, name: seller.store.name, slug: seller.store.slug },
      plan: adminOverride ? { key: 'platform-admin', name: 'Platform administrator access', status: 'ACTIVE', version: 1, versionStatus: 'ACTIVE' } : effective.plan ? { id: effective.plan.id, key: effective.plan.key, name: effective.version?.name ?? effective.plan.name, status: effective.plan.status, version: effective.version?.version ?? 1, versionStatus: effective.version?.status ?? 'ACTIVE' } : { key: 'legacy-compatible', name: 'Legacy compatible', status: 'ACTIVE', version: 1, versionStatus: 'ACTIVE' },
      assignment: effective.assignment ? { id: effective.assignment.id, status: effective.assignment.status, source: effective.assignment.source, effectiveFrom: effective.assignment.effectiveFrom, effectiveUntil: effective.assignment.effectiveUntil } : { id: null, status: 'ACTIVE', source: 'LEGACY_FALLBACK', effectiveFrom: null, effectiveUntil: null },
      pricing: effective.version ? {
        description: effective.version.description,
        currency: effective.version.currency,
        monthlyPriceMinor: effective.version.monthlyPriceMinor,
        annualPriceMinor: effective.version.annualPriceMinor,
        annualDiscountPercent: effective.version.annualDiscountPercent,
        defaultInterval: effective.version.defaultInterval,
        termIntervals: effective.version.termIntervals,
        expirationBehavior: effective.version.expirationBehavior,
        cancellationPolicy: effective.version.cancellationPolicy,
        freeTrialDays: effective.version.freeTrialDays,
        introPriceMinor: effective.version.introPriceMinor,
        introDurationDays: effective.version.introDurationDays,
        effectiveFrom: effective.version.effectiveFrom,
        effectiveUntil: effective.version.effectiveUntil
      } : {
        description: 'Compatibility plan for existing Stores.', currency: 'USD', monthlyPriceMinor: 0,
        annualPriceMinor: 0, annualDiscountPercent: null, defaultInterval: 'MONTHLY', termIntervals: null,
        expirationBehavior: 'DOWNGRADE_TO_LEGACY', cancellationPolicy: 'CANCEL_ANYTIME', freeTrialDays: 0,
        introPriceMinor: null, introDurationDays: null, effectiveFrom: null, effectiveUntil: null
      },
      entitlements,
      usage: { products: productCount, stores: storeCount, vendors: 1, staffSeats: seller._count.staff, blogPosts: blogPostCount, contentPages: contentPageCount, mediaStorageBytes: mediaBytes._sum.sizeBytes ?? 0 },
      notes: adminOverride ? {
        connectors: 'Platform admin entitlements bypass Store plan gates. External payment-provider onboarding, credentials, and operational activation remain separately controlled.',
        customDomain: 'Custom-domain features are included; DNS, domain ownership verification, and TLS provisioning remain required.',
        mobileTemplates: 'All supported responsive web storefront templates are included; these are not native applications.'
      } : {
        connectors: 'Plan connectors describe eligibility only. Seller payment processing and seller payout integrations are not enabled by this plan.',
        customDomain: 'Eligibility does not provision DNS or TLS.',
        mobileTemplates: 'These are responsive web storefront templates, not native applications.'
      }
    });
  }));

  app.get('/api/seller/plan-options', requireAuth, requireRole(...sellerRoles), run(async (_req, res) => {
    const user = actor(res);
    if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, select: { store: { select: { id: true, isPlatformStore: true } } } });
    if (!seller?.store) return res.status(404).json({ error: 'The approved seller Store is unavailable.' });
    if (user.role === Role.ADMIN && seller.store.isPlatformStore) return res.json({ adminOverride: true, checkoutAvailable: false, checkoutUnavailableReason: 'The official platform Store is exempt from plan billing.', offers: [] });
    const now = new Date();
    const versions = await prisma.storePlanVersion.findMany({
      where: {
        status: StorePlanVersionStatus.ACTIVE,
        plan: { status: StorePlanStatus.ACTIVE, key: { not: 'legacy-compatible' } },
        effectiveFrom: { lte: now },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }]
      },
      include: { plan: { select: { key: true, name: true } } },
      orderBy: [{ monthlyPriceMinor: 'asc' }, { planId: 'asc' }, { version: 'desc' }]
    });
    const providerReady = storePlanBillingSandboxEnabled;
    const unavailableReason = providerReady ? 'Stripe test-mode sandbox is enabled; no live billing is available.' : 'Stripe Store billing sandbox is disabled.';
    res.json({ checkoutAvailable: providerReady, checkoutUnavailableReason: unavailableReason, offers: versions.map(version => {
      const terms = stripeStoreBillingTermsSupported(version);
      return {
      id: version.id, plan: { key: version.plan.key, name: version.name }, version: version.version, description: version.description,
      currency: version.currency, monthlyPriceMinor: version.monthlyPriceMinor, annualPriceMinor: version.annualPriceMinor,
      annualDiscountPercent: version.annualDiscountPercent, defaultInterval: version.defaultInterval,
      termIntervals: version.termIntervals, expirationBehavior: version.expirationBehavior,
      cancellationPolicy: version.cancellationPolicy, freeTrialDays: version.freeTrialDays,
      introPriceMinor: version.introPriceMinor, introDurationDays: version.introDurationDays,
      entitlements: asStorePlanEntitlements(version), checkoutSupported: providerReady && terms.supported,
      checkoutUnavailableReason: !providerReady ? unavailableReason : terms.reason
      };
    }) });
  }));

  app.get('/api/seller/billing', requireAuth, requireRole(...sellerRoles), run(async (_req, res) => {
    const user = actor(res);
    if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, select: { store: { select: { id: true, isPlatformStore: true } }, user: { select: { email: true } } } });
    if (!seller?.store) return res.status(404).json({ error: 'The approved seller Store is unavailable.' });
    if (user.role === Role.ADMIN && seller.store.isPlatformStore) return res.json({ adminOverride: true, checkoutAvailable: false, cancellationAvailable: false, checkoutUnavailableReason: 'The official platform Store has no subscription billing or cancellation.', current: null, subscriptions: [], historyAvailable: false });
    if (!seller.user.email) return res.status(409).json({ code: 'SELLER_EMAIL_REQUIRED', error: 'An email address is required for subscription checkout.' });
    const subscriptions = await prisma.storeSubscription.findMany({
      where: { storeId: seller.store.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, status: true, interval: true, currency: true, monthlyPriceMinor: true,
        annualPriceMinor: true, introPriceMinor: true, introDurationDays: true, freeTrialDays: true,
        termIntervals: true, expirationBehavior: true, cancellationPolicy: true, termsSnapshot: true,
        currentPeriodStart: true, currentPeriodEnd: true, trialEndsAt: true, introEndsAt: true,
        nextChargeAt: true, expiresAt: true, cancelAtPeriodEnd: true, cancelledAt: true, createdAt: true,
        planVersion: { select: { version: true, name: true, plan: { select: { key: true } } } },
        invoices: { select: { id: true, status: true, amountMinor: true, refundedMinor: true, currency: true, periodStart: true, periodEnd: true, dueAt: true, paidAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 }
      }
    });
    const now = new Date();
    const current = subscriptions.find(item => ['TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID'].includes(item.status) || (item.status === 'CANCELLED' && item.expiresAt !== null && item.expiresAt > now)) ?? null;
    const providerReady = storePlanBillingSandboxEnabled;
    res.json({
      checkoutAvailable: providerReady,
      cancellationAvailable: Boolean(stripeStoreBillingProvider()),
      checkoutUnavailableReason: providerReady ? 'Stripe test-mode sandbox is enabled; this is not live billing.' : 'Subscription checkout is unavailable because the Stripe Store billing sandbox is disabled. No subscription payment has been simulated.',
      current,
      subscriptions,
      historyAvailable: subscriptions.length > 0
    });
  }));

  app.post('/api/seller/billing/subscribe', requireAuth, requireRole(...sellerRoles), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId) return res.status(403).json({ error: 'Seller scope required.' });
    const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, select: { store: { select: { id: true, isPlatformStore: true } }, user: { select: { email: true } } } });
    if (!seller?.store) return res.status(404).json({ error: 'The approved seller Store is unavailable.' });
    if (user.role === Role.ADMIN && seller.store.isPlatformStore) return res.status(409).json({ code: 'PLATFORM_STORE_BILLING_EXEMPT', error: 'The official platform Store has full administrator entitlements and cannot be subscribed or billed.' });
    if (!storePlanBillingSandboxEnabled) return res.status(503).json({ code: 'PLAN_BILLING_DISABLED', error: 'Stripe Store billing sandbox is disabled. No subscription or entitlement change was created.' });
    const provider = stripeStoreBillingProvider();
    if (!provider) return res.status(503).json({ code: 'PLAN_BILLING_DISABLED', error: 'Stripe Store billing sandbox is not configured. No subscription or entitlement change was created.' });
    if (!seller.user.email) return res.status(409).json({ code: 'SELLER_EMAIL_REQUIRED', error: 'An email address is required for subscription checkout.' });
    const body = z.object({ planVersionId: z.string().trim().min(1).max(80), interval: z.enum(['MONTHLY', 'ANNUAL']) }).strict().parse(req.body);
    const clientKey = req.get('Idempotency-Key');
    if (!clientKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(clientKey)) return res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'Provide an Idempotency-Key between 16 and 128 safe characters.' });
    const requestKeyHash = createHash('sha256').update(clientKey).digest('hex');
    const prepared = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${seller.store!.id} FOR UPDATE`;
      const existing = await tx.storeSubscription.findUnique({ where: { storeId_requestKeyHash: { storeId: seller.store!.id, requestKeyHash } }, include: { planVersion: { include: { plan: true } }, store: { include: { seller: { include: { user: true } } } } } });
      if (existing) {
        if (existing.planVersionId !== body.planVersionId || existing.interval !== body.interval) throw fail(409, 'This idempotency key was already used for different plan terms.');
        if (existing.status !== 'PENDING') throw fail(409, 'This idempotent checkout request is no longer pending. Start a new request only after reviewing the current subscription state.');
        return { subscription: existing, duplicate: true };
      }
      const outstanding = await tx.storeSubscription.findFirst({ where: { storeId: seller.store!.id, status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELLED'] }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } });
      if (outstanding) throw fail(409, 'This Store already has a pending or active subscription. Resolve it before starting another checkout.');
      const version = await tx.storePlanVersion.findUnique({ where: { id: body.planVersionId }, include: { plan: true } });
      const now = new Date();
      if (!version || version.status !== StorePlanVersionStatus.ACTIVE || version.plan.status !== StorePlanStatus.ACTIVE || version.plan.key === 'legacy-compatible' || (version.effectiveFrom && version.effectiveFrom > now) || (version.effectiveUntil && version.effectiveUntil <= now)) throw fail(409, 'This plan version is not available for subscription checkout.');
      const termsSupport = stripeStoreBillingTermsSupported(version);
      if (!termsSupport.supported) throw Object.assign(fail(409, termsSupport.reason!), { code: 'PLAN_BILLING_TERMS_UNSUPPORTED' });
      const amountMinor = body.interval === 'ANNUAL' ? version.annualPriceMinor : version.monthlyPriceMinor;
      if (amountMinor <= 0 || isFreePlan(version)) throw fail(409, 'Free plans do not require subscription checkout.');
      if (version.freeTrialDays > 0) {
        const priorTrial = await tx.storeSubscription.findFirst({ where: { storeId: seller.store!.id, freeTrialDays: { gt: 0 }, OR: [{ trialEndsAt: { not: null } }, { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'EXPIRED'] } }] }, select: { id: true } });
        if (priorTrial) throw fail(409, 'A free trial has already been used by this Store.');
      }
      const currentAssignment = await tx.storePlanAssignment.findFirst({ where: { storeId: seller.store!.id, status: 'ACTIVE', effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' } });
      const termsSnapshot = {
        schemaVersion: 1, provider: 'STRIPE', sandbox: true, storeId: seller.store!.id,
        planVersionId: version.id, planKey: version.plan.key, planName: version.name, planVersion: version.version,
        interval: body.interval, currency: version.currency, monthlyPriceMinor: version.monthlyPriceMinor,
        annualPriceMinor: version.annualPriceMinor, agreedPriceMinor: amountMinor,
        freeTrialDays: version.freeTrialDays, cancellationPolicy: version.cancellationPolicy,
        expirationBehavior: version.expirationBehavior, taxTreatment: 'NOT_COLLECTED_IN_SANDBOX',
        proration: 'NONE', previousPlanVersionId: currentAssignment?.planVersionId ?? null,
        createdAt: now.toISOString()
      } satisfies Prisma.InputJsonObject;
      const subscription = await tx.storeSubscription.create({
        data: {
          storeId: seller.store!.id, planVersionId: version.id, requestedById: user.id,
          provider: 'STRIPE', status: 'PENDING', interval: body.interval, currency: version.currency,
          monthlyPriceMinor: version.monthlyPriceMinor, annualPriceMinor: version.annualPriceMinor,
          introPriceMinor: null, introDurationDays: null, freeTrialDays: version.freeTrialDays,
          termIntervals: null, expirationBehavior: version.expirationBehavior,
          cancellationPolicy: version.cancellationPolicy, termsSnapshot, requestKeyHash
        },
        include: { planVersion: { include: { plan: true } }, store: { include: { seller: { include: { user: true } } } } }
      });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_SUBSCRIPTION_CHECKOUT_REQUESTED', entity: 'StoreSubscription', entityId: subscription.id, metadata: { storeId: seller.store!.id, planVersionId: version.id, interval: body.interval, currency: version.currency, amountMinor, sandbox: true } } });
      return { subscription, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    const subscription = prepared.subscription;
    const amountMinor = body.interval === 'ANNUAL' ? subscription.annualPriceMinor ?? 0 : subscription.monthlyPriceMinor;
    let checkout;
    try {
      if (subscription.providerCheckoutSessionId) {
        checkout = await provider.retrieveCheckout(subscription.providerCheckoutSessionId);
        if (!checkout.url || checkout.status !== 'open') return res.status(409).json({ code: 'CHECKOUT_SESSION_UNAVAILABLE', error: 'The existing sandbox checkout session is no longer open. Review your subscription history before starting another request.' });
        checkout = { ...checkout, subscriptionId: subscription.providerSubscriptionId };
      } else {
        if (prepared.duplicate && subscription.createdAt.getTime() < Date.now() - 20 * 60 * 60 * 1000) return res.status(409).json({ code: 'CHECKOUT_RECONCILIATION_REQUIRED', error: 'The previous checkout request is too old to retry safely. Wait for provider reconciliation or contact support; a second session was not created.' });
        checkout = await provider.createCheckout({
          subscriptionId: subscription.id, storeId: subscription.storeId, storeName: subscription.store.name,
          planName: subscription.planVersion.name, planVersion: subscription.planVersion.version,
          interval: body.interval, currency: 'USD', unitAmountMinor: amountMinor, trialDays: subscription.freeTrialDays,
          sellerEmail: seller.user.email,
          successUrl: `${env.WEB_ORIGIN}/seller/plan?billing=success`,
          cancelUrl: `${env.WEB_ORIGIN}/seller/plan?billing=cancelled`
        });
      }
      await prisma.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', providerCheckoutSessionId: checkout.id, ...(checkout.subscriptionId ? { providerSubscriptionId: checkout.subscriptionId } : {}) } });
    } catch {
      return res.status(502).json({ code: 'BILLING_PROVIDER_UNAVAILABLE', error: 'Stripe sandbox checkout could not be created. Retry with the same Idempotency-Key; no entitlement was granted.' });
    }
    return res.status(prepared.duplicate ? 200 : 201).json({ subscriptionId: subscription.id, checkoutUrl: checkout.url, sandbox: true, duplicate: prepared.duplicate });
  }));
}
