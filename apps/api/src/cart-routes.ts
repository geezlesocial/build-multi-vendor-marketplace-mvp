import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { ProductStatus, SellerStatus } from "@prisma/client";
import { z } from "zod";
import { prisma, requireAuth } from "./security.js";
import {
  wholesaleConfigurationError,
  wholesaleQuantityError,
} from "./wholesale-domain.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export function registerCartRoutes(app: Express) {
  app.get(
    "/api/cart",
    requireAuth,
    run(async (_req, res) => {
      const user = res.locals.user as { id: string };
      const cart = await prisma.cart.findUnique({
        where: { userId: user.id },
        include: {
          items: {
            include: {
              variant: true,
              product: {
                include: {
                  productType: true,
                  inventory: true,
                  seller: { include: { store: true } },
                },
              },
            },
          },
        },
      });
      res.json(cart ?? { items: [] });
    }),
  );

  app.post(
    "/api/cart/items",
    requireAuth,
    run(async (req, res) => {
      const user = res.locals.user as { id: string };
      const body = z
        .object({
          productId: z.string().cuid(),
          variantId: z.string().cuid().optional(),
          quantity: z.number().int().positive().max(99),
        })
        .parse(req.body);
      const product = await prisma.product.findFirst({
        where: {
          id: body.productId,
          status: ProductStatus.APPROVED,
          OR: [
            { sellerId: null },
            { seller: { status: SellerStatus.APPROVED } },
          ],
        },
        include: { variants: true },
      });
      if (!product)
        return res.status(404).json({ error: "Product unavailable" });
      const variant = body.variantId
        ? product.variants.find(
            (v) =>
              v.id === body.variantId && v.status === ProductStatus.APPROVED,
          )
        : null;
      if (body.variantId && !variant)
        return res.status(409).json({ error: "Variant unavailable" });
      const configError = wholesaleConfigurationError(product);
      if (configError)
        return res.status(409).json({
          error: configError,
          code: "WHOLESALE_CONFIGURATION_INVALID",
        });
      const available =
        variant?.stock ??
        (
          await prisma.inventory.findUnique({
            where: { productId: product.id },
          })
        )?.quantity ??
        0;
      const cart = await prisma.cart.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
      const item = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cart.id} FOR UPDATE`;
        const existing = await tx.cartItem.findUnique({
          where: {
            cartId_productId: { cartId: cart.id, productId: body.productId },
          },
        });
        const nextQuantity = (existing?.quantity ?? 0) + body.quantity;
        const quantityError = wholesaleQuantityError(
          product,
          nextQuantity,
          false,
        );
        if (quantityError)
          throw Object.assign(new Error(quantityError), {
            statusCode: 409,
            code: "WHOLESALE_QUANTITY_INVALID",
          });
        if (nextQuantity > 99)
          throw Object.assign(
            new Error("A cart line cannot exceed 99 units."),
            { statusCode: 409, code: "CART_QUANTITY_LIMIT" },
          );
        if (available < nextQuantity)
          throw Object.assign(new Error("Insufficient stock"), {
            statusCode: 409,
            code: "INSUFFICIENT_STOCK",
          });
        return existing
          ? tx.cartItem.update({
              where: { id: existing.id },
              data: { quantity: nextQuantity, variantId: body.variantId },
            })
          : tx.cartItem.create({
              data: {
                cartId: cart.id,
                productId: body.productId,
                variantId: body.variantId,
                quantity: body.quantity,
              },
            });
      });
      res.status(201).json(item);
    }),
  );

  app.patch(
    "/api/cart/items/:productId",
    requireAuth,
    run(async (req, res) => {
      const user = res.locals.user as { id: string };
      const qty = z
        .object({ quantity: z.number().int().nonnegative().max(99) })
        .parse(req.body).quantity;
      const productId = param(req.params.productId);
      const cart = await prisma.cart.findUnique({ where: { userId: user.id } });
      if (!cart) return res.status(404).json({ error: "Cart not found" });
      const item = await prisma.cartItem.findUnique({
        where: { cartId_productId: { cartId: cart.id, productId } },
        include: { variant: true, product: { include: { inventory: true } } },
      });
      if (!item) return res.status(404).json({ error: "Cart item not found" });
      if (qty === 0) await prisma.cartItem.delete({ where: { id: item.id } });
      else {
        const quantityError = wholesaleQuantityError(item.product, qty, false);
        if (quantityError)
          return res
            .status(409)
            .json({ error: quantityError, code: "WHOLESALE_QUANTITY_INVALID" });
        const available =
          item.variant?.stock ?? item.product.inventory?.quantity ?? 0;
        if (qty > available)
          return res.status(409).json({
            error: `Only ${available} available for ${item.product.name}`,
          });
        await prisma.cartItem.update({
          where: { id: item.id },
          data: { quantity: qty },
        });
      }
      res.status(204).send();
    }),
  );
}
