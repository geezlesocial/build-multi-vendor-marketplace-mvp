import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { Prisma, Role, StoreThemePreset } from "@prisma/client";
import { z } from "zod";
import { prisma, requireAuth, requireRole } from "./security.js";
import { authorizedBrandingStore } from "./store-branding-access.js";
import {
  ALL_THEME_PRESETS,
  defaultThemeCatalogConfig,
  publicStoreThemeCatalog,
  readThemeCatalogConfig,
  resolveStoreThemeAccess,
  storeThemeCatalog,
  themeCatalogConfigSchema,
} from "./store-theme-domain.js";
import { storeThemeSchema } from "./platform-domain.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
const actor = (res: Response) =>
  res.locals.user as { id: string; role: Role; sellerId?: string };
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const catalogSaveSchema = z
  .object({
    config: themeCatalogConfigSchema,
    expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
const restoreSchema = z
  .object({ expectedVersion: z.number().int().min(0) })
  .strict();

export function registerStoreThemeRoutes(app: Express) {
  app.get(
    "/api/store-themes/catalog",
    run(async (_req, res) => {
      const config = await readThemeCatalogConfig();
      res.setHeader("Cache-Control", "no-store");
      res.json({ themes: await publicStoreThemeCatalog(), config });
    }),
  );

  app.get(
    "/api/seller/store-theme/revisions",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER, Role.ADMIN),
    run(async (_req, res) => {
      const current = actor(res);
      const store = await authorizedBrandingStore(current);
      if (!store)
        throw fail(
          403,
          "Approved Store owner or authorized branding staff required.",
        );
      const [revisions, access] = await Promise.all([
        prisma.storeThemeRevision.findMany({
          where: { storeId: store.id },
          orderBy: { version: "desc" },
          take: 50,
          select: {
            id: true,
            version: true,
            themeJson: true,
            changeNote: true,
            createdAt: true,
            editor: { select: { name: true, email: true } },
          },
        }),
        resolveStoreThemeAccess(prisma, store.id),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        revisions,
        latestVersion: revisions[0]?.version ?? 0,
        access,
      });
    }),
  );

  app.post(
    "/api/seller/store-theme/revisions/:revisionId/restore",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER, Role.ADMIN),
    run(async (req, res) => {
      const currentActor = actor(res);
      const store = await authorizedBrandingStore(currentActor);
      if (!store)
        throw fail(
          403,
          "Approved Store owner or authorized branding staff required.",
        );
      const revisionId = param(req.params.revisionId);
      const input = restoreSchema.parse(req.body);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const [revision, latest] = await Promise.all([
          tx.storeThemeRevision.findFirst({
            where: { id: revisionId, storeId: store.id },
          }),
          tx.storeThemeRevision.findFirst({
            where: { storeId: store.id },
            orderBy: { version: "desc" },
            select: { version: true },
          }),
        ]);
        if (!revision)
          throw fail(404, "Theme revision not found for this Store.");
        const latestVersion = latest?.version ?? 0;
        if (input.expectedVersion !== latestVersion)
          return { conflict: true as const, latestVersion };
        const restoredTheme = storeThemeSchema.parse(revision.themeJson);
        const access = await resolveStoreThemeAccess(tx, store.id);
        if (!access.allowedThemes.includes(restoredTheme.themePreset))
          return { denied: true as const, latestVersion };
        await tx.store.update({
          where: { id: store.id },
          data: { themeDraftJson: json(restoredTheme) },
        });
        const newRevision = await tx.storeThemeRevision.create({
          data: {
            storeId: store.id,
            version: latestVersion + 1,
            themeJson: json(restoredTheme),
            editorId: currentActor.id,
            changeNote: `Restored revision ${revision.version}`,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: currentActor.id,
            action: "STORE_THEME_REVISION_RESTORED",
            entity: "Store",
            entityId: store.id,
            metadata: json({
              sourceRevision: revision.version,
              newVersion: newRevision.version,
              themePreset: restoredTheme.themePreset,
            }),
          },
        });
        return { revision: newRevision, latestVersion: newRevision.version };
      });
      if ("conflict" in result)
        return res.status(409).json({
          code: "THEME_VERSION_CONFLICT",
          error:
            "The Store theme changed in another session. Reload before restoring.",
          currentVersion: result.latestVersion,
        });
      if ("denied" in result)
        return res.status(409).json({
          code: "PLAN_ENTITLEMENT_REQUIRED",
          entitlement: "themePreset",
          upgradeRequired: true,
          error:
            "This revision uses a paid theme. Restore it after an eligible paid subscription is active.",
          planUrl: "/seller/plan",
        });
      res.json({ draftVersion: result.latestVersion });
    }),
  );

  app.get(
    "/api/admin/store-themes",
    requireAuth,
    requireRole(Role.ADMIN),
    run(async (_req, res) => {
      const [settings, stores, history] = await Promise.all([
        prisma.marketplaceSettings.findUnique({
          where: { id: "default" },
          select: { themeCatalogJson: true, updatedAt: true },
        }),
        prisma.store.findMany({
          where: { seller: { status: "APPROVED" } },
          orderBy: { name: "asc" },
          take: 1000,
          select: {
            id: true,
            name: true,
            slug: true,
            isPlatformStore: true,
            themePublishedJson: true,
            themePublishedAt: true,
          },
        }),
        prisma.auditLog.findMany({
          where: { action: "STORE_THEME_CATALOG_UPDATED" },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: {
            id: true,
            createdAt: true,
            metadata: true,
            actor: { select: { name: true, email: true } },
          },
        }),
      ]);
      const config = themeCatalogConfigSchema.safeParse(
        settings?.themeCatalogJson,
      );
      const resolvedConfig = config.success
        ? config.data
        : defaultThemeCatalogConfig;
      const usage = Object.fromEntries(
        ALL_THEME_PRESETS.map((preset) => [preset, 0]),
      ) as Record<StoreThemePreset, number>;
      for (const store of stores) {
        if (
          !store.themePublishedJson ||
          typeof store.themePublishedJson !== "object" ||
          Array.isArray(store.themePublishedJson)
        )
          continue;
        const preset = (store.themePublishedJson as { themePreset?: unknown })
          .themePreset;
        if (typeof preset === "string" && Object.hasOwn(usage, preset))
          usage[preset as StoreThemePreset] += 1;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        themes: storeThemeCatalog(resolvedConfig),
        config: resolvedConfig,
        configUpdatedAt: settings?.updatedAt.toISOString() ?? null,
        usage,
        stores: stores.map((store) => ({
          id: store.id,
          name: store.name,
          slug: store.slug,
          isPlatformStore: store.isPlatformStore,
          themePreset:
            store.themePublishedJson &&
            typeof store.themePublishedJson === "object" &&
            !Array.isArray(store.themePublishedJson)
              ? ((store.themePublishedJson as { themePreset?: unknown })
                  .themePreset ?? null)
              : null,
          publishedAt: store.themePublishedAt,
        })),
        history,
      });
    }),
  );

  app.put(
    "/api/admin/store-themes/catalog",
    requireAuth,
    requireRole(Role.ADMIN),
    run(async (req, res) => {
      const currentActor = actor(res);
      const input = catalogSaveSchema.parse(req.body);
      const result = await prisma.$transaction(async (tx) => {
        await tx.marketplaceSettings.upsert({
          where: { id: "default" },
          update: {},
          create: { id: "default" },
        });
        await tx.$queryRaw`SELECT "id" FROM "MarketplaceSettings" WHERE "id" = 'default' FOR UPDATE`;
        const current = await tx.marketplaceSettings.findUniqueOrThrow({
          where: { id: "default" },
        });
        const expectedChanged =
          input.expectedUpdatedAt === null
            ? current.themeCatalogJson !== null
            : current.updatedAt.toISOString() !==
              new Date(input.expectedUpdatedAt).toISOString();
        if (expectedChanged)
          return { conflict: true as const, updatedAt: current.updatedAt };
        const saved = await tx.marketplaceSettings.update({
          where: { id: "default" },
          data: { themeCatalogJson: json(input.config) },
        });
        await tx.auditLog.create({
          data: {
            actorId: currentActor.id,
            action: "STORE_THEME_CATALOG_UPDATED",
            entity: "MarketplaceSettings",
            entityId: "default",
            metadata: json({
              reason: input.reason,
              config: input.config,
              updatedAt: saved.updatedAt.toISOString(),
            }),
          },
        });
        return { saved };
      });
      if ("conflict" in result && result.conflict)
        return res.status(409).json({
          code: "THEME_CATALOG_CONFLICT",
          error:
            "Platform settings changed in another session. Reload before saving.",
          updatedAt: result.updatedAt.toISOString(),
        });
      res.json({
        config: input.config,
        configUpdatedAt: result.saved.updatedAt.toISOString(),
      });
    }),
  );
}
