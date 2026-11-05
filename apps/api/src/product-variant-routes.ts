import type { Express } from "express";
import express from "express";
import {
  MediaKind,
  MediaScanStatus,
  MediaUploadStatus,
  ProductStatus,
  Role,
} from "@prisma/client";
import { prisma, requireAuth, requireRole } from "./security.js";
import { variantSchema } from "./validation.js";

const asyncRoute =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

const normalizeColorName = (value: string) =>
  value.trim().normalize("NFKC").replace(/\s+/gu, " ");
const colorNameKey = (value: string) => normalizeColorName(value).toLowerCase();

type Actor = { id: string; role: Role; sellerId?: string };
const actor = (res: express.Response) => res.locals.user as Actor;

async function productMediaScope(sellerId: string | null) {
  if (!sellerId) return null;
  const store = await prisma.store.findUnique({
    where: { sellerId },
    select: { id: true },
  });
  if (!store)
    throw Object.assign(new Error("Product Store scope is unavailable."), {
      statusCode: 409,
    });
  return store.id;
}

async function approvedVariantImage(
  mediaAssetId: string | null | undefined,
  storeId: string | null,
) {
  if (!mediaAssetId) return;
  const asset = await prisma.mediaAsset.findFirst({
    where: {
      id: mediaAssetId,
      storeId,
      kind: MediaKind.IMAGE,
      uploadStatus: MediaUploadStatus.COMPLETE,
      scanStatus: MediaScanStatus.APPROVED,
    },
    select: { id: true },
  });
  if (!asset)
    throw Object.assign(
      new Error("Choose an approved image from this Store's media library."),
      { statusCode: 409 },
    );
}

function publicVariant(variant: {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  stock: number;
  mediaAsset?: {
    id: string;
    kind: MediaKind;
    uploadStatus: MediaUploadStatus;
    scanStatus: MediaScanStatus;
  } | null;
}) {
  return {
    id: variant.id,
    name: variant.name,
    priceMinor: variant.priceMinor,
    currency: variant.currency,
    stock: variant.stock,
    image:
      variant.mediaAsset?.kind === MediaKind.IMAGE &&
      variant.mediaAsset.uploadStatus === MediaUploadStatus.COMPLETE &&
      variant.mediaAsset.scanStatus === MediaScanStatus.APPROVED
        ? {
            id: variant.mediaAsset.id,
            url: `/content-media/${encodeURIComponent(variant.mediaAsset.id)}`,
          }
        : null,
  };
}

export function registerProductVariantRoutes(app: Express) {
  app.get(
    "/api/products/:id/variants",
    asyncRoute(async (req, res) => {
      const product = await prisma.product.findFirst({
        where: {
          id: routeParam(req.params.id),
          status: ProductStatus.APPROVED,
          OR: [{ sellerId: null }, { seller: { status: "APPROVED" } }],
        },
        select: { id: true },
      });
      if (!product) return res.status(404).json({ error: "Product not found" });
      const variants = await prisma.productVariant.findMany({
        where: { productId: product.id, status: ProductStatus.APPROVED },
        orderBy: { name: "asc" },
        include: {
          mediaAsset: {
            select: {
              id: true,
              kind: true,
              uploadStatus: true,
              scanStatus: true,
            },
          },
        },
      });
      res.json(variants.map(publicVariant));
    }),
  );

  app.get(
    "/api/stores/:slug/variants",
    asyncRoute(async (req, res) => {
      const slug = routeParam(req.params.slug);
      const store = await prisma.store.findFirst({
        where: { slug, seller: { status: "APPROVED" } },
        select: { sellerId: true },
      });
      if (!store) return res.status(404).json({ error: "Store not found" });
      const products = await prisma.product.findMany({
        where: { sellerId: store.sellerId, status: ProductStatus.APPROVED },
        select: {
          id: true,
          variants: {
            where: { status: ProductStatus.APPROVED },
            orderBy: { name: "asc" },
            include: {
              mediaAsset: {
                select: {
                  id: true,
                  kind: true,
                  uploadStatus: true,
                  scanStatus: true,
                },
              },
            },
          },
        },
      });
      res.setHeader(
        "Cache-Control",
        "public, max-age=30, stale-while-revalidate=60",
      );
      res.json(
        products.map((product) => ({
          productId: product.id,
          variants: product.variants.map(publicVariant),
        })),
      );
    }),
  );

  app.post(
    "/api/products/:id/variants",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = actor(res);
      const parsedInput = variantSchema.parse(req.body);
      const input = {
        ...parsedInput,
        name: normalizeColorName(parsedInput.name),
      };
      const product = await prisma.product.findUnique({
        where: { id: routeParam(req.params.id) },
        select: { id: true, sellerId: true, status: true, currency: true },
      });
      if (
        !product ||
        (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)
      )
        return res.status(404).json({ error: "Product not found" });
      if (product.status === ProductStatus.ARCHIVED)
        return res
          .status(409)
          .json({
            error: "Restore this listing before editing its color options.",
          });
      const storeId = await productMediaScope(product.sellerId);
      await approvedVariantImage(input.mediaAssetId, storeId);
      const matchesRequest = (
        existing: {
          productId: string;
          name: string;
          sku: string;
          priceMinor: number;
          stock: number;
          mediaAssetId: string | null;
        } | null,
      ) =>
        Boolean(
          existing &&
          existing.productId === product.id &&
          existing.name === input.name &&
          existing.sku === input.sku &&
          existing.priceMinor === input.priceMinor &&
          existing.stock === input.stock &&
          existing.mediaAssetId === (input.mediaAssetId ?? null),
        );
      const existingBySku = await prisma.productVariant.findUnique({
        where: { sku: input.sku },
      });
      if (existingBySku) {
        if (matchesRequest(existingBySku)) {
          res.status(200).json(existingBySku);
          return;
        }
        res
          .status(409)
          .json({
            error: "This SKU is already assigned to a different variant.",
          });
        return;
      }
      let variant;
      try {
        variant = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${product.id} FOR UPDATE`;
          const existingColors = await tx.productVariant.findMany({
            where: { productId: product.id },
            select: { id: true, name: true },
          });
          if (
            existingColors.some(
              (existing) =>
                colorNameKey(existing.name) === colorNameKey(input.name),
            )
          )
            throw Object.assign(
              new Error(
                "A color with that name already exists on this listing.",
              ),
              { statusCode: 409 },
            );
          const created = await tx.productVariant.create({
            data: {
              productId: product.id,
              name: input.name,
              sku: input.sku,
              priceMinor: input.priceMinor,
              stock: input.stock,
              mediaAssetId: input.mediaAssetId ?? null,
              currency: product.currency,
              status:
                user.role === Role.ADMIN
                  ? ProductStatus.APPROVED
                  : ProductStatus.PENDING,
            },
          });
          if (
            user.role !== Role.ADMIN &&
            product.status === ProductStatus.APPROVED
          ) {
            await tx.product.updateMany({
              where: {
                id: product.id,
                sellerId: user.sellerId,
                status: ProductStatus.APPROVED,
              },
              data: { status: ProductStatus.PENDING },
            });
          }
          await tx.auditLog.create({
            data: {
              actorId: user.id,
              action: "PRODUCT_VARIANT_CREATED",
              entity: "ProductVariant",
              entityId: created.id,
              metadata: {
                productId: product.id,
                mediaAssetId: created.mediaAssetId,
                status: created.status,
              },
            },
          });
          return created;
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        const concurrentVariant = await prisma.productVariant.findUnique({
          where: { sku: input.sku },
        });
        if (matchesRequest(concurrentVariant)) {
          res.status(200).json(concurrentVariant);
          return;
        }
        res
          .status(409)
          .json({
            error: "This SKU is already assigned to a different variant.",
          });
        return;
      }
      res.status(201).json(variant);
    }),
  );

  app.patch(
    "/api/products/:id/variants/:variantId",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = actor(res);
      const parsedInput = variantSchema.partial().parse(req.body);
      const input = {
        ...parsedInput,
        ...(parsedInput.name !== undefined
          ? { name: normalizeColorName(parsedInput.name) }
          : {}),
      };
      const variant = await prisma.productVariant.findFirst({
        where: {
          id: routeParam(req.params.variantId),
          product: {
            id: routeParam(req.params.id),
            ...(user.role === Role.ADMIN ? {} : { sellerId: user.sellerId }),
          },
        },
        include: {
          product: { select: { id: true, sellerId: true, status: true } },
        },
      });
      if (!variant) return res.status(404).json({ error: "Variant not found" });
      if (variant.product.status === ProductStatus.ARCHIVED)
        return res
          .status(409)
          .json({
            error: "Restore this listing before editing its color options.",
          });
      if (Object.hasOwn(input, "mediaAssetId")) {
        if (input.mediaAssetId) {
          const storeId = await productMediaScope(variant.product.sellerId);
          await approvedVariantImage(input.mediaAssetId, storeId);
        }
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${variant.product.id} FOR UPDATE`;
        if (input.name !== undefined) {
          const existingColors = await tx.productVariant.findMany({
            where: { productId: variant.product.id, id: { not: variant.id } },
            select: { id: true, name: true },
          });
          if (
            existingColors.some(
              (existing) =>
                colorNameKey(existing.name) === colorNameKey(input.name!),
            )
          )
            throw Object.assign(
              new Error(
                "A color with that name already exists on this listing.",
              ),
              { statusCode: 409 },
            );
        }
        const result = await tx.productVariant.update({
          where: { id: variant.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sku !== undefined ? { sku: input.sku } : {}),
            ...(input.priceMinor !== undefined
              ? { priceMinor: input.priceMinor }
              : {}),
            ...(input.stock !== undefined ? { stock: input.stock } : {}),
            ...(Object.hasOwn(input, "mediaAssetId")
              ? { mediaAssetId: input.mediaAssetId ?? null }
              : {}),
            ...(user.role === Role.ADMIN
              ? {}
              : { status: ProductStatus.PENDING }),
          },
        });
        if (
          user.role !== Role.ADMIN &&
          variant.product.status === ProductStatus.APPROVED
        ) {
          await tx.product.updateMany({
            where: {
              id: variant.product.id,
              sellerId: user.sellerId,
              status: ProductStatus.APPROVED,
            },
            data: { status: ProductStatus.PENDING },
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: "PRODUCT_VARIANT_UPDATED",
            entity: "ProductVariant",
            entityId: result.id,
            metadata: {
              productId: variant.product.id,
              mediaAssetId: result.mediaAssetId,
              status: result.status,
            },
          },
        });
        return result;
      });
      res.json(updated);
    }),
  );

  app.delete(
    "/api/products/:id/variants/:variantId",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = actor(res);
      const variant = await prisma.productVariant.findFirst({
        where: {
          id: routeParam(req.params.variantId),
          product: {
            id: routeParam(req.params.id),
            ...(user.role === Role.ADMIN ? {} : { sellerId: user.sellerId }),
          },
        },
        select: {
          id: true,
          productId: true,
          product: { select: { status: true } },
        },
      });
      if (!variant) return res.status(404).json({ error: "Variant not found" });
      if (variant.product.status === ProductStatus.ARCHIVED)
        return res
          .status(409)
          .json({
            error: "Restore this listing before editing its color options.",
          });
      const [cartReferences, orderReferences] = await Promise.all([
        prisma.cartItem.count({ where: { variantId: variant.id } }),
        prisma.orderItem.count({ where: { variantId: variant.id } }),
      ]);
      if (cartReferences || orderReferences)
        return res
          .status(409)
          .json({
            error:
              "This color is referenced by a cart or order and cannot be removed.",
          });
      await prisma.$transaction(async (tx) => {
        await tx.productVariant.delete({ where: { id: variant.id } });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: "PRODUCT_VARIANT_REMOVED",
            entity: "ProductVariant",
            entityId: variant.id,
            metadata: { productId: variant.productId },
          },
        });
      });
      res.status(204).send();
    }),
  );
}
