import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { canRestoreSellerAfterAccountReactivation, memberStatusChangeFailure, SELLER_ACCOUNT_SUSPENSION_REASON } from './member-security-domain.js';
import { createUserNotification } from './notification-delivery.js';

type MemberRow = {
  id: string; email: string; name: string; role: string; accountStatus: string; createdAt: Date;
  sellerId: string | null; sellerStatus: string | null; storeName: string | null;
  activeSessions: number; buyerOrders: number;
};
type Actor = { id: string; role: Role };

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as Actor;
const selection = Prisma.sql`
  SELECT u."id", u."email", u."name", u."role"::text AS "role", u."accountStatus", u."createdAt",
    s."id" AS "sellerId", s."status"::text AS "sellerStatus", st."name" AS "storeName",
    (SELECT COUNT(*)::int FROM "Session" se WHERE se."userId" = u."id" AND se."expiresAt" > CURRENT_TIMESTAMP) AS "activeSessions",
    (SELECT COUNT(*)::int FROM "ParentOrder" po WHERE po."buyerId" = u."id") AS "buyerOrders"
  FROM "User" u LEFT JOIN "Seller" s ON s."userId" = u."id" LEFT JOIN "Store" st ON st."sellerId" = s."id"`;

export function registerMemberAdminRoutes(app: Express) {
  app.get('/api/admin/members', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const search = z.string().trim().max(120).catch('').parse(req.query.q);
    const status = req.query.status && req.query.status !== 'ALL' ? z.enum(['ACTIVE', 'SUSPENDED']).parse(req.query.status) : undefined;
    const role = req.query.role && req.query.role !== 'ALL' ? z.nativeEnum(Role).parse(req.query.role) : undefined;
    const page = z.coerce.number().int().min(1).max(1000).catch(1).parse(req.query.page);
    const filters: Prisma.Sql[] = [];
    if (search.length >= 2) { const pattern = `%${search}%`; filters.push(Prisma.sql`(u."email" ILIKE ${pattern} OR u."name" ILIKE ${pattern})`); }
    if (status) filters.push(Prisma.sql`u."accountStatus" = ${status}`);
    if (role) filters.push(Prisma.sql`u."role" = ${role}::"Role"`);
    const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}` : Prisma.empty;
    const pageSize = 50;
    const [members, totalRows] = await Promise.all([
      prisma.$queryRaw<MemberRow[]>(Prisma.sql`${selection} ${where} ORDER BY u."createdAt" DESC, u."id" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "User" u ${where}`)
    ]);
    res.json({ members: members.map(member => ({ ...member, isCurrentAdmin: member.id === admin.id })), page, pageSize, total: totalRows[0]?.total ?? 0 });
  }));

  app.patch('/api/admin/members/:id/status', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(8).max(500) }).parse(req.body);
    const memberId = param(req.params.id);
    const result = await prisma.$transaction(async tx => {
      const activeAdmins = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "role" = 'ADMIN' AND "accountStatus" = 'ACTIVE' ORDER BY "id" FOR UPDATE`;
      const targets = await tx.$queryRaw<{ id: string; email: string; role: string; accountStatus: string }[]>`SELECT "id", "email", "role"::text AS "role", "accountStatus" FROM "User" WHERE "id" = ${memberId} FOR UPDATE`;
      const target = targets[0];
      if (!target) throw fail(404, 'Member not found.');
      const failure = memberStatusChangeFailure({ actorId: admin.id, targetId: target.id, targetRole: target.role, currentStatus: target.accountStatus, nextStatus: input.status, activeAdminCount: activeAdmins.length });
      if (failure) throw fail(409, failure);

      const linkedSeller = await tx.seller.findUnique({ where: { userId: memberId }, select: { id: true, status: true, reason: true } });
      let sellerStatusBefore: SellerStatus | null = null;
      let sellerReasonBefore: string | null = null;
      if (input.status === 'SUSPENDED' && linkedSeller?.status === SellerStatus.APPROVED) {
        sellerStatusBefore = linkedSeller.status;
        sellerReasonBefore = linkedSeller.reason;
        await tx.seller.update({ where: { id: linkedSeller.id }, data: { status: SellerStatus.SUSPENDED, reason: SELLER_ACCOUNT_SUSPENSION_REASON } });
      } else if (input.status === 'ACTIVE' && linkedSeller) {
        const suspensions = await tx.$queryRaw<{ sellerStatusBefore: string | null; sellerReasonBefore: string | null }[]>`
          SELECT "metadata"->>'sellerStatusBefore' AS "sellerStatusBefore", "metadata"->>'sellerReasonBefore' AS "sellerReasonBefore"
          FROM "AuditLog" WHERE "entity" = 'User' AND "entityId" = ${memberId} AND "action" = 'MEMBER_ACCOUNT_STATUS_CHANGED'
            AND "metadata"->>'newStatus' = 'SUSPENDED' ORDER BY "createdAt" DESC LIMIT 1`;
        const previous = suspensions[0];
        if (canRestoreSellerAfterAccountReactivation({ sellerStatus: linkedSeller.status, sellerReason: linkedSeller.reason, previousStatus: previous?.sellerStatusBefore ?? null })) {
          await tx.seller.update({ where: { id: linkedSeller.id }, data: { status: SellerStatus.APPROVED, reason: previous?.sellerReasonBefore ?? null } });
        }
      }

      await tx.$executeRaw`UPDATE "User" SET "accountStatus" = ${input.status}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${memberId}`;
      const revoked = await tx.session.deleteMany({ where: { userId: memberId } });
      await tx.auditLog.create({ data: { actorId: admin.id, action: 'MEMBER_ACCOUNT_STATUS_CHANGED', entity: 'User', entityId: memberId, metadata: {
        oldStatus: target.accountStatus, newStatus: input.status, reason: input.reason,
        sellerStatusBefore, sellerReasonBefore, sessionsRevoked: revoked.count
      } } });
      if (input.status === 'ACTIVE') await createUserNotification(tx, { userId: memberId, eventType: 'ACCOUNT_REACTIVATED', title: 'Account access restored', body: 'Your account is active again. Sign in to continue.', link: '/sign-in', payloadJson: { memberId } }, 'account');
      return { id: memberId, status: input.status, sessionsRevoked: revoked.count };
    }, { isolationLevel: 'ReadCommitted' });
    res.json(result);
  }));

  app.post('/api/admin/members/:id/revoke-sessions', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const memberId = param(req.params.id);
    const reason = z.object({ reason: z.string().trim().min(8).max(500) }).parse(req.body).reason;
    if (admin.id === memberId) return res.status(409).json({ error: 'Use sign out in your own account menu instead.' });
    const result = await prisma.$transaction(async tx => {
      const target = await tx.user.findUnique({ where: { id: memberId }, select: { id: true } });
      if (!target) throw fail(404, 'Member not found.');
      const deleted = await tx.session.deleteMany({ where: { userId: memberId } });
      await tx.auditLog.create({ data: { actorId: admin.id, action: 'MEMBER_SESSIONS_REVOKED', entity: 'User', entityId: memberId, metadata: { reason, sessionsRevoked: deleted.count } } });
      return { id: memberId, sessionsRevoked: deleted.count };
    });
    res.json(result);
  }));
}
