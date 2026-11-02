import type { Express } from "express";
import express from "express";
import {
  ApprovalPolicy,
  Prisma,
  ProductStatus,
  Role,
  SellerStatus,
} from "@prisma/client";
import { env } from "./config.js";
import { prisma, requireAuth, requireRole } from "./security.js";
import { productSchema } from "./validation.js";
import { validateProductCatalogSelection } from "./catalog-routes.js";
import {
  effectiveStorePlan,
  isAtLimit,
  storeEntitlements,
} from "./store-plan-domain.js";
import { isValidSalePrice } from "./product-pricing.js";
import { wholesaleConfigurationError } from "./wholesale-domain.js";

const asyncRoute =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export function registerProductRoutes(app: Express) {
  app.get(
    "/api/products",
    asyncRoute(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const category =
        typeof req.query.category === "string" ? req.query.category : undefined;
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(
        50,
        Math.max(1, Number(req.query.pageSize ?? 12)),
      );
      const where: Prisma.ProductWhereInput = {
        status: ProductStatus.APPROVED,
        AND: [
          {
            OR: [
              { sellerId: null },
              { seller: { status: SellerStatus.APPROVED } },
            ],
          },
          ...(q
            ? [
                {
                  OR: [
                    { name: { contains: q, mode: "insensitive" as const } },
                    {
                      description: {
                        contains: q,
                        mode: "insensitive" as const,
                      },
                    },
                  ],
                },
              ]
            : []),
          ...(category ? [{ category: { slug: category } }] : []),
        ],
      };
      const [items, total] = await Promise.all([
        prisma.product.findMany({
          where,
          include: {
            seller: { include: { store: true } },
            category: true,
            brand: true,
            productType: true,
            featureAssignments: { include: { feature: true } },
            inventory: true,
            images: true,
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.product.count({ where }),
      ]);
      res.json({
        items: items.map((product) => ({
          ...product,
          availableStock: product.inventory?.quantity ?? 0,
        })),
        page,
        pageSize,
        total,
      });
    }),
  );

  app.get(
    "/api/products/:id",
    asyncRoute(async (req, res) => {
      const product = await prisma.product.findFirst({
        where: {
          id: routeParam(req.params.id),
          status: ProductStatus.APPROVED,
          OR: [
            { sellerId: null },
            { seller: { status: SellerStatus.APPROVED } },
          ],
        },
        include: {
          seller: { include: { store: true } },
          category: true,
          brand: true,
          productType: true,
          featureAssignments: { include: { feature: true } },
          inventory: true,
          images: true,
          mediaAttachments: {
            where: {
              mediaAsset: { uploadStatus: "COMPLETE", scanStatus: "APPROVED" },
            },
            orderBy: { position: "asc" },
            include: {
              mediaAsset: {
                select: {
                  id: true,
                  kind: true,
                  detectedMime: true,
                  safeName: true,
                  originalName: true,
                },
              },
            },
          },
        },
      });
      if (!product) return res.status(404).json({ error: "Product not found" });
      const mediaAttachments = product.mediaAttachments.map(
        ({ mediaAsset, ...attachment }) => ({
          ...attachment,
          kind: mediaAsset.kind,
          detectedMime: mediaAsset.detectedMime,
          originalName: mediaAsset.originalName,
          url: `/content-media/${encodeURIComponent(mediaAsset.id)}`,
        }),
      );
      res.json({
        ...product,
        features: product.featureAssignments.map((item) => item.feature),
        mediaAttachments,
        availableStock: product.inventory?.quantity ?? 0,
      });
    }),
  );

  app.get(
    "/api/categories",
    asyncRoute(async (_req, res) =>
      res.json(
        await prisma.category.findMany({
          where: { status: "ACTIVE" },
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        }),
      ),
    ),
  );

  app.post(
    "/api/products",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as {
        id: string;
        role: Role;
        sellerId?: string;
      };
      const input = productSchema.parse(req.body);
      if (!isValidSalePrice(input.priceMinor, input.salePriceMinor))
        return res
          .status(400)
          .json({ error: "Sale price must be lower than the regular price." });
      const wholesaleEnabled = input.wholesaleEnabled ?? false;
      const wholesaleMinQuantity = wholesaleEnabled
        ? (input.wholesaleMinQuantity ?? null)
        : null;
      const wholesaleMaxQuantity = wholesaleEnabled
        ? (input.wholesaleMaxQuantity ?? null)
        : null;
      const wholesaleError = wholesaleConfigurationError({
        wholesaleEnabled,
        wholesaleMinQuantity,
        wholesaleMaxQuantity,
      });
      if (wholesaleError)
        return res.status(400).json({
          error: wholesaleError,
          code: "WHOLESALE_CONFIGURATION_INVALID",
        });
      const scopedSellerId =
        user.role === Role.ADMIN
          ? (
              await prisma.store.findFirst({
                where: { isPlatformStore: true },
                select: { sellerId: true },
              })
            )?.sellerId
          : user.sellerId;
      const seller = scopedSellerId
        ? await prisma.seller.findFirst({
            where: { id: scopedSellerId, status: SellerStatus.APPROVED },
            include: { store: true },
          })
        : null;
      if (user.role !== Role.ADMIN && !seller)
        return res.status(403).json({ error: "Approved seller required" });
      const settings = await prisma.marketplaceSettings.findUnique({
        where: { id: "default" },
      });
      if (seller && user.role !== Role.ADMIN && !settings?.multiVendorEnabled)
        return res.status(409).json({ error: "Multi-vendor mode is disabled" });
      const productData = {
        sellerId: seller?.id,
        name: input.name,
        slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`,
        description: input.description,
        priceMinor: input.priceMinor,
        salePriceMinor: input.salePriceMinor ?? null,
        color: input.color ?? null,
        currency: seller?.store?.baseCurrency ?? env.CURRENCY,
        barcode: input.barcode,
        wholesaleEnabled,
        wholesaleMinQuantity,
        wholesaleMaxQuantity,
        status:
          user.role === Role.ADMIN ||
          settings?.productApprovalPolicy === ApprovalPolicy.AUTOMATIC
            ? ProductStatus.APPROVED
            : ProductStatus.PENDING,
        inventory: { create: { quantity: input.stock } },
      };
      if (seller) {
        const store = seller.store ? { id: seller.store.id } : null;
        if (!store)
          return res
            .status(409)
            .json({ error: "Complete Store setup before adding products." });
        const result = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
          const effective = await effectiveStorePlan(tx, store.id);
          const entitlements = await storeEntitlements(
            tx,
            store.id,
            effective.version,
          );
          const usage = await tx.product.count({
            where: {
              sellerId: seller.id,
              status: { not: ProductStatus.ARCHIVED },
            },
          });
          if (isAtLimit(usage, entitlements.productLimit))
            return {
              limitReached: true as const,
              usage,
              limit: entitlements.productLimit,
            };
          const taxonomy = await validateProductCatalogSelection(input, tx);
          return {
            product: await tx.product.create({
              data: {
                ...productData,
                categoryId: taxonomy.categoryId,
                brandId: taxonomy.brandId,
                productTypeId: taxonomy.productTypeId,
                featureAssignments: {
                  create: taxonomy.featureIds.map((featureId) => ({
                    featureId,
                  })),
                },
              },
            }),
          };
        });
        if ("limitReached" in result)
          return res.status(409).json({
            code: "PLAN_LIMIT_REACHED",
            entitlement: "productLimit",
            upgradeRequired: true,
            error:
              "Your Store has reached its product limit. Archive a listing or ask an administrator about a plan change.",
            usage: result.usage,
            limit: result.limit,
            planUrl: "/seller/plan",
          });
        res.status(201).json(result.product);
        return;
      }
      const product = await prisma.$transaction(async (tx) => {
        const taxonomy = await validateProductCatalogSelection(input, tx);
        return tx.product.create({
          data: {
            ...productData,
            categoryId: taxonomy.categoryId,
            brandId: taxonomy.brandId,
            productTypeId: taxonomy.productTypeId,
            featureAssignments: {
              create: taxonomy.featureIds.map((featureId) => ({ featureId })),
            },
          },
        });
      });
      res.status(201).json(product);
    }),
  );

  app.patch(
    "/api/products/:id",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { role: Role; sellerId?: string };
      const input = productSchema.partial().parse(req.body);
      const existing = await prisma.product.findUnique({
        where: { id: routeParam(req.params.id) },
        include: { featureAssignments: { select: { featureId: true } } },
      });
      if (
        !existing ||
        (user.role !== Role.ADMIN && existing.sellerId !== user.sellerId)
      )
        return res.status(404).json({ error: "Product not found" });
      const nextPriceMinor = input.priceMinor ?? existing.priceMinor;
      const nextSalePriceMinor =
        input.salePriceMinor !== undefined
          ? input.salePriceMinor
          : existing.salePriceMinor;
      if (!isValidSalePrice(nextPriceMinor, nextSalePriceMinor))
        return res
          .status(400)
          .json({ error: "Sale price must be lower than the regular price." });
      const wholesaleEnabled =
        input.wholesaleEnabled ?? existing.wholesaleEnabled;
      const wholesaleMinQuantity = wholesaleEnabled
        ? input.wholesaleMinQuantity !== undefined
          ? input.wholesaleMinQuantity
          : existing.wholesaleMinQuantity
        : null;
      const wholesaleMaxQuantity = wholesaleEnabled
        ? input.wholesaleMaxQuantity !== undefined
          ? input.wholesaleMaxQuantity
          : existing.wholesaleMaxQuantity
        : null;
      const wholesaleError = wholesaleConfigurationError({
        wholesaleEnabled,
        wholesaleMinQuantity,
        wholesaleMaxQuantity,
      });
      if (wholesaleError)
        return res.status(400).json({
          error: wholesaleError,
          code: "WHOLESALE_CONFIGURATION_INVALID",
        });
      const product = await prisma.$transaction(async (tx) => {
        const taxonomy = await validateProductCatalogSelection(
          {
            categoryId:
              input.categoryId !== undefined
                ? input.categoryId
                : existing.categoryId,
            brandId:
              input.brandId !== undefined ? input.brandId : existing.brandId,
            productTypeId:
              input.productTypeId !== undefined
                ? input.productTypeId
                : existing.productTypeId,
            featureIds:
              input.featureIds ??
              existing.featureAssignments.map((item) => item.featureId),
          },
          tx,
        );
        const updated = await tx.product.update({
          where: { id: existing.id },
          data: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.priceMinor !== undefined
              ? { priceMinor: input.priceMinor }
              : {}),
            ...(input.salePriceMinor !== undefined
              ? { salePriceMinor: input.salePriceMinor }
              : {}),
            ...(input.categoryId !== undefined
              ? { categoryId: taxonomy.categoryId }
              : {}),
            ...(input.brandId !== undefined
              ? { brandId: taxonomy.brandId }
              : {}),
            ...(input.productTypeId !== undefined
              ? { productTypeId: taxonomy.productTypeId }
              : {}),
            ...(input.color !== undefined ? { color: input.color } : {}),
            ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
            wholesaleEnabled,
            wholesaleMinQuantity,
            wholesaleMaxQuantity,
          },
        });
        if (
          input.featureIds !== undefined ||
          input.categoryId !== undefined ||
          input.productTypeId !== undefined
        ) {
          await tx.productFeatureAssignment.deleteMany({
            where: { productId: existing.id },
          });
          if (taxonomy.featureIds.length)
            await tx.productFeatureAssignment.createMany({
              data: taxonomy.featureIds.map((featureId) => ({
                productId: existing.id,
                featureId,
              })),
            });
        }
        if (input.stock !== undefined)
          await tx.inventory.update({
            where: { productId: existing.id },
            data: { quantity: input.stock },
          });
        return updated;
      });
      res.json(product);
    }),
  );
}
