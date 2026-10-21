import assert from 'node:assert/strict';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required in CI; refusing to skip missing-provider review verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('missing provider reference failure and cancellation events are durably reviewable and idempotent', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = 'wallet-funding-missing-reference-treasury';

  const [{ prisma }, funding, { WalletFundingStatus }] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts'),
    import('@prisma/client')
  ]);

  const target = await prisma.user.create({ data: { email: `wallet-funding-missing-reference-${Date.now()}@example.test`, name: 'Missing Provider Reference Target', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const account = await prisma.walletAccount.create({ data: { userId: target.id, type: 'USER', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: account.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletAccount.create({ data: { id: 'wallet-funding-missing-reference-treasury', type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: 'wallet-funding-missing-reference-treasury', currency: 'USD', availableMinor: 100, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });

  const createIntent = (amountMinor, key) => prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: account.id, amountMinor, currency: 'USD', provider: 'STRIPE', idempotencyKey: key } });
  const financialState = async intentId => ({
    intent: await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: intentId }, select: { status: true, providerIntentId: true } }),
    ledger: await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: intentId } }),
    allocations: await prisma.walletBalanceAllocation.count({ where: { referenceId: intentId } }),
    balance: await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: account.id, currency: 'USD' } }, select: { availableMinor: true, pendingMinor: true, heldMinor: true, frozenMinor: true } })
  });

  try {
    const failedIntent = await createIntent(7, 'wallet-funding-missing-provider-failure');
    const failedEvent = {
      provider: 'STRIPE',
      eventId: 'evt_wallet_funding_missing_provider_failure',
      eventType: 'payment_intent.payment_failed',
      outcome: 'FAILED',
      providerIntentId: null,
      fundingIntentId: failedIntent.id,
      amountMinor: 7,
      amountReceivedMinor: null,
      currency: 'USD',
      purpose: 'wallet_top_up',
      liveMode: false
    };
    const beforeFailure = await financialState(failedIntent.id);
    assert.deepEqual(await funding.processWalletFundingEvent(failedEvent), { outcome: 'REVIEW_REQUIRED', intentId: failedIntent.id, reason: 'PROVIDER_REFERENCE_REQUIRED' });
    assert.deepEqual(await financialState(failedIntent.id), beforeFailure);
    const failureReview = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: failedEvent.eventId } } });
    assert.equal(failureReview.eventType, failedEvent.eventType);
    assert.equal(failureReview.reviewReason, 'PROVIDER_REFERENCE_REQUIRED');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: failedEvent.eventId } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED', entityId: failedIntent.id } }), 1);
    assert.deepEqual(await funding.processWalletFundingEvent(failedEvent), { outcome: 'REVIEW_REQUIRED', intentId: failedIntent.id, reason: 'PROVIDER_REFERENCE_REQUIRED' });
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED', entityId: failedIntent.id } }), 1);

    const cancelledIntent = await createIntent(8, 'wallet-funding-missing-provider-cancellation');
    const cancelledEvent = {
      ...failedEvent,
      eventId: 'evt_wallet_funding_missing_provider_cancellation',
      eventType: 'payment_intent.canceled',
      outcome: 'CANCELLED',
      fundingIntentId: cancelledIntent.id,
      amountMinor: 8
    };
    const beforeCancellation = await financialState(cancelledIntent.id);
    assert.deepEqual(await funding.processWalletFundingEvent(cancelledEvent), { outcome: 'REVIEW_REQUIRED', intentId: cancelledIntent.id, reason: 'PROVIDER_REFERENCE_REQUIRED' });
    assert.deepEqual(await financialState(cancelledIntent.id), beforeCancellation);
    const cancellationReview = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: cancelledEvent.eventId } } });
    assert.equal(cancellationReview.eventType, cancelledEvent.eventType);
    assert.equal(cancellationReview.reviewReason, 'PROVIDER_REFERENCE_REQUIRED');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: cancelledEvent.eventId } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED', entityId: cancelledIntent.id } }), 1);
    assert.deepEqual(await funding.processWalletFundingEvent(cancelledEvent), { outcome: 'REVIEW_REQUIRED', intentId: cancelledIntent.id, reason: 'PROVIDER_REFERENCE_REQUIRED' });
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED', entityId: cancelledIntent.id } }), 1);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: failedIntent.id } })).status, WalletFundingStatus.PENDING);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: cancelledIntent.id } })).status, WalletFundingStatus.PENDING);
  } finally {
    await prisma.$disconnect();
  }
});
