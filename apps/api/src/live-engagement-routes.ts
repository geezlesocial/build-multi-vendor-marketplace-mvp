import { createHash, randomBytes } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
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
const reactionMutationLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const MAX_ACTIVE_ENGAGEMENT_STREAMS = 500;
const MAX_SESSION_ENGAGEMENT_STREAMS = 200;
const engagementStreams = new Map<string, Set<Response>>();
const lastEngagementCounts = new Map<string, string>();
let activeStreamCount = 0;
let engagementTimer: NodeJS.Timeout | null = null;
let engagementPublishInFlight = false;

function publishEngagementCounts() {
  if (engagementPublishInFlight || engagementStreams.size === 0) return;
  engagementPublishInFlight = true;
  const sessionIds = [...engagementStreams.keys()];
  void prisma.liveSessionReaction.groupBy({
    by: ['sessionId', 'reaction'],
    where: { sessionId: { in: sessionIds } },
    _count: { _all: true }
  }).then(reactions => {
    const countsBySession = new Map<string, Record<LiveSessionReactionKind, number>>();
    for (const sessionId of sessionIds) {
      countsBySession.set(sessionId, Object.fromEntries(reactionKinds.map(kind => [kind, 0])) as Record<LiveSessionReactionKind, number>);
    }
    for (const item of reactions) countsBySession.get(item.sessionId)![item.reaction] = item._count._all;
    for (const sessionId of sessionIds) {
      const subscribers = engagementStreams.get(sessionId);
      if (!subscribers) continue;
      const counts = countsBySession.get(sessionId)!;
      const serializedCounts = JSON.stringify(counts);
      if (lastEngagementCounts.get(sessionId) === serializedCounts) continue;
      lastEngagementCounts.set(sessionId, serializedCounts);
      const payload = `event: engagement\ndata: ${JSON.stringify({ counts })}\n\n`;
      for (const subscriber of subscribers) {
        if (!subscriber.writableEnded) subscriber.write(payload);
      }
    }
  }).catch(() => undefined).finally(() => {
    engagementPublishInFlight = false;
  });
}

async function activeSession(id: string) {
  return prisma.liveSession.findFirst({
    where: { id, deletedAt: null, status: LiveSessionStatus.LIVE, providerSessionRef: { not: null }, seller: { is: { status: SellerStatus.APPROVED } } },
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

  app.get('/api/live-sessions/:id/engagement/events', run(async (req, res) => {
    await requireLiveShopping();
    const session = await activeSession(param(req.params.id));
    if (!session) return res.status(404).json({ error: 'Live session not found' });
    const viewers = engagementStreams.get(session.id) ?? new Set<Response>();
    if (activeStreamCount >= MAX_ACTIVE_ENGAGEMENT_STREAMS || viewers.size >= MAX_SESSION_ENGAGEMENT_STREAMS) {
      return res.status(503).json({ error: 'Live engagement is at capacity. Use the refresh fallback.' });
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    viewers.add(res);
    engagementStreams.set(session.id, viewers);
    activeStreamCount += 1;

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 20_000);
    heartbeat.unref();

    if (!engagementTimer) {
      engagementTimer = setInterval(publishEngagementCounts, 2_000);
      engagementTimer.unref();
    }

    const close = () => {
      clearInterval(heartbeat);
      const subscribers = engagementStreams.get(session.id);
      subscribers?.delete(res);
      activeStreamCount = Math.max(0, activeStreamCount - 1);
      if (subscribers?.size === 0) {
        engagementStreams.delete(session.id);
        lastEngagementCounts.delete(session.id);
      }
      if (engagementStreams.size === 0 && engagementTimer) {
        clearInterval(engagementTimer);
        engagementTimer = null;
      }
    };
    res.on('close', close);
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

  app.put('/api/live-sessions/:id/reaction', reactionMutationLimit, requireAuth, run(async (req, res) => {
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
