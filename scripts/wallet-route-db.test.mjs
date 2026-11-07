import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { validateE2EDatabaseURL } from "./e2e-database-url.mjs";

const databaseUrl = process.env.WALLET_TEST_DATABASE_URL;
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
const runningInCI = /^(1|true)$/i.test(process.env.CI ?? "");
if (!databaseUrl && runningInCI) {
  throw new Error(
    "WALLET_TEST_DATABASE_URL is required in CI; refusing to skip disposable wallet route verification",
  );
}
if (databaseUrl) {
  validateE2EDatabaseURL(databaseUrl);
  if (!sandboxId)
    throw new Error(
      "WALLET_FUNDING_SANDBOX_ID must match the fresh disposable database identity",
    );
}

test(
  "wallet route and Club Coin idempotency checks require an explicit disposable database",
  { skip: !databaseUrl },
  async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.PASSWORD_PEPPER = "synthetic-wallet-test-pepper-not-a-secret";
    process.env.WALLET_FUNDING_SANDBOX_ID = sandboxId;
    process.env.WALLET_FUNDING_SANDBOX_MODE = "true";
    process.env.WALLET_FUNDING_PROVIDER_READY = "true";
    process.env.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST = "";
    process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID =
      "pending-synthetic-fixture-treasury";
    process.env.MONEY_MOVEMENT_HARD_DISABLED = "true";
    process.env.CLUB_COINS_HARD_DISABLED = "true";
    const [
      { app },
      security,
      walletRoutes,
      config,
      walletLedger,
      funding,
      walletIdentity,
    ] = await Promise.all([
      import("../apps/api/src/index.ts"),
      import("../apps/api/src/security.ts"),
      import("../apps/api/src/wallet-routes.ts"),
      import("../apps/api/src/config.ts"),
      import("../apps/api/src/wallet-ledger.ts"),
      import("../apps/api/src/wallet-funding.ts"),
      import("../apps/api/src/wallet-identity.ts"),
    ]);
    if (!config.isDisposableDatabaseUrl(databaseUrl))
      throw new Error(
        "Wallet route test refused a database outside the matching per-run disposable sandbox",
      );
    const { prisma, tokenHash } = security;
    const { applyClubCoinAdjustment, walletAudit } = walletRoutes;
    const {
      appendWalletAllocations,
      buildPostingAllocations,
      recordWalletStateTransition,
    } = walletLedger;
    const { env } = config;
    const verifiedAndOnboardedAt = new Date();
    const admin = await prisma.user.create({
      data: {
        email: `wallet-review-admin-${Date.now()}@example.test`,
        name: "Wallet Review Admin",
        role: "ADMIN",
        passwordHash: "synthetic-only",
        emailVerifiedAt: verifiedAndOnboardedAt,
        onboardingCompletedAt: verifiedAndOnboardedAt,
      },
    });
    const target = await prisma.user.create({
      data: {
        email: `wallet-review-target-${Date.now()}@example.test`,
        name: "Wallet Review Target",
        role: "BUYER",
        passwordHash: "synthetic-only",
        emailVerifiedAt: verifiedAndOnboardedAt,
        onboardingCompletedAt: verifiedAndOnboardedAt,
      },
    });
    const recipient = await prisma.user.create({
      data: {
        email: `wallet-review-recipient-${Date.now()}@example.test`,
        name: "Wallet Review Recipient",
        role: "BUYER",
        passwordHash: "synthetic-only",
        emailVerifiedAt: verifiedAndOnboardedAt,
        onboardingCompletedAt: verifiedAndOnboardedAt,
      },
    });
    const walletIds = new Set();
    const nextWalletId = () => {
      let walletId;
      do {
        walletId = walletIdentity.generateUserWalletId();
      } while (walletIds.has(walletId));
      walletIds.add(walletId);
      return walletId;
    };
    const walletAccount = await prisma.walletAccount.create({
      data: {
        userId: target.id,
        walletId: nextWalletId(),
        type: "USER",
        status: "ACTIVE",
      },
    });
    const recipientWalletAccount = await prisma.walletAccount.create({
      data: {
        userId: recipient.id,
        walletId: nextWalletId(),
        type: "USER",
        status: "ACTIVE",
      },
    });
    await prisma.walletBalance.create({
      data: {
        accountId: walletAccount.id,
        currency: "USD",
        availableMinor: 0,
        pendingMinor: 0,
        heldMinor: 0,
        frozenMinor: 0,
      },
    });
    await prisma.walletBalance.create({
      data: {
        accountId: recipientWalletAccount.id,
        currency: "USD",
        availableMinor: 0,
        pendingMinor: 0,
        heldMinor: 0,
        frozenMinor: 0,
      },
    });
    const treasuryAccount = await prisma.walletAccount.create({
      data: { type: "TREASURY", status: "ACTIVE" },
    });
    env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = treasuryAccount.id;
    await prisma.walletBalance.create({
      data: {
        accountId: treasuryAccount.id,
        currency: "USD",
        availableMinor: 100,
        pendingMinor: 0,
        heldMinor: 0,
        frozenMinor: 0,
      },
    });
    await prisma.walletBalanceAllocation.create({
      data: {
        accountId: treasuryAccount.id,
        currency: "USD",
        state: "AVAILABLE",
        deltaMinor: 100,
        idempotencyKey: "wallet-review-opening-baseline-1",
        referenceType: "OPENING_BALANCE",
        referenceId: treasuryAccount.id,
        isOpeningBaseline: true,
        baselineEvidenceRef: "WALLET-REVIEW-BASELINE-1",
        baselineVerified: true,
      },
    });
    await prisma.$transaction(async (tx) => {
      const opening = await tx.walletLedgerTransaction.create({
        data: {
          idempotencyKey: "wallet-review-opening-1",
          entryType: "FUNDING",
          status: "POSTED",
          currency: "USD",
          referenceType: "TEST_OPENING_BALANCE",
          referenceId: walletAccount.id,
        },
      });
      await tx.walletBalance.update({
        where: {
          accountId_currency: { accountId: walletAccount.id, currency: "USD" },
        },
        data: { availableMinor: { increment: 100 } },
      });
      await tx.walletBalance.update({
        where: {
          accountId_currency: {
            accountId: treasuryAccount.id,
            currency: "USD",
          },
        },
        data: { availableMinor: { decrement: 100 } },
      });
      const postings = [
        {
          transactionId: opening.id,
          accountId: walletAccount.id,
          direction: "DEBIT",
          amountMinor: 100,
          currency: "USD",
        },
        {
          transactionId: opening.id,
          accountId: treasuryAccount.id,
          direction: "CREDIT",
          amountMinor: 100,
          currency: "USD",
        },
      ];
      await tx.walletLedgerPosting.createMany({ data: postings });
      await appendWalletAllocations(
        tx,
        buildPostingAllocations(
          opening.id,
          "wallet-review-opening-1",
          postings,
        ),
      );
    });

    const first = await applyClubCoinAdjustment(admin.id, {
      userId: target.id,
      amount: 10,
      reason: "review adjustment",
      reference: "review-ref-1",
      idempotencyKey: "review-adjustment-1",
    });
    const retry = await applyClubCoinAdjustment(admin.id, {
      userId: target.id,
      amount: 10,
      reason: "review adjustment",
      reference: "review-ref-1",
      idempotencyKey: "review-adjustment-1",
    });
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.entry.id, first.entry.id);
    await assert.rejects(
      () =>
        applyClubCoinAdjustment(admin.id, {
          userId: target.id,
          amount: 11,
          reason: "review adjustment",
          reference: "review-ref-1",
          idempotencyKey: "review-adjustment-1",
        }),
      (error) => error?.statusCode === 409,
    );

    const concurrent = await Promise.all([
      applyClubCoinAdjustment(admin.id, {
        userId: target.id,
        amount: 7,
        reason: "concurrent adjustment",
        reference: "review-ref-2",
        idempotencyKey: "review-adjustment-2",
      }),
      applyClubCoinAdjustment(admin.id, {
        userId: target.id,
        amount: 7,
        reason: "concurrent adjustment",
        reference: "review-ref-2",
        idempotencyKey: "review-adjustment-2",
      }),
    ]);
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    assert.equal(concurrent[0].entry.id, concurrent[1].entry.id);
    const coinAccount = await prisma.clubCoinAccount.findUniqueOrThrow({
      where: { userId: target.id },
    });
    assert.equal(coinAccount.balance, 17);
    assert.equal(
      await prisma.clubCoinEntry.count({
        where: { accountId: coinAccount.id },
      }),
      2,
    );

    const sessionToken = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    await prisma.session.create({
      data: {
        tokenHash: tokenHash(sessionToken),
        userId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const senderSessionToken = randomBytes(32).toString("hex");
    const senderCsrfToken = randomBytes(32).toString("hex");
    await prisma.session.create({
      data: {
        tokenHash: tokenHash(senderSessionToken),
        userId: target.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cookie = `${env.SESSION_COOKIE_NAME}=${sessionToken}; marketplace_csrf=${csrfToken}`;
    const senderCookie = `${env.SESSION_COOKIE_NAME}=${senderSessionToken}; marketplace_csrf=${senderCsrfToken}`;
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const requestForCookie = (requestCookie, requestCsrf, path, options = {}) =>
      fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          cookie: requestCookie,
          "x-csrf-token": requestCsrf,
          ...(options.headers ?? {}),
        },
      });
    const request = (path, options = {}) =>
      requestForCookie(cookie, csrfToken, path, options);
    const senderRequest = (path, options = {}) =>
      requestForCookie(senderCookie, senderCsrfToken, path, options);
    const paymentIntents = new Map();
    funding.setWalletFundingProviderForTests({
      name: "STRIPE",
      createPaymentIntent: async (input) => {
        const paymentIntent = {
          providerIntentId: `pi_route_${input.fundingIntentId}`,
          clientSecret: `pi_route_${input.fundingIntentId}_secret_synthetic`,
          amountMinor: input.amountMinor,
          currency: input.currency.toUpperCase(),
          status: "requires_payment_method",
          liveMode: false,
          metadata: {
            scrolithFundingIntentId: input.fundingIntentId,
            scrolithFundingUserId: input.userId,
            scrolithIdempotencyKey: input.idempotencyKey,
            scrolithPurpose: "wallet_top_up",
          },
        };
        paymentIntents.set(paymentIntent.providerIntentId, paymentIntent);
        return paymentIntent;
      },
      retrievePaymentIntent: async (providerIntentId) =>
        paymentIntents.get(providerIntentId),
      verifyWebhook: () => {
        throw new Error("Webhook adapter is not used by this test");
      },
    });

    try {
      const beforeDisabled = await prisma.clubCoinEntry.count({
        where: { userId: target.id },
      });
      const disabledResponse = await request(
        "/api/admin/club-coins/adjustments",
        {
          method: "POST",
          body: JSON.stringify({
            userId: target.id,
            amount: 3,
            reason: "disabled route",
            reference: "disabled-route",
            idempotencyKey: "disabled-route-1",
          }),
        },
      );
      assert.equal(disabledResponse.status, 409);
      assert.equal(
        await prisma.clubCoinEntry.count({ where: { userId: target.id } }),
        beforeDisabled,
      );

      const originalMoneyGate = env.MONEY_MOVEMENT_HARD_DISABLED;
      const originalFundingReady = env.WALLET_FUNDING_PROVIDER_READY;
      const originalClubCoinsGate = env.CLUB_COINS_HARD_DISABLED;
      try {
        // These are process-local overrides in a disposable database only. The
        // production defaults remain hard-disabled and are restored in finally.
        env.MONEY_MOVEMENT_HARD_DISABLED = false;
        env.WALLET_FUNDING_PROVIDER_READY = true;
        env.CLUB_COINS_HARD_DISABLED = false;
        await prisma.marketplaceSettings.upsert({
          where: { id: "default" },
          update: {
            walletEnabled: true,
            walletTransfersEnabled: true,
            walletFundingEnabled: true,
            walletEmergencyPause: false,
            clubCoinsEnabled: true,
          },
          create: {
            id: "default",
            walletEnabled: true,
            walletTransfersEnabled: true,
            walletFundingEnabled: true,
            walletEmergencyPause: false,
            clubCoinsEnabled: true,
          },
        });

        const transferPayload = {
          recipientEmail: recipient.email,
          amountMinor: 10,
          currency: "USD",
          idempotencyKey: "route-transfer-race-1",
        };
        const transferResponses = await Promise.all([
          senderRequest("/api/wallet/transfers", {
            method: "POST",
            body: JSON.stringify(transferPayload),
          }),
          senderRequest("/api/wallet/transfers", {
            method: "POST",
            body: JSON.stringify(transferPayload),
          }),
        ]);
        const transferBodies = await Promise.all(
          transferResponses.map((response) => response.json()),
        );
        assert.equal(
          transferResponses.filter((response) => response.status === 201)
            .length,
          1,
        );
        assert.equal(
          transferResponses.filter((response) => response.status === 200)
            .length,
          1,
        );
        assert.equal(transferBodies[0].id, transferBodies[1].id);
        const transferConflict = await senderRequest("/api/wallet/transfers", {
          method: "POST",
          body: JSON.stringify({ ...transferPayload, amountMinor: 11 }),
        });
        assert.equal(transferConflict.status, 409);

        const fundingPayload = {
          amountMinor: 25,
          currency: "USD",
          provider: "STRIPE",
          idempotencyKey: "route-funding-race-1",
        };
        const fundingResponses = await Promise.all([
          senderRequest("/api/wallet/funding-intents", {
            method: "POST",
            body: JSON.stringify(fundingPayload),
          }),
          senderRequest("/api/wallet/funding-intents", {
            method: "POST",
            body: JSON.stringify(fundingPayload),
          }),
        ]);
        const fundingBodies = await Promise.all(
          fundingResponses.map((response) => response.json()),
        );
        assert.equal(
          fundingResponses.filter((response) => response.status === 201).length,
          1,
        );
        assert.equal(
          fundingResponses.filter((response) => response.status === 200).length,
          1,
        );
        assert.equal(fundingBodies[0].id, fundingBodies[1].id);
        const unsupportedFundingProvider = await senderRequest(
          "/api/wallet/funding-intents",
          {
            method: "POST",
            body: JSON.stringify({ ...fundingPayload, provider: "OTHER_TEST" }),
          },
        );
        assert.equal(unsupportedFundingProvider.status, 400);
        const fundingConflict = await senderRequest(
          "/api/wallet/funding-intents",
          {
            method: "POST",
            body: JSON.stringify({ ...fundingPayload, amountMinor: 26 }),
          },
        );
        assert.equal(fundingConflict.status, 409);

        const transferRecord = await prisma.walletTransfer.findUniqueOrThrow({
          where: { idempotencyKey: transferPayload.idempotencyKey },
        });
        const transferAllocations =
          await prisma.walletBalanceAllocation.findMany({
            where: { transactionId: transferRecord.ledgerTransactionId },
          });
        assert.equal(transferAllocations.length, 2);
        assert.equal(
          transferAllocations.reduce((sum, item) => sum + item.deltaMinor, 0),
          0,
        );
        await prisma.$transaction((tx) =>
          recordWalletStateTransition(tx, {
            accountId: walletAccount.id,
            currency: "USD",
            fromState: "AVAILABLE",
            toState: "PENDING",
            amountMinor: 20,
            referenceId: "state-transition-available-pending",
            idempotencyKey: "state-transition-available-pending",
          }),
        );
        await prisma.$transaction((tx) =>
          recordWalletStateTransition(tx, {
            accountId: walletAccount.id,
            currency: "USD",
            fromState: "PENDING",
            toState: "HELD",
            amountMinor: 20,
            referenceId: "state-transition-pending-held",
            idempotencyKey: "state-transition-pending-held",
          }),
        );
        await prisma.$transaction((tx) =>
          recordWalletStateTransition(tx, {
            accountId: walletAccount.id,
            currency: "USD",
            fromState: "HELD",
            toState: "FROZEN",
            amountMinor: 20,
            referenceId: "state-transition-held-frozen",
            idempotencyKey: "state-transition-held-frozen",
          }),
        );
        await prisma.$transaction((tx) =>
          recordWalletStateTransition(tx, {
            accountId: walletAccount.id,
            currency: "USD",
            fromState: "FROZEN",
            toState: "AVAILABLE",
            amountMinor: 20,
            referenceId: "state-transition-frozen-available",
            idempotencyKey: "state-transition-frozen-available",
          }),
        );
        const concurrentStateTransitions = await Promise.allSettled([
          prisma.$transaction((tx) =>
            recordWalletStateTransition(tx, {
              accountId: walletAccount.id,
              currency: "USD",
              fromState: "AVAILABLE",
              toState: "HELD",
              amountMinor: 60,
              referenceId: "state-transition-race-1",
              idempotencyKey: "state-transition-race-1",
            }),
          ),
          prisma.$transaction((tx) =>
            recordWalletStateTransition(tx, {
              accountId: walletAccount.id,
              currency: "USD",
              fromState: "AVAILABLE",
              toState: "HELD",
              amountMinor: 60,
              referenceId: "state-transition-race-2",
              idempotencyKey: "state-transition-race-2",
            }),
          ),
        ]);
        assert.equal(
          concurrentStateTransitions.filter(
            (result) => result.status === "fulfilled",
          ).length,
          1,
        );
        assert.equal(
          concurrentStateTransitions.filter(
            (result) => result.status === "rejected",
          ).length,
          1,
        );
        await prisma.$transaction((tx) =>
          recordWalletStateTransition(tx, {
            accountId: walletAccount.id,
            currency: "USD",
            fromState: "HELD",
            toState: "AVAILABLE",
            amountMinor: 60,
            referenceId: "state-transition-race-release",
            idempotencyKey: "state-transition-race-release",
          }),
        );
        const stateBalance = await prisma.walletBalance.findUniqueOrThrow({
          where: {
            accountId_currency: {
              accountId: walletAccount.id,
              currency: "USD",
            },
          },
        });
        assert.equal(stateBalance.availableMinor, 90);
        assert.equal(stateBalance.pendingMinor, 0);
        assert.equal(stateBalance.heldMinor, 0);
        assert.equal(stateBalance.frozenMinor, 0);

        const beforeRejectedLedgerCount =
          await prisma.walletLedgerTransaction.count();
        const beforeRejectedAllocationCount =
          await prisma.walletBalanceAllocation.count();
        await assert.rejects(() =>
          prisma.$transaction(async (tx) => {
            const invalid = await tx.walletLedgerTransaction.create({
              data: {
                idempotencyKey: "wallet-review-invalid-allocation-1",
                entryType: "TRANSFER",
                status: "POSTED",
                currency: "USD",
                referenceType: "TEST_INVALID_ALLOCATION",
              },
            });
            await tx.walletLedgerPosting.createMany({
              data: [
                {
                  transactionId: invalid.id,
                  accountId: walletAccount.id,
                  direction: "CREDIT",
                  amountMinor: 9,
                  currency: "USD",
                },
                {
                  transactionId: invalid.id,
                  accountId: recipientWalletAccount.id,
                  direction: "DEBIT",
                  amountMinor: 9,
                  currency: "USD",
                },
              ],
            });
            await tx.walletBalanceAllocation.create({
              data: {
                accountId: walletAccount.id,
                transactionId: invalid.id,
                currency: "USD",
                state: "AVAILABLE",
                deltaMinor: -8,
                idempotencyKey: "wallet-review-invalid-allocation-entry-1",
                referenceType: "LEDGER_POSTING",
                referenceId: invalid.id,
              },
            });
          }),
        );
        assert.equal(
          await prisma.walletLedgerTransaction.count(),
          beforeRejectedLedgerCount,
        );
        assert.equal(
          await prisma.walletBalanceAllocation.count(),
          beforeRejectedAllocationCount,
        );

        const beforeRejectedState =
          await prisma.walletBalance.findUniqueOrThrow({
            where: {
              accountId_currency: {
                accountId: walletAccount.id,
                currency: "USD",
              },
            },
          });
        const beforeRejectedStateAllocations =
          await prisma.walletBalanceAllocation.count();
        await assert.rejects(() =>
          prisma.$transaction((tx) =>
            recordWalletStateTransition(tx, {
              accountId: walletAccount.id,
              currency: "USD",
              fromState: "AVAILABLE",
              toState: "HELD",
              amountMinor: 10_000,
              referenceId: "state-transition-insufficient",
              idempotencyKey: "state-transition-insufficient",
            }),
          ),
        );
        const afterRejectedState = await prisma.walletBalance.findUniqueOrThrow(
          {
            where: {
              accountId_currency: {
                accountId: walletAccount.id,
                currency: "USD",
              },
            },
          },
        );
        assert.deepEqual(afterRejectedState, beforeRejectedState);
        assert.equal(
          await prisma.walletBalanceAllocation.count(),
          beforeRejectedStateAllocations,
        );

        const beforeCoinEntries = await prisma.clubCoinEntry.count({
          where: { userId: target.id },
        });
        const beforeCoinAudits = await prisma.auditLog.count({
          where: { entity: "ClubCoinEntry", entityId: { not: null } },
        });
        const beforeCoinBalance = (
          await prisma.clubCoinAccount.findUniqueOrThrow({
            where: { userId: target.id },
          })
        ).balance;
        const originalAuditWrite = walletAudit.write;
        walletAudit.write = async () => {
          throw new Error("synthetic Club Coin audit failure");
        };
        let failedAdjustment;
        try {
          failedAdjustment = await request(
            "/api/admin/club-coins/adjustments",
            {
              method: "POST",
              body: JSON.stringify({
                userId: target.id,
                amount: 3,
                reason: "audit rollback",
                reference: "audit-rollback-1",
                idempotencyKey: "audit-rollback-1",
              }),
            },
          );
        } finally {
          walletAudit.write = originalAuditWrite;
        }
        assert.equal(failedAdjustment.status, 500);
        assert.equal(
          await prisma.clubCoinEntry.count({ where: { userId: target.id } }),
          beforeCoinEntries,
        );
        assert.equal(
          (
            await prisma.clubCoinAccount.findUniqueOrThrow({
              where: { userId: target.id },
            })
          ).balance,
          beforeCoinBalance,
        );
        assert.equal(
          await prisma.auditLog.count({
            where: { entity: "ClubCoinEntry", entityId: { not: null } },
          }),
          beforeCoinAudits,
        );
      } finally {
        env.MONEY_MOVEMENT_HARD_DISABLED = originalMoneyGate;
        env.WALLET_FUNDING_PROVIDER_READY = originalFundingReady;
        env.CLUB_COINS_HARD_DISABLED = originalClubCoinsGate;
        await prisma.marketplaceSettings.update({
          where: { id: "default" },
          data: {
            walletEnabled: false,
            walletTransfersEnabled: false,
            walletFundingEnabled: false,
            walletEmergencyPause: true,
            clubCoinsEnabled: false,
          },
        });
      }

      const beforeAudit = await prisma.auditLog.count({
        where: { entity: "WalletAccount", entityId: walletAccount.id },
      });
      const originalAuditWrite = walletAudit.write;
      walletAudit.write = async () => {
        throw new Error("synthetic audit failure");
      };
      const failedStatus = await request(
        `/api/admin/wallet/users/${target.id}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "FROZEN", reason: "fault injection" }),
        },
      );
      walletAudit.write = originalAuditWrite;
      assert.equal(failedStatus.status, 500);
      assert.equal(
        (
          await prisma.walletAccount.findUniqueOrThrow({
            where: { id: walletAccount.id },
          })
        ).status,
        "ACTIVE",
      );
      assert.equal(
        await prisma.auditLog.count({
          where: { entity: "WalletAccount", entityId: walletAccount.id },
        }),
        beforeAudit,
      );

      const successfulStatus = await request(
        `/api/admin/wallet/users/${target.id}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "FROZEN",
            reason: "approved review state",
          }),
        },
      );
      assert.equal(successfulStatus.status, 200);
      assert.equal(
        (
          await prisma.walletAccount.findUniqueOrThrow({
            where: { id: walletAccount.id },
          })
        ).status,
        "FROZEN",
      );
      assert.equal(
        await prisma.auditLog.count({
          where: { entity: "WalletAccount", entityId: walletAccount.id },
        }),
        beforeAudit + 1,
      );

      const reconciliation = await request("/api/admin/wallet/reconciliation");
      assert.equal(reconciliation.status, 200);
      const reconciliationBody = await reconciliation.json();
      assert.equal(reconciliationBody.status, "MATCHED");
      assert.equal(reconciliationBody.rows[0].currency, "USD");
    } finally {
      funding.setWalletFundingProviderForTests(null);
      server.close();
      await once(server, "close").catch(() => undefined);
      await prisma.$disconnect();
    }
  },
);
