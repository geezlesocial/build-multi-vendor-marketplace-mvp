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
  const methods = {
    product: {
      findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
      count: vi.fn(async (_args: unknown): Promise<number> => 0),
      findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
      findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
      create: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
      update: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    },
    productVariant: {
      findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
      findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
      findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
      create: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
      update: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    },
    category: {
      findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
    },
    marketplaceSettings: {
      findUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
    },
    store: {
      findFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
    },
    productFeatureAssignment: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      createMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
    },
    inventory: {
      update: vi.fn(async (_args: unknown): Promise<unknown> => ({})),
    },
    $transaction: vi.fn(async () => null),
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
      currency: "SGD",
    });
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
