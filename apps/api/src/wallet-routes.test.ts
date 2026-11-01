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
  const settings = {
    walletEnabled: true,
    walletFundingEnabled: true,
    walletTransfersEnabled: true,
    walletCheckoutEnabled: true,
    walletWithdrawalsEnabled: true,
    walletEmergencyPause: false,
    clubCoinsEnabled: false,
    clubCoinsEarnEnabled: false,
    clubCoinsRedeemEnabled: false,
    clubCoinTransfersEnabled: false,
    clubCoinConversionEnabled: false,
    clubCoinRedemptionRatio: 1,
    clubCoinMaxDiscountMinor: 0,
    clubCoinName: "Club Coins",
  };
  const env = {
    CURRENCY: "USD",
    MONEY_MOVEMENT_HARD_DISABLED: true,
    WALLET_FUNDING_PROVIDER_READY: false,
    CLUB_COINS_HARD_DISABLED: true,
  };
  const actors: Record<string, { id: string; role: string }> = {
    buyer: { id: "buyer_test", role: "BUYER" },
    seller: { id: "seller_test", role: "SELLER" },
    admin: { id: "admin_test", role: "ADMIN" },
  };
  const activeWallet = {
    id: "wallet_test",
    userId: "buyer_test",
    walletId: null as string | null,
    type: "USER",
    status: "ACTIVE",
  };
  const verification = { sender: true, recipient: true };
  const methods = {
    marketplaceSettings: {
      upsert: vi.fn(async () => settings),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...settings,
        ...data,
      })),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; email?: string } }) => {
          if (where.id === "buyer_test")
            return {
              id: "buyer_test",
              role: "BUYER",
              emailVerifiedAt: verification.sender ? new Date() : null,
              walletAccount: {
                id: "buyer_wallet",
                walletId: "uib2345",
                status: "ACTIVE",
              },
            };
          if (where.id === "seller_test")
            return {
              id: "seller_test",
              role: "SELLER",
              emailVerifiedAt: verification.recipient ? new Date() : null,
              walletAccount: {
                id: "seller_wallet",
                walletId: "uib9876",
                status: "ACTIVE",
              },
            };
          if (where.id === "admin_test")
            return {
              id: "admin_test",
              role: "ADMIN",
              emailVerifiedAt: new Date(),
              walletAccount: {
                id: "admin_wallet",
                walletId: "UI314159",
                status: "ACTIVE",
              },
            };
          if (where.email === "seller@example.test")
            return {
              id: "seller_test",
              emailVerifiedAt: verification.recipient ? new Date() : null,
              walletAccount: {
                id: "seller_wallet",
                walletId: "uib9876",
                status: "ACTIVE",
              },
            };
          if (where.email === "unverified@example.test")
            return {
              id: "unverified_test",
              emailVerifiedAt: null,
              walletAccount: {
                id: "unverified_wallet",
                walletId: "uib4321",
                status: "ACTIVE",
              },
            };
          return null;
        },
      ),
    },
    walletAccount: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { userId?: string; walletId?: string };
        }) => {
          if (where.userId === "buyer_test") return { ...activeWallet };
          if (where.walletId === "UI314159")
            return {
              id: "admin_wallet",
              walletId: "UI314159",
              status: "ACTIVE",
            };
          if (where.walletId === "UIB9876")
            return {
              id: "seller_wallet",
              walletId: "UIB9876",
              status: "ACTIVE",
              user: {
                id: "seller_test",
                emailVerifiedAt: verification.recipient ? new Date() : null,
              },
            };
          return null;
        },
      ),
      findUniqueOrThrow: vi.fn(async () => ({ ...activeWallet })),
      upsert: vi.fn(async () => ({ ...activeWallet })),
      updateMany: vi.fn(async ({ data }: { data: { walletId?: string } }) => {
        if (data.walletId) activeWallet.walletId = data.walletId;
        return { count: 1 };
      }),
      count: vi.fn(async () => 0),
    },
    walletBalance: { groupBy: vi.fn(async () => []) },
    clubCoinAccount: {
      aggregate: vi.fn(async () => ({
        _sum: { balance: 0 },
        _count: { _all: 0 },
      })),
    },
    currencyCatalogEntry: {
      findFirst: vi.fn(async () => ({ code: "USD" })),
      findMany: vi.fn(async () => [
        { code: "USD", name: "US Dollar", symbol: "$", minorUnitExponent: 2 },
      ]),
    },
    walletTransfer: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    },
    walletFundingIntent: { findUnique: vi.fn(), create: vi.fn() },
    walletLedgerPosting: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(),
    },
    walletLedgerTransaction: { create: vi.fn() },
    walletBalanceAllocation: { createMany: vi.fn() },
    auditLog: { create: vi.fn() },
    clubCoinEntry: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    clubCoinRule: { findMany: vi.fn() },
    $transaction: vi.fn(async (operation: (tx: typeof methods) => unknown) =>
      operation(methods),
    ),
  };
  return { actors, activeWallet, env, methods, settings, verification };
});

vi.mock("./config.js", () => ({ env: mocks.env }));
vi.mock("./security.js", () => ({
  prisma: mocks.methods,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const key = req.get("x-test-actor") ?? "";
    const user = mocks.actors[key];
    if (!user)
      return res.status(401).json({ error: "Authentication required" });
    res.locals.user = user;
    next();
  },
  requireRole:
    (role: string) =>
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.locals.user?.role !== role)
        return res.status(403).json({ error: "Insufficient permissions" });
      next();
    },
}));
vi.mock("./wallet-funding.js", () => ({
  createWalletFundingPayment: vi.fn(),
  getStripeWalletFundingProvider: vi.fn(() => null),
  persistWalletFundingProviderReference: vi.fn(),
  processWalletFundingEvent: vi.fn(),
  recoverWalletFundingPaymentIntent: vi.fn(),
  validateWalletFundingPaymentIntent: vi.fn(),
  walletFundingSandboxEnabled: vi.fn(() => false),
  WalletFundingRetryableError: class WalletFundingRetryableError extends Error {},
}));
vi.mock("./live-domain.js", () => ({
  liveShoppingState: vi.fn(async () => ({
    effectiveEnabled: false,
    reason: "disabled",
  })),
}));

import { registerWalletRoutes } from "./wallet-routes.js";

describe("wallet HTTP route authorization and fail-closed boundaries", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerWalletRoutes(app);
    app.use(
      (
        error: { statusCode?: number; message?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res
          .status(error.statusCode ?? 500)
          .json({ error: error.message ?? "Internal server error" });
      },
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server failed to bind to an ephemeral local port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.env, {
      MONEY_MOVEMENT_HARD_DISABLED: true,
      WALLET_FUNDING_PROVIDER_READY: false,
      CLUB_COINS_HARD_DISABLED: true,
    });
    Object.assign(mocks.settings, {
      walletEnabled: true,
      walletFundingEnabled: true,
      walletTransfersEnabled: true,
      walletCheckoutEnabled: true,
      walletWithdrawalsEnabled: true,
      walletEmergencyPause: false,
    });
    mocks.activeWallet.walletId = null;
    mocks.verification.sender = true;
    mocks.verification.recipient = true;
  });

  async function request(path: string, actor?: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(actor ? { "x-test-actor": actor } : {}),
        ...init.headers,
      },
    });
  }

  it("requires authentication and administrator role before reading protected wallet administration data", async () => {
    expect((await request("/api/wallet")).status).toBe(401);
    expect((await request("/api/admin/wallet/summary", "buyer")).status).toBe(
      403,
    );
    expect(mocks.methods.marketplaceSettings.upsert).not.toHaveBeenCalled();
  });

  it("keeps wallet transfers and administrative funding disabled by the hard server gate", async () => {
    const transfer = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: "seller@example.test",
        amountMinor: 100,
        currency: "USD",
        idempotencyKey: "transfer_test_001",
      }),
    });
    expect(transfer.status).toBe(409);
    expect(await transfer.json()).toMatchObject({
      error: "Wallet transfers are disabled",
    });

    const funding = await request(
      "/api/admin/wallet/users/seller_test/fund",
      "admin",
      {
        method: "POST",
        body: JSON.stringify({
          amountMinor: 500,
          currency: "USD",
          reason: "Synthetic route safety check",
          reference: "TEST-REF-001",
          idempotencyKey: "admin_fund_test_001",
        }),
      },
    );
    expect(funding.status).toBe(409);
    expect(await funding.json()).toMatchObject({
      error:
        "Real-money wallet movement is hard-disabled by server configuration.",
    });
    expect(mocks.methods.walletTransfer.create).not.toHaveBeenCalled();
  });

  it("rejects unverified senders and unverified recipients before a transfer transaction", async () => {
    mocks.env.MONEY_MOVEMENT_HARD_DISABLED = false;
    mocks.verification.sender = false;

    const payload = {
      recipientEmail: "seller@example.test",
      amountMinor: 100,
      currency: "USD",
      idempotencyKey: "transfer_verified_001",
    };
    const senderRejected = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(senderRejected.status).toBe(403);
    expect(await senderRejected.json()).toMatchObject({
      error: "Verify your email before sending wallet funds.",
    });

    mocks.verification.sender = true;
    mocks.verification.recipient = false;
    const recipientRejected = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(recipientRejected.status).toBe(409);
    expect(await recipientRejected.json()).toMatchObject({
      error:
        "Recipient must have an active eWallet and a verified email address.",
    });

    const idRejected = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify({
        recipientWalletId: " uib9876 ",
        amountMinor: 100,
        currency: "USD",
        idempotencyKey: "transfer_wallet_id_001",
      }),
    });
    expect(idRejected.status).toBe(409);
    expect(mocks.methods.walletAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: "UIB9876" } }),
    );
    expect(mocks.methods.$transaction).not.toHaveBeenCalled();
  });

  it("activates a wallet once and reuses its assigned ID on repeat activation", async () => {
    const first = await request("/api/wallet/activate", "buyer", {
      method: "POST",
      body: "{}",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      walletId: string;
      alreadyActivated: boolean;
    };
    expect(firstBody).toMatchObject({ alreadyActivated: false });
    expect(firstBody.walletId).toMatch(/^UIB\d{6}$/);

    const repeat = await request("/api/wallet/activate", "buyer", {
      method: "POST",
      body: "{}",
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({
      walletId: firstBody.walletId,
      alreadyActivated: true,
    });
  });

  it("blocks attempts to enable wallet movement while the emergency server gate is active", async () => {
    const response = await request("/api/admin/wallet/settings", "admin", {
      method: "PATCH",
      body: JSON.stringify({
        walletTransfersEnabled: true,
        reason: "Synthetic gate verification",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error:
        "Real-money wallet movement is hard-disabled by server configuration",
    });
    expect(mocks.methods.marketplaceSettings.update).not.toHaveBeenCalled();
  });
});
