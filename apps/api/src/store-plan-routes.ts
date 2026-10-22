import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, Role, SellerStatus, StorePlanAssignmentStatus, StorePlanStatus, StorePlanVersionStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { asStorePlanEntitlements, effectiveStorePlan, isAtLimit, storePlanEntitlementsSchema } from './store-plan-domain.js';

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
  reason
}).strict();

const editPlanSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  entitlements: storePlanEntitlementsSchema.optional(),
  reason
}).strict().refine(input => input.name !== undefined || input.entitlements !== undefined, 'Provide a name or a new entitlement version');

const assignmentSchema = z.object({ versionId: z.string().trim().min(1).max(80), reason }).strict();
const actionSchema = z.object({ reason }).strict();

async function planAudit(tx: Prisma.TransactionClient, actorId: string, action: string, entity: string, entityId: string, metadata: unknown) {
  await tx.auditLog.create({ data: { actorId, action, entity, entityId, metadata: json(metadata) } });
}

function versionData(entitlements: z.infer<typeof storePlanEntitlementsSchema>) {
  return {
    ...entitlements,
    allowedThemes: entitlements.allowedThemes,
    paymentConnectors: entitlements.paymentConnectors,
    mobileTemplates: entitlements.mobileTemplates
  };
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
      const version = await tx.storePlanVersion.create({ data: { planId: plan.id, version: 1, createdById: user.id, ...versionData(input.entitlements) } });
      await planAudit(tx, user.id, 'STORE_PLAN_CREATED', 'StorePlan', plan.id, { name: plan.name, key: plan.key, version: version.version, entitlements: input.entitlements, reason: input.reason });
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
      if (input.entitlements) {
        const nextVersion = (await tx.storePlanVersion.aggregate({ where: { planId }, _max: { version: true } }))._max.version ?? 0;
        version = await tx.storePlanVersion.create({ data: { planId, version: nextVersion + 1, createdById: user.id, ...versionData(input.entitlements) } });
      }
      await planAudit(tx, user.id, 'STORE_PLAN_EDITED', 'StorePlan', planId, {
        oldName: current.name,
        newName: updated.name,
        newDraftVersion: input.entitlements ? version?.version : null,
        entitlements: input.entitlements ?? null,
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
      const version = await tx.storePlanVersion.update({ where: { id: target.id }, data: { status: StorePlanVersionStatus.ACTIVE, activatedAt: new Date() } });
      const updatedPlan = await tx.storePlan.update({ where: { id: planId }, data: { status: StorePlanStatus.ACTIVE } });
      await planAudit(tx, user.id, 'STORE_PLAN_VERSION_ACTIVATED', 'StorePlanVersion', version.id, { planId, version: version.version, reason: input.reason });
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
      const storeUsage = await tx.store.count({ where: { sellerId: store.sellerId } });
      const vendorUsage = 1; // Store currently has exactly one Seller owner by schema.
      if (storeUsage > version.storeLimit || vendorUsage > version.vendorLimit) throw fail(409, 'This plan is below the Store or vendor count already in use. Existing access was not changed.');

      const now = new Date();
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
    const [effective, productCount, storeCount] = await Promise.all([
      effectiveStorePlan(prisma, seller.store.id),
      prisma.product.count({ where: { sellerId: seller.id, status: { not: 'ARCHIVED' } } }),
      prisma.store.count({ where: { sellerId: seller.id } })
    ]);
    const entitlements = asStorePlanEntitlements(effective.version);
    res.json({
      store: { id: seller.store.id, name: seller.store.name, slug: seller.store.slug },
      plan: effective.plan ? { id: effective.plan.id, key: effective.plan.key, name: effective.plan.name, status: effective.plan.status, version: effective.version?.version ?? 1, versionStatus: effective.version?.status ?? 'ACTIVE' } : { key: 'legacy-compatible', name: 'Legacy compatible', status: 'ACTIVE', version: 1, versionStatus: 'ACTIVE' },
      assignment: effective.assignment ? { id: effective.assignment.id, status: effective.assignment.status, source: effective.assignment.source, effectiveFrom: effective.assignment.effectiveFrom, effectiveUntil: effective.assignment.effectiveUntil } : { id: null, status: 'ACTIVE', source: 'LEGACY_FALLBACK', effectiveFrom: null, effectiveUntil: null },
      entitlements,
      usage: { products: productCount, stores: storeCount, vendors: 1, staffSeats: seller._count.staff },
      notes: {
        connectors: 'Plan connectors describe eligibility only. Seller payment processing and seller payout integrations are not enabled by this plan.',
        customDomain: 'Eligibility does not provision DNS or TLS.',
        mobileTemplates: 'These are responsive web storefront templates, not native applications.'
      }
    });
  }));
}
