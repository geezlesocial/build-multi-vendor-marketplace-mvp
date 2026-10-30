import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { PaymentMethod, PaymentStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { ORDER_RESOLUTION_ACTIVE_STATUSES, ORDER_RESOLUTION_REVIEW_STATUSES, canRecordManualCodRefund, refundEventMatchesCase } from './order-resolution-domain.js';
import { reverseClubCoinsForOrder } from './club-coins-awards.js';
import { createUserNotification } from './notification-delivery.js';

type Actor = { id: string; role: Role; sellerId?: string };
type CaseRow = {
  id: string; parentOrderId: string; sellerOrderId: string; buyerId: string; sellerId: string | null;
  type: string; status: string; reason: string; description: string; requestedAmountMinor: number | null;
  approvedAmountMinor: number | null; resolutionNote: string | null; providerWebhookEventRowId: string | null;
  manualRefundReference: string | null; decidedById: string | null; settledAt: Date | null;
  createdAt: Date; updatedAt: Date; orderNumber: string; currency: string; parentTotalMinor: number;
  sellerOrderTotalMinor: number; paymentMethod: string | null; paymentStatus: string | null;
  storeName: string | null; buyerName: string; messages: Array<{ id: string; authorId: string; authorName: string | null; authorRole: string; body: string; createdAt: Date }>;
};

const activeStatuses = ORDER_RESOLUTION_ACTIVE_STATUSES;
const finalStatuses = ['RESOLVED', 'REJECTED'];
const refundEventType: Record<'STRIPE' | 'PAYPAL' | 'PAYMONGO' | 'PAYSTACK', string> = {
  STRIPE: 'charge.refunded', PAYPAL: 'PAYMENT.CAPTURE.REFUNDED',
  PAYMONGO: 'refund.succeeded', PAYSTACK: 'refund.processed'
};
const refundProviderTypes = [PaymentMethod.STRIPE, PaymentMethod.PAYPAL, PaymentMethod.PAYMONGO, PaymentMethod.PAYSTACK] as const;
const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
const actor = (res: Response) => res.locals.user as Actor;

async function selectCasesForSellerOrders(sellerOrderIds: string[], db: typeof prisma | import('@prisma/client').Prisma.TransactionClient = prisma) {
  if (!sellerOrderIds.length) return [] as CaseRow[];
  const rows = await db.$queryRaw<CaseRow[]>`
    SELECT c."id", c."parentOrderId", c."sellerOrderId", c."buyerId", c."sellerId", c."type", c."status", c."reason", c."description",
      c."requestedAmountMinor", c."approvedAmountMinor", c."resolutionNote", c."providerWebhookEventRowId", c."manualRefundReference", c."decidedById", c."settledAt", c."createdAt", c."updatedAt",
      p."orderNumber", p."currency", p."totalMinor" AS "parentTotalMinor", so."totalMinor" AS "sellerOrderTotalMinor", pay."method"::text AS "paymentMethod", pay."status"::text AS "paymentStatus",
      st."name" AS "storeName", buyer."name" AS "buyerName",
      COALESCE(jsonb_agg(jsonb_build_object('id', m."id", 'authorId', m."authorId", 'authorName', author."name", 'authorRole', m."authorRole", 'body', m."body", 'createdAt', m."createdAt") ORDER BY m."createdAt") FILTER (WHERE m."id" IS NOT NULL), '[]'::jsonb) AS "messages"
    FROM "OrderResolutionCase" c
    JOIN "ParentOrder" p ON p."id" = c."parentOrderId"
    JOIN "SellerOrder" so ON so."id" = c."sellerOrderId"
    LEFT JOIN "Payment" pay ON pay."parentId" = p."id"
    LEFT JOIN "Seller" s ON s."id" = c."sellerId"
    LEFT JOIN "Store" st ON st."sellerId" = s."id"
    JOIN "User" buyer ON buyer."id" = c."buyerId"
    LEFT JOIN "OrderResolutionMessage" m ON m."caseId" = c."id"
    LEFT JOIN "User" author ON author."id" = m."authorId"
    WHERE c."sellerOrderId" = ANY(${sellerOrderIds}::text[])
    GROUP BY c."id", p."id", so."id", pay."id", st."id", buyer."id"
    ORDER BY c."createdAt" DESC`;
  return rows.map(sanitizeCase);
}

async function selectCase(caseId: string, db: typeof prisma | import('@prisma/client').Prisma.TransactionClient = prisma) {
  const rows = await db.$queryRaw<CaseRow[]>`
    SELECT c."id", c."parentOrderId", c."sellerOrderId", c."buyerId", c."sellerId", c."type", c."status", c."reason", c."description",
      c."requestedAmountMinor", c."approvedAmountMinor", c."resolutionNote", c."providerWebhookEventRowId", c."manualRefundReference", c."decidedById", c."settledAt", c."createdAt", c."updatedAt",
      p."orderNumber", p."currency", p."totalMinor" AS "parentTotalMinor", so."totalMinor" AS "sellerOrderTotalMinor", pay."method"::text AS "paymentMethod", pay."status"::text AS "paymentStatus",
      st."name" AS "storeName", buyer."name" AS "buyerName",
      COALESCE(jsonb_agg(jsonb_build_object('id', m."id", 'authorId', m."authorId", 'authorName', author."name", 'authorRole', m."authorRole", 'body', m."body", 'createdAt', m."createdAt") ORDER BY m."createdAt") FILTER (WHERE m."id" IS NOT NULL), '[]'::jsonb) AS "messages"
    FROM "OrderResolutionCase" c
    JOIN "ParentOrder" p ON p."id" = c."parentOrderId"
    JOIN "SellerOrder" so ON so."id" = c."sellerOrderId"
    LEFT JOIN "Payment" pay ON pay."parentId" = p."id"
    LEFT JOIN "Seller" s ON s."id" = c."sellerId"
    LEFT JOIN "Store" st ON st."sellerId" = s."id"
    JOIN "User" buyer ON buyer."id" = c."buyerId"
    LEFT JOIN "OrderResolutionMessage" m ON m."caseId" = c."id"
    LEFT JOIN "User" author ON author."id" = m."authorId"
    WHERE c."id" = ${caseId}
    GROUP BY c."id", p."id", so."id", pay."id", st."id", buyer."id"`;
  return rows[0] ?? null;
}

function sanitizeCase(record: CaseRow): Omit<CaseRow, 'providerWebhookEventRowId' | 'decidedById'> {
  const safe = { ...record } as Partial<CaseRow>;
  delete safe.providerWebhookEventRowId;
  delete safe.decidedById;
  return safe as Omit<CaseRow, 'providerWebhookEventRowId' | 'decidedById'>;
}

function publicCase(record: CaseRow | null) {
  if (!record) return null;
  return sanitizeCase(record);
}

function assertParticipant(record: CaseRow, user: Actor) {
  if (user.role === Role.ADMIN) return;
  if (record.buyerId === user.id) return;
  if ((user.role === Role.SELLER || user.role === Role.CASHIER) && record.sellerId && record.sellerId === user.sellerId) return;
  throw fail(404, 'Order case not found.');
}

export { selectCasesForSellerOrders };

export function registerOrderResolutionRoutes(app: Express) {
  app.post('/api/orders/:parentOrderId/shipments/:sellerOrderId/resolution-cases', requireAuth, run(async (req, res) => {
    const user = actor(res);
    if (user.role === Role.ADMIN) throw fail(403, 'Use the platform review workflow to create an administrative case.');
    const input = z.object({
      type: z.enum(['REFUND_REQUEST', 'DELIVERY_DISPUTE']),
      reason: z.enum(['ITEM_NOT_RECEIVED', 'DAMAGED', 'WRONG_ITEM', 'MISSING_ITEMS', 'NOT_AS_DESCRIBED', 'OTHER']),
      description: z.string().trim().min(10).max(3000)
    }).strict().parse(req.body);
    const parentOrderId = param(req.params.parentOrderId);
    const sellerOrderId = param(req.params.sellerOrderId);
    const initial = await prisma.sellerOrder.findFirst({ where: { id: sellerOrderId, parentId: parentOrderId }, select: { id: true, parentId: true } });
    if (!initial) throw fail(404, 'Order item not found.');
    const caseId = randomUUID();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.id} FOR UPDATE`;
      const order = await tx.sellerOrder.findUnique({ where: { id: initial.id }, include: { parent: { include: { payment: true } }, seller: true } });
      if (!order || order.parent.buyerId !== user.id) throw fail(404, 'Order item not found.');
      if (order.receivedAt) throw fail(409, 'A case cannot be opened after receipt confirmation. Contact support for help with rights available under applicable law or your payment provider.', 'RECEIPT_ALREADY_CONFIRMED');
      if (order.status === 'CANCELLED' || order.parent.status === 'CANCELLED') throw fail(409, 'A cancelled order cannot open a new delivery case.');
      const payment = order.parent.payment;
      if (!payment || payment.method === PaymentMethod.POS || (payment.method !== PaymentMethod.COD && payment.status !== PaymentStatus.PAID)) throw fail(409, 'Only an eligible COD or paid online order can open a case.');
      const prior = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "OrderResolutionCase" WHERE "sellerOrderId" = ${order.id} FOR UPDATE`;
      if (prior.length) throw fail(409, 'A case already exists for this Store order. Reply in its case thread to continue.');
      await tx.$executeRaw`
        INSERT INTO "OrderResolutionCase" ("id", "parentOrderId", "sellerOrderId", "buyerId", "sellerId", "type", "status", "reason", "description", "createdAt", "updatedAt")
        VALUES (${caseId}, ${order.parentId}, ${order.id}, ${user.id}, ${order.sellerId}, ${input.type}, 'OPEN', ${input.reason}, ${input.description}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      if (order.seller) await createUserNotification(tx, {
        userId: order.seller.userId, eventType: 'ORDER_RESOLUTION_CASE_OPENED', title: 'Buyer opened an order case',
        body: `A buyer opened a ${input.type === 'REFUND_REQUEST' ? 'refund request' : 'delivery dispute'} for order ${order.parent.orderNumber}.`,
        link: '/dashboard?mode=seller&tab=orders', payloadJson: { caseId, parentOrderId, sellerOrderId }
      }, 'orders');
      await tx.auditLog.create({ data: { actorId: user.id, action: 'ORDER_RESOLUTION_CASE_OPENED', entity: 'OrderResolutionCase', entityId: caseId, metadata: { parentOrderId, sellerOrderId, type: input.type, reason: input.reason } } });
    }, { isolationLevel: 'ReadCommitted' });
    res.status(201).json(publicCase(await selectCase(caseId)));
  }));

  app.post('/api/order-resolution-cases/:caseId/messages', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const caseId = param(req.params.caseId);
    const body = z.object({ body: z.string().trim().min(2).max(3000) }).strict().parse(req.body).body;
    const initial = await selectCase(caseId);
    if (!initial) throw fail(404, 'Order case not found.');
    assertParticipant(initial, user);
    const messageId = randomUUID();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.sellerOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "OrderResolutionCase" WHERE "id" = ${caseId} FOR UPDATE`;
      const current = await selectCase(caseId, tx);
      if (!current) throw fail(404, 'Order case not found.');
      assertParticipant(current, user);
      if (finalStatuses.includes(current.status) || current.status === 'REFUND_APPROVED') throw fail(409, 'This case is locked after an administrative decision.');
      await tx.$executeRaw`INSERT INTO "OrderResolutionMessage" ("id", "caseId", "authorId", "authorRole", "body", "createdAt") VALUES (${messageId}, ${caseId}, ${user.id}, ${user.role}, ${body}, CURRENT_TIMESTAMP)`;
      const nextStatus = user.role === Role.BUYER ? 'OPEN' : 'UNDER_REVIEW';
      await tx.$executeRaw`UPDATE "OrderResolutionCase" SET "status" = ${nextStatus}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${caseId}`;
      const recipientId = user.role === Role.BUYER && current.sellerId
        ? (await tx.seller.findUnique({ where: { id: current.sellerId }, select: { userId: true } }))?.userId
        : current.buyerId;
      if (recipientId) await createUserNotification(tx, {
        userId: recipientId, eventType: 'ORDER_RESOLUTION_CASE_MESSAGE', title: 'New order case update',
        body: `There is a new update on order ${current.orderNumber}.`, link: user.role === Role.BUYER ? '/dashboard?mode=seller&tab=orders' : '/dashboard?tab=orders', payloadJson: { caseId, parentOrderId: current.parentOrderId }
      }, 'orders');
      await tx.auditLog.create({ data: { actorId: user.id, action: 'ORDER_RESOLUTION_CASE_MESSAGE_ADDED', entity: 'OrderResolutionCase', entityId: caseId, metadata: { authorRole: user.role } } });
    }, { isolationLevel: 'ReadCommitted' });
    res.json(publicCase(await selectCase(caseId)));
  }));

  app.get('/api/admin/order-resolution-cases', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const cases = await prisma.$queryRaw<CaseRow[]>`
      SELECT c."id", c."parentOrderId", c."sellerOrderId", c."buyerId", c."sellerId", c."type", c."status", c."reason", c."description",
        c."requestedAmountMinor", c."approvedAmountMinor", c."resolutionNote", c."providerWebhookEventRowId", c."manualRefundReference", c."decidedById", c."settledAt", c."createdAt", c."updatedAt",
        p."orderNumber", p."currency", p."totalMinor" AS "parentTotalMinor", so."totalMinor" AS "sellerOrderTotalMinor", pay."method"::text AS "paymentMethod", pay."status"::text AS "paymentStatus",
        st."name" AS "storeName", buyer."name" AS "buyerName",
        COALESCE(jsonb_agg(jsonb_build_object('id', m."id", 'authorId', m."authorId", 'authorName', author."name", 'authorRole', m."authorRole", 'body', m."body", 'createdAt', m."createdAt") ORDER BY m."createdAt") FILTER (WHERE m."id" IS NOT NULL), '[]'::jsonb) AS "messages"
      FROM "OrderResolutionCase" c JOIN "ParentOrder" p ON p."id" = c."parentOrderId" JOIN "SellerOrder" so ON so."id" = c."sellerOrderId"
      LEFT JOIN "Payment" pay ON pay."parentId" = p."id" LEFT JOIN "Seller" s ON s."id" = c."sellerId" LEFT JOIN "Store" st ON st."sellerId" = s."id"
      JOIN "User" buyer ON buyer."id" = c."buyerId" LEFT JOIN "OrderResolutionMessage" m ON m."caseId" = c."id" LEFT JOIN "User" author ON author."id" = m."authorId"
      GROUP BY c."id", p."id", so."id", pay."id", st."id", buyer."id" ORDER BY c."updatedAt" DESC LIMIT 200`;
    const parentIds = [...new Set(cases.filter(item => refundProviderTypes.includes(item.paymentMethod as typeof refundProviderTypes[number])).map(item => item.parentOrderId))];
    const events = parentIds.length ? await prisma.processedWebhookEvent.findMany({
      where: { parentOrderId: { in: parentIds }, identityVerified: true, reviewReason: null, OR: [
        { provider: PaymentMethod.STRIPE, eventType: refundEventType.STRIPE },
        { provider: PaymentMethod.PAYPAL, eventType: refundEventType.PAYPAL },
        { provider: PaymentMethod.PAYMONGO, eventType: refundEventType.PAYMONGO },
        { provider: PaymentMethod.PAYSTACK, eventType: refundEventType.PAYSTACK }
      ] },
      select: { id: true, provider: true, eventId: true, eventType: true, parentOrderId: true, amountMinor: true, currency: true, normalizedAmountMinor: true, normalizedCurrency: true, receivedAt: true }, orderBy: { receivedAt: 'desc' }, take: 500
    }) : [];
    const eventsByOrder = new Map<string, typeof events>();
    for (const event of events) if (event.parentOrderId) eventsByOrder.set(event.parentOrderId, [...(eventsByOrder.get(event.parentOrderId) ?? []), event]);
    res.json(cases.map(item => ({ ...item, providerRefundEvents: (eventsByOrder.get(item.parentOrderId) ?? []).map(event => ({
      ...event, amountMinor: event.normalizedAmountMinor ?? event.amountMinor, currency: event.normalizedCurrency ?? event.currency
    })) })));
  }));

  app.post('/api/admin/order-resolution-cases/:caseId/decision', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ outcome: z.enum(['APPROVE_REFUND', 'REJECT', 'RESOLVE_NO_REFUND']), approvedAmountMinor: z.number().int().positive().optional(), note: z.string().trim().min(8).max(1500) }).strict().superRefine((value, ctx) => {
      if (value.outcome === 'APPROVE_REFUND' && value.approvedAmountMinor === undefined) ctx.addIssue({ code: 'custom', message: 'Enter the approved refund amount.', path: ['approvedAmountMinor'] });
      if (value.outcome !== 'APPROVE_REFUND' && value.approvedAmountMinor !== undefined) ctx.addIssue({ code: 'custom', message: 'Refund amount is only valid when approving a refund.', path: ['approvedAmountMinor'] });
    }).parse(req.body);
    const caseId = param(req.params.caseId);
    const initial = await selectCase(caseId);
    if (!initial) throw fail(404, 'Order case not found.');
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.sellerOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "OrderResolutionCase" WHERE "id" = ${caseId} FOR UPDATE`;
      const current = await selectCase(caseId, tx);
      if (!current) throw fail(404, 'Order case not found.');
      if (!ORDER_RESOLUTION_REVIEW_STATUSES.includes(current.status as typeof ORDER_RESOLUTION_REVIEW_STATUSES[number])) throw fail(409, 'This case already has a final or pending-refund decision.');
      if (input.outcome === 'APPROVE_REFUND' && (input.approvedAmountMinor! > current.sellerOrderTotalMinor || (current.requestedAmountMinor !== null && input.approvedAmountMinor! > current.requestedAmountMinor))) throw fail(400, 'The approved amount cannot exceed the seller order total or the buyer requested amount.');
      const status = input.outcome === 'APPROVE_REFUND' ? 'REFUND_APPROVED' : input.outcome === 'REJECT' ? 'REJECTED' : 'RESOLVED';
      await tx.$executeRaw`UPDATE "OrderResolutionCase" SET "status" = ${status}, "approvedAmountMinor" = ${input.approvedAmountMinor ?? null}, "resolutionNote" = ${input.note}, "decidedById" = ${user.id}, "updatedAt" = CURRENT_TIMESTAMP, "settledAt" = ${input.outcome === 'APPROVE_REFUND' ? null : new Date()} WHERE "id" = ${caseId}`;
      const messageId = randomUUID();
      const publicNote = input.outcome === 'APPROVE_REFUND'
        ? `Refund approved for ${input.approvedAmountMinor} minor units. Approval does not issue the refund; verified provider settlement is still required.`
        : input.note;
      await tx.$executeRaw`INSERT INTO "OrderResolutionMessage" ("id", "caseId", "authorId", "authorRole", "body", "createdAt") VALUES (${messageId}, ${caseId}, ${user.id}, 'ADMIN', ${publicNote}, CURRENT_TIMESTAMP)`;
      await createUserNotification(tx, { userId: current.buyerId, eventType: 'ORDER_RESOLUTION_CASE_DECIDED', title: 'Order case reviewed', body: `An administrator updated your case for order ${current.orderNumber}.`, link: '/dashboard?tab=orders', payloadJson: { caseId, parentOrderId: current.parentOrderId, status } }, 'orders');
      await tx.auditLog.create({ data: { actorId: user.id, action: 'ORDER_RESOLUTION_CASE_DECIDED', entity: 'OrderResolutionCase', entityId: caseId, metadata: { outcome: input.outcome, approvedAmountMinor: input.approvedAmountMinor ?? null, note: input.note } } });
    }, { isolationLevel: 'ReadCommitted' });
    res.json(publicCase(await selectCase(caseId)));
  }));

  app.post('/api/admin/order-resolution-cases/:caseId/settle-refund', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ provider: z.enum(['STRIPE', 'PAYPAL', 'PAYMONGO', 'PAYSTACK']).optional(), providerEventId: z.string().trim().min(1).max(255).optional(), manualRefundReference: z.string().trim().min(3).max(200).optional() }).strict().superRefine((value, ctx) => {
      if (Boolean(value.provider) !== Boolean(value.providerEventId)) ctx.addIssue({ code: 'custom', message: 'Select both a payment provider and verified refund event.', path: ['providerEventId'] });
      if (Boolean(value.providerEventId) === Boolean(value.manualRefundReference)) ctx.addIssue({ code: 'custom', message: 'Provide exactly one provider refund event or COD repayment reference.', path: ['manualRefundReference'] });
    }).parse(req.body);
    const caseId = param(req.params.caseId);
    const initial = await selectCase(caseId);
    if (!initial) throw fail(404, 'Order case not found.');
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.sellerOrderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "OrderResolutionCase" WHERE "id" = ${caseId} FOR UPDATE`;
      const current = await selectCase(caseId, tx);
      if (!current) throw fail(404, 'Order case not found.');
      const event = input.provider && input.providerEventId ? await tx.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: input.provider as PaymentMethod, eventId: input.providerEventId } } }) : null;
      if (current.status === 'RESOLVED' && ((event && current.providerWebhookEventRowId === event.id) || (input.manualRefundReference && current.manualRefundReference === input.manualRefundReference))) return;
      if (current.status !== 'REFUND_APPROVED' || !current.approvedAmountMinor) throw fail(409, 'Approve a refund amount before recording its settlement.');
      let providerEventRowId: string | null = null;
      if (event && input.provider && input.providerEventId) {
        if (!refundEventMatchesCase({ paymentMethod: current.paymentMethod, parentOrderId: current.parentOrderId, parentTotalMinor: current.parentTotalMinor, currency: current.currency, approvedAmountMinor: current.approvedAmountMinor, event })) throw fail(409, 'The selected event is not a verified refund for this order, currency, and approved amount.');
        const verifiedRefunds = await tx.processedWebhookEvent.findMany({ where: { parentOrderId: current.parentOrderId, provider: input.provider as PaymentMethod, identityVerified: true, reviewReason: null, eventType: refundEventType[input.provider] }, select: { amountMinor: true, normalizedAmountMinor: true } });
        const refundAmounts = verifiedRefunds.map(refund => refund.normalizedAmountMinor ?? refund.amountMinor ?? 0);
        const verifiedRefundTotal = input.provider === 'STRIPE'
          ? Math.max(0, ...refundAmounts)
          : refundAmounts.reduce((total, amount) => total + amount, 0);
        const allocatedRows = await tx.$queryRaw<Array<{ amountMinor: bigint | number }>>`SELECT COALESCE(SUM("approvedAmountMinor"), 0) AS "amountMinor" FROM "OrderResolutionCase" WHERE "parentOrderId" = ${current.parentOrderId} AND "status" = 'RESOLVED' AND "providerWebhookEventRowId" IS NOT NULL`;
        const alreadyAllocated = Number(allocatedRows[0]?.amountMinor ?? 0);
        if (!Number.isSafeInteger(verifiedRefundTotal) || !Number.isSafeInteger(alreadyAllocated) || alreadyAllocated + current.approvedAmountMinor > verifiedRefundTotal) throw fail(409, 'Verified provider refunds do not have enough unallocated value to settle this case.');
        providerEventRowId = event.id;
      } else if (input.manualRefundReference) {
        if (!canRecordManualCodRefund(current.paymentMethod, current.paymentStatus)) throw fail(409, 'Manual repayment references are allowed only for COD after the seller has recorded cash collection.');
      } else throw fail(409, 'A matching, verified provider refund event is required.');
      await tx.$executeRaw`UPDATE "OrderResolutionCase" SET "status" = 'RESOLVED', "providerWebhookEventRowId" = ${providerEventRowId}, "manualRefundReference" = ${input.manualRefundReference ?? null}, "settledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${caseId}`;
      await reverseClubCoinsForOrder(tx, current.parentOrderId, input.providerEventId ?? input.manualRefundReference ?? caseId, `Reversed after admin-recorded refund settlement for case ${caseId}.`);
      await tx.auditLog.create({ data: { actorId: user.id, action: 'ORDER_RESOLUTION_REFUND_SETTLED', entity: 'OrderResolutionCase', entityId: caseId, metadata: { provider: input.provider ?? 'COD_MANUAL', providerEventId: input.providerEventId ?? null, manualRefundReference: input.manualRefundReference ?? null, amountMinor: current.approvedAmountMinor } } });
      await createUserNotification(tx, { userId: current.buyerId, eventType: 'ORDER_RESOLUTION_REFUND_SETTLED', title: 'Refund settlement recorded', body: `The approved refund for order ${current.orderNumber} has been recorded.`, link: '/dashboard?tab=orders', payloadJson: { caseId, parentOrderId: current.parentOrderId } }, 'orders');
    }, { isolationLevel: 'ReadCommitted' });
    res.json(publicCase(await selectCase(caseId)));
  }));
}
