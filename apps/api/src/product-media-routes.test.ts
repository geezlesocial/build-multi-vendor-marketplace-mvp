import { createServer, type Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => {
  const calls = {
    productFindUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    storeFindUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    mediaAssetFindFirst: vi.fn(
      async (_args: unknown): Promise<unknown> => null,
    ),
    productImageCount: vi.fn(async (_args: unknown) => 0),
    productMediaFindMany: vi.fn(
      async (_args: unknown) => [] as Array<{ mediaAsset: { kind: string } }>,
    ),
    productMediaCount: vi.fn(async (_args: unknown) => 0),
    productMediaCreate: vi.fn(async (_args: unknown): Promise<unknown> => null),
    productMediaFindFirst: vi.fn(
      async (_args: unknown): Promise<unknown> => null,
    ),
    productMediaDelete: vi.fn(async (_args: unknown) => undefined),
    productImageCreate: vi.fn(async (_args: unknown): Promise<unknown> => null),
    productImageFindFirst: vi.fn(
      async (_args: unknown): Promise<unknown> => null,
    ),
    productImageDelete: vi.fn(async (_args: unknown) => undefined),
    auditCreate: vi.fn(async (_args: unknown) => undefined),
    queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, _productId: string) => [],
    ),
  };

  const tx = {
    $queryRaw: calls.queryRaw,
    productImage: {
      count: calls.productImageCount,
      create: calls.productImageCreate,
      delete: calls.productImageDelete,
    },
    productMedia: {
      findMany: calls.productMediaFindMany,
      count: calls.productMediaCount,
      create: calls.productMediaCreate,
      delete: calls.productMediaDelete,
    },
    mediaAsset: { findFirst: calls.mediaAssetFindFirst },
    auditLog: { create: calls.auditCreate },
  };

  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
    product: { findUnique: calls.productFindUnique },
    store: { findUnique: calls.storeFindUnique },
    productMedia: { findFirst: calls.productMediaFindFirst },
    productImage: { findFirst: calls.productImageFindFirst },
  };

  return { calls, prisma, tx };
});

vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "user-1",
      role: req.get("x-test-role") ?? "SELLER",
      sellerId: req.get("x-test-seller") ?? "seller-1",
    };
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (!roles.includes(res.locals.user?.role))
        return res.status(403).json({ error: "Insufficient permissions." });
      next();
    },
}));

import { registerProductMediaRoutes } from "./product-media-routes.js";

const productId = "product-1";
const sellerId = "seller-1";
const storeId = "store-1";
const assetId = "asset-1";
const servers: Server[] = [];

async function startServer() {
  const app = express();
  app.use(express.json());
  registerProductMediaRoutes(app);
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof ZodError)
        return res.status(400).json({ error: "Validation failed." });
      const apiError = error as { statusCode?: unknown; code?: unknown };
      const status =
        typeof apiError.statusCode === "number" ? apiError.statusCode : 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
        ...(typeof apiError.code === "string" ? { code: apiError.code } : {}),
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Product media test server did not bind to a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

function send(
  baseUrl: string,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-test-auth": "yes",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("product media route security and persistence", () => {
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.calls.productFindUnique.mockResolvedValue({
      id: productId,
      sellerId,
    });
    mocks.calls.storeFindUnique.mockResolvedValue({ id: storeId });
    mocks.calls.mediaAssetFindFirst.mockResolvedValue({
      id: assetId,
      kind: "IMAGE",
    });
    mocks.calls.productImageCount.mockResolvedValue(0);
    mocks.calls.productMediaFindMany.mockResolvedValue([]);
    mocks.calls.productMediaCount.mockResolvedValue(0);
    mocks.calls.productMediaCreate.mockImplementation(async (input) => ({
      id: "attachment-1",
      ...(input as { data: Record<string, unknown> }).data,
      mediaAsset: {
        id: assetId,
        originalName: "product.webp",
        kind: "IMAGE",
        detectedMime: "image/webp",
        safeName: "product.webp",
        scanStatus: "APPROVED",
        uploadStatus: "COMPLETE",
      },
    }));
    mocks.calls.productImageCreate.mockResolvedValue({
      id: "image-1",
      productId,
      mediaAssetId: assetId,
      url: `/content-media/${assetId}`,
      alt: "Product photo",
    });
    mocks.calls.productMediaFindFirst.mockResolvedValue({
      id: "attachment-1",
      productId,
      mediaAssetId: assetId,
    });
    mocks.calls.productImageFindFirst.mockResolvedValue({
      id: "image-1",
      productId,
      mediaAssetId: assetId,
    });
    baseUrl = await startServer();
  });

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  });

  it("requires authentication and seller/admin role before looking up products", async () => {
    const unauthenticated = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
      { "x-test-auth": "no" },
    );
    const buyer = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
      { "x-test-role": "BUYER" },
    );

    expect(unauthenticated.status).toBe(401);
    expect(buyer.status).toBe(403);
    expect(mocks.calls.productFindUnique).not.toHaveBeenCalled();
  });

  it("rejects malformed attachment input before querying product data", async () => {
    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId, unexpected: true },
    );

    expect(response.status).toBe(400);
    expect(mocks.calls.productFindUnique).not.toHaveBeenCalled();
  });

  it("returns not found when the requested product does not exist", async () => {
    mocks.calls.productFindUnique.mockResolvedValue(null);

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );

    expect(response.status).toBe(404);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("hides another seller's product and does not enter a transaction", async () => {
    mocks.calls.productFindUnique.mockResolvedValue({
      id: productId,
      sellerId: "seller-2",
    });

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );

    expect(response.status).toBe(404);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.calls.mediaAssetFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed when the seller's Store scope is missing", async () => {
    mocks.calls.storeFindUnique.mockResolvedValue(null);

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );

    expect(response.status).toBe(409);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires a completed, approved asset owned by the product Store", async () => {
    mocks.calls.mediaAssetFindFirst.mockResolvedValue(null);

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/approved .* owned by this Store/i);
    expect(mocks.calls.mediaAssetFindFirst).toHaveBeenCalledWith({
      where: {
        id: assetId,
        kind: { in: ["IMAGE", "VIDEO", "DOCUMENT"] },
        storeId,
        uploadStatus: "COMPLETE",
        scanStatus: "APPROVED",
      },
      select: { id: true, kind: true },
    });
    expect(mocks.calls.productMediaCreate).not.toHaveBeenCalled();
  });

  it("attaches approved Store media transactionally and audits the action", async () => {
    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId, label: "Front view" },
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ id: "attachment-1", label: "Front view" });
    expect(mocks.calls.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.calls.productMediaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          productId,
          mediaAssetId: assetId,
          position: 0,
          label: "Front view",
        },
      }),
    );
    expect(mocks.calls.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "user-1",
          action: "PRODUCT_MEDIA_ATTACHED",
          entity: "ProductMedia",
          metadata: { productId, mediaAssetId: assetId, kind: "IMAGE" },
        }),
      }),
    );
  });

  it("allows admins to manage a product but still scopes assets to its Store", async () => {
    mocks.calls.productFindUnique.mockResolvedValue({
      id: productId,
      sellerId: "seller-2",
    });
    mocks.calls.storeFindUnique.mockResolvedValue({ id: "store-2" });

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
      { "x-test-role": "ADMIN" },
    );

    expect(response.status).toBe(201);
    expect(mocks.calls.mediaAssetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ storeId: "store-2" }),
      }),
    );
  });

  it("allows an admin to attach approved platform media to a platform product", async () => {
    mocks.calls.productFindUnique.mockResolvedValue({
      id: productId,
      sellerId: null,
    });

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
      { "x-test-role": "ADMIN" },
    );

    expect(response.status).toBe(201);
    expect(mocks.calls.storeFindUnique).not.toHaveBeenCalled();
    expect(mocks.calls.mediaAssetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ storeId: null }),
      }),
    );
  });

  it("enforces the one-video capacity using legacy images and attachments together", async () => {
    mocks.calls.mediaAssetFindFirst.mockResolvedValue({
      id: assetId,
      kind: "VIDEO",
    });
    mocks.calls.productMediaFindMany.mockResolvedValue([
      { mediaAsset: { kind: "VIDEO" } },
    ]);

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("PRODUCT_MEDIA_LIMIT_REACHED");
    expect(mocks.calls.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.calls.productMediaCreate).not.toHaveBeenCalled();
  });

  it("enforces the document limit across existing attachments", async () => {
    mocks.calls.mediaAssetFindFirst.mockResolvedValue({
      id: assetId,
      kind: "DOCUMENT",
    });
    mocks.calls.productMediaFindMany.mockResolvedValue(
      Array.from({ length: 4 }, () => ({ mediaAsset: { kind: "DOCUMENT" } })),
    );

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PRODUCT_MEDIA_LIMIT_REACHED");
    expect(mocks.calls.productMediaCreate).not.toHaveBeenCalled();
  });

  it("maps a concurrent duplicate attachment to a conflict response", async () => {
    mocks.calls.productMediaCreate.mockRejectedValue({ code: "P2002" });

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/media`,
      { mediaAssetId: assetId },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already attached/i);
  });

  it("validates legacy image alt text and only attaches approved image assets", async () => {
    const invalid = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/images`,
      { mediaAssetId: assetId, alt: " " },
    );
    expect(invalid.status).toBe(400);
    expect(mocks.calls.productFindUnique).not.toHaveBeenCalled();

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/images`,
      { mediaAssetId: assetId, alt: " Product photo " },
    );

    expect(response.status).toBe(201);
    expect(mocks.calls.mediaAssetFindFirst).toHaveBeenCalledWith({
      where: {
        id: assetId,
        kind: "IMAGE",
        storeId,
        uploadStatus: "COMPLETE",
        scanStatus: "APPROVED",
      },
      select: { id: true },
    });
    expect(mocks.calls.productImageCreate).toHaveBeenCalledWith({
      data: {
        productId,
        mediaAssetId: assetId,
        url: `/content-media/${encodeURIComponent(assetId)}`,
        alt: "Product photo",
      },
    });
  });

  it("counts legacy images toward the shared image capacity", async () => {
    mocks.calls.productImageCount.mockResolvedValue(12);

    const response = await send(
      baseUrl,
      "POST",
      `/api/products/${productId}/images`,
      { mediaAssetId: assetId, alt: "Product photo" },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PRODUCT_MEDIA_LIMIT_REACHED");
    expect(mocks.calls.productImageCreate).not.toHaveBeenCalled();
  });

  it("prevents detaching media from another seller's product", async () => {
    mocks.calls.productFindUnique.mockResolvedValue({
      id: productId,
      sellerId: "seller-2",
    });

    const response = await send(
      baseUrl,
      "DELETE",
      `/api/products/${productId}/media/attachment-1`,
    );

    expect(response.status).toBe(404);
    expect(mocks.calls.productMediaFindFirst).not.toHaveBeenCalled();
    expect(mocks.calls.productMediaDelete).not.toHaveBeenCalled();
  });

  it("detaches an owned attachment and records an audit event", async () => {
    const response = await send(
      baseUrl,
      "DELETE",
      `/api/products/${productId}/media/attachment-1`,
    );

    expect(response.status).toBe(204);
    expect(mocks.calls.productMediaDelete).toHaveBeenCalledWith({
      where: { id: "attachment-1" },
    });
    expect(mocks.calls.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "user-1",
          action: "PRODUCT_MEDIA_DETACHED",
          entity: "ProductMedia",
          entityId: "attachment-1",
        }),
      }),
    );
  });

  it("returns not found when a legacy product image is absent", async () => {
    mocks.calls.productImageFindFirst.mockResolvedValue(null);

    const response = await send(
      baseUrl,
      "DELETE",
      `/api/products/${productId}/images/image-1`,
    );

    expect(response.status).toBe(404);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("detaches an owned legacy image and records an audit event", async () => {
    const response = await send(
      baseUrl,
      "DELETE",
      `/api/products/${productId}/images/image-1`,
    );

    expect(response.status).toBe(204);
    expect(mocks.calls.productImageDelete).toHaveBeenCalledWith({
      where: { id: "image-1" },
    });
    expect(mocks.calls.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "user-1",
          action: "PRODUCT_MEDIA_DETACHED",
          entity: "ProductImage",
          entityId: "image-1",
        }),
      }),
    );
  });
});
