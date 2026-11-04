import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { Role, SeofyAuditAiStatus, SellerStatus } from "@prisma/client";
import { prisma, requireAuth, requireRole } from "./security.js";
import { AUDIT_FRESHNESS_DAYS } from "./seofy-service.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

export function registerSeofySupportRoutes(app: Express) {
  app.get(
    "/api/public/seo/stores/:slug",
    run(async (req, res) => {
      const slug = Array.isArray(req.params.slug)
        ? (req.params.slug[0] ?? "")
        : (req.params.slug ?? "");
      const store = await prisma.store.findFirst({
        where: {
          slug,
          isPlatformStore: false,
          seller: { status: SellerStatus.APPROVED },
        },
        select: { seoTitle: true, seoDescription: true },
      });
      if (!store) return res.status(404).json({ error: "Store not found." });
      res.setHeader("Cache-Control", "no-store");
      res.json(store);
    }),
  );

  app.get(
    "/api/admin/seofy/metrics",
    requireAuth,
    requireRole(Role.ADMIN),
    run(async (_req, res) => {
      const since = new Date(Date.now() - AUDIT_FRESHNESS_DAYS * 86_400_000);
      const [audits, aiUsed, appliedSuggestions, optedInStores, lastAudit] =
        await Promise.all([
          prisma.seofyAudit.count({ where: { createdAt: { gte: since } } }),
          prisma.seofyAudit.count({
            where: {
              createdAt: { gte: since },
              aiStatus: SeofyAuditAiStatus.USED,
            },
          }),
          prisma.seofySuggestion.count({
            where: {
              createdAt: { gte: since },
              status: "APPLIED",
            },
          }),
          prisma.store.count({
            where: { isPlatformStore: false, seofyLearningEnabled: true },
          }),
          prisma.seofyAudit.findFirst({
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
        ]);
      res.json({
        windowDays: AUDIT_FRESHNESS_DAYS,
        audits,
        localAiAudits: aiUsed,
        appliedSuggestions,
        optedInStores,
        lastAuditAt: lastAudit?.createdAt ?? null,
        sellerDetailsExposed: false,
      });
    }),
  );
}
