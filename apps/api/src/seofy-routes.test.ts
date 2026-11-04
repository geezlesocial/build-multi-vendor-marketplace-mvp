import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const product = {
    id: "product-a",
    sellerId: "seller-a",
    name: "Handmade ceramic mug",
    description:
      "A handmade ceramic mug with a glazed finish, comfortable handle, and simple design for coffee, tea, and warm drinks. Each mug is shaped for daily use and finished by hand in small batches.",
    seoTitle: null,
    seoDescription: null,
    category: { name: "Drinkware" },
    brand: null,
    images: [{ alt: "" }],
    seller: { store: { name: "Clay House" } },
  };
  const calls = {
    paidEntitled: false,
    sellerFindFirst: vi.fn(async () => ({
      id: "seller-a",
      status: "APPROVED",
      store: {
        id: "store-a",
        name: "Clay House",
        slug: "clay-house",
        description: "Public Store description",
        seoTitle: null,
        seoDescription: null,
        seofyLearningEnabled: false,
        isPlatformStore: false,
      },
    })),
    assignmentFindFirst: vi.fn(async () => ({
      source: "SUBSCRIPTION",
      effectiveFrom: new Date(Date.now() - 60_000),
      effectiveUntil: null,
      planVersion: {
        id: "version-a",
        status: "ACTIVE",
        effectiveFrom: new Date(Date.now() - 60_000),
        effectiveUntil: null,
        monthlyPriceMinor: calls.paidEntitled ? 1000 : 0,
        annualPriceMinor: 0,
        introPriceMinor: null,
        freeTrialDays: 0,
        seofyEnabled: true,
        plan: { status: "ACTIVE" },
      },
    })),
    legacyFindFirst: vi.fn(async () => null),
    storeFindFirst: vi.fn(async () => ({
      seoTitle: "Clay House | Handmade Goods",
      seoDescription: "Public Store description for shoppers.",
    })),
    storeSubscriptionFindFirst: vi.fn(async () => ({
      provider: "STRIPE",
      providerSubscriptionId: "subscription-a",
      status: "ACTIVE",
      monthlyPriceMinor: 1000,
      currentPeriodStart: new Date(Date.now() - 60_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      trialEndsAt: null,
      expiresAt: null,
      cancelledAt: null,
    })),
    productFindFirst: vi.fn(async () => product),
    productFindMany: vi.fn(async () => []),
    productUpdateMany: vi.fn(async () => ({ count: 1 })),
    auditCreate: vi.fn(
      async ({
        data,
      }: {
        data: {
          suggestions: { create: Record<string, unknown>[] };
          [key: string]: unknown;
        };
      }) => ({
        ...data,
        id: "audit-a",
        status: "READY",
        createdAt: new Date(),
        suggestions: data.suggestions.create.map((suggestion, index) => ({
          ...suggestion,
          id: `suggestion-${index + 1}`,
          status: "PENDING",
          createdAt: new Date(),
        })),
      }),
    ),
    auditFindFirst: vi.fn(async () => null),
    auditFindMany: vi.fn(async () => []),
    auditUpdate: vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => data,
    ),
    suggestionUpdateMany: vi.fn(async () => ({ count: 1 })),
    auditLogCreate: vi.fn(async () => ({ id: "audit-log-a" })),
    queryRaw: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  const tx = {
    $queryRaw: calls.queryRaw,
    seller: { findFirst: calls.sellerFindFirst },
    storePlanAssignment: { findFirst: calls.assignmentFindFirst },
    storePlanVersion: { findFirst: calls.legacyFindFirst },
    storeSubscription: { findFirst: calls.storeSubscriptionFindFirst },
    store: { findFirst: calls.storeFindFirst },
    product: {
      findFirst: calls.productFindFirst,
      findMany: calls.productFindMany,
      updateMany: calls.productUpdateMany,
    },
    seofyAudit: {
      create: calls.auditCreate,
      findFirst: calls.auditFindFirst,
      findMany: calls.auditFindMany,
      update: calls.auditUpdate,
      deleteMany: calls.deleteMany,
    },
    seofySuggestion: { updateMany: calls.suggestionUpdateMany },
    auditLog: { create: calls.auditLogCreate },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
    seller: { findFirst: calls.sellerFindFirst },
    storePlanAssignment: { findFirst: calls.assignmentFindFirst },
    storePlanVersion: { findFirst: calls.legacyFindFirst },
    storeSubscription: { findFirst: calls.storeSubscriptionFindFirst },
    product: {
      findFirst: calls.productFindFirst,
      findMany: calls.productFindMany,
      updateMany: calls.productUpdateMany,
    },
    store: {
      findFirst: calls.storeFindFirst,
      update: vi.fn(async () => ({ seofyLearningEnabled: true })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    marketplaceSettings: {
      findUnique: vi.fn(async () => ({ jimaConfig: null })),
    },
    seofyAudit: { deleteMany: calls.deleteMany },
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
    const role = req.get("x-test-role");
    if (!role)
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "user-a",
      role,
      sellerId: role === "SELLER" ? "seller-a" : undefined,
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
        return res.status(403).json({ error: "Insufficient permissions." });
      next();
    },
}));

vi.mock("./store-theme-domain.js", () => ({
  hasActivePaidThemeSubscription: vi.fn(() => mocks.calls.paidEntitled),
}));

import { registerSeofyRoutes } from "./seofy-routes.js";

const servers: Server[] = [];
async function startServer() {
  const app = express();
  app.use(express.json());
  registerSeofyRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not bind.");
  return `http://127.0.0.1:${address.port}`;
}

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
  vi.clearAllMocks();
  mocks.calls.paidEntitled = false;
});

describe("SEO-FY seller and public routes", () => {
  it("requires authentication and seller role on the seller workspace", async () => {
    const base = await startServer();
    const anonymous = await fetch(`${base}/api/seller/seofy`);
    expect(anonymous.status).toBe(401);
    const administrator = await fetch(`${base}/api/seller/seofy`, {
      headers: { "x-test-role": "ADMIN" },
    });
    expect(administrator.status).toBe(403);
    expect(mocks.calls.sellerFindFirst).not.toHaveBeenCalled();
  });

  it("serves only public SEO metadata for an approved seller Store", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/public/seo/stores/clay-house`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      seoTitle: "Clay House | Handmade Goods",
      seoDescription: "Public Store description for shoppers.",
    });
    expect(mocks.calls.storeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: "clay-house",
          isPlatformStore: false,
          seller: { status: "APPROVED" },
        }),
      }),
    );
  });

  it("rejects audit, apply, and learning server-side for free Stores even when a plan flag is mislabeled enabled", async () => {
    const base = await startServer();
    const headers = {
      "content-type": "application/json",
      "x-test-role": "SELLER",
    };
    const requests = [
      fetch(`${base}/api/seller/seofy/audits`, {
        method: "POST",
        headers,
        body: JSON.stringify({ targetType: "STORE" }),
      }),
      fetch(`${base}/api/seller/seofy/audits/audit-a/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ suggestionIds: ["suggestion-a"] }),
      }),
      fetch(`${base}/api/seller/seofy/learning`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true }),
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
    expect(mocks.calls.storeSubscriptionFindFirst).not.toHaveBeenCalled();
  });

  it("creates a paid seller audit only for that seller's approved Store product", async () => {
    mocks.calls.paidEntitled = true;
    const base = await startServer();
    const response = await fetch(`${base}/api/seller/seofy/audits`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-role": "SELLER",
      },
      body: JSON.stringify({ targetType: "PRODUCT", targetId: "product-a" }),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(201);
    const audit = JSON.parse(responseText);
    expect(audit).toMatchObject({
      id: "audit-a",
      targetType: "PRODUCT",
      targetId: "product-a",
      storeId: "store-a",
      aiStatus: "NOT_CONFIGURED",
    });
    expect(mocks.calls.productFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "product-a",
          sellerId: "seller-a",
          status: "APPROVED",
          seller: { status: "APPROVED", store: { id: "store-a" } },
        },
      }),
    );
  });

  it("does not audit a product outside the authenticated seller's Store", async () => {
    mocks.calls.paidEntitled = true;
    mocks.calls.productFindFirst.mockResolvedValueOnce(null as never);
    const base = await startServer();
    const response = await fetch(`${base}/api/seller/seofy/audits`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-role": "SELLER",
      },
      body: JSON.stringify({
        targetType: "PRODUCT",
        targetId: "other-product",
      }),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(404);
    expect(mocks.calls.auditCreate).not.toHaveBeenCalled();
  });

  it("applies only a seller-approved SEO field using the prior value as a compare-and-swap guard", async () => {
    mocks.calls.paidEntitled = true;
    const base = await startServer();
    const headers = {
      "content-type": "application/json",
      "x-test-role": "SELLER",
    };
    const createdResponse = await fetch(`${base}/api/seller/seofy/audits`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetType: "PRODUCT", targetId: "product-a" }),
    });
    const createdText = await createdResponse.text();
    expect(createdResponse.status, createdText).toBe(201);
    const created = JSON.parse(createdText);
    mocks.calls.auditFindFirst.mockResolvedValueOnce(created as never);
    const applyResponse = await fetch(
      `${base}/api/seller/seofy/audits/audit-a/apply`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ suggestionIds: ["suggestion-1"] }),
      },
    );
    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toMatchObject({
      appliedCount: 1,
      status: "PARTIALLY_APPLIED",
    });
    expect(mocks.calls.productUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "product-a",
        sellerId: "seller-a",
        status: "APPROVED",
        seoTitle: null,
      },
      data: { seoTitle: "Handmade ceramic mug | Clay House" },
    });
  });
});
