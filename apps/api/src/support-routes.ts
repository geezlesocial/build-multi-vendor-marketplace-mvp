import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { canAccessSupportTicket, canReplyToSupportTicket, canTransitionSupportStatus, statusAfterSupportReply, SUPPORT_PRIORITIES, SUPPORT_STATUSES, type SupportActor } from './support-domain.js';
import { createUserNotifications } from './notification-delivery.js';

type TicketRow = {
  id: string; ticketNumber: string; buyerId: string; buyerName: string; sellerId: string | null; storeName: string | null;
  parentOrderId: string | null; orderNumber: string | null; sellerOrderId: string | null; subject: string; category: string;
  status: string; priority: string; assignedAdminId: string | null; assignedAdminName: string | null;
  createdAt: Date; updatedAt: Date; resolvedAt: Date | null; lastMessage: string | null; lastMessageAt: Date | null;
  lastMessageAuthorRole: string | null; messageCount: number;
};
type MessageRow = { id: string; authorId: string; authorName: string; authorRole: string; body: string; createdAt: Date };
type TicketWithMessages = TicketRow & { messages: MessageRow[] };
type Actor = SupportActor & { role: string; sellerId?: string };

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as Actor;
const categorySchema = z.enum(['ORDER', 'DELIVERY', 'PAYMENT', 'PRODUCT', 'ACCOUNT', 'OTHER']);
const ticketSelection = Prisma.sql`
  SELECT t."id", t."ticketNumber", t."buyerId", buyer."name" AS "buyerName", t."sellerId", st."name" AS "storeName",
    t."parentOrderId", po."orderNumber", t."sellerOrderId", t."subject", t."category", t."status", t."priority",
    t."assignedAdminId", assigned."name" AS "assignedAdminName", t."createdAt", t."updatedAt", t."resolvedAt",
    latest."body" AS "lastMessage", latest."createdAt" AS "lastMessageAt", latest."authorRole" AS "lastMessageAuthorRole",
    (SELECT COUNT(*)::int FROM "SupportMessage" countMessage WHERE countMessage."ticketId" = t."id") AS "messageCount"
  FROM "SupportTicket" t
  JOIN "User" buyer ON buyer."id" = t."buyerId"
  LEFT JOIN "Seller" s ON s."id" = t."sellerId"
  LEFT JOIN "Store" st ON st."sellerId" = s."id"
  LEFT JOIN "ParentOrder" po ON po."id" = t."parentOrderId"
  LEFT JOIN "User" assigned ON assigned."id" = t."assignedAdminId"
  LEFT JOIN LATERAL (SELECT m."body", m."createdAt", m."authorRole" FROM "SupportMessage" m WHERE m."ticketId" = t."id" ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1) latest ON TRUE`;

async function selectTicket(ticketId: string, db: typeof prisma | Prisma.TransactionClient = prisma): Promise<TicketWithMessages | null> {
  const rows = await db.$queryRaw<TicketRow[]>(Prisma.sql`${ticketSelection} WHERE t."id" = ${ticketId}`);
  const ticket = rows[0];
  if (!ticket) return null;
  const messages = await db.$queryRaw<MessageRow[]>`
    SELECT recent."id", recent."authorId", u."name" AS "authorName", recent."authorRole", recent."body", recent."createdAt"
    FROM (SELECT m."id", m."authorId", m."authorRole", m."body", m."createdAt" FROM "SupportMessage" m
      WHERE m."ticketId" = ${ticketId} ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 500) recent
    JOIN "User" u ON u."id" = recent."authorId" ORDER BY recent."createdAt" ASC, recent."id" ASC`;
  return { ...ticket, messages };
}

function canAccess(ticket: TicketWithMessages, user: Actor) { return canAccessSupportTicket(ticket, user); }
function authorRole(ticket: TicketWithMessages, user: Actor): string {
  if (user.role === Role.ADMIN) return 'ADMIN';
  if (ticket.buyerId === user.id) return 'BUYER';
  if (ticket.sellerId && ticket.sellerId === user.sellerId) return user.role === Role.CASHIER ? 'CASHIER' : 'SELLER';
  return user.role;
}

async function notifyParticipants(tx: Prisma.TransactionClient, ticket: TicketWithMessages, authorId: string, title: string, eventType: string) {
  const recipientLinks = new Map<string, string>();
  if (ticket.buyerId !== authorId) recipientLinks.set(ticket.buyerId, '/dashboard?tab=messages');
  if (ticket.sellerId) {
    const seller = await tx.seller.findUnique({ where: { id: ticket.sellerId }, select: { userId: true } });
    if (seller && seller.userId !== authorId) recipientLinks.set(seller.userId, '/dashboard?mode=seller&tab=messages');
  }
  const admins = await tx.user.findMany({ where: { role: Role.ADMIN }, select: { id: true }, take: 100 });
  for (const admin of admins) if (admin.id !== authorId) recipientLinks.set(admin.id, '/admin/platform?section=support');
  if (!recipientLinks.size) return;
  await createUserNotifications(tx, [...recipientLinks].map(([userId, link]) => ({ category: 'support' as const, draft: {
    userId, eventType, title, body: `There is an update on support ticket ${ticket.ticketNumber}.`,
    link, payloadJson: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber }
  } })));
}

export function registerSupportRoutes(app: Express) {
  app.get('/api/support/tickets', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const status = req.query.status ? z.enum(SUPPORT_STATUSES).parse(req.query.status) : undefined;
    const page = z.coerce.number().int().min(1).max(1000).catch(1).parse(req.query.page);
    const limit = 50;
    const scope = user.role === Role.ADMIN
      ? Prisma.sql`TRUE`
      : user.sellerId
        ? Prisma.sql`(t."buyerId" = ${user.id} OR t."sellerId" = ${user.sellerId})`
        : Prisma.sql`t."buyerId" = ${user.id}`;
    const statusClause = status ? Prisma.sql`AND t."status" = ${status}` : Prisma.empty;
    const rows = await prisma.$queryRaw<TicketRow[]>(Prisma.sql`${ticketSelection} WHERE ${scope} ${statusClause} ORDER BY t."updatedAt" DESC, t."id" DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`);
    res.json({ tickets: rows, page, pageSize: limit });
  }));

  app.get('/api/support/tickets/:id', requireAuth, run(async (req, res) => {
    const ticket = await selectTicket(param(req.params.id));
    if (!ticket || !canAccess(ticket, actor(res))) return res.status(404).json({ error: 'Support ticket not found.' });
    res.json(ticket);
  }));

  app.post('/api/support/tickets', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = z.object({
      subject: z.string().trim().min(5).max(140), category: categorySchema.default('OTHER'),
      body: z.string().trim().min(1).max(4000), sellerOrderId: z.string().trim().min(1).max(80).optional()
    }).parse(req.body);
    let order: { sellerOrderId: string; parentOrderId: string; sellerId: string | null; orderNumber: string } | null = null;
    if (input.sellerOrderId) {
      const rows = await prisma.$queryRaw<{ sellerOrderId: string; parentOrderId: string; sellerId: string | null; orderNumber: string }[]>`
        SELECT so."id" AS "sellerOrderId", so."parentId" AS "parentOrderId", so."sellerId", po."orderNumber"
        FROM "SellerOrder" so JOIN "ParentOrder" po ON po."id" = so."parentId"
        WHERE so."id" = ${input.sellerOrderId} AND po."buyerId" = ${user.id}`;
      order = rows[0] ?? null;
      if (!order) return res.status(404).json({ error: 'That order is not available for this support request.' });
    }
    const ticketId = randomUUID();
    const messageId = randomUUID();
    const ticketNumber = `SUP-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6).toUpperCase()}`;
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "SupportTicket" ("id", "ticketNumber", "buyerId", "sellerId", "parentOrderId", "sellerOrderId", "subject", "category", "createdAt", "updatedAt")
        VALUES (${ticketId}, ${ticketNumber}, ${user.id}, ${order?.sellerId ?? null}, ${order?.parentOrderId ?? null}, ${order?.sellerOrderId ?? null}, ${input.subject}, ${input.category}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO "SupportMessage" ("id", "ticketId", "authorId", "authorRole", "body", "createdAt") VALUES (${messageId}, ${ticketId}, ${user.id}, ${user.role}, ${input.body}, CURRENT_TIMESTAMP)`;
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SUPPORT_TICKET_OPENED', entity: 'SupportTicket', entityId: ticketId, metadata: { category: input.category, linkedOrder: Boolean(order) } } });
      const created = await selectTicket(ticketId, tx);
      if (created) await notifyParticipants(tx, created, user.id, 'New support ticket', 'SUPPORT_TICKET_OPENED');
    });
    const ticket = await selectTicket(ticketId);
    res.status(201).json(ticket);
  }));

  app.post('/api/support/tickets/:id/messages', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const body = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body).body;
    const ticketId = param(req.params.id);
    const messageId = randomUUID();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ${ticketId} FOR UPDATE`;
      const current = await selectTicket(ticketId, tx);
      if (!current || !canAccess(current, user)) throw fail(404, 'Support ticket not found.');
      if (!canReplyToSupportTicket(current, user)) throw fail(409, 'This support ticket is closed for replies. A resolved ticket can only be reopened by its buyer within seven days.');
      const role = authorRole(current, user);
      const nextStatus = statusAfterSupportReply(current.status, { ...user, role });
      await tx.$executeRaw`INSERT INTO "SupportMessage" ("id", "ticketId", "authorId", "authorRole", "body", "createdAt") VALUES (${messageId}, ${ticketId}, ${user.id}, ${role}, ${body}, CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`UPDATE "SupportTicket" SET "status" = ${nextStatus}, "resolvedAt" = CASE WHEN ${nextStatus} = 'OPEN' THEN NULL ELSE "resolvedAt" END, "assignedAdminId" = CASE WHEN ${role} = 'ADMIN' AND "assignedAdminId" IS NULL THEN ${user.id} ELSE "assignedAdminId" END, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${ticketId}`;
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SUPPORT_MESSAGE_ADDED', entity: 'SupportTicket', entityId: ticketId, metadata: { authorRole: role } } });
      const updated = await selectTicket(ticketId, tx);
      if (updated) await notifyParticipants(tx, updated, user.id, 'Support ticket updated', 'SUPPORT_TICKET_MESSAGE');
    });
    res.status(201).json(await selectTicket(ticketId));
  }));

  app.patch('/api/support/tickets/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({
      status: z.enum(SUPPORT_STATUSES).optional(), priority: z.enum(SUPPORT_PRIORITIES).optional(), assignToMe: z.boolean().optional()
    }).refine(value => value.status !== undefined || value.priority !== undefined || value.assignToMe !== undefined, 'Provide a status, priority, or assignment update.').parse(req.body);
    const ticketId = param(req.params.id);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ${ticketId} FOR UPDATE`;
      const current = await selectTicket(ticketId, tx);
      if (!current) throw fail(404, 'Support ticket not found.');
      const nextStatus = input.status ?? current.status;
      if (input.status && !canTransitionSupportStatus(current.status, input.status, user.role, Boolean(current.sellerId))) throw fail(409, `Cannot change ticket status from ${current.status} to ${input.status}.`);
      const nextPriority = input.priority ?? current.priority;
      const assignedAdminId = input.assignToMe ? user.id : current.assignedAdminId;
      const resolvedAt = nextStatus === 'RESOLVED' ? new Date() : current.status === 'RESOLVED' && nextStatus !== 'RESOLVED' ? null : current.resolvedAt;
      await tx.$executeRaw`UPDATE "SupportTicket" SET "status" = ${nextStatus}, "priority" = ${nextPriority}, "assignedAdminId" = ${assignedAdminId}, "resolvedAt" = ${resolvedAt}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${ticketId}`;
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SUPPORT_TICKET_UPDATED', entity: 'SupportTicket', entityId: ticketId, metadata: { oldStatus: current.status, newStatus: nextStatus, oldPriority: current.priority, newPriority: nextPriority, assigned: Boolean(assignedAdminId) } } });
      if (input.status && input.status !== current.status) {
        const updated = await selectTicket(ticketId, tx);
        if (updated) await notifyParticipants(tx, updated, user.id, 'Support ticket status updated', 'SUPPORT_TICKET_STATUS');
      }
    });
    res.json(await selectTicket(ticketId));
  }));
}
