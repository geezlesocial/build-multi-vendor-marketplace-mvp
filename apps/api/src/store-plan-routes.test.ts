import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => {
  const calls = {
    sellerFindFirst: vi.fn(async () => ({
      store: { id: "store-synthetic", isPlatformStore: false },
      user: { email: "seller@example.test" },
    })),
    listPlans: vi.fn(async () => []),
    transaction: vi.fn(async () => {
      throw new Error(
        "A transaction must not start in these guarded requests.",
      );
    }),
    provider: vi.fn(() => null),
  };
  const prisma = {
    $transaction: calls.transaction,
    seller: { findFirst: calls.sellerFindFirst },
    storePlan: { findMany: calls.listPlans },
  };
  return { calls, prisma };
});

vi.mock("./config.js", () => ({
  env: { WEB_ORIGIN: "http://localhost:5173" },
}));
vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "user-synthetic",
      role: req.get("x-test-role") ?? "SELLER",
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
      const user = res.locals.user as
        { role?: string; sellerId?: string } | undefined;
      const platformAdminSellerAccess =
        user?.role === "ADMIN" &&
        Boolean(user.sellerId) &&
        roles.includes("SELLER");
      if (
        !user ||
        (!roles.includes(user.role ?? "") && !platformAdminSellerAccess)
      )
        return res.status(403).json({ error: "Insufficient permissions." });
      next();
    },
}));
vi.mock("./stripe-store-billing.js", () => ({
  storePlanBillingSandboxEnabled: false,
  stripeStoreBillingProvider: mocks.calls.provider,
  stripeStoreBillingTermsSupported: vi.fn(() => ({
    supported: false,
    reason: "Synthetic sandbox is disabled.",
  })),
}));

import { registerStorePlanRoutes } from "./store-plan-routes.js";

const servers: Server[] = [];

async function startServer() {
  const app = express();
  app.use(express.json());
  registerStorePlanRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError)
        return res.status(400).json({ error: "Validation failed." });
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Store plan route test server did not bind to TCP.");
  return `http://127.0.0.1:${address.port}`;
}

function request(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    auth?: string;
    role?: string;
    sellerId?: string;
    body?: unknown;
  } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.sellerFindFirst.mockResolvedValue({
    store: { id: "store-synthetic", isPlatformStore: false },
    user: { email: "seller@example.test" },
  });
  mocks.calls.listPlans.mockResolvedValue([]);
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

describe("Store plan API authorization and billing gates", () => {
  it("denies unauthenticated and seller access to administrator plan data", async () => {
    const baseUrl = await startServer();
    const path = "/api/admin/store-plans";

    expect((await request(baseUrl, path)).status).toBe(401);
    expect(
      (await request(baseUrl, path, { auth: "yes", role: "SELLER" })).status,
    ).toBe(403);
    expect(mocks.calls.listPlans).not.toHaveBeenCalled();
  });

  it("requires an authenticated seller scope before billing checkout", async () => {
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/seller/billing/subscribe", {
      method: "POST",
      auth: "yes",
      role: "SELLER",
      body: { planVersionId: "version-synthetic", interval: "MONTHLY" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "Seller scope required.",
    });
    expect(mocks.calls.sellerFindFirst).not.toHaveBeenCalled();
    expect(mocks.calls.transaction).not.toHaveBeenCalled();
  });

  it("does not create checkout or subscription state while billing is disabled", async () => {
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/seller/billing/subscribe", {
      method: "POST",
      auth: "yes",
      role: "SELLER",
      sellerId: "seller-synthetic",
      body: { planVersionId: "version-synthetic", interval: "MONTHLY" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "PLAN_BILLING_DISABLED",
    });
    expect(mocks.calls.sellerFindFirst).toHaveBeenCalledWith({
      where: { id: "seller-synthetic", status: "APPROVED" },
      select: {
        store: { select: { id: true, isPlatformStore: true } },
        user: { select: { email: true } },
      },
    });
    expect(mocks.calls.transaction).not.toHaveBeenCalled();
    expect(mocks.calls.provider).not.toHaveBeenCalled();
  });

  it("keeps the official platform Store exempt from subscription billing", async () => {
    mocks.calls.sellerFindFirst.mockResolvedValueOnce({
      store: { id: "platform-store-synthetic", isPlatformStore: true },
      user: { email: "admin@example.test" },
    });
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/seller/billing/subscribe", {
      method: "POST",
      auth: "yes",
      role: "ADMIN",
      sellerId: "platform-seller-synthetic",
      body: { planVersionId: "version-synthetic", interval: "MONTHLY" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "PLATFORM_STORE_BILLING_EXEMPT",
    });
    expect(mocks.calls.transaction).not.toHaveBeenCalled();
    expect(mocks.calls.provider).not.toHaveBeenCalled();
  });
});
