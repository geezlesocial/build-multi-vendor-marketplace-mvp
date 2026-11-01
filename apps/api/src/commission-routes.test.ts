import { createServer, type Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => {
  const state = {
    current: {
      id: "policy-draft-1",
      version: 1,
      freeStoreScopeKey: "FREE_STORES",
      type: "PERCENTAGE",
      basisPoints: 650,
      currency: "USD",
      status: "DRAFT",
      reason: "Synthetic commission policy",
    } as Record<string, unknown>,
  };
  const calls = {
    listPolicies: vi.fn(async () => [] as Array<Record<string, unknown>>),
    findFirst: vi.fn(async () => null as Record<string, unknown> | null),
    findUnique: vi.fn(async () => state.current),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "policy-draft-created",
      status: "DRAFT",
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...state.current,
      ...data,
    })),
    policyQuery: vi.fn(async () => []),
    auditCreate: vi.fn(async () => undefined),
    transaction: vi.fn(
      async (
        callback: (client: object) => Promise<unknown>,
        _options?: unknown,
      ) => callback(tx),
    ),
  };
  const tx = {
    $queryRaw: calls.policyQuery,
    sellerCommissionPolicyVersion: {
      findFirst: calls.findFirst,
      findUnique: calls.findUnique,
      create: calls.create,
      update: calls.update,
    },
    auditLog: { create: calls.auditCreate },
  };
  const prisma = {
    $transaction: calls.transaction,
    sellerCommissionPolicyVersion: { findMany: calls.listPolicies },
  };
  return { calls, prisma, state };
});

vi.mock("./config.js", () => ({ env: { CURRENCY: "USD" } }));
vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  audit: vi.fn(async () => undefined),
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "user-test-admin",
      role: req.get("x-test-role") ?? "ADMIN",
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
vi.mock("./seller-commission.js", () => ({
  allocatePartialRefund: vi.fn(async () => undefined),
}));
vi.mock("./currency-domain.js", () => ({
  calculateCommissionMinor: vi.fn(() => 0),
}));
vi.mock("./payment-webhook-reconciliation.js", () => ({
  reconcileVerifiedPaymentEvent: vi.fn(async () => ({ becamePaid: false })),
}));
vi.mock("./integration-operations-domain.js", () => ({
  isRetryablePaymentWebhookEvent: vi.fn(() => false),
}));
vi.mock("./provider-integrations-domain.js", () => ({
  redactProviderAuditReason: vi.fn((reason: string) => reason),
}));

import { registerCommissionRoutes } from "./commission-routes.js";

const servers: Server[] = [];

function policyRecord(status = "DRAFT") {
  return {
    id: "policy-draft-1",
    version: 1,
    freeStoreScopeKey: "FREE_STORES",
    type: "PERCENTAGE",
    basisPoints: 650,
    currency: "USD",
    status,
    reason: "Synthetic commission policy",
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());
  registerCommissionRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError)
        return res.status(400).json({ error: "Validation failed" });
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Commission route test server did not bind to a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

function request(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    auth?: string;
    role?: string;
    body?: unknown;
  } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
      ...(options.role ? { "x-test-role": options.role } : {}),
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
  mocks.state.current = policyRecord();
  mocks.calls.listPolicies.mockResolvedValue([]);
  mocks.calls.findFirst.mockResolvedValue(null);
  mocks.calls.findUnique.mockImplementation(async () => mocks.state.current);
  mocks.calls.create.mockImplementation(async ({ data }) => ({
    ...data,
    id: "policy-draft-created",
    status: "DRAFT",
  }));
  mocks.calls.update.mockImplementation(async ({ data }) => ({
    ...mocks.state.current,
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

describe("seller commission policy API boundaries", () => {
  it("rejects unauthenticated and non-admin policy reads and draft creation", async () => {
    const baseUrl = await startServer();
    const route = "/api/admin/seller-commission-policies";
    const payload = {
      type: "PERCENTAGE",
      basisPoints: 500,
      reason: "Synthetic policy creation",
    };

    expect((await request(baseUrl, route)).status).toBe(401);
    expect(
      (await request(baseUrl, route, { auth: "yes", role: "SELLER" })).status,
    ).toBe(403);
    expect(
      (
        await request(baseUrl, route, {
          method: "POST",
          auth: "yes",
          role: "BUYER",
          body: payload,
        })
      ).status,
    ).toBe(403);
    expect(mocks.calls.listPolicies).not.toHaveBeenCalled();
    expect(mocks.calls.transaction).not.toHaveBeenCalled();
  });

  it("creates an audited all-free-Store draft in a transaction without enabling money movement", async () => {
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/admin/seller-commission-policies",
      {
        method: "POST",
        auth: "yes",
        body: {
          type: "PERCENTAGE",
          basisPoints: 725,
          reason: "Synthetic commission rate review",
        },
      },
    );
    const result = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(result).toMatchObject({
      id: "policy-draft-created",
      version: 1,
      freeStoreScopeKey: "FREE_STORES",
      type: "PERCENTAGE",
      basisPoints: 725,
      currency: "USD",
      status: "DRAFT",
    });
    expect(mocks.calls.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(mocks.calls.policyQuery).toHaveBeenCalledOnce();
    expect(mocks.calls.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 1,
        freeStoreScopeKey: "FREE_STORES",
        fixedMinor: null,
        basisPoints: 725,
        createdById: "user-test-admin",
      }),
    });
    expect(mocks.calls.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "user-test-admin",
        action: "SELLER_COMMISSION_POLICY_DRAFT_CREATED",
        entityId: "policy-draft-created",
      }),
    });
  });

  it("rejects malformed percentage drafts before opening a transaction", async () => {
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/admin/seller-commission-policies",
      {
        method: "POST",
        auth: "yes",
        body: { type: "PERCENTAGE", reason: "Missing basis points" },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Validation failed" });
    expect(mocks.calls.transaction).not.toHaveBeenCalled();
  });

  it("edits only an all-free-Store draft and records the change reason", async () => {
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/admin/seller-commission-policies/policy-draft-1",
      {
        method: "PATCH",
        auth: "yes",
        body: {
          type: "PERCENTAGE",
          basisPoints: 800,
          reason: "Updated draft commission rate",
          changeReason: "Aligning with revised operating costs",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.calls.update).toHaveBeenCalledWith({
      where: { id: "policy-draft-1" },
      data: {
        type: "PERCENTAGE",
        basisPoints: 800,
        reason: "Updated draft commission rate",
      },
    });
    expect(mocks.calls.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SELLER_COMMISSION_POLICY_DRAFT_UPDATED",
        metadata: expect.objectContaining({
          changeReason: "Aligning with revised operating costs",
        }),
      }),
    });
  });

  it("refuses edits to activated policy versions without changing or auditing them", async () => {
    mocks.state.current = policyRecord("ACTIVE");
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/admin/seller-commission-policies/policy-draft-1",
      {
        method: "PATCH",
        auth: "yes",
        body: {
          type: "PERCENTAGE",
          basisPoints: 900,
          reason: "Attempt to alter active terms",
          changeReason: "Should be rejected",
        },
      },
    );
    const result = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(result.error).toMatch(
      /only draft commission policies can be edited/i,
    );
    expect(mocks.calls.update).not.toHaveBeenCalled();
    expect(mocks.calls.auditCreate).not.toHaveBeenCalled();
  });

  it("retires a removable draft and preserves an audit record instead of deleting history", async () => {
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/admin/seller-commission-policies/policy-draft-1",
      {
        method: "DELETE",
        auth: "yes",
        body: { reason: "Withdraw duplicate commission draft" },
      },
    );
    const result = (await response.json()) as {
      removed: boolean;
      policy: { status: string };
    };

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      removed: true,
      policy: { status: "RETIRED" },
    });
    expect(mocks.calls.update).toHaveBeenCalledWith({
      where: { id: "policy-draft-1" },
      data: { status: "RETIRED" },
    });
    expect(mocks.calls.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SELLER_COMMISSION_POLICY_DRAFT_REMOVED",
        entityId: "policy-draft-1",
      }),
    });
  });
});
