import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required in CI; refusing to skip disposable wallet funding recovery verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('webhook delivery remains retryable across provider-reference persistence failure', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = 'wallet-funding-recovery-test-treasury';

  const [{ prisma }, funding] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts')
  ]);
  const { processWalletFundingEvent, StripeWalletFundingProvider, walletFundingSandboxEnabled } = funding;
  const target = await prisma.user.create({ data: { email: `wallet-funding-recovery-${Date.now()}@example.test`, name: 'Wallet Funding Recovery Target', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const targetAccount = await prisma.walletAccount.create({ data: { userId: target.id, type: 'USER', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: targetAccount.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletAccount.create({ data: { id: 'wallet-funding-recovery-test-treasury', type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: 'wallet-funding-recovery-test-treasury', currency: 'USD', availableMinor: 10, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletBalanceAllocation.create({ data: { accountId: 'wallet-funding-recovery-test-treasury', currency: 'USD', state: 'AVAILABLE', deltaMinor: 10, idempotencyKey: 'wallet-funding-recovery-opening', referenceType: 'OPENING_BALANCE', referenceId: 'wallet-funding-recovery-test-treasury', isOpeningBaseline: true, baselineEvidenceRef: 'DISPOSABLE-WALLET-FUNDING-RECOVERY', baselineVerified: true } });

  const fundingStateCounts = async () => Promise.all([
    prisma.walletFundingIntent.count(),
    prisma.walletBalance.count(),
    prisma.walletLedgerTransaction.count(),
    prisma.walletBalanceAllocation.count(),
    prisma.processedWebhookEvent.count()
  ]);
  assert.equal(walletFundingSandboxEnabled('postgresql://user:password@db.example.test:5432/wallet_funding_test'), false);
  assert.equal(walletFundingSandboxEnabled('postgresql://user:password@127.0.0.1:5432/marketplace'), false);
  assert.equal(walletFundingSandboxEnabled(databaseUrl), true);
  const beforeRejectedTarget = await fundingStateCounts();
  assert.equal(walletFundingSandboxEnabled('postgresql://user:password@db.example.test:5432/wallet_funding_test'), false);
  assert.deepEqual(await fundingStateCounts(), beforeRejectedTarget);

  try {
    const intent = await prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: targetAccount.id, amountMinor: 3, currency: 'USD', provider: 'STRIPE', idempotencyKey: 'wallet-funding-recovery-intent' } });
    const providerCalls = [];
    const mockProvider = {
      createPaymentIntent: async input => {
        providerCalls.push(input);
        return { providerIntentId: 'pi_wallet_funding_recovery', clientSecret: null };
      }
    };
    const providerInput = { fundingIntentId: intent.id, idempotencyKey: intent.idempotencyKey, amountMinor: intent.amountMinor, currency: intent.currency };
    const createdPayment = await mockProvider.createPaymentIntent(providerInput);
    await assert.rejects(
      () => funding.persistWalletFundingProviderReference(intent.id, createdPayment.providerIntentId, async () => { throw new Error('injected persistence failure'); }),
      /injected persistence failure/
    );

    const webhookSecret = 'whsec_synthetic_wallet_funding_recovery';
    const provider = new StripeWalletFundingProvider(new Stripe('sk_test_synthetic_wallet_funding_recovery'), webhookSecret);
    const payload = JSON.stringify({
      id: 'evt_wallet_funding_recovery',
      object: 'event',
      livemode: false,
      type: 'payment_intent.succeeded',
      data: { object: {
        id: createdPayment.providerIntentId,
        object: 'payment_intent',
        amount: 3,
        amount_received: 3,
        currency: 'usd',
        metadata: { scrolithFundingIntentId: intent.id, scrolithPurpose: 'wallet_top_up' }
      } }
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const event = provider.verifyWebhook(Buffer.from(payload), signature);
    assert.equal(event.eventId, 'evt_wallet_funding_recovery');

    await assert.rejects(
      () => processWalletFundingEvent(event),
      error => error instanceof funding.WalletFundingRetryableError
    );
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: event.eventId } }), 0);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: intent.id } }), 0);
    assert.equal(await prisma.walletBalanceAllocation.count({ where: { referenceId: intent.id } }), 0);
    assert.equal((await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } })).availableMinor, 0);

    const retryPayment = await mockProvider.createPaymentIntent(providerInput);
    await funding.persistWalletFundingProviderReference(intent.id, retryPayment.providerIntentId);
    assert.equal(providerCalls.length, 2);
    assert.equal(providerCalls[0].idempotencyKey, providerCalls[1].idempotencyKey);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: intent.id } })).providerIntentId, createdPayment.providerIntentId);

    const applied = await processWalletFundingEvent(event);
    assert.equal(applied.outcome, 'SUCCEEDED');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: event.eventId } }), 1);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: intent.id } }), 1);
    assert.equal(await prisma.walletBalanceAllocation.count({ where: { referenceId: intent.id } }), 2);
    assert.equal((await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } })).availableMinor, 3);

    const duplicate = await processWalletFundingEvent(event);
    assert.equal(duplicate.outcome, 'DUPLICATE');
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: intent.id } }), 1);
    assert.equal(await prisma.walletBalanceAllocation.count({ where: { referenceId: intent.id } }), 2);
  } finally {
    await prisma.$disconnect();
  }
});
