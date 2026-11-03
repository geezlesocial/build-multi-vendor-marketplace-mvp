import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import express from "express";
import type { Prisma } from "@prisma/client";
import { LiveSessionStatus, ProductStatus, SellerStatus } from "@prisma/client";
import { env } from "./config.js";
import { currentUser, prisma, requireAuth } from "./security.js";
import { liveReportSchema } from "./validation.js";
import { liveProvider } from "./live-provider.js";
import { liveReplayStorageReady, streamReplayObject } from "./live-replays.js";
import {
  liveShoppingState,
  publicLiveSession,
  requireLiveShopping,
} from "./live-domain.js";

const run =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export function registerLivePublicRoutes(app: Express) {
  app.get(
    "/api/live-shopping/status",
    run(async (_req, res) => {
      const state = await liveShoppingState();
      res.json({
        ...state,
        recordingAvailable:
          state.readiness.configured && liveReplayStorageReady(),
        recordingStorageConfigured: liveReplayStorageReady(),
      });
    }),
  );

  app.get(
    "/api/live-sessions",
    run(async (_req, res) => {
      const liveState = await liveShoppingState();
      const visibleSessions: Prisma.LiveSessionWhereInput[] = [
        {
          status: "ENDED",
          recordingStatus: "READY",
          replayPublishedAt: { not: null },
        },
      ];
      if (liveState.effectiveEnabled) {
        visibleSessions.push({
          status: {
            in: [
              LiveSessionStatus.SCHEDULED,
              LiveSessionStatus.STARTING,
              LiveSessionStatus.LIVE,
              LiveSessionStatus.PAUSED,
            ],
          },
          OR: [
            { status: { not: LiveSessionStatus.SCHEDULED } },
            { scheduledAt: { gte: new Date() } },
          ],
        });
      }
      const liveSessionWhere: Prisma.LiveSessionWhereInput = {
        deletedAt: null,
        seller: { is: { status: SellerStatus.APPROVED } },
        OR: visibleSessions,
      };
      const sessions = await prisma.liveSession.findMany({
        where: liveSessionWhere,
        include: {
          seller: {
            include: { store: { select: { name: true, slug: true } } },
          },
          products: {
            where: { product: { is: { status: ProductStatus.APPROVED } } },
            orderBy: { sortOrder: "asc" },
            include: { product: { include: { inventory: true } } },
          },
        },
        orderBy: [{ scheduledAt: "asc" }, { endedAt: "desc" }],
        take: 50,
      });
      res.json(
        sessions.map((session) =>
          publicLiveSession({
            ...session,
            products: session.products.map((link) => ({
              ...link,
              product: {
                ...link.product,
                availableStock: link.product.inventory?.quantity ?? 0,
              },
            })),
          }),
        ),
      );
    }),
  );

  app.get(
    "/api/live-sessions/:id",
    run(async (req, res) => {
      const liveState = await liveShoppingState();
      const publicSessionOptions: Prisma.LiveSessionWhereInput[] = [
        {
          status: LiveSessionStatus.ENDED,
          recordingStatus: "READY",
          replayPublishedAt: { not: null },
        },
      ];
      if (liveState.effectiveEnabled) {
        publicSessionOptions.push({
          status: {
            in: [
              LiveSessionStatus.SCHEDULED,
              LiveSessionStatus.STARTING,
              LiveSessionStatus.LIVE,
              LiveSessionStatus.PAUSED,
            ],
          },
          OR: [
            { status: { not: LiveSessionStatus.SCHEDULED } },
            { scheduledAt: { gte: new Date() } },
          ],
        });
      }
      const sessionWhere: Prisma.LiveSessionWhereInput = {
        id: param(req.params.id),
        deletedAt: null,
        seller: { is: { status: SellerStatus.APPROVED } },
        OR: publicSessionOptions,
      };
      const session = await prisma.liveSession.findFirst({
        where: sessionWhere,
        include: {
          seller: {
            include: { store: { select: { name: true, slug: true } } },
          },
          products: {
            where: { product: { is: { status: ProductStatus.APPROVED } } },
            orderBy: { sortOrder: "asc" },
            include: { product: { include: { inventory: true } } },
          },
        },
      });
      if (!session)
        return res.status(404).json({ error: "Live session not found" });
      res.set("Cache-Control", "no-store");
      res.json(
        publicLiveSession({
          ...session,
          products: session.products.map((link) => ({
            ...link,
            product: {
              ...link.product,
              availableStock: link.product.inventory?.quantity ?? 0,
            },
          })),
        }),
      );
    }),
  );

  app.get(
    "/api/live-sessions/:id/replay",
    run(async (req, res) => {
      const session = await prisma.liveSession.findFirst({
        where: {
          id: param(req.params.id),
          deletedAt: null,
          status: "ENDED",
          recordingStatus: "READY",
          replayPublishedAt: { not: null },
          seller: { is: { status: SellerStatus.APPROVED } },
        },
        select: { recordingStorageKey: true },
      });
      if (!session?.recordingStorageKey)
        return res.status(404).json({ error: "Published replay not found." });
      await streamReplayObject(req, res, session.recordingStorageKey);
    }),
  );

  app.get(
    "/api/live-sessions/:id/token",
    run(async (req, res) => {
      await requireLiveShopping();
      const session = await prisma.liveSession.findFirst({
        where: {
          id: param(req.params.id),
          deletedAt: null,
          status: { in: ["STARTING", "LIVE", "PAUSED"] },
          seller: { is: { status: SellerStatus.APPROVED } },
          providerSessionRef: { not: null },
        },
        select: { providerSessionRef: true },
      });
      if (!session?.providerSessionRef)
        return res
          .status(409)
          .json({ error: "This show is not ready for viewer playback." });
      const user = await currentUser(req);
      let guestKey = req.cookies?.marketplace_live_viewer as string | undefined;
      if (!user && !/^[a-f0-9]{64}$/i.test(guestKey ?? "")) {
        guestKey = randomBytes(32).toString("hex");
        res.cookie("marketplace_live_viewer", guestKey, {
          httpOnly: true,
          secure: env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 365 * 24 * 60 * 60 * 1000,
          path: "/api/live-sessions",
        });
      }
      const identity = user
        ? `viewer:${user.id}`
        : `guest:${createHash("sha256").update(guestKey!).digest("hex")}`;
      res.json({
        ...(await liveProvider.issueViewerToken(
          session.providerSessionRef,
          identity,
          user?.name ?? "Viewer",
        )),
        role: "viewer",
      });
    }),
  );

  app.post(
    "/api/live-sessions/:id/reports",
    requireAuth,
    run(async (req, res) => {
      await requireLiveShopping();
      const user = res.locals.user as { id: string };
      const input = liveReportSchema.parse(req.body);
      const session = await prisma.liveSession.findFirst({
        where: {
          id: param(req.params.id),
          deletedAt: null,
          status: { in: ["STARTING", "LIVE", "PAUSED"] },
        },
        select: { id: true },
      });
      if (!session)
        return res.status(404).json({ error: "Live session not found" });
      const report = await prisma.liveSessionReport.create({
        data: {
          sessionId: session.id,
          reporterId: user.id,
          reason: input.reason,
        },
      });
      res.status(201).json({ id: report.id, status: report.status });
    }),
  );
}
