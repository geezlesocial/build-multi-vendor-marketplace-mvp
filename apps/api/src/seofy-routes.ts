import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import {
  Prisma,
  ProductStatus,
  Role,
  SeofyAuditAiStatus,
  SeofyAuditStatus,
  SeofyAuditTargetType,
  SeofySuggestionField,
  SeofySuggestionStatus,
  SellerStatus,
} from "@prisma/client";
import { z } from "zod";
import {
  getJimaRuntimeConfig,
  JimaUserRateLimiter,
  requestJimaCompletion,
  withJimaRuntimeSlot,
} from "./jima-routes.js";
import { prisma, requireAuth, requireRole } from "./security.js";
import {
  buildFallbackSeofySuggestions,
  buildSeofyFindings,
  parseJimaSeofySuggestions,
  seofyJimaMessages,
} from "./seofy-domain.js";
import {
  activePaidSeofyEntitlement,
  approvedSellerStore,
  auditTargetForSeller,
  LEARNING_MIN_USERS,
  privacySafeLearning,
  targetRecord,
} from "./seofy-service.js";
import { registerSeofySupportRoutes } from "./seofy-support-routes.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) =>
  res.locals.user as { id: string; role: Role; sellerId?: string };
const fail = (
  statusCode: number,
  message: string,
  extra?: Record<string, unknown>,
) => Object.assign(new Error(message), { statusCode, ...extra });
const auditRateLimiter = new JimaUserRateLimiter(4, 60_000);

const createAuditSchema = z
  .object({
    targetType: z.nativeEnum(SeofyAuditTargetType),
    targetId: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.targetType === SeofyAuditTargetType.STORE
        ? value.targetId === undefined
        : Boolean(value.targetId),
    "A product ID is required for product audits.",
  );
const applySchema = z
  .object({
    suggestionIds: z.array(z.string().trim().min(1).max(80)).min(1).max(2),
  })
  .strict()
  .refine(
    (value) => new Set(value.suggestionIds).size === value.suggestionIds.length,
    "Choose each suggestion only once.",
  );
const learningSchema = z.object({ enabled: z.boolean() }).strict();
export function registerSeofyRoutes(app: Express) {
  registerSeofySupportRoutes(app);

  app.get(
    "/api/seller/seofy",
    requireAuth,
    requireRole(Role.SELLER),
    run(async (_req, res) => {
      const user = actor(res);
      if (!user.sellerId) throw fail(403, "Seller scope required.");
      const { store, sellerId } = await approvedSellerStore(user.sellerId);
      const [eligible, products, audits, jimaConfig] = await Promise.all([
        activePaidSeofyEntitlement(prisma, store.id),
        prisma.product.findMany({
          where: { sellerId, status: ProductStatus.APPROVED },
          orderBy: { updatedAt: "desc" },
          take: 50,
          select: {
            id: true,
            name: true,
            slug: true,
            seoTitle: true,
            seoDescription: true,
            updatedAt: true,
          },
        }),
        prisma.seofyAudit.findMany({
          where: { storeId: store.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { suggestions: { orderBy: { createdAt: "asc" } } },
        }),
        getJimaRuntimeConfig(),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        store: { id: store.id, name: store.name, slug: store.slug },
        entitlement: {
          enabled: eligible,
          learningOptIn: store.seofyLearningEnabled,
        },
        learningAvailable:
          jimaConfig.enabled && jimaConfig.personalizationEnabled,
        products,
        audits,
      });
    }),
  );

  app.patch(
    "/api/seller/seofy/learning",
    requireAuth,
    requireRole(Role.SELLER),
    run(async (req, res) => {
      const user = actor(res);
      if (!user.sellerId) throw fail(403, "Seller scope required.");
      const input = learningSchema.parse(req.body);
      const { store, sellerId } = await approvedSellerStore(user.sellerId);
      if (!(await activePaidSeofyEntitlement(prisma, store.id)))
        throw fail(
          403,
          "SEO-FY learning controls require an active paid Store subscription.",
          {
            code: "PLAN_FEATURE_NOT_ENABLED",
            entitlement: "seofyEnabled",
            planUrl: "/seller/plan",
          },
        );
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} AND "sellerId" = ${sellerId} FOR UPDATE`;
        if (
          !(await tx.seller.findFirst({
            where: { id: sellerId, status: SellerStatus.APPROVED },
            select: { id: true },
          }))
        )
          throw fail(403, "An approved seller Store is required.");
        if (!(await activePaidSeofyEntitlement(tx, store.id)))
          throw fail(403, "SEO-FY requires an active paid Store subscription.");
        const value = await tx.store.update({
          where: { id: store.id },
          data: { seofyLearningEnabled: input.enabled },
          select: { seofyLearningEnabled: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: input.enabled
              ? "SEOFY_AGGREGATE_LEARNING_ENABLED"
              : "SEOFY_AGGREGATE_LEARNING_DISABLED",
            entity: "Store",
            entityId: store.id,
            metadata: {
              consentedSignalsOnly: true,
              minimumConsentingUsers: LEARNING_MIN_USERS,
            },
          },
        });
        return value;
      });
      res.json({
        learningOptIn: updated.seofyLearningEnabled,
        message: updated.seofyLearningEnabled
          ? "Only privacy-safe aggregates from buyers who opted into personalization may inform future local audits."
          : "Aggregate learning is off. Existing buyer personalization preferences are unchanged.",
      });
    }),
  );

  app.post(
    "/api/seller/seofy/audits",
    requireAuth,
    requireRole(Role.SELLER),
    run(async (req, res) => {
      const user = actor(res);
      if (!user.sellerId) throw fail(403, "Seller scope required.");
      const input = createAuditSchema.parse(req.body);
      const { store, sellerId } = await approvedSellerStore(user.sellerId);
      if (!(await activePaidSeofyEntitlement(prisma, store.id)))
        throw fail(
          403,
          "SEO-FY audits require an active paid Store subscription.",
          {
            code: "PLAN_FEATURE_NOT_ENABLED",
            entitlement: "seofyEnabled",
            planUrl: "/seller/plan",
          },
        );
      const rate = auditRateLimiter.consume(`seofy:${user.id}`);
      if (!rate.allowed)
        throw fail(
          429,
          `SEO-FY is rate limited. Try again in ${rate.retryAfterSeconds} seconds.`,
        );
      const target = await auditTargetForSeller(
        sellerId,
        store.id,
        input.targetType,
        input.targetId,
      );
      const findings = buildSeofyFindings(target);
      const config = await getJimaRuntimeConfig();
      const aggregateLearning = await privacySafeLearning(
        store.id,
        sellerId,
        store.seofyLearningEnabled &&
          config.enabled &&
          config.personalizationEnabled,
      );
      let aiStatus: SeofyAuditAiStatus = SeofyAuditAiStatus.NOT_CONFIGURED;
      let suggestions = buildFallbackSeofySuggestions(target);
      if (config.enabled) {
        try {
          const runtimeResult = await withJimaRuntimeSlot(() =>
            requestJimaCompletion(
              {
                ...config,
                maxTokens: Math.min(800, Math.max(config.maxTokens, 500)),
              },
              seofyJimaMessages(target, findings, aggregateLearning),
              20_000,
            ),
          );
          if (!runtimeResult.accepted) aiStatus = SeofyAuditAiStatus.BUSY;
          else {
            const parsed = parseJimaSeofySuggestions(runtimeResult.value);
            if (parsed === null) aiStatus = SeofyAuditAiStatus.INVALID_RESPONSE;
            else {
              aiStatus = SeofyAuditAiStatus.USED;
              const changed = parsed.filter(
                (suggestion) =>
                  suggestion.recommendedValue !==
                  (suggestion.field === SeofySuggestionField.SEO_TITLE
                    ? target.seoTitle
                    : target.seoDescription),
              );
              if (changed.length) suggestions = changed;
            }
          }
        } catch {
          aiStatus = SeofyAuditAiStatus.UNAVAILABLE;
        }
      }
      const audit = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} AND "sellerId" = ${sellerId} FOR UPDATE`;
        if (!(await activePaidSeofyEntitlement(tx, store.id)))
          throw fail(403, "SEO-FY requires an active paid Store subscription.");
        const current = await targetRecord(tx, {
          kind: input.targetType,
          targetId: target.targetId,
          storeId: store.id,
          sellerId,
        });
        if (!current || current.sourceHash !== target.sourceHash)
          throw fail(
            409,
            "Store or product details changed during the audit. Refresh and run a new audit.",
            { code: "SEO_FY_SOURCE_CHANGED" },
          );
        const created = await tx.seofyAudit.create({
          data: {
            storeId: store.id,
            createdById: user.id,
            targetType: input.targetType,
            targetId: target.targetId,
            sourceHash: target.sourceHash,
            findings: JSON.parse(
              JSON.stringify(findings),
            ) as Prisma.InputJsonValue,
            aiStatus,
            learningUsed: aggregateLearning.length > 0,
            suggestions: {
              create: suggestions.map((suggestion) => ({
                field: suggestion.field as SeofySuggestionField,
                currentValue:
                  suggestion.field === "SEO_TITLE"
                    ? target.seoTitle
                    : target.seoDescription,
                recommendedValue: suggestion.recommendedValue,
                rationale: suggestion.rationale,
                evidence: suggestion.evidence,
              })),
            },
          },
          include: { suggestions: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: "SEOFY_AUDIT_GENERATED",
            entity: "SeofyAudit",
            entityId: created.id,
            metadata: {
              targetType: created.targetType,
              aiStatus: created.aiStatus,
              learningUsed: created.learningUsed,
              findingCount: findings.length,
              suggestionCount: suggestions.length,
            },
          },
        });
        return created;
      });
      res.status(201).json(audit);
    }),
  );

  app.post(
    "/api/seller/seofy/audits/:auditId/apply",
    requireAuth,
    requireRole(Role.SELLER),
    run(async (req, res) => {
      const user = actor(res);
      if (!user.sellerId) throw fail(403, "Seller scope required.");
      const auditId = Array.isArray(req.params.auditId)
        ? (req.params.auditId[0] ?? "")
        : (req.params.auditId ?? "");
      const input = applySchema.parse(req.body);
      const { store, sellerId } = await approvedSellerStore(user.sellerId);
      if (!(await activePaidSeofyEntitlement(prisma, store.id)))
        throw fail(
          403,
          "Applying SEO-FY changes requires an active paid Store subscription.",
          {
            code: "PLAN_FEATURE_NOT_ENABLED",
            entitlement: "seofyEnabled",
            planUrl: "/seller/plan",
          },
        );
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} AND "sellerId" = ${sellerId} FOR UPDATE`;
        if (!(await activePaidSeofyEntitlement(tx, store.id)))
          throw fail(403, "SEO-FY requires an active paid Store subscription.");
        const audit = await tx.seofyAudit.findFirst({
          where: { id: auditId, storeId: store.id },
          include: { suggestions: true },
        });
        if (!audit) return { kind: "missing" as const };
        const selected = audit.suggestions.filter((suggestion) =>
          input.suggestionIds.includes(suggestion.id),
        );
        if (selected.length !== input.suggestionIds.length)
          return { kind: "missing" as const };
        if (
          selected.some(
            (suggestion) => suggestion.status !== SeofySuggestionStatus.PENDING,
          ) ||
          audit.status === SeofyAuditStatus.STALE
        )
          return { kind: "conflict" as const };
        if (audit.targetType === SeofyAuditTargetType.PRODUCT)
          await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${audit.targetId} AND "sellerId" = ${sellerId} FOR UPDATE`;
        const target = await targetRecord(tx, {
          kind: audit.targetType,
          targetId: audit.targetId,
          storeId: store.id,
          sellerId,
        });
        if (!target || target.sourceHash !== audit.sourceHash) {
          await tx.seofySuggestion.updateMany({
            where: { auditId: audit.id, status: SeofySuggestionStatus.PENDING },
            data: { status: SeofySuggestionStatus.STALE },
          });
          await tx.seofyAudit.update({
            where: { id: audit.id },
            data: { status: SeofyAuditStatus.STALE },
          });
          return { kind: "stale" as const };
        }
        const fieldMap: Record<
          SeofySuggestionField,
          "seoTitle" | "seoDescription"
        > = { SEO_TITLE: "seoTitle", SEO_DESCRIPTION: "seoDescription" };
        for (const suggestion of selected) {
          const field = fieldMap[suggestion.field];
          if (target[field] !== suggestion.currentValue) {
            await tx.seofySuggestion.updateMany({
              where: {
                auditId: audit.id,
                status: SeofySuggestionStatus.PENDING,
              },
              data: { status: SeofySuggestionStatus.STALE },
            });
            await tx.seofyAudit.update({
              where: { id: audit.id },
              data: { status: SeofyAuditStatus.STALE },
            });
            return { kind: "stale" as const };
          }
          const changed =
            audit.targetType === SeofyAuditTargetType.STORE
              ? await tx.store.updateMany({
                  where: {
                    id: store.id,
                    sellerId,
                    [field]: suggestion.currentValue,
                  },
                  data: { [field]: suggestion.recommendedValue },
                })
              : await tx.product.updateMany({
                  where: {
                    id: audit.targetId,
                    sellerId,
                    status: ProductStatus.APPROVED,
                    [field]: suggestion.currentValue,
                  },
                  data: { [field]: suggestion.recommendedValue },
                });
          if (changed.count !== 1)
            throw fail(
              409,
              "SEO metadata changed while applying. Run a fresh audit before retrying.",
              { code: "SEO_FY_CONCURRENCY_CONFLICT" },
            );
        }
        await tx.seofySuggestion.updateMany({
          where: {
            id: { in: input.suggestionIds },
            auditId: audit.id,
            status: SeofySuggestionStatus.PENDING,
          },
          data: {
            status: SeofySuggestionStatus.APPLIED,
            appliedAt: new Date(),
          },
        });
        const pending = audit.suggestions.filter(
          (suggestion) =>
            suggestion.status === SeofySuggestionStatus.PENDING &&
            !input.suggestionIds.includes(suggestion.id),
        ).length;
        const status = pending
          ? SeofyAuditStatus.PARTIALLY_APPLIED
          : SeofyAuditStatus.APPLIED;
        await tx.seofyAudit.update({
          where: { id: audit.id },
          data: { status, ...(pending ? {} : { appliedAt: new Date() }) },
        });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: "SEOFY_SUGGESTIONS_APPLIED",
            entity: "SeofyAudit",
            entityId: audit.id,
            metadata: {
              targetType: audit.targetType,
              appliedCount: selected.length,
              fields: selected.map((suggestion) => suggestion.field),
            },
          },
        });
        return {
          kind: "applied" as const,
          appliedCount: selected.length,
          status,
        };
      });
      if (result.kind === "missing")
        return res
          .status(404)
          .json({ error: "SEO-FY audit or suggestions not found." });
      if (result.kind === "conflict")
        return res.status(409).json({
          error:
            "These suggestions were already applied or are no longer available.",
        });
      if (result.kind === "stale")
        return res.status(409).json({
          error:
            "Store or product details changed after this report. The suggestions were marked stale; run a fresh audit.",
        });
      res.json({
        appliedCount: result.appliedCount,
        status: result.status,
        message:
          "Approved SEO metadata was saved. Product price, inventory, listing status, slug, and checkout settings were not changed.",
      });
    }),
  );
}
