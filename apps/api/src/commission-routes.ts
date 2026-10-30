import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { PaymentMethod, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { allocatePartialRefund } from './seller-commission.js';
import { calculateCommissionMinor } from './currency-domain.js';
import { reconcileVerifiedPaymentEvent } from './payment-webhook-reconciliation.js';
import { isRetryablePaymentWebhookEvent } from './integration-operations-domain.js';
import { redactProviderAuditReason } from './provider-integrations-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string; role: Role };
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const policyInput = z.object({
  type: z.enum(['ZERO', 'PERCENTAGE']),
  basisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
  reason: z.string().trim().min(5).max(500)
}).strict().superRefine((input, context) => {
  if (input.type === 'ZERO' && input.basisPoints != null) context.addIssue({ code: 'custom', path: ['basisPoints'], message: 'Zero commission has no percentage.' });
  if (input.type === 'PERCENTAGE' && input.basisPoints == null) context.addIssue({ code: 'custom', path: ['basisPoints'], message: 'Enter a percentage for this policy.' });
});
const policyDraftUpdateInput = z.object({
  type: z.enum(['ZERO', 'PERCENTAGE']),
  basisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
  reason: z.string().trim().min(5).max(500),
  changeReason: z.string().trim().min(5).max(500)
}).strict().superRefine((input, context) => {
  if (input.type === 'ZERO' && input.basisPoints != null) context.addIssue({ code: 'custom', path: ['basisPoints'], message: 'Zero commission has no percentage.' });
  if (input.type === 'PERCENTAGE' && input.basisPoints == null) context.addIssue({ code: 'custom', path: ['basisPoints'], message: 'Enter a percentage for this policy.' });
});

export function registerCommissionRoutes(app: Express) {
  app.get('/api/admin/seller-commission-policies', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const policies = await prisma.sellerCommissionPolicyVersion.findMany({ include: { store: { select: { id: true, name: true, slug: true } }, planVersion: { include: { plan: true } }, creator: { select: { name: true, email: true } } }, orderBy: [{ createdAt: 'desc' }, { version: 'desc' }] });
    res.json({ policies, moneyMovementEnabled: false, currency: env.CURRENCY });
  }));

  app.get('/api/admin/seller-commission-ledger', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [groups, entries, unresolvedReviews] = await Promise.all([
      prisma.sellerCommissionLedgerEntry.groupBy({ by: ['sellerId', 'currency'], _sum: { amountMinor: true }, _count: { _all: true }, orderBy: [{ currency: 'asc' }, { sellerId: 'asc' }] }),
      prisma.sellerCommissionLedgerEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 500, include: { seller: { include: { store: { select: { name: true, slug: true } } } } } }),
      prisma.sellerCommissionReviewEvent.count({ where: { status: 'NEEDS_ALLOCATION' } })
    ]);
    const sellers = await prisma.seller.findMany({ where: { id: { in: [...new Set(groups.map(group => group.sellerId))] } }, include: { store: { select: { name: true, slug: true } } } });
    res.json({ totals: groups.map(group => ({ sellerId: group.sellerId, store: sellers.find(seller => seller.id === group.sellerId)?.store ?? null, currency: group.currency, netMinor: group._sum.amountMinor ?? 0, entries: group._count._all })), entries, unresolvedReviews, fundedOrReconciled: false, note: 'Ledger represents accrued policy outcomes only. No commission funding, deduction, settlement, or payout reconciliation is configured.' });
  }));

  app.post('/api/admin/seller-commission-policies', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = policyInput.parse(req.body);
    const created = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ acquired: number }>>`
        WITH advisory_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtext('commission-policy:free-stores')::bigint)
        )
        SELECT 1::int AS acquired FROM advisory_lock
      `;
      const previous = await tx.sellerCommissionPolicyVersion.findFirst({ where: { freeStoreScopeKey: 'FREE_STORES' }, orderBy: { version: 'desc' } });
      const policy = await tx.sellerCommissionPolicyVersion.create({ data: {
        version: (previous?.version ?? 0) + 1, freeStoreScopeKey: 'FREE_STORES',
        type: input.type, currency: env.CURRENCY, fixedMinor: null,
        basisPoints: input.basisPoints ?? null, minimumMinor: null,
        capMinor: null, reason: input.reason, createdById: user.id
      } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SELLER_COMMISSION_POLICY_DRAFT_CREATED', entity: 'SellerCommissionPolicyVersion', entityId: policy.id, metadata: { version: policy.version, scope: 'FREE_STORES', type: policy.type, basisPoints: policy.basisPoints, reason: policy.reason } } });
      return policy;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    res.status(201).json(created);
  }));

  app.patch('/api/admin/seller-commission-policies/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const id = param(req.params.id);
    const input = policyDraftUpdateInput.parse(req.body);
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SellerCommissionPolicyVersion" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.sellerCommissionPolicyVersion.findUnique({ where: { id } });
      if (!current) throw Object.assign(new Error('Commission policy draft not found.'), { statusCode: 404 });
      if (current.status !== 'DRAFT') throw Object.assign(new Error('Only draft commission policies can be edited. Activated or retired policy versions are immutable.'), { statusCode: 409 });
      if (current.freeStoreScopeKey !== 'FREE_STORES') throw Object.assign(new Error('Legacy scoped policies cannot be edited here. Create a new all-free-Stores draft instead.'), { statusCode: 409 });

      const row = await tx.sellerCommissionPolicyVersion.update({ where: { id }, data: {
        type: input.type,
        basisPoints: input.type === 'PERCENTAGE' ? input.basisPoints ?? null : null,
        reason: input.reason
      } });
      await tx.auditLog.create({ data: {
        actorId: user.id,
        action: 'SELLER_COMMISSION_POLICY_DRAFT_UPDATED',
        entity: 'SellerCommissionPolicyVersion',
        entityId: row.id,
        metadata: {
          version: row.version,
          scope: 'FREE_STORES',
          previous: { type: current.type, basisPoints: current.basisPoints, reason: current.reason },
          updated: { type: row.type, basisPoints: row.basisPoints, reason: row.reason },
          changeReason: input.changeReason
        }
      } });
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json(updated);
  }));

  app.delete('/api/admin/seller-commission-policies/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const id = param(req.params.id);
    const reason = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body).reason;
    const removed = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SellerCommissionPolicyVersion" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.sellerCommissionPolicyVersion.findUnique({ where: { id } });
      if (!current) throw Object.assign(new Error('Commission policy draft not found.'), { statusCode: 404 });
      if (current.status !== 'DRAFT') throw Object.assign(new Error('Only a draft commission policy can be removed.'), { statusCode: 409 });
      if (current.freeStoreScopeKey !== 'FREE_STORES') throw Object.assign(new Error('Legacy scoped policies cannot be removed here.'), { statusCode: 409 });

      // Drafts have never been effective; setting effectiveUntil without an
      // effectiveFrom violates SellerCommissionPolicyVersion_effective_check.
      // Retire the draft in-place while preserving its historical terms.
      const row = await tx.sellerCommissionPolicyVersion.update({ where: { id }, data: { status: 'RETIRED' } });
      await tx.auditLog.create({ data: {
        actorId: user.id,
        action: 'SELLER_COMMISSION_POLICY_DRAFT_REMOVED',
        entity: 'SellerCommissionPolicyVersion',
        entityId: row.id,
        metadata: {
          version: row.version,
          scope: 'FREE_STORES',
          previous: { type: current.type, basisPoints: current.basisPoints, reason: current.reason },
          reason
        }
      } });
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ removed: true, policy: removed });
  }));

  app.post('/api/admin/seller-commission-policies/:id/activate', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const reason = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body).reason;
    const now = new Date();
    const activated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SellerCommissionPolicyVersion" WHERE "id" = ${param(req.params.id)} FOR UPDATE`;
      const policy = await tx.sellerCommissionPolicyVersion.findUnique({ where: { id: param(req.params.id) } });
      if (!policy || policy.status !== 'DRAFT') throw Object.assign(new Error('Only a draft policy can be activated.'), { statusCode: 409 });
      if (policy.freeStoreScopeKey !== 'FREE_STORES' || policy.type === 'FIXED_PER_ORDER' || policy.type === 'PERCENTAGE_PLUS_FIXED') throw Object.assign(new Error('This is a legacy scoped policy. Create a new all-free-Stores policy; existing order snapshots are unchanged.'), { statusCode: 409 });
      const active = await tx.sellerCommissionPolicyVersion.findFirst({ where: { freeStoreScopeKey: 'FREE_STORES', status: 'ACTIVE' } });
      if (active) await tx.sellerCommissionPolicyVersion.update({ where: { id: active.id }, data: { status: 'SUPERSEDED', effectiveUntil: now } });
      const row = await tx.sellerCommissionPolicyVersion.update({ where: { id: policy.id }, data: { status: 'ACTIVE', effectiveFrom: now, effectiveUntil: null, activatedAt: now } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SELLER_COMMISSION_POLICY_ACTIVATED', entity: 'SellerCommissionPolicyVersion', entityId: row.id, metadata: { version: row.version, supersededPolicyId: active?.id ?? null, reason } } });
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json(activated);
  }));

  app.post('/api/admin/seller-commission-policies/:id/retire', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const reason = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body).reason;
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SellerCommissionPolicyVersion" WHERE "id" = ${param(req.params.id)} FOR UPDATE`;
      const policy = await tx.sellerCommissionPolicyVersion.findUnique({ where: { id: param(req.params.id) } });
      if (!policy || !['ACTIVE', 'DRAFT'].includes(policy.status)) throw Object.assign(new Error('This policy cannot be retired.'), { statusCode: 409 });
      const row = await tx.sellerCommissionPolicyVersion.update({ where: { id: policy.id }, data: { status: 'RETIRED', effectiveUntil: new Date() } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SELLER_COMMISSION_POLICY_RETIRED', entity: 'SellerCommissionPolicyVersion', entityId: row.id, metadata: { reason } } });
      return row;
    });
    res.json(result);
  }));

  app.post('/api/admin/seller-commission-preview', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const input = z.object({ policy: policyInput.omit({ reason: true }), eligibleBaseMinor: z.number().int().min(0).max(2_000_000_000) }).strict().parse(req.body);
    res.json({ commissionMinor: calculateCommissionMinor({ type: input.policy.type, fixedMinor: null, basisPoints: input.policy.basisPoints ?? null, minimumMinor: null, capMinor: null }, input.eligibleBaseMinor), eligibleBaseMinor: input.eligibleBaseMinor, currency: env.CURRENCY });
  }));

  app.get('/api/admin/seller-commission-reviews', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    res.json(await prisma.sellerCommissionReviewEvent.findMany({ where: { status: 'NEEDS_ALLOCATION' }, include: { parentOrder: { include: { sellerOrders: { include: { items: true, seller: { include: { store: true } } } } } }, reviewedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' }, take: 100 }));
  }));

  app.get('/api/admin/seller-commission-webhook-events', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const events = await prisma.processedWebhookEvent.findMany({
      where: { reviewReason: { not: null } },
      select: { id: true, provider: true, eventId: true, eventType: true, providerObjectRef: true, paymentLookupRef: true, metadataOrderId: true, parentOrderId: true, amountMinor: true, providerTotalMinor: true, currency: true, captureConfirmed: true, identityVerified: true, reviewReason: true, providerOccurredAt: true, receivedAt: true },
      orderBy: { receivedAt: 'asc' }, take: 100
    });
    res.json(events);
  }));

  app.post('/api/admin/seller-commission-webhook-events/:id/retry', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const id = param(req.params.id);
    const reason = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body).reason;
    const outcome = await prisma.$transaction(async tx => {
      const event = await tx.processedWebhookEvent.findUnique({ where: { id } });
      if (!event) throw Object.assign(new Error('Webhook event not found.'), { statusCode: 404 });
      if (event.reviewReason === null) throw Object.assign(new Error('Webhook event is already reconciled.'), { statusCode: 409, code: 'WEBHOOK_EVENT_ALREADY_RECONCILED' });
      if (!event.identityVerified || !event.eventType) throw Object.assign(new Error('A verified provider redelivery is required before this legacy event can be retried.'), { statusCode: 409, code: 'WEBHOOK_REDELIVERY_REQUIRED' });
      if (!isRetryablePaymentWebhookEvent(event.provider, event.eventType)) throw Object.assign(new Error('This event type is not eligible for payment reconciliation retry.'), { statusCode: 409, code: 'WEBHOOK_EVENT_NOT_RETRYABLE' });
      const result = await reconcileVerifiedPaymentEvent(tx, {
        provider: event.provider,
        eventId: event.eventId,
        eventType: event.eventType,
        providerObjectRef: event.providerObjectRef,
        paymentLookupRef: event.paymentLookupRef,
        metadataOrderId: event.metadataOrderId,
        amountMinor: event.amountMinor,
        currency: event.currency,
        providerTotalMinor: event.providerTotalMinor,
        occurredAt: event.providerOccurredAt,
        ...(event.captureConfirmed === null ? {} : { captureConfirmed: event.captureConfirmed })
      });
      const updated = await tx.processedWebhookEvent.findUniqueOrThrow({ where: { id: event.id }, select: { reviewReason: true, parentOrderId: true } });
      await tx.auditLog.create({ data: {
        actorId: user.id,
        action: 'PAYMENT_WEBHOOK_RECONCILIATION_RETRIED',
        entity: 'ProcessedWebhookEvent',
        entityId: event.id,
        metadata: { provider: event.provider, eventId: event.eventId, previousReviewReason: event.reviewReason, reviewReason: updated.reviewReason, parentOrderId: updated.parentOrderId, reason: redactProviderAuditReason(reason) }
      } });
      return { reviewReason: updated.reviewReason, parentOrderId: updated.parentOrderId, becamePaid: result.becamePaid };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    res.status(outcome.reviewReason ? 202 : 200).json({ ok: true, reconciliation: outcome.reviewReason ? 'REVIEW_REQUIRED' : 'COMPLETE', ...outcome });
  }));

  app.post('/api/admin/seller-commission-reviews/:id/resolve', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ allocations: z.array(z.object({ orderItemId: z.string().cuid(), refundMinor: z.number().int().positive().max(2_000_000_000) }).strict()).min(1).max(200), reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    await prisma.$transaction(async tx => {
      const review = await tx.sellerCommissionReviewEvent.findUnique({ where: { id: param(req.params.id) }, select: { parentOrderId: true } });
      if (!review) throw Object.assign(new Error('Refund review event not found or already resolved.'), { statusCode: 404 });
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${review.parentOrderId} FOR UPDATE`;
      await allocatePartialRefund(tx, { parentOrderId: review.parentOrderId, reviewEventId: param(req.params.id), actorId: user.id, allocations: input.allocations });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SELLER_COMMISSION_REFUND_ALLOCATION_POSTED', entity: 'SellerCommissionReviewEvent', entityId: param(req.params.id), metadata: { allocations: input.allocations, reason: input.reason } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    res.json({ ok: true });
  }));
}
