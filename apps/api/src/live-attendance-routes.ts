import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { ClubCoinEventType, LiveSessionStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { awardClubCoinsForEvent } from './club-coins-awards.js';
import { creditLiveAttendance, LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS } from './club-coins-domain.js';
import { prisma, requireAuth } from './security.js';
import { requireLiveShopping } from './live-domain.js';
import { liveProvider } from './live-provider.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';

export function registerLiveAttendanceRoutes(app: Express) {
  app.get('/api/live-sessions/:id/attendance', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const attendance = await prisma.liveSessionAttendance.findUnique({ where: { sessionId_userId: { sessionId: param(req.params.id), userId: user.id } }, select: { eligibleDurationSeconds: true, rewardedAt: true, startedAt: true, lastHeartbeatAt: true } });
    res.json({ attendance, rewardThresholdSeconds: LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS });
  }));

  app.post('/api/live-sessions/:id/attendance/heartbeat', requireAuth, run(async (req, res) => {
    const liveState = await requireLiveShopping();
    if (!liveState.readiness.attendanceVerificationAvailable) throw fail(409, 'Live-attendance rewards are disabled until the selected provider can verify viewer playback server-side.');
    const input = z.object({ playing: z.boolean() }).strict().parse(req.body);
    const user = res.locals.user as { id: string; emailVerifiedAt?: Date | null };
    if (!user.emailVerifiedAt) throw fail(403, 'Verify your email address before earning live-attendance rewards.');
    const sessionId = param(req.params.id);
    const now = new Date();
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "LiveSession" WHERE "id" = ${sessionId} FOR SHARE`;
      const session = await tx.liveSession.findUnique({ where: { id: sessionId }, select: { id: true, status: true, providerSessionRef: true, playbackRef: true } });
      if (!session || session.status !== LiveSessionStatus.LIVE) throw fail(404, 'This live session is not currently broadcasting.');
      if (!session.providerSessionRef || !session.playbackRef) throw fail(409, 'Attendance rewards require a provider-backed live playback session.');
      if (input.playing && !(await liveProvider.verifyViewerPlayback(session.providerSessionRef, `viewer:${user.id}`))) throw fail(409, 'Playback could not be verified by the live provider. Keep the show playing and retry.');
      const attendance = await tx.liveSessionAttendance.upsert({
        where: { sessionId_userId: { sessionId, userId: user.id } },
        update: {},
        create: { sessionId, userId: user.id, startedAt: now, lastHeartbeatAt: now }
      });
      await tx.$queryRaw`SELECT "id" FROM "LiveSessionAttendance" WHERE "id" = ${attendance.id} FOR UPDATE`;
      const current = await tx.liveSessionAttendance.findUnique({ where: { id: attendance.id } });
      if (!current) throw fail(409, 'Attendance record changed; retry.');
      if (current.rewardedAt) return { attendance: current, creditedSeconds: 0, rewardEntriesCreated: 0 };
      if (!input.playing) {
        const paused = await tx.liveSessionAttendance.update({ where: { id: current.id }, data: { lastHeartbeatAt: now } });
        return { attendance: paused, creditedSeconds: 0, rewardEntriesCreated: 0 };
      }
      const credited = creditLiveAttendance({ eligibleDurationSeconds: current.eligibleDurationSeconds, lastHeartbeatAt: current.lastHeartbeatAt }, now);
      const reachedThreshold = credited.eligibleDurationSeconds >= LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS;
      const updated = await tx.liveSessionAttendance.update({ where: { id: current.id }, data: { eligibleDurationSeconds: credited.eligibleDurationSeconds, lastHeartbeatAt: now, ...(reachedThreshold ? { rewardedAt: now } : {}) } });
      const reward = reachedThreshold ? await awardClubCoinsForEvent(tx, { eventType: ClubCoinEventType.LIVE_ATTENDANCE, eventId: current.id, userId: user.id, now }) : { created: 0 };
      return { attendance: updated, creditedSeconds: credited.creditedSeconds, rewardEntriesCreated: reward.created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    res.json({ eligibleDurationSeconds: result.attendance.eligibleDurationSeconds, rewardThresholdSeconds: LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS, rewarded: Boolean(result.attendance.rewardedAt), creditedSeconds: result.creditedSeconds, rewardEntriesCreated: result.rewardEntriesCreated });
  }));
}
