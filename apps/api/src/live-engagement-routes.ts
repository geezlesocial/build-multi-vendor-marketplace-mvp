import { createHash, randomBytes } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { LiveSessionReactionKind, LiveSessionStatus, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { currentUser, prisma, requireAuth } from './security.js';
import { requireLiveShopping } from './live-domain.js';
import { liveProvider } from './live-provider.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const viewerCookie = 'marketplace_live_viewer';
const reactionSchema = z.object({ reaction: z.nativeEnum(LiveSessionReactionKind).nullable() }).strict();
const reactionKinds = Object.values(LiveSessionReactionKind);

async function activeSession(id: string) {
  return prisma.liveSession.findFirst({
    where: { id, status: LiveSessionStatus.LIVE, providerSessionRef: { not: null }, seller: { is: { status: SellerStatus.APPROVED } } },
    select: { id: true, providerSessionRef: true }
  });
}

async function engagement(sessionId: string, userId?: string | null, providerSessionRef?: string | null) {
  const [viewCount, reactions, selectedReaction, viewersNow] = await Promise.all([
    prisma.liveSessionView.count({ where: { sessionId } }),
    prisma.liveSessionReaction.groupBy({ by: ['reaction'], where: { sessionId }, _count: { _all: true } }),
    userId ? prisma.liveSessionReaction.findUnique({ where: { sessionId_userId: { sessionId, userId } }, select: { reaction: true } }) : Promise.resolve(null),
    providerSessionRef ? liveProvider.getViewerCount(providerSessionRef).catch(() => null) : Promise.resolve(null)
  ]);
  const counts = Object.fromEntries(reactionKinds.map(kind => [kind, 0])) as Record<LiveSessionReactionKind, number>;
  for (const item of reactions) counts[item.reaction] = item._count._all;
  return { viewCount, viewersNow, reactions: counts, myReaction: selectedReaction?.reaction ?? null };
}

export function registerLiveEngagementRoutes(app: Express) {
  app.get('/api/live-sessions/:id/engagement', run(async (req, res) => {
    await requireLiveShopping();
    const session = await activeSession(param(req.params.id));
    if (!session) return res.status(404).json({ error: 'Live session not found' });
    const user = await currentUser(req);
    res.set('Cache-Control', 'no-store');
    res.json(await engagement(session.id, user?.id, session.providerSessionRef));
  }));

  app.post('/api/live-sessions/:id/view', run(async (req, res) => {
    await requireLiveShopping();
    const session = await activeSession(param(req.params.id));
    if (!session?.providerSessionRef) return res.status(404).json({ error: 'Live session not found' });
    const user = await currentUser(req);
    let guestKey = req.cookies?.[viewerCookie] as string | undefined;
    if (!user && !/^[a-f0-9]{64}$/i.test(guestKey ?? '')) {
      guestKey = randomBytes(32).toString('hex');
      res.cookie(viewerCookie, guestKey, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000, path: '/api/live-sessions' });
    }
    const guestIdentity = /^[a-f0-9]{64}$/i.test(guestKey ?? '') ? `guest:${createHash('sha256').update(guestKey!).digest('hex')}` : null;
    const viewerIdentities = user ? [`viewer:${user.id}`, ...(guestIdentity ? [guestIdentity] : [])] : guestIdentity ? [guestIdentity] : [];
    const playbackVerified = await Promise.all(viewerIdentities.map(identity => liveProvider.verifyViewerPlayback(session.providerSessionRef!, identity).catch(() => false)));
    if (!playbackVerified.some(Boolean)) return res.status(409).json({ error: 'The live stream must be actively playing before this view is counted.' });
    const viewerKeyHash = createHash('sha256').update(user ? `user:${user.id}` : `guest:${guestKey}`).digest('hex');
    await prisma.liveSessionView.upsert({
      where: { sessionId_viewerKeyHash: { sessionId: session.id, viewerKeyHash } },
      update: { lastViewedAt: new Date() },
      create: { sessionId: session.id, viewerKeyHash }
    });
    const viewCount = await prisma.liveSessionView.count({ where: { sessionId: session.id } });
    res.json({ viewCount });
  }));

  app.put('/api/live-sessions/:id/reaction', requireAuth, run(async (req, res) => {
    await requireLiveShopping();
    const input = reactionSchema.parse(req.body);
    const user = res.locals.user as { id: string };
    const session = await activeSession(param(req.params.id));
    if (!session) return res.status(404).json({ error: 'Live session not found' });
    if (input.reaction) {
      await prisma.liveSessionReaction.upsert({
        where: { sessionId_userId: { sessionId: session.id, userId: user.id } },
        update: { reaction: input.reaction },
        create: { sessionId: session.id, userId: user.id, reaction: input.reaction }
      });
    } else {
      await prisma.liveSessionReaction.deleteMany({ where: { sessionId: session.id, userId: user.id } });
    }
    res.json(await engagement(session.id, user.id, session.providerSessionRef));
  }));
}
