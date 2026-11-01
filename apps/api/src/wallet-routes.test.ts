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
    id: "buyer_wallet",
    userId: "buyer_test",
    walletId: null as string | null,
    type: "USER",
    status: "ACTIVE",
  };
  const balanceState = {
    byAccount: { buyer_wallet: 1_000, seller_wallet: 250 } as Record<
      string,
      number
    >,
    forceDebitFailure: false,
  };
  const transferState: {
    completed: {
      id: string;
      senderId: string;
      recipientId: string;
      amountMinor: number;
      currency: string;
      status: string;
      idempotencyKey: string;
    } | null;
  } = { completed: null };
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
          if (where.userId === "seller_test")
            return {
              id: "seller_wallet",
              userId: "seller_test",
              walletId: "uib9876",
              status: "ACTIVE",
            };
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
    walletBalance: {
      groupBy: vi.fn(async () => []),
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: {
            accountId_currency: { accountId: string; currency: string };
          };
        }) => ({
          id: `balance:${where.accountId_currency.accountId}`,
          accountId: where.accountId_currency.accountId,
          currency: where.accountId_currency.currency,
          availableMinor:
            balanceState.byAccount[where.accountId_currency.accountId] ?? 0,
          pendingMinor: 0,
          heldMinor: 0,
          frozenMinor: 0,
        }),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { availableMinor: { decrement: number } };
        }) => {
          if (balanceState.forceDebitFailure) return { count: 0 };
          const accountId = where.id.slice("balance:".length);
          const balance = balanceState.byAccount[accountId] ?? 0;
          if (balance < data.availableMinor.decrement) return { count: 0 };
          balanceState.byAccount[accountId] =
            balance - data.availableMinor.decrement;
          return { count: 1 };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { availableMinor: { increment: number } };
        }) => {
          const accountId = where.id.slice("balance:".length);
          balanceState.byAccount[accountId] =
            (balanceState.byAccount[accountId] ?? 0) +
            data.availableMinor.increment;
          return {
            id: where.id,
            availableMinor: balanceState.byAccount[accountId],
          };
        },
      ),
    },
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
      findUnique: vi.fn(async () => transferState.completed),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const transfer = {
          id: "transfer_synthetic_1",
          senderId: String(data.senderId),
          recipientId: String(data.recipientId),
          amountMinor: Number(data.amountMinor),
          currency: String(data.currency),
          status: String(data.status),
          idempotencyKey: String(data.idempotencyKey),
        };
        transferState.completed = transfer;
        return { ...data, id: transfer.id };
      }),
      update: vi.fn(),
    },
    walletFundingIntent: { findUnique: vi.fn(), create: vi.fn() },
    walletLedgerPosting: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(),
    },
    walletLedgerTransaction: {
      create: vi.fn(async () => ({ id: "ledger_synthetic_transfer_1" })),
    },
    walletBalanceAllocation: { createMany: vi.fn() },
    auditLog: { create: vi.fn() },
    clubCoinEntry: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    clubCoinRule: { findMany: vi.fn() },
    $transaction: vi.fn(async (operation: (tx: typeof methods) => unknown) =>
      operation(methods),
    ),
  };
  return {
    actors,
    activeWallet,
    balanceState,
    env,
    methods,
    settings,
    transferState,
    verification,
  };
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
    mocks.balanceState.byAccount.buyer_wallet = 1_000;
    mocks.balanceState.byAccount.seller_wallet = 250;
    mocks.balanceState.forceDebitFailure = false;
    mocks.transferState.completed = null;
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

  it("posts a balanced transfer once and returns the existing result on exact replay", async () => {
    mocks.env.MONEY_MOVEMENT_HARD_DISABLED = false;
    const payload = {
      recipientEmail: "seller@example.test",
      amountMinor: 200,
      currency: "USD",
      idempotencyKey: "transfer_balanced_001",
    };

    const first = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      id: "transfer_synthetic_1",
      status: "COMPLETED",
      amountMinor: 200,
      currency: "USD",
    });
    expect(mocks.balanceState.byAccount).toEqual({
      buyer_wallet: 800,
      seller_wallet: 450,
    });
    expect(mocks.methods.walletLedgerPosting.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          accountId: "buyer_wallet",
          direction: "CREDIT",
          amountMinor: 200,
          currency: "USD",
        }),
        expect.objectContaining({
          accountId: "seller_wallet",
          direction: "DEBIT",
          amountMinor: 200,
          currency: "USD",
        }),
      ]),
    });
    expect(mocks.methods.walletBalanceAllocation.createMany).toHaveBeenCalled();
    expect(mocks.methods.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WALLET_TRANSFER_COMPLETED",
          actorId: "buyer_test",
        }),
      }),
    );

    const replay = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: "transfer_synthetic_1",
      status: "COMPLETED",
    });
    expect(mocks.methods.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.balanceState.byAccount).toEqual({
      buyer_wallet: 800,
      seller_wallet: 450,
    });

    const mismatchedReplay = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify({ ...payload, amountMinor: 201 }),
    });
    expect(mismatchedReplay.status).toBe(409);
    expect(await mismatchedReplay.json()).toMatchObject({
      error: "Idempotency key was already used for a different request",
    });
    expect(mocks.methods.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.balanceState.byAccount).toEqual({
      buyer_wallet: 800,
      seller_wallet: 450,
    });
  });

  it("rejects a transfer with insufficient funds before ledger or recipient balance writes", async () => {
    mocks.env.MONEY_MOVEMENT_HARD_DISABLED = false;
    mocks.balanceState.byAccount.buyer_wallet = 50;

    const response = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: "seller@example.test",
        amountMinor: 100,
        currency: "USD",
        idempotencyKey: "transfer_insufficient_001",
      }),
    });

    const responseBody = await response.json();
    expect({ status: response.status, body: responseBody }).toMatchObject({
      status: 409,
      body: { error: "Insufficient available wallet funds" },
    });
    expect(mocks.methods.walletLedgerTransaction.create).not.toHaveBeenCalled();
    expect(mocks.methods.walletBalance.update).not.toHaveBeenCalled();
    expect(mocks.methods.walletLedgerPosting.createMany).not.toHaveBeenCalled();
    expect(mocks.methods.walletTransfer.create).not.toHaveBeenCalled();
    expect(mocks.balanceState.byAccount).toEqual({
      buyer_wallet: 50,
      seller_wallet: 250,
    });
  });

  it("rejects a concurrent balance-debit race without posting the transfer", async () => {
    mocks.env.MONEY_MOVEMENT_HARD_DISABLED = false;
    mocks.balanceState.forceDebitFailure = true;

    const response = await request("/api/wallet/transfers", "buyer", {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: "seller@example.test",
        amountMinor: 200,
        currency: "USD",
        idempotencyKey: "transfer_debit_race_001",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Insufficient available wallet funds",
    });
    expect(mocks.methods.walletBalance.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.methods.walletLedgerTransaction.create).not.toHaveBeenCalled();
    expect(mocks.methods.walletBalance.update).not.toHaveBeenCalled();
    expect(mocks.methods.walletLedgerPosting.createMany).not.toHaveBeenCalled();
    expect(mocks.methods.walletTransfer.create).not.toHaveBeenCalled();
    expect(mocks.balanceState.byAccount).toEqual({
      buyer_wallet: 1_000,
      seller_wallet: 250,
    });
  });
});
