import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required in CI; refusing to skip webhook audit atomicity verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('webhook audit failures roll back success and missing-provider review state', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = 'wallet-funding-audit-atomicity-treasury';

  const [{ prisma }, funding, { WalletFundingStatus }] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts'),
    import('@prisma/client')
  ]);

  const target = await prisma.user.create({ data: { email: `wallet-funding-audit-atomicity-${Date.now()}@example.test`, name: 'Audit Atomicity Target', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const account = await prisma.walletAccount.create({ data: { userId: target.id, type: 'USER', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: account.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletAccount.create({ data: { id: 'wallet-funding-audit-atomicity-treasury', type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: 'wallet-funding-audit-atomicity-treasury', currency: 'USD', availableMinor: 100, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletBalanceAllocation.create({ data: { accountId: 'wallet-funding-audit-atomicity-treasury', currency: 'USD', state: 'AVAILABLE', deltaMinor: 100, idempotencyKey: 'wallet-funding-audit-atomicity-opening', referenceType: 'OPENING_BALANCE', referenceId: 'wallet-funding-audit-atomicity-treasury', isOpeningBaseline: true, baselineEvidenceRef: 'DISPOSABLE-WALLET-FUNDING-AUDIT-ATOMICITY', baselineVerified: true } });

  const providerSecret = 'whsec_synthetic_wallet_funding_audit_atomicity';
  const provider = new funding.StripeWalletFundingProvider(new Stripe('sk_test_synthetic_wallet_funding_audit_atomicity'), providerSecret);
  const signedEvent = (eventId, type, object) => {
    const payload = JSON.stringify({ id: eventId, object: 'event', livemode: false, type, data: { object } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: providerSecret });
    return provider.verifyWebhook(Buffer.from(payload), signature);
  };
  const state = async (intentId, eventId) => ({
    intent: await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: intentId }, select: { status: true, providerIntentId: true } }),
    receiptCount: await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId } }),
    auditCount: await prisma.auditLog.count({ where: { action: { in: ['WALLET_FUNDING_CONFIRMED', 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED'] }, entityId: intentId } }),
    ledgerCount: await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: intentId } }),
    allocationCount: await prisma.walletBalanceAllocation.count({ where: { referenceId: intentId } }),
    balance: await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: account.id, currency: 'USD' } }, select: { availableMinor: true, pendingMinor: true, heldMinor: true, frozenMinor: true } })
  });

  const failingAuditWriter = async () => {
    throw new Error('synthetic audit write failure');
  };

  try {
    const successIntent = await prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: account.id, amountMinor: 9, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_wallet_funding_audit_atomicity', idempotencyKey: 'wallet-funding-audit-atomicity-success' } });
    const successEvent = signedEvent('evt_wallet_funding_audit_atomicity_success', 'payment_intent.succeeded', {
      id: successIntent.providerIntentId,
      object: 'payment_intent',
      amount: 9,
      amount_received: 9,
      currency: 'usd',
      metadata: { scrolithFundingIntentId: successIntent.id, scrolithPurpose: 'wallet_top_up' }
    });
    const beforeSuccess = await state(successIntent.id, successEvent.eventId);
    funding.setWalletFundingAuditWriterForTests(failingAuditWriter);
    await assert.rejects(() => funding.processWalletFundingEvent(successEvent), /synthetic audit write failure/);
    assert.deepEqual(await state(successIntent.id, successEvent.eventId), beforeSuccess);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: successIntent.id } })).status, WalletFundingStatus.PENDING);

    funding.setWalletFundingAuditWriterForTests(null);
    assert.equal((await funding.processWalletFundingEvent(successEvent)).outcome, 'SUCCEEDED');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: successEvent.eventId } }), 1);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: successIntent.id } }), 1);
    assert.equal(await prisma.walletBalanceAllocation.count({ where: { referenceId: successIntent.id } }), 2);
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_CONFIRMED', entityId: successIntent.id } }), 1);
    assert.equal((await funding.processWalletFundingEvent(successEvent)).outcome, 'DUPLICATE');
    assert.deepEqual(await state(successIntent.id, successEvent.eventId), {
      ...beforeSuccess,
      intent: { status: WalletFundingStatus.SUCCEEDED, providerIntentId: successIntent.providerIntentId },
      receiptCount: 1,
      auditCount: 1,
      ledgerCount: 1,
      allocationCount: 2,
      balance: { availableMinor: 9, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 }
    });

    const reviewIntent = await prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: account.id, amountMinor: 10, currency: 'USD', provider: 'STRIPE', idempotencyKey: 'wallet-funding-audit-atomicity-review' } });
    const reviewEvent = signedEvent('evt_wallet_funding_audit_atomicity_review', 'payment_intent.payment_failed', {
      object: 'payment_intent',
      amount: 10,
      currency: 'usd',
      metadata: { scrolithFundingIntentId: reviewIntent.id, scrolithPurpose: 'wallet_top_up' }
    });
    assert.equal(reviewEvent.providerIntentId, null);
    const beforeReview = await state(reviewIntent.id, reviewEvent.eventId);
    funding.setWalletFundingAuditWriterForTests(failingAuditWriter);
    await assert.rejects(() => funding.processWalletFundingEvent(reviewEvent), /synthetic audit write failure/);
    assert.deepEqual(await state(reviewIntent.id, reviewEvent.eventId), beforeReview);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: reviewIntent.id } })).status, WalletFundingStatus.PENDING);

    funding.setWalletFundingAuditWriterForTests(null);
    assert.deepEqual(await funding.processWalletFundingEvent(reviewEvent), { outcome: 'REVIEW_REQUIRED', intentId: reviewIntent.id, reason: 'PROVIDER_REFERENCE_REQUIRED' });
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: reviewEvent.eventId } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED', entityId: reviewIntent.id } }), 1);
    assert.deepEqual(await funding.processWalletFundingEvent(reviewEvent), { outcome: 'REVIEW_REQUIRED', intentId: reviewIntent.id, reason: 'PROVIDER_REFERENCE_REQUIRED' });
    assert.deepEqual(await state(reviewIntent.id, reviewEvent.eventId), {
      ...beforeReview,
      receiptCount: 1,
      auditCount: 1
    });
  } finally {
    funding.setWalletFundingAuditWriterForTests(null);
    await prisma.$disconnect();
  }
});
