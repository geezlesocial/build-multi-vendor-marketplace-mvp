import assert from 'node:assert/strict';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TARGET_OWNERSHIP_TEST_DATABASE_URL;
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
if (!databaseUrl || !sandboxId) throw new Error('A per-run wallet funding database URL and sandbox identity are required');
validateE2EDatabaseURL(databaseUrl);

test('database and webhook enforce funding intent wallet ownership and USER account type', async () => {
  process.env.DOTENV_CONFIG_PATH = 'C:\\wallet-funding-test-env-file-must-not-exist';
  process.env.DATABASE_URL = databaseUrl;
  process.env.PASSWORD_PEPPER = 'synthetic-wallet-test-pepper-not-a-secret';
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_ID = sandboxId;
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = 'synthetic-test-treasury-not-used';

  const [config, { prisma }, funding] = await Promise.all([
    import('../apps/api/src/config.ts'),
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts')
  ]);
  if (!config.isDisposableDatabaseUrl(databaseUrl)) throw new Error('Wallet funding target ownership test refused a non-isolated database target');
  const owner = await prisma.user.create({ data: { email: `funding-target-owner-${Date.now()}@example.test`, name: 'Funding owner', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const other = await prisma.user.create({ data: { email: `funding-target-other-${Date.now()}@example.test`, name: 'Other owner', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const ownerWallet = await prisma.walletAccount.create({ data: { userId: owner.id, type: 'USER' } });
  const otherWallet = await prisma.walletAccount.create({ data: { userId: other.id, type: 'USER' } });
  const treasury = await prisma.walletAccount.create({ data: { type: 'TREASURY' } });

  try {
    await assert.rejects(() => prisma.walletFundingIntent.create({
      data: { userId: other.id, accountId: ownerWallet.id, amountMinor: 10, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_mismatch_owner', idempotencyKey: 'funding-target-mismatch-owner' }
    }));
    await assert.rejects(() => prisma.walletFundingIntent.create({
      data: { userId: owner.id, accountId: treasury.id, amountMinor: 10, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_mismatch_type', idempotencyKey: 'funding-target-mismatch-type' }
    }));

    const intent = await prisma.walletFundingIntent.create({
      data: { userId: owner.id, accountId: ownerWallet.id, amountMinor: 25, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_funding_target_runtime_guard', idempotencyKey: 'funding-target-runtime-guard' }
    });
    await assert.rejects(() => prisma.walletAccount.update({ where: { id: ownerWallet.id }, data: { userId: other.id } }));
    await assert.rejects(() => prisma.walletAccount.update({ where: { id: ownerWallet.id }, data: { type: 'TREASURY', userId: null } }));

    // Model a legacy/corrupted row by disabling only this test database's
    // application guard, then verify runtime webhook defense still holds.
    await prisma.$executeRawUnsafe('ALTER TABLE "WalletFundingIntent" DISABLE TRIGGER "WalletFundingIntent_user_wallet_guard_trigger"');
    try {
      await prisma.$executeRaw`UPDATE "WalletFundingIntent" SET "userId" = ${other.id} WHERE "id" = ${intent.id}`;
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "WalletFundingIntent" ENABLE TRIGGER "WalletFundingIntent_user_wallet_guard_trigger"');
    }

    const result = await funding.processWalletFundingEvent({
      provider: 'STRIPE',
      eventId: 'evt_funding_target_mismatch_runtime',
      eventType: 'payment_intent.succeeded',
      outcome: 'SUCCEEDED',
      providerIntentId: intent.providerIntentId,
      disputeId: null,
      fundingIntentId: intent.id,
      amountMinor: intent.amountMinor,
      amountReceivedMinor: intent.amountMinor,
      currency: intent.currency,
      purpose: 'wallet_top_up',
      liveMode: false
    });

    assert.deepEqual(result, { outcome: 'REVIEW_REQUIRED', intentId: intent.id, reason: 'FUNDING_TARGET_OWNERSHIP_OR_TYPE_MISMATCH' });
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: intent.id } })).status, 'REVIEW');
    assert.equal(await prisma.walletBalance.count({ where: { accountId: ownerWallet.id } }), 0);
    assert.equal(await prisma.walletBalance.count({ where: { accountId: otherWallet.id } }), 0);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: intent.id } }), 0);
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: 'evt_funding_target_mismatch_runtime' } } })).reviewReason, 'FUNDING_TARGET_OWNERSHIP_OR_TYPE_MISMATCH');
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_TARGET_REVIEW_REQUIRED', entityId: intent.id } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});
