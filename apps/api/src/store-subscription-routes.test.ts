import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStoreSubscriptionRoutes } from "./store-subscription-routes.js";

const mocks = vi.hoisted(() => {
  const calls = {
    sellerFindFirst: vi.fn(async () => ({
      store: { id: "store-synthetic", isPlatformStore: false },
      user: { email: "seller@example.test" },
    })),
    listEvents: vi.fn(async () => [] as Array<Record<string, unknown>>),
    requestCancellation: vi.fn(async () => ({
      id: "subscription-synthetic",
      status: "CANCELLED",
      cancelAtPeriodEnd: true,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    })),
    processWebhook: vi.fn(async () => ({
      reconciliation: "APPLIED",
      duplicate: false,
    })),
    verifyWebhook: vi.fn(() => ({ id: "evt_synthetic", type: "test.event" })),
    provider: vi.fn(() => ({ sandbox: true })),
  };
  const prisma = {
    seller: { findFirst: calls.sellerFindFirst },
    storeSubscriptionEvent: { findMany: calls.listEvents },
  };
  return { calls, prisma };
});

vi.mock("./config.js", () => ({
  env: { STORE_PLAN_BILLING_SANDBOX_ENABLED: false },
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
      if (!roles.includes(res.locals.user?.role))
        return res.status(403).json({ error: "Insufficient permissions." });
      next();
    },
}));
vi.mock("./store-subscription-lifecycle.js", () => ({
  requestStoreSubscriptionCancellation: mocks.calls.requestCancellation,
  processStripeStoreBillingEvent: mocks.calls.processWebhook,
  SubscriptionBillingError: class SubscriptionBillingError extends Error {
    code = "SYNTHETIC_ERROR";
  },
}));
vi.mock("./stripe-store-billing.js", () => ({
  stripeStoreBillingProvider: mocks.calls.provider,
  verifyStripeStoreBillingWebhook: mocks.calls.verifyWebhook,
}));

const servers: Server[] = [];

async function startServer() {
  const app = express();
  registerStoreSubscriptionRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error(
      "Store subscription route test server did not bind to TCP.",
    );
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
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
      ...(options.role ? { "x-test-role": options.role } : {}),
      ...(options.sellerId ? { "x-test-seller-id": options.sellerId } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.sellerFindFirst.mockResolvedValue({
    store: { id: "store-synthetic", isPlatformStore: false },
    user: { email: "seller@example.test" },
  });
  mocks.calls.listEvents.mockResolvedValue([]);
  mocks.calls.verifyWebhook.mockReturnValue({
    id: "evt_synthetic",
    type: "test.event",
  } as never);
  mocks.calls.processWebhook.mockResolvedValue({
    reconciliation: "APPLIED",
    duplicate: false,
  });
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

describe("Store subscription API safety boundaries", () => {
  it("rejects unauthenticated and non-seller cancellation requests", async () => {
    const baseUrl = await startServer();
    const path = "/api/seller/billing/subscription-synthetic/cancel";

    expect((await request(baseUrl, path, { method: "POST" })).status).toBe(401);
    expect(
      (
        await request(baseUrl, path, {
          method: "POST",
          auth: "yes",
          role: "BUYER",
        })
      ).status,
    ).toBe(403);
    expect(mocks.calls.sellerFindFirst).not.toHaveBeenCalled();
    expect(mocks.calls.provider).not.toHaveBeenCalled();
    expect(mocks.calls.requestCancellation).not.toHaveBeenCalled();
  });

  it("keeps subscription cancellation closed when sandbox billing is disabled", async () => {
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/billing/subscription-synthetic/cancel",
      {
        method: "POST",
        auth: "yes",
        role: "SELLER",
        sellerId: "seller-synthetic",
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "PLAN_BILLING_DISABLED",
    });
    expect(mocks.calls.sellerFindFirst).not.toHaveBeenCalled();
    expect(mocks.calls.provider).not.toHaveBeenCalled();
    expect(mocks.calls.requestCancellation).not.toHaveBeenCalled();
    expect(mocks.calls.processWebhook).not.toHaveBeenCalled();
  });

  it("rejects Stripe webhook requests without a raw-body signature before processing", async () => {
    const baseUrl = await startServer();
    const missingSignature = await request(
      baseUrl,
      "/api/webhooks/stripe/store-billing",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "evt_untrusted" }),
      },
    );

    expect(missingSignature.status).toBe(400);
    expect(await missingSignature.json()).toMatchObject({
      code: "SIGNATURE_REQUIRED",
    });
    expect(mocks.calls.verifyWebhook).not.toHaveBeenCalled();

    mocks.calls.verifyWebhook.mockImplementationOnce(() => {
      throw new Error("Invalid signature");
    });
    const invalidSignature = await request(
      baseUrl,
      "/api/webhooks/stripe/store-billing",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "synthetic-invalid-signature",
        },
        body: JSON.stringify({ id: "evt_untrusted" }),
      },
    );

    expect(invalidSignature.status).toBe(400);
    expect(await invalidSignature.json()).toMatchObject({
      code: "INVALID_SIGNATURE",
    });
    expect(mocks.calls.processWebhook).not.toHaveBeenCalled();
  });

  it("passes only signature-verified raw webhook events to reconciliation", async () => {
    const baseUrl = await startServer();
    const payload = JSON.stringify({ id: "evt_synthetic", type: "test.event" });
    const response = await request(
      baseUrl,
      "/api/webhooks/stripe/store-billing",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "synthetic-valid-signature",
        },
        body: payload,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      reconciliation: "APPLIED",
      duplicate: false,
    });
    expect(mocks.calls.verifyWebhook).toHaveBeenCalledWith(
      Buffer.from(payload),
      "synthetic-valid-signature",
    );
    expect(mocks.calls.processWebhook).toHaveBeenCalledWith(mocks.prisma, {
      id: "evt_synthetic",
      type: "test.event",
    });
  });

  it("restricts billing-event diagnostics to admins and returns safe event summaries", async () => {
    const baseUrl = await startServer();
    const path = "/api/admin/store-billing/events";

    expect((await request(baseUrl, path)).status).toBe(401);
    expect(
      (await request(baseUrl, path, { auth: "yes", role: "SELLER" })).status,
    ).toBe(403);
    expect(mocks.calls.listEvents).not.toHaveBeenCalled();

    mocks.calls.listEvents.mockResolvedValueOnce([
      {
        id: "event-synthetic",
        status: "PROCESSED",
        safeSummary: { outcome: "accepted" },
      },
    ]);
    const response = await request(baseUrl, path, {
      auth: "yes",
      role: "ADMIN",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "event-synthetic",
        status: "PROCESSED",
        safeSummary: { outcome: "accepted" },
      },
    ]);
    expect(mocks.calls.listEvents).toHaveBeenCalledWith({
      orderBy: { receivedAt: "desc" },
      take: 100,
      select: {
        id: true,
        provider: true,
        providerEventId: true,
        eventType: true,
        status: true,
        signatureVerified: true,
        subscriptionId: true,
        safeSummary: true,
        errorCode: true,
        receivedAt: true,
        processedAt: true,
      },
    });
  });
});
