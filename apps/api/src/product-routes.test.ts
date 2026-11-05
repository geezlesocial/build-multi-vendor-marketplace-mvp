import { createServer, type Server } from "node:http";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => {
  const env = { CURRENCY: "USD" };
  const product = {
    findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
    count: vi.fn(async (_args: unknown): Promise<number> => 0),
    findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    create: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    update: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    updateMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
  };
  const productVariant = {
    findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
    findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    create: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    update: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    updateMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
    delete: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    count: vi.fn(async (_args: unknown): Promise<number> => 0),
  };
  const transaction = {
    product,
    productVariant,
    auditLog: { create: vi.fn(async (_args: unknown) => ({})) },
    $queryRaw: vi.fn(async () => []),
  };
  const methods = {
    product,
    productVariant,
    category: {
      findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
    },
    marketplaceSettings: {
      findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    },
    store: {
      findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
      findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    },
    mediaAsset: {
      findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    },
    productFeatureAssignment: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      createMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
    },
    inventory: {
      update: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    },
    $transaction: vi.fn(async (callback?: unknown) => {
      if (typeof callback !== "function") return null;
      return (callback as (tx: typeof transaction) => unknown)(transaction);
    }),
  };
  return { env, methods };
});

vi.mock("./config.js", () => ({ env: mocks.env }));
vi.mock("./security.js", () => ({
  prisma: mocks.methods,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const role = req.get("x-test-role");
    if (!role)
      return res.status(401).json({ error: "Authentication required" });
    res.locals.user = {
      id: "user-test",
      role,
      ...(req.get("x-test-seller-id")
        ? { sellerId: req.get("x-test-seller-id") }
        : {}),
    };
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!roles.includes(res.locals.user?.role))
        return res.status(403).json({ error: "Insufficient permissions" });
      next();
    },
}));
vi.mock("./catalog-routes.js", () => ({
  validateProductCatalogSelection: vi.fn(async () => ({
    categoryId: null,
    brandId: null,
    productTypeId: "physical-product",
    featureIds: [],
  })),
}));
vi.mock("./store-plan-domain.js", () => ({
  effectiveStorePlan: vi.fn(async () => ({ version: 1 })),
  isAtLimit: vi.fn(() => false),
  storeEntitlements: vi.fn(async () => ({ productLimit: 100 })),
}));

import { registerProductRoutes } from "./product-routes.js";
import { registerProductVariantRoutes } from "./product-variant-routes.js";

describe("product route HTTP behavior", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerProductRoutes(app);
    registerProductVariantRoutes(app);
    app.use(
      (
        error: { statusCode?: number; message?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) =>
        res
          .status(error.statusCode ?? 500)
          .json({ error: error.message ?? "Internal server error" }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Product route test server failed to bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.methods.product.findMany.mockResolvedValue([]);
    mocks.methods.product.count.mockResolvedValue(0);
    mocks.methods.product.findFirst.mockResolvedValue(null);
    mocks.methods.product.findUnique.mockResolvedValue(null);
    mocks.methods.product.create.mockResolvedValue({ id: "product-created" });
    mocks.methods.product.update.mockResolvedValue({ id: "product-updated" });
    mocks.methods.productVariant.findMany.mockResolvedValue([]);
    mocks.methods.productVariant.findFirst.mockResolvedValue(null);
    mocks.methods.productVariant.findUnique.mockResolvedValue(null);
    mocks.methods.productVariant.create.mockResolvedValue({
      id: "variant-created",
    });
    mocks.methods.productVariant.update.mockResolvedValue({
      id: "variant-updated",
    });
    mocks.methods.category.findMany.mockResolvedValue([]);
    mocks.methods.marketplaceSettings.findUnique.mockResolvedValue({
      multiVendorEnabled: true,
      productApprovalPolicy: "MANUAL",
    });
    mocks.methods.store.findFirst.mockResolvedValue(null);
    mocks.methods.mediaAsset.findFirst.mockResolvedValue(null);
  });

  async function request(
    path: string,
    options: {
      method?: string;
      role?: string;
      sellerId?: string;
      body?: unknown;
    } = {},
  ) {
    return fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.role ? { "x-test-role": options.role } : {}),
        ...(options.sellerId ? { "x-test-seller-id": options.sellerId } : {}),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  }

  it("keeps public product search approved-only and clamps pagination", async () => {
    mocks.methods.product.findMany.mockResolvedValue([
      { id: "p-1", inventory: { quantity: 4 } },
    ]);
    mocks.methods.product.count.mockResolvedValue(1);

    const response = await request(
      "/api/products?q=%20lamp%20&category=home&page=2&pageSize=100",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: "p-1", availableStock: 4 }],
      page: 2,
      pageSize: 50,
      total: 1,
    });
    const query = mocks.methods.product.findMany.mock.calls[0]?.[0] as {
      skip: number;
      take: number;
      where: { status: string; AND: Array<{ OR?: unknown[] }> };
    };
    expect(query.skip).toBe(50);
    expect(query.take).toBe(50);
    expect(query.where.status).toBe("APPROVED");
    expect(query.where.AND[0]?.OR).toEqual([
      { sellerId: null },
      { seller: { status: "APPROVED" } },
    ]);
    expect(query.where.AND).toContainEqual({
      OR: [
        { name: { contains: "lamp", mode: "insensitive" } },
        { description: { contains: "lamp", mode: "insensitive" } },
      ],
    });
  });

  it("returns only approved products and sanitizes attached public media URLs", async () => {
    mocks.methods.product.findFirst.mockResolvedValue({
      id: "p-1",
      inventory: { quantity: 2 },
      featureAssignments: [{ feature: { id: "feature-1", name: "Cotton" } }],
      mediaAttachments: [
        {
          id: "attachment-1",
          mediaAsset: {
            id: "asset / 1",
            kind: "IMAGE",
            detectedMime: "image/webp",
            originalName: "front.webp",
            safeName: "internal-storage-name",
          },
        },
      ],
    });

    const response = await request("/api/products/p-1");
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.features).toEqual([{ id: "feature-1", name: "Cotton" }]);
    expect(result.availableStock).toBe(2);
    expect(result.mediaAttachments).toEqual([
      {
        id: "attachment-1",
        kind: "IMAGE",
        detectedMime: "image/webp",
        originalName: "front.webp",
        url: "/content-media/asset%20%2F%201",
      },
    ]);
    const query = mocks.methods.product.findFirst.mock.calls[0]?.[0] as {
      where: { status: string };
      include: {
        mediaAttachments: { where: { mediaAsset: Record<string, string> } };
      };
    };
    expect(query.where.status).toBe("APPROVED");
    expect(query.include.mediaAttachments.where.mediaAsset).toEqual({
      uploadStatus: "COMPLETE",
      scanStatus: "APPROVED",
    });
  });

  it("hides products owned by another seller from update attempts", async () => {
    mocks.methods.product.findUnique.mockResolvedValue({
      id: "product-other",
      sellerId: "seller-b",
      priceMinor: 500,
      salePriceMinor: null,
      featureAssignments: [],
    });

    const response = await request("/api/products/product-other", {
      method: "PATCH",
      role: "SELLER",
      sellerId: "seller-a",
      body: { name: "Attempted edit" },
    });

    expect(response.status).toBe(404);
    expect(mocks.methods.product.update).not.toHaveBeenCalled();
  });

  it("creates a seller variant as pending and preserves the product currency", async () => {
    mocks.methods.product.findUnique.mockResolvedValue({
      id: "product-owned",
      sellerId: "seller-a",
      status: "APPROVED",
      currency: "SGD",
    });
    mocks.methods.store.findUnique.mockResolvedValue({ id: "store-a" });
    mocks.methods.productVariant.create.mockResolvedValue({
      id: "variant-created",
      status: "PENDING",
      currency: "SGD",
    });

    const response = await request("/api/products/product-owned/variants", {
      method: "POST",
      role: "SELLER",
      sellerId: "seller-a",
      body: { name: "Large", sku: "LARGE-01", priceMinor: 1250, stock: 3 },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: "PENDING",
      currency: "SGD",
    });
    expect(mocks.methods.productVariant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: "product-owned",
        currency: "SGD",
        status: "PENDING",
      }),
    });
  });

  it("returns an existing matching variant on retry instead of creating a duplicate", async () => {
    const input = {
      name: "Ocean Blue",
      sku: "BOTTLE-OCEAN-BLUE",
      priceMinor: 1999,
      stock: 24,
    };
    const savedVariant = {
      id: "variant-created",
      productId: "product-owned",
      ...input,
      mediaAssetId: null,
      status: "PENDING",
      currency: "USD",
    };
    mocks.methods.product.findUnique.mockResolvedValue({
      id: "product-owned",
      sellerId: "seller-a",
      status: "PENDING",
      currency: "USD",
    });
    mocks.methods.store.findUnique.mockResolvedValue({ id: "store-a" });
    mocks.methods.productVariant.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(savedVariant);
    mocks.methods.productVariant.create.mockResolvedValue(savedVariant);

    const first = await request("/api/products/product-owned/variants", {
      method: "POST",
      role: "SELLER",
      sellerId: "seller-a",
      body: input,
    });
    const retry = await request("/api/products/product-owned/variants", {
      method: "POST",
      role: "SELLER",
      sellerId: "seller-a",
      body: input,
    });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      id: "variant-created",
      name: "Ocean Blue",
    });
    expect(mocks.methods.productVariant.create).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate color name even when the SKU is different", async () => {
    mocks.methods.product.findUnique.mockResolvedValue({
      id: "product-owned",
      sellerId: "seller-a",
      status: "PENDING",
      currency: "USD",
    });
    mocks.methods.store.findUnique.mockResolvedValue({ id: "store-a" });
    mocks.methods.productVariant.findMany.mockResolvedValue([
      { id: "variant-existing", name: "Ocean Blue" },
    ]);

    const response = await request("/api/products/product-owned/variants", {
      method: "POST",
      role: "SELLER",
      sellerId: "seller-a",
      body: {
        name: "  ocean   blue  ",
        sku: "BOTTLE-OCEAN-BLUE-2",
        priceMinor: 1999,
        stock: 24,
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "A color with that name already exists on this listing.",
    });
    expect(mocks.methods.productVariant.create).not.toHaveBeenCalled();
  });

  it("allows replacing a color image only with an approved Store image", async () => {
    mocks.methods.productVariant.findFirst.mockResolvedValue({
      id: "variant-existing",
      product: { id: "product-owned", sellerId: "seller-a", status: "PENDING" },
    });
    mocks.methods.store.findUnique.mockResolvedValue({ id: "store-a" });
    const approvedImageId = "c123456789012345678901234";
    mocks.methods.mediaAsset.findFirst.mockResolvedValue({
      id: approvedImageId,
    });
    mocks.methods.productVariant.update.mockResolvedValue({
      id: "variant-existing",
      mediaAssetId: approvedImageId,
    });

    const response = await request(
      "/api/products/product-owned/variants/variant-existing",
      {
        method: "PATCH",
        role: "SELLER",
        sellerId: "seller-a",
        body: { mediaAssetId: approvedImageId },
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.methods.mediaAsset.findFirst).toHaveBeenCalledWith({
      where: {
        id: approvedImageId,
        storeId: "store-a",
        kind: "IMAGE",
        uploadStatus: "COMPLETE",
        scanStatus: "APPROVED",
      },
      select: { id: true },
    });
    expect(mocks.methods.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "variant-existing" },
        data: expect.objectContaining({ mediaAssetId: approvedImageId }),
      }),
    );
  });

  it("removes a color image by restoring the general product-image fallback", async () => {
    mocks.methods.productVariant.findFirst.mockResolvedValue({
      id: "variant-existing",
      product: { id: "product-owned", sellerId: "seller-a", status: "PENDING" },
    });
    mocks.methods.productVariant.update.mockResolvedValue({
      id: "variant-existing",
      mediaAssetId: null,
    });

    const response = await request(
      "/api/products/product-owned/variants/variant-existing",
      {
        method: "PATCH",
        role: "SELLER",
        sellerId: "seller-a",
        body: { mediaAssetId: null },
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.methods.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "variant-existing" },
        data: expect.objectContaining({ mediaAssetId: null }),
      }),
    );
    expect(mocks.methods.mediaAsset.findFirst).not.toHaveBeenCalled();
  });

  it("does not allow a seller to add a variant to another seller's product", async () => {
    mocks.methods.product.findUnique.mockResolvedValue({
      id: "product-other",
      sellerId: "seller-b",
      currency: "USD",
    });

    const response = await request("/api/products/product-other/variants", {
      method: "POST",
      role: "SELLER",
      sellerId: "seller-a",
      body: { name: "Large", sku: "LARGE-01", priceMinor: 1250, stock: 3 },
    });

    expect(response.status).toBe(404);
    expect(mocks.methods.productVariant.create).not.toHaveBeenCalled();
  });
});
