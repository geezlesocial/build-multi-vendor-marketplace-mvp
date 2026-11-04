import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import {
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaUploadStatus,
  Prisma,
  Role,
} from "@prisma/client";
import { audit, prisma, requireAuth, requireRole } from "./security.js";
import { taxonomySchema } from "./platform-domain.js";
import { catalogDefaultSuppressionKey } from "./catalog-default-suppression.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

async function assertCatalogImage(
  imageUrl: string | null | undefined,
  db: typeof prisma | Prisma.TransactionClient = prisma,
) {
  if (imageUrl == null) return;
  const match = /^\/content-media\/([A-Za-z0-9_-]{1,100})$/.exec(imageUrl);
  if (!match)
    throw fail(
      400,
      "Choose an image from the approved platform media library.",
    );
  const asset = await db.mediaAsset.findFirst({
    where: {
      id: match[1],
      storeId: null,
      purpose: MediaPurpose.PLATFORM_BRANDING,
      kind: MediaKind.IMAGE,
      uploadStatus: MediaUploadStatus.COMPLETE,
      scanStatus: MediaScanStatus.APPROVED,
    },
    select: { id: true },
  });
  if (!asset)
    throw fail(
      409,
      "Catalog images must finish upload and pass the malware scan before they can be saved.",
    );
}

async function assertCategoryDepth(
  parentId: string | null | undefined,
  categoryId?: string,
  db: typeof prisma | Prisma.TransactionClient = prisma,
) {
  const categories = await db.category.findMany({
    select: { id: true, parentId: true },
  });
  const byId = new Map(categories.map((category) => [category.id, category]));
  const children = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    children.set(category.parentId, [
      ...(children.get(category.parentId) ?? []),
      category.id,
    ]);
  }

  let parentDepth = 0;
  let currentId = parentId ?? null;
  const ancestors = new Set<string>();
  while (currentId) {
    if (currentId === categoryId || ancestors.has(currentId))
      throw fail(400, "Category parent would create a cycle");
    const current = byId.get(currentId);
    if (!current) throw fail(400, "Choose an existing parent category.");
    ancestors.add(currentId);
    parentDepth += 1;
    if (parentDepth > 3)
      throw fail(400, "Category nesting is limited to three levels");
    currentId = current.parentId;
  }

  if (!categoryId) return;
  const visit = (id: string, path: Set<string>): number => {
    if (path.has(id))
      throw fail(
        409,
        "The existing category tree contains a cycle and must be corrected before moving this category.",
      );
    const nextPath = new Set(path).add(id);
    return Math.max(
      0,
      ...(children.get(id) ?? []).map(
        (childId) => visit(childId, nextPath) + 1,
      ),
    );
  };
  if (parentDepth + 1 + visit(categoryId, new Set()) > 3)
    throw fail(
      400,
      "This move would place an existing child category beyond the three-level limit.",
    );
}

export function registerCatalogAdminRoutes(app: Express) {
  const admin = [Role.ADMIN];
  const actor = (res: Response) =>
    res.locals.user as { id: string; role: Role };

  app.get(
    "/api/admin/categories",
    requireAuth,
    requireRole(...admin),
    run(async (_req, res) =>
      res.json(
        await prisma.category.findMany({
          include: {
            parent: true,
            _count: { select: { products: true, children: true } },
          },
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        }),
      ),
    ),
  );
  app.post(
    "/api/admin/categories",
    requireAuth,
    requireRole(...admin),
    run(async (req, res) => {
      const user = actor(res);
      const input = taxonomySchema.parse(req.body);
      if (
        await prisma.slugRedirect.findUnique({
          where: { fromPath: `/category/${input.slug}` },
          select: { fromPath: true },
        })
      )
        throw fail(
          409,
          "That category URL is reserved by an existing redirect; choose a different slug.",
        );
      const created = await prisma.$transaction(
        async (tx) => {
          await assertCatalogImage(input.imageUrl, tx);
          await assertCategoryDepth(input.parentId, undefined, tx);
          return tx.category.create({ data: input });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await audit(user.id, "CATEGORY_CREATED", "Category", created.id, {
        name: created.name,
      });
      res.status(201).json(created);
    }),
  );
  app.patch(
    "/api/admin/categories/:id",
    requireAuth,
    requireRole(...admin),
    run(async (req, res) => {
      const user = actor(res);
      const input = taxonomySchema.partial().parse(req.body);
      const id = param(req.params.id);
      const updated = await prisma.$transaction(
        async (tx) => {
          const existing = await tx.category.findUnique({ where: { id } });
          if (!existing) return null;
          await assertCategoryDepth(
            Object.hasOwn(input, "parentId")
              ? input.parentId
              : existing.parentId,
            existing.id,
            tx,
          );
          await assertCatalogImage(input.imageUrl, tx);
          if (input.slug && input.slug !== existing.slug) {
            if (
              await tx.category.findFirst({
                where: { slug: input.slug, id: { not: existing.id } },
                select: { id: true },
              })
            )
              throw fail(409, "Category slug is already in use");
            if (
              await tx.slugRedirect.findUnique({
                where: { fromPath: `/category/${input.slug}` },
                select: { fromPath: true },
              })
            )
              throw fail(
                409,
                "That category URL is reserved by an existing redirect; choose a different slug.",
              );
          }
          const category = await tx.category.update({
            where: { id: existing.id },
            data: input,
          });
          if (input.slug && input.slug !== existing.slug) {
            const oldPath = `/category/${existing.slug}`;
            const nextPath = `/category/${input.slug}`;
            await tx.slugRedirect.updateMany({
              where: { destinationPath: oldPath },
              data: { destinationPath: nextPath },
            });
            await tx.slugRedirect.upsert({
              where: { fromPath: oldPath },
              update: {
                destinationPath: nextPath,
                statusCode: 301,
                createdById: user.id,
              },
              create: {
                fromPath: oldPath,
                destinationPath: nextPath,
                statusCode: 301,
                createdById: user.id,
              },
            });
          }
          return category;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (!updated)
        return res.status(404).json({ error: "Category not found" });
      await audit(user.id, "CATEGORY_UPDATED", "Category", updated.id, {
        changed: Object.keys(input),
      });
      res.json(updated);
    }),
  );
  app.delete(
    "/api/admin/categories/:id",
    requireAuth,
    requireRole(...admin),
    run(async (req, res) => {
      const user = actor(res);
      const id = param(req.params.id);
      const existing = await prisma.$transaction(
        async (tx) => {
          const category = await tx.category.findUnique({
            where: { id },
            include: {
              _count: {
                select: {
                  products: true,
                  children: true,
                  catalogFeatures: true,
                  childCategorySuggestions: true,
                  featureSuggestions: true,
                },
              },
            },
          });
          if (!category) return null;
          if (
            category._count.products ||
            category._count.children ||
            category._count.catalogFeatures ||
            category._count.childCategorySuggestions ||
            category._count.featureSuggestions
          )
            throw fail(
              409,
              "Reassign or archive referenced products, features, child categories, or suggestions before deletion",
            );
          const defaultKey = catalogDefaultSuppressionKey(
            "category",
            category.id,
          );
          if (defaultKey)
            await tx.catalogDefaultSuppression.upsert({
              where: { defaultKey },
              update: {},
              create: { defaultKey, entityKind: "category" },
            });
          await tx.slugRedirect.deleteMany({
            where: {
              OR: [
                { fromPath: `/category/${category.slug}` },
                { destinationPath: `/category/${category.slug}` },
              ],
            },
          });
          await tx.category.delete({ where: { id: category.id } });
          return category;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (!existing)
        return res.status(404).json({ error: "Category not found" });
      await audit(user.id, "CATEGORY_DELETED", "Category", existing.id);
      res.status(204).send();
    }),
  );

  app.get(
    "/api/admin/brands",
    requireAuth,
    requireRole(...admin),
    run(async (_req, res) =>
      res.json(
        await prisma.brand.findMany({
          include: { _count: { select: { products: true } } },
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        }),
      ),
    ),
  );
  app.post(
    "/api/admin/brands",
    requireAuth,
    requireRole(...admin),
    run(async (req, res) => {
      const user = actor(res);
      const input = taxonomySchema.omit({ parentId: true }).parse(req.body);
      const created = await prisma.$transaction(
        async (tx) => {
          await assertCatalogImage(input.imageUrl, tx);
          return tx.brand.create({ data: input });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await audit(user.id, "BRAND_CREATED", "Brand", created.id, {
        name: created.name,
      });
      res.status(201).json(created);
    }),
  );
  app.patch(
    "/api/admin/brands/:id",
    requireAuth,
    requireRole(...admin),
    run(async (req, res) => {
      const user = actor(res);
      const input = taxonomySchema
        .omit({ parentId: true })
        .partial()
        .parse(req.body);
      const existing = await prisma.brand.findUnique({
        where: { id: param(req.params.id) },
      });
      if (!existing) return res.status(404).json({ error: "Brand not found" });
      const conflict = input.slug
        ? await prisma.brand.findFirst({
            where: { slug: input.slug, id: { not: existing.id } },
          })
        : null;
      if (conflict) throw fail(409, "Brand slug is already in use");
      const updated = await prisma.$transaction(
        async (tx) => {
          await assertCatalogImage(input.imageUrl, tx);
          return tx.brand.update({ where: { id: existing.id }, data: input });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await audit(user.id, "BRAND_UPDATED", "Brand", updated.id, {
        changed: Object.keys(input),
      });
      res.json(updated);
    }),
  );
  app.delete(
    "/api/admin/brands/:id",
    requireAuth,
    requireRole(...admin),
    run(async (req, res) => {
      const user = actor(res);
      const id = param(req.params.id);
      const existing = await prisma.$transaction(
        async (tx) => {
          const brand = await tx.brand.findUnique({
            where: { id },
            include: { _count: { select: { products: true } } },
          });
          if (!brand) return null;
          if (brand._count.products)
            throw fail(
              409,
              "Reassign or archive products before deleting a referenced brand",
            );
          const defaultKey = catalogDefaultSuppressionKey("brand", brand.id);
          if (defaultKey)
            await tx.catalogDefaultSuppression.upsert({
              where: { defaultKey },
              update: {},
              create: { defaultKey, entityKind: "brand" },
            });
          await tx.brand.delete({ where: { id: brand.id } });
          return brand;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (!existing) return res.status(404).json({ error: "Brand not found" });
      await audit(user.id, "BRAND_DELETED", "Brand", existing.id);
      res.status(204).send();
    }),
  );
}
