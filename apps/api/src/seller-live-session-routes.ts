import type { Express } from "express";
import express from "express";
import { Role } from "@prisma/client";
import { z } from "zod";
import { audit, prisma, requireAuth, requireRole } from "./security.js";
import { liveSessionSchema } from "./validation.js";
import { canDeleteLiveShow } from "./live-state.js";
import {
  eligibleProducts,
  eligibleSeller,
  publicLiveSession,
} from "./live-domain.js";
import { registerSellerLiveSessionLifecycleRoutes } from "./seller-live-session-lifecycle-routes.js";
import { syncLiveShopProducts } from "./live-shop-products.js";

const asyncRoute =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T =>
  schema.parse(value);
const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export function registerSellerLiveSessionRoutes(app: Express) {
  app.get(
    "/api/seller/live-sessions",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (_req, res) => {
      const user = res.locals.user as { id: string; sellerId?: string };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const view = _req.query.view === undefined ? "active" : _req.query.view;
      if (view !== "active" && view !== "deleted")
        return res
          .status(400)
          .json({ error: "View must be active or deleted." });
      const sessions = await prisma.liveSession.findMany({
        where: {
          sellerId: user.sellerId,
          deletedAt: view === "deleted" ? { not: null } : null,
        },
        include: {
          products: {
            orderBy: { sortOrder: "asc" },
            include: { product: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      res.json(sessions.map(publicLiveSession));
    }),
  );
  app.post(
    "/api/seller/live-sessions",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { sellerId?: string };
      if (!user.sellerId || !(await eligibleSeller(user.sellerId)))
        return res
          .status(403)
          .json({ error: "Approved, non-suspended seller required" });
      const input = parse(liveSessionSchema, req.body);
      if (
        input.featuredProductId &&
        !input.productIds.includes(input.featuredProductId)
      )
        return res
          .status(400)
          .json({ error: "Featured product must be linked to the session" });
      await eligibleProducts(user.sellerId, input.productIds);
      const scheduledAt = input.scheduledAt
        ? new Date(input.scheduledAt)
        : null;
      if (scheduledAt && scheduledAt <= new Date())
        return res
          .status(400)
          .json({ error: "Choose a future date and time for the live show." });
      const session = await prisma.liveSession.create({
        data: {
          sellerId: user.sellerId,
          title: input.title,
          description: input.description,
          coverImageUrl: input.coverImageUrl,
          scheduledAt,
          timezone: input.timezone,
          status: scheduledAt ? "SCHEDULED" : "DRAFT",
          products: {
            create: input.productIds.map((productId, sortOrder) => ({
              productId,
              sortOrder,
              featured: productId === input.featuredProductId,
              shopFeatured: true,
              shopSortOrder: sortOrder,
              shopPinned: productId === input.featuredProductId,
            })),
          },
        },
        include: { products: true },
      });
      await audit(
        (res.locals.user as { id: string }).id,
        "LIVE_SESSION_CREATED",
        "LiveSession",
        session.id,
        { status: session.status, productCount: input.productIds.length },
      );
      res.status(201).json(publicLiveSession(session));
    }),
  );
  app.patch(
    "/api/seller/live-sessions/:id",
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
        },
        include: { products: true },
      });
      if (!session)
        return res.status(404).json({ error: "Live session not found" });
      if (!["DRAFT", "SCHEDULED"].includes(session.status))
        return res
          .status(409)
          .json({ error: "Only draft or scheduled shows can be edited." });
      const input = parse(liveSessionSchema.partial(), req.body);
      if (input.productIds) {
        if (
          input.featuredProductId &&
          !input.productIds.includes(input.featuredProductId)
        )
          return res
            .status(400)
            .json({ error: "Featured product must be linked to the session" });
        await eligibleProducts(session.sellerId, input.productIds);
      } else if (
        input.featuredProductId &&
        !session.products.some(
          (link) => link.productId === input.featuredProductId,
        )
      )
        return res
          .status(400)
          .json({ error: "Featured product must be linked to the session" });
      const scheduledAt =
        input.scheduledAt === undefined
          ? undefined
          : input.scheduledAt
            ? new Date(input.scheduledAt)
            : null;
      if (scheduledAt && scheduledAt <= new Date())
        return res
          .status(400)
          .json({ error: "Choose a future date and time for the live show." });
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.liveSession.updateMany({
          where: {
            id: session.id,
            sellerId: session.sellerId,
            status: session.status,
            deletedAt: null,
          },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.coverImageUrl !== undefined
              ? { coverImageUrl: input.coverImageUrl }
              : {}),
            ...(scheduledAt !== undefined
              ? {
                  scheduledAt,
                  status: scheduledAt
                    ? ("SCHEDULED" as const)
                    : ("DRAFT" as const),
                }
              : {}),
            ...(input.timezone !== undefined
              ? { timezone: input.timezone }
              : {}),
          },
        });
        if (!changed.count) return null;
        if (input.productIds) {
          await syncLiveShopProducts(
            tx,
            session.id,
            input.productIds,
            input.featuredProductId,
          );
        }
        return tx.liveSession.findUnique({
          where: { id: session.id },
          include: {
            products: {
              orderBy: { sortOrder: "asc" },
              include: { product: true },
            },
          },
        });
      });
      if (!updated)
        return res.status(409).json({
          error: "Show status changed while saving; refresh and retry.",
        });
      await audit(
        (res.locals.user as { id: string }).id,
        "LIVE_SESSION_UPDATED",
        "LiveSession",
        session.id,
        {
          previousStatus: session.status,
          status: updated.status,
          productCount: input.productIds?.length ?? session.products.length,
        },
      );
      res.json(publicLiveSession(updated));
    }),
  );
  app.delete(
    "/api/seller/live-sessions/:id",
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
          deletedAt: null,
        },
        select: {
          id: true,
          status: true,
          recordingStatus: true,
          replayPublishedAt: true,
        },
      });
      if (!session)
        return res.status(404).json({ error: "Live show not found." });
      if (!canDeleteLiveShow(session.status, session.recordingStatus))
        return res.status(409).json({
          error: ["STARTING", "LIVE", "PAUSED"].includes(session.status)
            ? "End the broadcast before deleting this show."
            : "Wait for the replay recording to finish before deleting this show.",
        });
      const deletedAt = new Date();
      const changed = await prisma.liveSession.updateMany({
        where: {
          id: session.id,
          sellerId: user.sellerId,
          status: session.status,
          recordingStatus: session.recordingStatus,
          deletedAt: null,
        },
        data: {
          deletedAt,
          replayPublishedAt: null,
          ...(session.status === "SCHEDULED" ? { status: "DRAFT" } : {}),
        },
      });
      if (!changed.count)
        return res.status(409).json({
          error: "Show state changed while deleting; refresh and retry.",
        });
      await audit(user.id, "LIVE_SESSION_DELETED", "LiveSession", session.id, {
        previousStatus: session.status,
        replayWasPublished: Boolean(session.replayPublishedAt),
      });
      res.status(204).send();
    }),
  );
  app.post(
    "/api/seller/live-sessions/:id/restore",
    requireAuth,
    requireRole(Role.SELLER),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { id: string; sellerId?: string };
      if (!user.sellerId)
        return res.status(403).json({ error: "Seller scope required" });
      const id = routeParam(req.params.id);
      const changed = await prisma.liveSession.updateMany({
        where: { id, sellerId: user.sellerId, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      if (!changed.count)
        return res.status(404).json({ error: "Deleted show not found." });
      await audit(user.id, "LIVE_SESSION_RESTORED", "LiveSession", id, {});
      const session = await prisma.liveSession.findFirst({
        where: { id, sellerId: user.sellerId, deletedAt: null },
        include: {
          products: {
            orderBy: { sortOrder: "asc" },
            include: { product: true },
          },
        },
      });
      if (!session)
        return res.status(409).json({
          error:
            "Show was restored but could not be reloaded. Refresh your list.",
        });
      res.json(publicLiveSession(session));
    }),
  );
  registerSellerLiveSessionLifecycleRoutes(app);
}
