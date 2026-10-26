import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import { env } from './config.js';

export const prisma = new PrismaClient();

export async function hashPassword(password: string) {
  return bcrypt.hash(`${password}${env.PASSWORD_PEPPER}`, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(`${password}${env.PASSWORD_PEPPER}`, passwordHash);
}

export function newToken() { return crypto.randomBytes(32).toString('hex'); }
export function tokenHash(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }

export async function createSession(userId: string, res: Response) {
  const token = newToken();
  const csrf = newToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86400000);
  await prisma.session.create({ data: { tokenHash: tokenHash(token), userId, expiresAt } });
  res.cookie(env.SESSION_COOKIE_NAME, token, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', expires: expiresAt, path: '/' });
  res.cookie('marketplace_csrf', csrf, { httpOnly: false, secure: env.NODE_ENV === 'production', sameSite: 'lax', expires: expiresAt, path: '/' });
}

export type AuthUser = { id: string; email: string; name: string; role: Role; emailVerifiedAt?: Date | null; sellerId?: string; avatarUrl?: string };

export async function currentUser(req: Request): Promise<AuthUser | null> {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: { include: { seller: true, staffMemberships: true } } } });
  if (!session || session.expiresAt <= new Date()) return null;
  const account = await prisma.$queryRaw<{ accountStatus: string }[]>`SELECT "accountStatus" FROM "User" WHERE "id" = ${session.userId}`;
  if (account[0]?.accountStatus !== 'ACTIVE') {
    await prisma.session.deleteMany({ where: { userId: session.userId } });
    return null;
  }
  const platformSeller = session.user.role === Role.ADMIN
    ? await prisma.store.findFirst({ where: { isPlatformStore: true }, select: { sellerId: true } })
    : null;
  const sellerId = session.user.role === Role.ADMIN
    ? platformSeller?.sellerId
    : session.user.seller?.id ?? session.user.staffMemberships[0]?.sellerId;
  return { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role, emailVerifiedAt: session.user.emailVerifiedAt, ...(sellerId ? { sellerId } : {}), ...(session.user.avatarMediaId ? { avatarUrl: '/api/account/avatar' } : {}) };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  currentUser(req).then(user => {
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    res.locals.user = user;
    next();
  }).catch(next);
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as AuthUser | undefined;
    const platformAdminSellerAccess = user?.role === Role.ADMIN && Boolean(user.sellerId) && roles.includes(Role.SELLER);
    if (!user || (!roles.includes(user.role) && !platformAdminSellerAccess)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

export async function audit(actorId: string | undefined, action: string, entity: string, entityId: string | undefined, metadata?: unknown) {
  await prisma.auditLog.create({ data: { actorId, action, entity, entityId, metadata: metadata as object | undefined } });
}

export function safeUser(user: AuthUser) { return user; }
