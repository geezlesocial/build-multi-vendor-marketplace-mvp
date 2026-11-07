import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { validateE2EDatabaseURL } from "./e2e-database-url.mjs";

const databaseUrl = process.env.WALLET_FUNDING_RETRY_TEST_DATABASE_URL;
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
if (!databaseUrl || !sandboxId)
  throw new Error("A fresh per-run wallet funding retry database is required");
validateE2EDatabaseURL(databaseUrl);

test("authenticated funding retry recovers only its owner-validated existing PaymentIntent", async () => {
  process.env.DOTENV_CONFIG_PATH =
    "C:\\wallet-funding-test-env-file-must-not-exist";
  process.env.DATABASE_URL = databaseUrl;
  process.env.PASSWORD_PEPPER = "synthetic-wallet-test-pepper-not-a-secret";
  process.env.NODE_ENV = "test";
  process.env.WALLET_FUNDING_SANDBOX_ID = sandboxId;
  process.env.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST = "";
  process.env.WALLET_FUNDING_SANDBOX_MODE = "true";
  process.env.WALLET_FUNDING_PROVIDER_READY = "true";
  process.env.MONEY_MOVEMENT_HARD_DISABLED = "false";
  process.env.CLUB_COINS_HARD_DISABLED = "true";
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID =
    "synthetic-test-treasury-not-used";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";

  const [config, { app }, security, funding] = await Promise.all([
    import("../apps/api/src/config.ts"),
    import("../apps/api/src/index.ts"),
    import("../apps/api/src/security.ts"),
    import("../apps/api/src/wallet-funding.ts"),
  ]);
  if (!config.isDisposableDatabaseUrl(databaseUrl))
    throw new Error(
      "Funding retry test refused a non-isolated database target",
    );
  const { prisma, tokenHash } = security;
  const paymentIntents = new Map();
  let retrieveMode = "valid";
  let createCalls = 0;
  let retrieveCalls = 0;
  const mockProvider = {
    name: "STRIPE",
    createPaymentIntent: async (input) => {
      createCalls += 1;
      const payment = {
        providerIntentId: `pi_retry_${input.fundingIntentId}`,
        clientSecret: `pi_retry_${input.fundingIntentId}_secret_synthetic`,
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
      paymentIntents.set(payment.providerIntentId, payment);
      return payment;
    },
    retrievePaymentIntent: async (providerIntentId) => {
      retrieveCalls += 1;
      if (retrieveMode === "error")
        throw new Error("synthetic provider outage detail");
      const payment = paymentIntents.get(providerIntentId);
      if (retrieveMode === "mismatch")
        return { ...payment, amountMinor: payment.amountMinor + 1 };
      return payment;
    },
    verifyWebhook: () => {
      throw new Error("Webhook adapter is not used by this test");
    },
  };
  funding.setWalletFundingProviderForTests(mockProvider);

  const verifiedAndOnboardedAt = new Date();
  const buyer = await prisma.user.create({
    data: {
      email: `funding-retry-owner-${Date.now()}@example.test`,
      name: "Retry owner",
      role: "BUYER",
      passwordHash: "synthetic-only",
      emailVerifiedAt: verifiedAndOnboardedAt,
      onboardingCompletedAt: verifiedAndOnboardedAt,
    },
  });
  const otherBuyer = await prisma.user.create({
    data: {
      email: `funding-retry-other-${Date.now()}@example.test`,
      name: "Other buyer",
      role: "BUYER",
      passwordHash: "synthetic-only",
      emailVerifiedAt: verifiedAndOnboardedAt,
      onboardingCompletedAt: verifiedAndOnboardedAt,
    },
  });
  const makeAuth = async (userId) => {
    const sessionToken = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    await prisma.session.create({
      data: {
        tokenHash: tokenHash(sessionToken),
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { sessionToken, csrfToken };
  };
  const ownerAuth = await makeAuth(buyer.id);
  const otherAuth = await makeAuth(otherBuyer.id);
  await prisma.marketplaceSettings.upsert({
    where: { id: "default" },
    update: {
      walletEnabled: true,
      walletFundingEnabled: true,
      walletEmergencyPause: false,
    },
    create: {
      id: "default",
      walletEnabled: true,
      walletFundingEnabled: true,
      walletEmergencyPause: false,
    },
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const payload = {
    amountMinor: 2750,
    currency: "USD",
    provider: "STRIPE",
    idempotencyKey: "funding-retry-idempotency-001",
  };
  const request = (auth, body = payload) =>
    fetch(`${baseUrl}/api/wallet/funding-intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${config.env.SESSION_COOKIE_NAME}=${auth.sessionToken}; marketplace_csrf=${auth.csrfToken}`,
        "x-csrf-token": auth.csrfToken,
      },
      body: JSON.stringify(body),
    });

  try {
    // The first server response is deliberately discarded to simulate client-side response loss.
    const lostResponse = await request(ownerAuth);
    assert.equal(lostResponse.status, 201);
    assert.equal(createCalls, 1);
    const intent = await prisma.walletFundingIntent.findUniqueOrThrow({
      where: { idempotencyKey: payload.idempotencyKey },
    });
    assert.ok(intent.providerIntentId);

    const recoveredResponse = await request(ownerAuth);
    const recoveredBody = await recoveredResponse.json();
    assert.equal(recoveredResponse.status, 200);
    assert.equal(recoveredBody.providerIntentId, intent.providerIntentId);
    assert.equal(
      recoveredBody.clientSecret,
      paymentIntents.get(intent.providerIntentId).clientSecret,
    );
    assert.equal(retrieveCalls, 1);
    assert.equal(createCalls, 1);

    const retrievesBeforeWrongOwner = retrieveCalls;
    const wrongOwnerResponse = await request(otherAuth);
    const wrongOwnerBody = await wrongOwnerResponse.json();
    assert.equal(wrongOwnerResponse.status, 409);
    assert.equal(
      JSON.stringify(wrongOwnerBody).includes("clientSecret"),
      false,
    );
    assert.equal(retrieveCalls, retrievesBeforeWrongOwner);

    retrieveMode = "mismatch";
    const mismatchResponse = await request(ownerAuth);
    assert.equal(mismatchResponse.status, 503);
    assert.equal(
      (await mismatchResponse.text()).includes("clientSecret"),
      false,
    );
    retrieveMode = "error";
    const providerErrorResponse = await request(ownerAuth);
    assert.equal(providerErrorResponse.status, 503);
    assert.equal(
      (await providerErrorResponse.text()).includes(
        "synthetic provider outage detail",
      ),
      false,
    );
    assert.equal(
      (
        await prisma.walletFundingIntent.findUniqueOrThrow({
          where: { id: intent.id },
        })
      ).status,
      "PENDING",
    );
    assert.equal(createCalls, 1);
  } finally {
    funding.setWalletFundingProviderForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
