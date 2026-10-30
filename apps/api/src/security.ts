import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import { env } from './config.js';
import { hasPlatformPermission, PLATFORM_POSITION_LABELS, requiredPlatformPermission, type PlatformPosition } from './platform-access.js';

export const prisma = new PrismaClient();

function passwordDigest(password: string) {
  return crypto.createHmac('sha256', env.PASSWORD_PEPPER).update(password, 'utf8').digest('base64url');
}

export async function hashPassword(password: string) {
  // bcrypt ignores bytes after byte 72. Pre-hashing prevents long passwords and
  // the pepper from being silently truncated while keeping legacy hashes valid.
  return `v2$${await bcrypt.hash(passwordDigest(password), 12)}`;
}

export async function verifyPassword(password: string, passwordHash: string) {
  if (passwordHash.startsWith('v2$')) return bcrypt.compare(passwordDigest(password), passwordHash.slice(3));
  // Backward-compatible verification for existing marketplace accounts.
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

export type AuthUser = { id: string; email: string; name: string; role: Role; emailVerifiedAt?: Date | null; onboardingCompletedAt?: Date | null; sellerId?: string; avatarUrl?: string; platformPermissions?: string[]; platformPosition?: PlatformPosition; platformPositionName?: string };

export async function resolvePlatformPositionName(position: string | undefined) {
  if (!position) return undefined;
  const builtInName = PLATFORM_POSITION_LABELS[position as keyof typeof PLATFORM_POSITION_LABELS];
  if (builtInName) return builtInName;
  return (await prisma.platformTeamPosition.findUnique({ where: { id: position }, select: { name: true } }))?.name ?? position;
}

export async function currentUser(req: Request): Promise<AuthUser | null> {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME] as string | undefined;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: { include: { seller: true, staffMemberships: true, platformCollaborator: true } } } });
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
  const collaborator = session.user.platformCollaborator;
  const platformPositionName = session.user.role === Role.PLATFORM_STAFF && collaborator?.enabled ? await resolvePlatformPositionName(collaborator.position) : undefined;
  return { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role, emailVerifiedAt: session.user.emailVerifiedAt, onboardingCompletedAt: session.user.onboardingCompletedAt, ...(sellerId ? { sellerId } : {}), ...(session.user.avatarMediaId ? { avatarUrl: '/api/account/avatar' } : {}), ...(session.user.role === Role.PLATFORM_STAFF && collaborator?.enabled ? { platformPosition: collaborator.position as PlatformPosition, platformPositionName, platformPermissions: collaborator.permissions } : {}) };
}

function allowedBeforeOnboarding(req: Request) {
  if (req.method === 'GET' && req.path === '/api/onboarding') return true;
  if (req.method === 'POST' && req.path === '/api/onboarding/complete') return true;
  if ((req.method === 'POST' || req.method === 'DELETE') && /^\/api\/onboarding\/stores\/[^/]+\/follow$/.test(req.path)) return true;
  if (req.method === 'POST' && req.path === '/api/auth/logout') return true;
  if (req.method === 'POST' && req.path === '/api/auth/email-verification/resend') return true;
  if (req.method === 'GET' && req.path === '/api/account/avatar') return true;
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  currentUser(req).then(user => {
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (!user.onboardingCompletedAt && !allowedBeforeOnboarding(req)) return res.status(428).json({ error: 'Complete account onboarding before using this feature.', code: 'ONBOARDING_REQUIRED', redirectTo: '/onboarding' });
    res.locals.user = user;
    next();
  }).catch(next);
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as AuthUser | undefined;
    const platformAdminSellerAccess = user?.role === Role.ADMIN && Boolean(user.sellerId) && roles.includes(Role.SELLER);
    const staffPermission = user?.role === Role.PLATFORM_STAFF && roles.includes(Role.ADMIN)
      ? requiredPlatformPermission(req.method, req.path, req.body)
      : null;
    const canReadMarketplaceOrPaymentPolicies = user?.role === Role.PLATFORM_STAFF
      && req.method === 'GET'
      && req.path === '/api/admin/platform/settings'
      && (user.platformPermissions ?? []).some(permission => permission === 'MARKETPLACE' || permission === 'PAYMENTS');
    const platformStaffAccess = user?.role === Role.PLATFORM_STAFF
      && Boolean(user.emailVerifiedAt)
      && (canReadMarketplaceOrPaymentPolicies || hasPlatformPermission(user.platformPermissions ?? [], staffPermission));
    if (!user || (!roles.includes(user.role) && !platformAdminSellerAccess && !platformStaffAccess)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

export async function audit(actorId: string | undefined, action: string, entity: string, entityId: string | undefined, metadata?: unknown) {
  await prisma.auditLog.create({ data: { actorId, action, entity, entityId, metadata: metadata as object | undefined } });
}

export function safeUser(user: AuthUser) { return user; }
