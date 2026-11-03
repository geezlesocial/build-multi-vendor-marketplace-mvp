import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => {
  class MockStoreEmailTransportError extends Error {}

  const makeUser = (overrides: Record<string, unknown> = {}) => ({
    id: "user-synthetic",
    email: "buyer@example.test",
    name: "Synthetic Buyer",
    emailVerifiedAt: null,
    emailVerificationSentAt: null,
    ...overrides,
  });
  const state = {
    resendUser: makeUser() as Record<string, unknown> | null,
    tokenUser: { id: "user-synthetic" } as Record<string, unknown> | null,
    updateCount: 1,
  };
  const calls = {
    queryRaw: vi.fn(async () => undefined),
    resendUserFindUnique: vi.fn(async () => state.resendUser as unknown),
    tokenUserFindFirst: vi.fn(async () => state.tokenUser as unknown),
    userUpdate: vi.fn(async () => ({ id: "user-synthetic" })),
    userUpdateMany: vi.fn(async () => ({ count: state.updateCount })),
    auditLogCreate: vi.fn(async () => undefined),
    awardCoins: vi.fn(async () => ({ created: 1 })),
    sendEmail: vi.fn(async () => undefined),
  };
  const tx = {
    $queryRaw: calls.queryRaw,
    user: {
      findUnique: calls.resendUserFindUnique,
      findFirst: calls.tokenUserFindFirst,
      update: calls.userUpdate,
      updateMany: calls.userUpdateMany,
    },
    auditLog: { create: calls.auditLogCreate },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback(tx),
    ),
  };
  return {
    calls,
    makeUser,
    prisma,
    state,
    StoreEmailTransportError: MockStoreEmailTransportError,
  };
});

vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  tokenHash: (token: string) => `hash:${token}`,
  newToken: () => "a".repeat(64),
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "user-synthetic",
      emailVerifiedAt: null,
    };
    next();
  },
}));
vi.mock("./club-coins-awards.js", () => ({
  awardClubCoinsForEvent: mocks.calls.awardCoins,
}));
vi.mock("./store-email-delivery.js", () => ({
  sendAccountVerificationEmail: mocks.calls.sendEmail,
  StoreEmailTransportError: mocks.StoreEmailTransportError,
}));

import { registerAccountVerificationRoutes } from "./account-verification-routes.js";

const servers: Server[] = [];

async function startServer() {
  const app = express();
  app.use(express.json());
  registerAccountVerificationRoutes(app);
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
    throw new Error("Account-verification test server did not bind to TCP.");
  return `http://127.0.0.1:${address.port}`;
}

function request(
  baseUrl: string,
  path: string,
  options: { method?: string; auth?: string; body?: unknown } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

const verificationPath = "/api/auth/verify-email";
const resendPath = "/api/auth/email-verification/resend";
const token = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.resendUser = mocks.makeUser();
  mocks.state.tokenUser = { id: "user-synthetic" };
  mocks.state.updateCount = 1;
  mocks.calls.resendUserFindUnique.mockResolvedValue(mocks.state.resendUser);
  mocks.calls.tokenUserFindFirst.mockResolvedValue(mocks.state.tokenUser);
  mocks.calls.userUpdateMany.mockImplementation(async () => ({
    count: mocks.state.updateCount,
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

describe("email-verification route authorization and replay safety", () => {
  it("validates a one-time token and atomically marks the account verified", async () => {
    const baseUrl = await startServer();
    const response = await request(baseUrl, verificationPath, {
      method: "POST",
      body: { token },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: true });
    expect(mocks.calls.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.calls.tokenUserFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailVerificationTokenHash: `hash:${token}`,
          emailVerifiedAt: null,
          emailVerificationExpiresAt: expect.objectContaining({
            gt: expect.any(Date),
          }),
        }),
      }),
    );
    expect(mocks.calls.userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "user-synthetic",
          emailVerificationTokenHash: `hash:${token}`,
          emailVerifiedAt: null,
        }),
        data: expect.objectContaining({
          emailVerifiedAt: expect.any(Date),
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
        }),
      }),
    );
    expect(mocks.calls.awardCoins).toHaveBeenCalledOnce();
    expect(mocks.calls.auditLogCreate).toHaveBeenCalledOnce();
  });

  it("rejects malformed, expired, or previously-used verification links", async () => {
    const baseUrl = await startServer();
    const malformed = await request(baseUrl, verificationPath, {
      method: "POST",
      body: { token: "not-a-token" },
    });
    expect(malformed.status).toBe(400);
    expect(mocks.calls.tokenUserFindFirst).not.toHaveBeenCalled();

    mocks.calls.tokenUserFindFirst.mockResolvedValue(null);
    const expiredOrUsed = await request(baseUrl, verificationPath, {
      method: "POST",
      body: { token },
    });
    expect(expiredOrUsed.status).toBe(400);
    expect(mocks.calls.userUpdateMany).not.toHaveBeenCalled();
    expect(mocks.calls.awardCoins).not.toHaveBeenCalled();
  });

  it("does not grant verification rewards when a concurrent token use wins", async () => {
    mocks.state.updateCount = 0;
    const baseUrl = await startServer();
    const response = await request(baseUrl, verificationPath, {
      method: "POST",
      body: { token },
    });

    expect(response.status).toBe(409);
    expect(mocks.calls.awardCoins).not.toHaveBeenCalled();
    expect(mocks.calls.auditLogCreate).not.toHaveBeenCalled();
  });

  it("requires authentication before resending a verification email", async () => {
    const baseUrl = await startServer();
    const response = await request(baseUrl, resendPath, { method: "POST" });

    expect(response.status).toBe(401);
    expect(mocks.calls.resendUserFindUnique).not.toHaveBeenCalled();
    expect(mocks.calls.sendEmail).not.toHaveBeenCalled();
  });

  it("enforces the resend cooldown before rotating a challenge", async () => {
    mocks.state.resendUser = mocks.makeUser({
      emailVerificationSentAt: new Date(Date.now() - 30_000),
    });
    mocks.calls.resendUserFindUnique.mockResolvedValue(mocks.state.resendUser);
    const baseUrl = await startServer();
    const response = await request(baseUrl, resendPath, {
      method: "POST",
      auth: "yes",
    });

    expect(response.status).toBe(429);
    expect(mocks.calls.userUpdate).not.toHaveBeenCalled();
    expect(mocks.calls.sendEmail).not.toHaveBeenCalled();
  });

  it("does not send another email to an already verified account", async () => {
    mocks.state.resendUser = mocks.makeUser({ emailVerifiedAt: new Date() });
    mocks.calls.resendUserFindUnique.mockResolvedValue(mocks.state.resendUser);
    const baseUrl = await startServer();
    const response = await request(baseUrl, resendPath, {
      method: "POST",
      auth: "yes",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verified: true,
      sent: false,
    });
    expect(mocks.calls.userUpdate).not.toHaveBeenCalled();
    expect(mocks.calls.sendEmail).not.toHaveBeenCalled();
  });

  it("stores only a hashed token and delivers the raw token through the mail adapter", async () => {
    const baseUrl = await startServer();
    const response = await request(baseUrl, resendPath, {
      method: "POST",
      auth: "yes",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verified: false,
      sent: true,
    });
    expect(mocks.calls.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailVerificationTokenHash: `hash:${token}`,
          emailVerificationExpiresAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.calls.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.test",
        token,
      }),
    );
  });

  it("keeps resend successful but reports unavailable mail delivery without exposing the token", async () => {
    mocks.calls.sendEmail.mockRejectedValue(
      new mocks.StoreEmailTransportError(
        "Synthetic mail transport unavailable.",
      ),
    );
    const baseUrl = await startServer();
    const response = await request(baseUrl, resendPath, {
      method: "POST",
      auth: "yes",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ verified: false, sent: false });
    expect(JSON.stringify(payload)).not.toContain(token);
  });
});
