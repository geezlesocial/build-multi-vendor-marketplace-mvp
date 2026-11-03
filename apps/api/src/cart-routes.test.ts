import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls = {
    cartFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
    cartUpsert: vi.fn(
      async (args?: { where?: { userId?: string } }): Promise<unknown> => ({
        id: `cart-${args?.where?.userId ?? "buyer-a"}`,
      }),
    ),
    productFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
    inventoryFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => ({
      quantity: 8,
    })),
    cartItemFindUnique: vi.fn(
      async (_args?: unknown): Promise<unknown> => null,
    ),
    cartItemCreate: vi.fn(
      async ({
        data,
      }: {
        data: Record<string, unknown>;
      }): Promise<unknown> => ({
        id: "item-created",
        ...data,
      }),
    ),
    cartItemUpdate: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }): Promise<unknown> => ({ ...where, ...data }),
    ),
    cartItemDelete: vi.fn(async (_args?: unknown): Promise<unknown> => ({
      id: "item-deleted",
    })),
    queryRaw: vi.fn(async (_query?: unknown): Promise<unknown[]> => []),
  };
  const tx = {
    $queryRaw: calls.queryRaw,
    cartItem: {
      findUnique: calls.cartItemFindUnique,
      create: calls.cartItemCreate,
      update: calls.cartItemUpdate,
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
    cart: { findUnique: calls.cartFindUnique, upsert: calls.cartUpsert },
    product: { findFirst: calls.productFindFirst },
    inventory: { findUnique: calls.inventoryFindUnique },
    cartItem: {
      findUnique: calls.cartItemFindUnique,
      create: calls.cartItemCreate,
      update: calls.cartItemUpdate,
      delete: calls.cartItemDelete,
    },
  };
  return { calls, prisma };
});

vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = { id: req.get("x-test-user") ?? "buyer-a" };
    next();
  },
}));

import { registerCartRoutes } from "./cart-routes.js";

const productId = "c123456789012345678901234";
const servers: Server[] = [];

async function startServer() {
  const app = express();
  app.use(express.json());
  registerCartRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      const body: Record<string, unknown> = {
        error: error instanceof Error ? error.message : "Unexpected error.",
      };
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
      )
        body.code = error.code;
      res.status(statusCode).json(body);
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cart route test server did not bind to a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

function authHeaders(userId = "buyer-a") {
  return { "x-test-auth": "yes", "x-test-user": userId };
}

async function addItem(
  baseUrl: string,
  quantity = 2,
  headers: Record<string, string> = authHeaders(),
) {
  return fetch(`${baseUrl}/api/cart/items`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ productId, quantity }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.cartFindUnique.mockResolvedValue(null);
  mocks.calls.cartUpsert.mockImplementation(async (args) => ({
    id: `cart-${args?.where?.userId ?? "buyer-a"}`,
  }));
  mocks.calls.productFindFirst.mockResolvedValue({
    id: productId,
    name: "Demo product",
    status: "APPROVED",
    variants: [],
    wholesaleEnabled: false,
    wholesaleMinQuantity: null,
    wholesaleMaxQuantity: null,
  });
  mocks.calls.inventoryFindUnique.mockResolvedValue({ quantity: 8 });
  mocks.calls.cartItemFindUnique.mockResolvedValue(null);
  mocks.calls.cartItemCreate.mockImplementation(async ({ data }) => ({
    id: "item-created",
    ...data,
  }));
  mocks.calls.cartItemUpdate.mockImplementation(async ({ where, data }) => ({
    ...where,
    ...data,
  }));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("cart HTTP routes", () => {
  it("requires authentication before reading or changing a cart", async () => {
    const baseUrl = await startServer();
    expect((await fetch(`${baseUrl}/api/cart`)).status).toBe(401);
    expect((await addItem(baseUrl, 1, {})).status).toBe(401);
    expect(mocks.calls.cartFindUnique).not.toHaveBeenCalled();
    expect(mocks.calls.productFindFirst).not.toHaveBeenCalled();
  });

  it("reads only the authenticated user cart and returns an empty-cart shape when absent", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/cart`, {
      headers: authHeaders("buyer-b"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(mocks.calls.cartFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "buyer-b" } }),
    );
  });

  it("does not create a cart when the requested listing is unavailable", async () => {
    mocks.calls.productFindFirst.mockResolvedValue(null);
    const baseUrl = await startServer();
    const response = await addItem(baseUrl, 1);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Product unavailable",
    });
    expect(mocks.calls.cartUpsert).not.toHaveBeenCalled();
  });

  it("adds an approved in-stock product under a locked cart row", async () => {
    const baseUrl = await startServer();
    const response = await addItem(baseUrl, 2, authHeaders("buyer-b"));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: "item-created",
      cartId: "cart-buyer-b",
      productId,
      quantity: 2,
    });
    expect(mocks.calls.productFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: productId }),
      }),
    );
    expect(mocks.calls.cartUpsert).toHaveBeenCalledWith({
      where: { userId: "buyer-b" },
      update: {},
      create: { userId: "buyer-b" },
    });
    expect(mocks.calls.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.calls.cartItemCreate).toHaveBeenCalledOnce();
  });

  it("rejects a cumulative quantity above available stock without changing the existing cart line", async () => {
    mocks.calls.cartItemFindUnique.mockResolvedValue({
      id: "item-existing",
      quantity: 7,
    });
    const baseUrl = await startServer();
    const response = await addItem(baseUrl, 2);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(mocks.calls.cartItemUpdate).not.toHaveBeenCalled();
    expect(mocks.calls.cartItemCreate).not.toHaveBeenCalled();
  });

  it("scopes cart-line updates to the authenticated user cart and refuses quantities above stock", async () => {
    mocks.calls.cartFindUnique.mockResolvedValue({ id: "cart-buyer-b" });
    mocks.calls.cartItemFindUnique.mockResolvedValue({
      id: "item-buyer-b",
      quantity: 1,
      variant: null,
      product: {
        id: productId,
        name: "Demo product",
        wholesaleEnabled: false,
        wholesaleMinQuantity: null,
        wholesaleMaxQuantity: null,
        inventory: { quantity: 3 },
      },
    });
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/cart/items/${productId}`, {
      method: "PATCH",
      headers: {
        ...authHeaders("buyer-b"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ quantity: 4 }),
    });
    expect(response.status).toBe(409);
    expect(mocks.calls.cartFindUnique).toHaveBeenCalledWith({
      where: { userId: "buyer-b" },
    });
    expect(mocks.calls.cartItemFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cartId_productId: { cartId: "cart-buyer-b", productId } },
      }),
    );
    expect(mocks.calls.cartItemUpdate).not.toHaveBeenCalled();
  });

  it("removes only the requested line from the authenticated user cart when quantity is zero", async () => {
    mocks.calls.cartFindUnique.mockResolvedValue({ id: "cart-buyer-b" });
    mocks.calls.cartItemFindUnique.mockResolvedValue({ id: "item-buyer-b" });
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/cart/items/${productId}`, {
      method: "PATCH",
      headers: {
        ...authHeaders("buyer-b"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ quantity: 0 }),
    });
    expect(response.status).toBe(204);
    expect(mocks.calls.cartItemFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cartId_productId: { cartId: "cart-buyer-b", productId } },
      }),
    );
    expect(mocks.calls.cartItemDelete).toHaveBeenCalledWith({
      where: { id: "item-buyer-b" },
    });
  });
});
