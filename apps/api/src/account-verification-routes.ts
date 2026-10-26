import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { ClubCoinEventType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { awardClubCoinsForEvent } from './club-coins-awards.js';
import { prisma, requireAuth, tokenHash, newToken } from './security.js';
import { sendAccountVerificationEmail, StoreEmailTransportError } from './store-email-delivery.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string; emailVerifiedAt?: string | null };

export async function createAccountVerificationChallenge(userId: string, options: { enforceCooldown?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const challenge = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true, emailVerificationSentAt: true } });
    if (!user) throw fail(404, 'Account not found.');
    if (user.emailVerifiedAt) return { alreadyVerified: true as const };
    if (options.enforceCooldown && user.emailVerificationSentAt && now.getTime() - user.emailVerificationSentAt.getTime() < 60_000) {
      throw fail(429, 'A verification email was requested recently. Wait one minute before requesting another.');
    }
    const token = newToken();
    await tx.user.update({ where: { id: user.id }, data: {
      emailVerificationTokenHash: tokenHash(token),
      emailVerificationExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      emailVerificationSentAt: now
    } });
    return { alreadyVerified: false as const, token, email: user.email, name: user.name };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return challenge;
}

export async function deliverAccountVerification(challenge: Awaited<ReturnType<typeof createAccountVerificationChallenge>>) {
  if (challenge.alreadyVerified) return { sent: false, alreadyVerified: true };
  try {
    await sendAccountVerificationEmail({ to: challenge.email, name: challenge.name, token: challenge.token });
    return { sent: true, alreadyVerified: false };
  } catch (error) {
    if (!(error instanceof StoreEmailTransportError)) throw error;
    return { sent: false, alreadyVerified: false };
  }
}

export function registerAccountVerificationRoutes(app: Express) {
  app.post('/api/auth/verify-email', run(async (req, res) => {
    const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(req.body);
    const hash = tokenHash(token);
    const now = new Date();
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "emailVerificationTokenHash" = ${hash} FOR UPDATE`;
      const user = await tx.user.findFirst({ where: { emailVerificationTokenHash: hash, emailVerificationExpiresAt: { gt: now }, emailVerifiedAt: null }, select: { id: true } });
      if (!user) throw fail(400, 'This verification link is invalid, expired, or already used. Request a new link from account settings.');
      const updated = await tx.user.updateMany({ where: { id: user.id, emailVerificationTokenHash: hash, emailVerifiedAt: null }, data: {
        emailVerifiedAt: now,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null
      } });
      if (updated.count !== 1) throw fail(409, 'This verification link has already been used.');
      const reward = await awardClubCoinsForEvent(tx, { eventType: ClubCoinEventType.ACCOUNT_VERIFIED, eventId: user.id, userId: user.id, now });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'ACCOUNT_EMAIL_VERIFIED', entity: 'User', entityId: user.id, metadata: { verifiedAt: now.toISOString(), rewardEntriesCreated: reward.created } } });
      return { userId: user.id, rewardEntriesCreated: reward.created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    res.json({ verified: true, message: 'Your email address is verified.', rewardEntriesCreated: result.rewardEntriesCreated });
  }));

  app.post('/api/auth/email-verification/resend', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const challenge = await createAccountVerificationChallenge(user.id, { enforceCooldown: true });
    const delivery = await deliverAccountVerification(challenge);
    res.json({ verified: delivery.alreadyVerified, sent: delivery.sent, message: delivery.alreadyVerified ? 'This account is already verified.' : delivery.sent ? 'Verification email sent. The link expires in 24 hours.' : 'A fresh verification link was created, but email delivery is not configured or verified yet. Contact the platform administrator.' });
  }));
}
