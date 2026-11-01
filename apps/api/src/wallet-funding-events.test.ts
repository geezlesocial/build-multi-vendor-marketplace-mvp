import {
  WalletAccountStatus,
  WalletAccountType,
  WalletFundingStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sandboxId = "0123456789abcdef0123456789abcdef";
  const databaseUrl = `postgresql://test:test@127.0.0.1:55439/wallet_funding_test_${sandboxId}?schema=public`;
  const env = {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    WALLET_FUNDING_SANDBOX_ID: sandboxId,
    WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST: "",
    WALLET_FUNDING_SANDBOX_MODE: true,
    WALLET_FUNDING_PROVIDER_READY: true,
    MONEY_MOVEMENT_HARD_DISABLED: false,
    WALLET_FUNDING_TREASURY_ACCOUNT_ID: "treasury_test",
  };
  const tx = {
    $queryRaw: vi.fn(async (..._args: unknown[]): Promise<unknown> => []),
    processedWebhookEvent: {
      createMany: vi.fn(async (_input: unknown): Promise<unknown> => ({
        count: 1,
      })),
      findUnique: vi.fn(async (_input: unknown): Promise<unknown> => null),
      update: vi.fn(async (_input: unknown): Promise<unknown> => null),
    },
    walletFundingIntent: {
      findUnique: vi.fn(async (_input: unknown): Promise<unknown> => null),
      update: vi.fn(async (_input: unknown): Promise<unknown> => null),
      updateMany: vi.fn(async (_input: unknown): Promise<unknown> => ({
        count: 1,
      })),
    },
    walletAccount: {
      findUnique: vi.fn(async (_input: unknown): Promise<unknown> => null),
      updateMany: vi.fn(async (_input: unknown): Promise<unknown> => ({
        count: 1,
      })),
    },
    walletBalance: {
      upsert: vi.fn(async (_input: unknown): Promise<unknown> => null),
      findUnique: vi.fn(async (_input: unknown): Promise<unknown> => null),
      updateMany: vi.fn(async (_input: unknown): Promise<unknown> => ({
        count: 1,
      })),
      update: vi.fn(async (_input: unknown): Promise<unknown> => null),
    },
    walletLedgerTransaction: {
      findUnique: vi.fn(async (_input: unknown): Promise<unknown> => null),
      create: vi.fn(async (_input: unknown): Promise<unknown> => ({
        id: "ledger_test",
      })),
    },
    walletLedgerPosting: {
      createMany: vi.fn(async (_input: unknown): Promise<unknown> => ({
        count: 2,
      })),
    },
    walletBalanceAllocation: {
      createMany: vi.fn(async (_input: unknown): Promise<unknown> => ({
        count: 2,
      })),
    },
    auditLog: {
      create: vi.fn(async (_input: unknown): Promise<unknown> => null),
    },
  };
  const transaction = vi.fn(
    async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  );
  const prisma = { $transaction: transaction };
  const isDisposableDatabaseUrl = vi.fn((url: string) => url === databaseUrl);
  return {
    databaseUrl,
    env,
    isDisposableDatabaseUrl,
    prisma,
    sandboxId,
    transaction,
    tx,
  };
});

vi.mock("./config.js", () => ({
  env: mocks.env,
  isDisposableDatabaseUrl: mocks.isDisposableDatabaseUrl,
}));
vi.mock("./payments.js", () => ({ stripe: null }));
vi.mock("./security.js", () => ({ prisma: mocks.prisma }));

import { isDisposableWalletFundingDatabaseUrl } from "./wallet-safety.js";
import {
  processWalletFundingEvent,
  WalletFundingRetryableError,
  type WalletFundingProviderEvent,
} from "./wallet-funding.js";

const intent = {
  id: "funding_test",
  userId: "user_test",
  accountId: "wallet_test",
  amountMinor: 2750,
  currency: "USD",
  provider: "STRIPE",
  providerIntentId: "pi_synthetic_test",
  disputeId: null,
  status: WalletFundingStatus.PENDING,
  refundObservedMinor: 0,
  refundAppliedMinor: 0,
  refundShortfallMinor: 0,
  disputeAmountMinor: 0,
  disputeHeldMinor: 0,
  disputeShortfallMinor: 0,
  disputeStatus: null,
};

function successfulEvent(
  overrides: Partial<WalletFundingProviderEvent> = {},
): WalletFundingProviderEvent {
  return {
    provider: "STRIPE",
    eventId: "evt_synthetic_test",
    eventType: "payment_intent.succeeded",
    outcome: "SUCCEEDED",
    providerIntentId: intent.providerIntentId,
    disputeId: null,
    fundingIntentId: intent.id,
    amountMinor: intent.amountMinor,
    amountReceivedMinor: intent.amountMinor,
    currency: intent.currency,
    purpose: "wallet_top_up",
    liveMode: false,
    ...overrides,
  };
}

function prepareMatchedIntent(targetOwner = intent.userId) {
  mocks.tx.$queryRaw.mockResolvedValueOnce([intent]).mockResolvedValueOnce([
    {
      id: intent.accountId,
      userId: targetOwner,
      type: WalletAccountType.USER,
    },
  ]);
}

function prepareSuccessfulCredit() {
  mocks.tx.walletAccount.findUnique
    .mockResolvedValueOnce({
      id: intent.accountId,
      userId: intent.userId,
      type: WalletAccountType.USER,
      status: WalletAccountStatus.ACTIVE,
    })
    .mockResolvedValueOnce({
      id: "treasury_test",
      type: WalletAccountType.TREASURY,
      status: WalletAccountStatus.ACTIVE,
    });
  mocks.tx.walletBalance.upsert.mockResolvedValueOnce({
    id: "user_balance_test",
  });
  mocks.tx.walletBalance.findUnique.mockResolvedValueOnce({
    id: "treasury_balance_test",
  });
}

describe("wallet funding provider event processing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(mocks.env, {
      NODE_ENV: "test",
      DATABASE_URL: mocks.databaseUrl,
      WALLET_FUNDING_SANDBOX_ID: mocks.sandboxId,
      WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST: "",
      WALLET_FUNDING_SANDBOX_MODE: true,
      WALLET_FUNDING_PROVIDER_READY: true,
      MONEY_MOVEMENT_HARD_DISABLED: false,
      WALLET_FUNDING_TREASURY_ACCOUNT_ID: "treasury_test",
    });
    mocks.isDisposableDatabaseUrl.mockImplementation((url) =>
      isDisposableWalletFundingDatabaseUrl(
        url,
        mocks.env.WALLET_FUNDING_SANDBOX_ID,
        mocks.env.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST,
      ),
    );
    mocks.transaction.mockImplementation(async (callback) =>
      callback(mocks.tx),
    );
    mocks.tx.processedWebhookEvent.createMany.mockResolvedValue({ count: 1 });
    mocks.tx.processedWebhookEvent.findUnique.mockResolvedValue(null);
    mocks.tx.walletFundingIntent.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.walletAccount.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.walletBalance.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.walletLedgerTransaction.create.mockResolvedValue({
      id: "ledger_test",
    });
    mocks.tx.walletLedgerPosting.createMany.mockResolvedValue({ count: 2 });
    mocks.tx.walletBalanceAllocation.createMany.mockResolvedValue({ count: 2 });
    mocks.tx.auditLog.create.mockResolvedValue(null);
  });

  it("fails closed before database work when the explicit sandbox gate is disabled", async () => {
    mocks.env.WALLET_FUNDING_SANDBOX_MODE = false;

    await expect(
      processWalletFundingEvent(successfulEvent()),
    ).rejects.toBeInstanceOf(WalletFundingRetryableError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      "remote host",
      {
        DATABASE_URL: `postgresql://test:test@db.example.test:55439/wallet_funding_test_${mocks.sandboxId}?schema=public`,
      },
    ],
    [
      "mismatched sandbox identity",
      { WALLET_FUNDING_SANDBOX_ID: "ffffffffffffffffffffffffffffffff" },
    ],
    [
      "default PostgreSQL port",
      { DATABASE_URL: mocks.databaseUrl.replace(":55439", ":5432") },
    ],
    [
      "nonmatching database allowlist",
      {
        WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST:
          "wallet_funding_test_other",
      },
    ],
  ] as const)("fails closed for an unsafe %s", async (_label, overrides) => {
    Object.assign(mocks.env, overrides);

    await expect(
      processWalletFundingEvent(successfulEvent()),
    ).rejects.toBeInstanceOf(WalletFundingRetryableError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("credits the owned user wallet and treasury exactly once for a verified sandbox capture", async () => {
    prepareMatchedIntent();
    prepareSuccessfulCredit();

    await expect(processWalletFundingEvent(successfulEvent())).resolves.toEqual(
      { outcome: "SUCCEEDED", intentId: intent.id },
    );

    expect(mocks.tx.walletBalance.updateMany).toHaveBeenCalledWith({
      where: {
        id: "treasury_balance_test",
        availableMinor: { gte: intent.amountMinor },
      },
      data: { availableMinor: { decrement: intent.amountMinor } },
    });
    expect(mocks.tx.walletBalance.update).toHaveBeenCalledWith({
      where: { id: "user_balance_test" },
      data: { availableMinor: { increment: intent.amountMinor } },
    });
    expect(mocks.tx.walletLedgerTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: `wallet-funding:${intent.id}:${intent.providerIntentId}`,
        currency: intent.currency,
        referenceId: intent.id,
      }),
    });
    const postings = mocks.tx.walletLedgerPosting.createMany.mock
      .calls[0]?.[0] as {
      data: { accountId: string; direction: string; amountMinor: number }[];
    };
    expect(postings.data).toEqual([
      expect.objectContaining({
        accountId: intent.accountId,
        direction: "DEBIT",
        amountMinor: intent.amountMinor,
      }),
      expect.objectContaining({
        accountId: "treasury_test",
        direction: "CREDIT",
        amountMinor: intent.amountMinor,
      }),
    ]);
    const allocations = mocks.tx.walletBalanceAllocation.createMany.mock
      .calls[0]?.[0] as { data: { accountId: string; deltaMinor: number }[] };
    expect(allocations.data).toEqual([
      expect.objectContaining({
        accountId: intent.accountId,
        deltaMinor: intent.amountMinor,
      }),
      expect.objectContaining({
        accountId: "treasury_test",
        deltaMinor: -intent.amountMinor,
      }),
    ]);
    expect(mocks.tx.walletFundingIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: intent.id,
          status: {
            in: [WalletFundingStatus.PENDING, WalletFundingStatus.FAILED],
          },
        },
        data: expect.objectContaining({
          status: WalletFundingStatus.SUCCEEDED,
          failureReason: null,
        }),
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "WALLET_FUNDING_CONFIRMED",
        entityId: intent.id,
      }),
    });
  });

  it.each([
    [
      "amount mismatch",
      { amountMinor: 100, amountReceivedMinor: 100 },
      "AMOUNT_MISMATCH",
    ],
    ["live-mode event", { liveMode: true }, "LIVE_PROVIDER_EVENT_REJECTED"],
  ] as const)(
    "rejects a %s without posting wallet balances",
    async (_label, overrides, reason) => {
      prepareMatchedIntent();

      await expect(
        processWalletFundingEvent(successfulEvent(overrides)),
      ).resolves.toMatchObject({ outcome: "REJECTED", reason });

      expect(mocks.tx.walletAccount.findUnique).not.toHaveBeenCalled();
      expect(mocks.tx.walletLedgerTransaction.create).not.toHaveBeenCalled();
      expect(mocks.tx.walletFundingIntent.updateMany).not.toHaveBeenCalled();
      expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "WALLET_FUNDING_WEBHOOK_REJECTED",
          metadata: expect.objectContaining({ reason }),
        }),
      });
    },
  );

  it("routes a funding target owned by another user to review without crediting either wallet", async () => {
    prepareMatchedIntent("different_user");

    await expect(
      processWalletFundingEvent(successfulEvent()),
    ).resolves.toMatchObject({
      outcome: "REVIEW_REQUIRED",
      intentId: intent.id,
      reason: "FUNDING_TARGET_OWNERSHIP_OR_TYPE_MISMATCH",
    });

    expect(mocks.tx.processedWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reviewReason: "FUNDING_TARGET_OWNERSHIP_OR_TYPE_MISMATCH" },
      }),
    );
    expect(mocks.tx.walletFundingIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: intent.id },
        data: expect.objectContaining({ status: WalletFundingStatus.REVIEW }),
      }),
    );
    expect(mocks.tx.walletBalance.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.walletLedgerTransaction.create).not.toHaveBeenCalled();
  });

  it("treats an already-processed provider event as a duplicate without locking or posting", async () => {
    mocks.tx.processedWebhookEvent.createMany.mockResolvedValueOnce({
      count: 0,
    });
    mocks.tx.processedWebhookEvent.findUnique.mockResolvedValueOnce({
      reviewReason: null,
    });

    await expect(processWalletFundingEvent(successfulEvent())).resolves.toEqual(
      { outcome: "DUPLICATE" },
    );

    expect(mocks.tx.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.tx.walletLedgerTransaction.create).not.toHaveBeenCalled();
  });
});
