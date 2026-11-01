import { randomUUID } from "node:crypto";
import type { Express } from "express";
import express from "express";
import { Role } from "@prisma/client";
import { EgressStatus } from "livekit-server-sdk";
import { z } from "zod";
import { audit, prisma, requireAuth, requireRole } from "./security.js";
import { canDeleteLiveShow } from "./live-state.js";
import {
  canTransitionLiveSession,
  requireLiveShopping,
} from "./live-domain.js";
import { liveProvider } from "./live-provider.js";
import {
  liveReplayStorageReady,
  reconcileLiveRecordings,
  removeReplayObject,
  replayObjectExists,
  streamReplayObject,
} from "./live-replays.js";

const asyncRoute =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export function registerSellerLiveSessionLifecycleRoutes(app: Express) {
  app.post(
    "/api/seller/live-sessions/:id/transition",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { id: string; sellerId?: string };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const next = z
        .object({
          status: z.enum([
            "DRAFT",
            "SCHEDULED",
            "STARTING",
            "LIVE",
            "PAUSED",
            "ENDED",
            "CANCELLED",
          ]),
        })
        .parse(req.body).status;
      const session = await prisma.liveSession.findFirst({
        where: {
          id: routeParam(req.params.id),
          sellerId: user.sellerId,
          deletedAt: null,
        },
      });
      if (!session)
        return res.status(404).json({ error: "Live session not found" });
      if (session.status === next)
        return res.json({ ok: true, status: session.status });
      if (!canTransitionLiveSession(session.status, next))
        return res.status(409).json({
          error: `Invalid live-session transition from ${session.status} to ${next}`,
        });
      if (next === "STARTING") {
        await requireLiveShopping();
        const providerSession = await liveProvider.createSession({
          title: session.title,
          scheduledAt: session.scheduledAt ?? undefined,
        });
        const started = await prisma.liveSession.updateMany({
          where: {
            id: session.id,
            sellerId: user.sellerId,
            status: session.status,
            deletedAt: null,
          },
          data: {
            status: "STARTING",
            provider: "LIVEKIT",
            providerSessionRef: providerSession.providerSessionRef,
            playbackRef: providerSession.playbackRef,
            providerStatus: providerSession.providerStatus,
          },
        });
        if (!started.count) {
          await liveProvider.endSession(providerSession.providerSessionRef);
          return res
            .status(409)
            .json({ error: "Live session changed; refresh and retry." });
        }
        await audit(
          user.id,
          "LIVE_SESSION_STATUS_CHANGED",
          "LiveSession",
          session.id,
          { old: session.status, new: next, provider: "LIVEKIT" },
        );
        return res.json({ ok: true, status: next });
      }
      let recording: { egressId: string; status: number } | null = null;
      let recordingStartFailed = false;
      const recordingKey = `live-replays/${session.id}/${randomUUID()}.mp4`;
      if (next === "LIVE") {
        await requireLiveShopping();
        if (
          !session.providerSessionRef ||
          !user.sellerId ||
          !(await liveProvider.verifyHostPublishing(
            session.providerSessionRef,
            `seller:${user.sellerId}`,
          ))
        )
          return res.status(409).json({
            error: "Start your camera and microphone before going live.",
          });
        if (liveReplayStorageReady()) {
          try {
            recording = await liveProvider.startRecording(
              session.providerSessionRef,
              recordingKey,
            );
          } catch {
            recordingStartFailed = true;
          }
        }
      }
      if (next === "PAUSED") await requireLiveShopping();
      if (next === "SCHEDULED" && !session.scheduledAt)
        return res.status(409).json({
          error: "Set a scheduled date and time before publishing this show.",
        });
      if (
        next === "SCHEDULED" &&
        session.scheduledAt &&
        session.scheduledAt <= new Date()
      )
        return res.status(409).json({
          error: "Choose a future date and time before publishing this show.",
        });
      let recordingEndStatus: number | null = null;
      const recordingNeedsFinalization = Boolean(
        session.recordingEgressId &&
        ["STARTING", "RECORDING", "PROCESSING"].includes(
          session.recordingStatus,
        ),
      );
      if (
        next === "ENDED" &&
        recordingNeedsFinalization &&
        session.recordingEgressId
      ) {
        try {
          recordingEndStatus = (
            await liveProvider.stopRecording(session.recordingEgressId)
          ).status;
        } catch {
          recordingEndStatus = null;
        }
      }
      const egressComplete =
        recordingEndStatus === EgressStatus.EGRESS_COMPLETE;
      const egressFailed =
        recordingEndStatus === EgressStatus.EGRESS_FAILED ||
        recordingEndStatus === EgressStatus.EGRESS_ABORTED;
      const shouldRetainRoomForEgress =
        next === "ENDED" &&
        Boolean(session.recordingEgressId) &&
        recordingEndStatus !== null &&
        !egressComplete &&
        !egressFailed;
      if (
        next === "ENDED" &&
        session.providerSessionRef &&
        !shouldRetainRoomForEgress
      )
        await liveProvider.endSession(session.providerSessionRef);
      const endedAt =
        next === "ENDED" || next === "CANCELLED" ? new Date() : null;
      const updated = await prisma.liveSession.updateMany({
        where: {
          id: session.id,
          sellerId: user.sellerId,
          status: session.status,
          deletedAt: null,
        },
        data: {
          status: next,
          ...(endedAt ? { endedAt } : {}),
          ...(next === "LIVE"
            ? {
                startedAt: new Date(),
                providerStatus: "LIVE",
                recordingStatus: recording
                  ? "STARTING"
                  : recordingStartFailed
                    ? "FAILED"
                    : "NOT_CONFIGURED",
                recordingEgressId: recording?.egressId ?? null,
                recordingStorageKey: recording ? recordingKey : null,
                recordingStartedAt: recording ? new Date() : null,
                recordingErrorCode: recordingStartFailed
                  ? "EGRESS_START_FAILED"
                  : null,
              }
            : {}),
          ...(next === "ENDED" && recordingNeedsFinalization
            ? {
                recordingStatus:
                  shouldRetainRoomForEgress || egressComplete
                    ? "PROCESSING"
                    : "FAILED",
                ...(shouldRetainRoomForEgress || egressComplete
                  ? {}
                  : {
                      recordingErrorCode: egressFailed
                        ? "EGRESS_FAILED"
                        : "EGRESS_STOP_FAILED",
                    }),
                recordingCompletedAt:
                  shouldRetainRoomForEgress || egressComplete
                    ? null
                    : new Date(),
              }
            : {}),
        },
      });
      if (!updated.count && recording?.egressId)
        await liveProvider
          .stopRecording(recording.egressId)
          .catch(() => undefined);
      if (!updated.count)
        return res
          .status(409)
          .json({ error: "Live session changed; retry with current state" });
      await audit(
        user.id,
        "LIVE_SESSION_STATUS_CHANGED",
        "LiveSession",
        session.id,
        { old: session.status, new: next },
      );
      if (next === "ENDED")
        void reconcileLiveRecordings().catch(() => undefined);
      res.json({ ok: true, status: next });
    }),
  );
  app.get(
    "/api/seller/live-sessions/:id/stream-token",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as {
        id: string;
        name?: string;
        sellerId?: string;
      };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const session = await prisma.liveSession.findFirst({
        where: {
          id: routeParam(req.params.id),
          sellerId: user.sellerId,
          deletedAt: null,
          status: { in: ["STARTING", "LIVE", "PAUSED"] },
          providerSessionRef: { not: null },
        },
        select: { providerSessionRef: true },
      });
      if (!session?.providerSessionRef)
        return res
          .status(409)
          .json({ error: "Start the broadcast before opening the studio." });
      res.json({
        ...(await liveProvider.issueHostToken(
          session.providerSessionRef,
          `seller:${user.sellerId}`,
          user.name ?? "Seller",
        )),
        role: "host",
      });
    }),
  );
  app.get(
    "/api/seller/live-sessions/:id/replay",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { sellerId?: string };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const session = await prisma.liveSession.findFirst({
        where: {
          id: routeParam(req.params.id),
          sellerId: user.sellerId,
          deletedAt: null,
          status: "ENDED",
          recordingStatus: "READY",
        },
        select: { recordingStorageKey: true },
      });
      if (!session?.recordingStorageKey)
        return res
          .status(404)
          .json({ error: "Replay is not ready for preview." });
      await streamReplayObject(req, res, session.recordingStorageKey);
    }),
  );
  app.post(
    "/api/seller/live-sessions/:id/replay",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { id: string; sellerId?: string };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const input = z
        .object({ published: z.boolean() })
        .strict()
        .parse(req.body);
      const session = await prisma.liveSession.findFirst({
        where: {
          id: routeParam(req.params.id),
          sellerId: user.sellerId,
          deletedAt: null,
          status: "ENDED",
          recordingStatus: "READY",
          recordingStorageKey: { not: null },
        },
        select: {
          id: true,
          recordingStorageKey: true,
          replayPublishedAt: true,
        },
      });
      if (!session?.recordingStorageKey)
        return res.status(409).json({
          error:
            "The replay cannot be published until its private recording is ready.",
        });
      if (
        input.published &&
        !(await replayObjectExists(session.recordingStorageKey))
      )
        return res.status(409).json({
          error:
            "The private replay file is not available in storage yet. Try again shortly.",
        });
      const updated = await prisma.liveSession.updateMany({
        where: {
          id: session.id,
          sellerId: user.sellerId,
          status: "ENDED",
          recordingStatus: "READY",
          recordingStorageKey: session.recordingStorageKey,
          replayPublishedAt: session.replayPublishedAt,
          deletedAt: null,
        },
        data: {
          replayPublishedAt: input.published
            ? (session.replayPublishedAt ?? new Date())
            : null,
        },
      });
      if (!updated.count)
        return res
          .status(409)
          .json({ error: "Replay state changed; refresh and try again." });
      await audit(
        user.id,
        input.published ? "LIVE_REPLAY_PUBLISHED" : "LIVE_REPLAY_UNPUBLISHED",
        "LiveSession",
        session.id,
        { published: input.published },
      );
      res.json({ id: session.id, published: input.published });
    }),
  );
  app.delete(
    "/api/seller/live-sessions/:id/replay",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { id: string; sellerId?: string };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const session = await prisma.liveSession.findFirst({
        where: {
          id: routeParam(req.params.id),
          sellerId: user.sellerId,
          status: "ENDED",
          recordingStatus: "READY",
          replayPublishedAt: null,
          recordingStorageKey: { not: null },
        },
        select: { id: true, recordingStorageKey: true },
      });
      if (!session?.recordingStorageKey)
        return res
          .status(409)
          .json({ error: "Unpublish the replay before deleting it." });
      await removeReplayObject(session.recordingStorageKey);
      const updated = await prisma.liveSession.updateMany({
        where: {
          id: session.id,
          sellerId: user.sellerId,
          recordingStatus: "READY",
          replayPublishedAt: null,
          recordingStorageKey: session.recordingStorageKey,
        },
        data: {
          recordingStatus: "FAILED",
          recordingStorageKey: null,
          recordingErrorCode: "SELLER_DELETED_REPLAY",
        },
      });
      if (!updated.count)
        return res.status(409).json({
          error: "Replay state changed while deleting; refresh and try again.",
        });
      await audit(
        user.id,
        "LIVE_REPLAY_DELETED",
        "LiveSession",
        session.id,
        {},
      );
      res.status(204).send();
    }),
  );
}
