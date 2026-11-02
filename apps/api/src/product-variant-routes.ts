import type { Express } from "express";
import express from "express";
import { ProductStatus, Role } from "@prisma/client";
import { prisma, requireAuth, requireRole } from "./security.js";
import { variantSchema } from "./validation.js";

const asyncRoute =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export function registerProductVariantRoutes(app: Express) {
  app.get(
    "/api/products/:id/variants",
    asyncRoute(async (req, res) => {
      const variants = await prisma.productVariant.findMany({
        where: {
          productId: routeParam(req.params.id),
          status: ProductStatus.APPROVED,
        },
        orderBy: { name: "asc" },
      });
      res.json(variants);
    }),
  );

  app.post(
    "/api/products/:id/variants",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { role: Role; sellerId?: string };
      const input = variantSchema.parse(req.body);
      const product = await prisma.product.findUnique({
        where: { id: routeParam(req.params.id) },
      });
      if (
        !product ||
        (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)
      )
        return res.status(404).json({ error: "Product not found" });
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          ...input,
          currency: product.currency,
          status:
            user.role === Role.ADMIN
              ? ProductStatus.APPROVED
              : ProductStatus.PENDING,
        },
      });
      res.status(201).json(variant);
    }),
  );

  app.patch(
    "/api/products/:id/variants/:variantId",
    requireAuth,
    requireRole(Role.SELLER, Role.ADMIN),
    asyncRoute(async (req, res) => {
      const user = res.locals.user as { role: Role; sellerId?: string };
      const input = variantSchema.partial().parse(req.body);
      const variant = await prisma.productVariant.findFirst({
        where: {
          id: routeParam(req.params.variantId),
          product: {
            id: routeParam(req.params.id),
            ...(user.role === Role.ADMIN ? {} : { sellerId: user.sellerId }),
          },
        },
      });
      if (!variant) return res.status(404).json({ error: "Variant not found" });
      res.json(
        await prisma.productVariant.update({
          where: { id: variant.id },
          data: input,
        }),
      );
    }),
  );
}
