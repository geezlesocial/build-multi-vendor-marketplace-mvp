import assert from 'node:assert/strict';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_DISPUTE_ORDER_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_DISPUTE_ORDER_TEST_DATABASE_URL is required in CI; refusing to skip dispute-order verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('dispute ordering is terminal, idempotent, and reconciled', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  const treasuryId = 'wallet-funding-dispute-order-treasury';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = treasuryId;

  const [{ prisma }, funding, reconciliation] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts'),
    import('../apps/api/src/wallet-reconciliation.ts')
  ]);
  const { processWalletFundingEvent } = funding;
  const { buildWalletReconciliationReport } = reconciliation;

  await prisma.walletAccount.create({ data: { id: treasuryId, type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: treasuryId, currency: 'USD', availableMinor: 100_000, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletBalanceAllocation.create({
    data: {
      accountId: treasuryId,
      currency: 'USD',
      state: 'AVAILABLE',
      deltaMinor: 100_000,
      idempotencyKey: 'wallet-funding-dispute-order-opening',
      referenceType: 'OPENING_BALANCE',
      referenceId: treasuryId,
      isOpeningBaseline: true,
      baselineEvidenceRef: 'DISPOSABLE-DISPUTE-ORDER',
      baselineVerified: true
    }
  });

  const createCase = async (amountMinor, label) => {
    const user = await prisma.user.create({ data: { email: `wallet-funding-dispute-${label}-${Date.now()}@example.test`, name: `Dispute ${label}`, role: 'BUYER', passwordHash: 'synthetic-only' } });
    const account = await prisma.walletAccount.create({ data: { userId: user.id, type: 'USER', status: 'ACTIVE' } });
    await prisma.walletBalance.create({ data: { accountId: account.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
    const intent = await prisma.walletFundingIntent.create({ data: { userId: user.id, accountId: account.id, amountMinor, currency: 'USD', provider: 'STRIPE', providerIntentId: `pi_dispute_order_${label}`, idempotencyKey: `funding-dispute-order-${label}` } });
    return { user, account, intent };
  };

  const event = (intent, eventId, outcome, amountMinor, disputeId, disputeResolution = null) => ({
    provider: 'STRIPE',
    eventId,
    eventType: outcome === 'DISPUTED' ? 'charge.dispute.created' : 'charge.dispute.closed',
    outcome,
    providerIntentId: intent.providerIntentId,
    fundingIntentId: null,
    disputeId,
    amountMinor,
    amountReceivedMinor: null,
    currency: 'USD',
    purpose: null,
    disputeResolution,
    liveMode: false
  });

  const success = intent => processWalletFundingEvent({
    provider: 'STRIPE',
    eventId: `evt_dispute_order_success_${intent.id}`,
    eventType: 'payment_intent.succeeded',
    outcome: 'SUCCEEDED',
    providerIntentId: intent.providerIntentId,
    fundingIntentId: intent.id,
    disputeId: null,
    amountMinor: intent.amountMinor,
    amountReceivedMinor: intent.amountMinor,
    currency: 'USD',
    purpose: 'wallet_top_up',
    liveMode: false
  });

  const state = async ({ intent, account }) => {
    const [freshIntent, balance, ledgerCount, allocationCount] = await Promise.all([
      prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: account.id, currency: 'USD' } } }),
      prisma.walletLedgerTransaction.count({ where: { referenceId: intent.id } }),
      prisma.walletBalanceAllocation.count({ where: { referenceId: intent.id } })
    ]);
    return { intent: freshIntent, balance, ledgerCount, allocationCount };
  };

  const assertReconciled = async ({ account, user }) => {
    const [balance, postings, allocations] = await Promise.all([
      prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: account.id, currency: 'USD' } } }),
      prisma.walletLedgerPosting.findMany({ where: { accountId: account.id, transaction: { status: 'POSTED' } }, select: { accountId: true, currency: true, direction: true, amountMinor: true } }),
      prisma.walletBalanceAllocation.findMany({ where: { accountId: account.id }, select: { accountId: true, currency: true, state: true, deltaMinor: true, isOpeningBaseline: true, baselineVerified: true } })
    ]);
    const report = buildWalletReconciliationReport([{ accountId: account.id, userId: user.id, currency: 'USD', availableMinor: balance.availableMinor, pendingMinor: balance.pendingMinor, heldMinor: balance.heldMinor, frozenMinor: balance.frozenMinor }], postings, allocations);
    assert.equal(report.status, 'MATCHED', JSON.stringify(report));
  };

  try {
    const won = await createCase(100, 'won');
    await success(won.intent);
    assert.equal((await processWalletFundingEvent(event(won.intent, 'evt_dispute_won_created', 'DISPUTED', 40, 'dp_won'))).outcome, 'DISPUTED');
    assert.equal((await processWalletFundingEvent(event(won.intent, 'evt_dispute_won_resolved', 'DISPUTE_WON', 40, 'dp_won', 'WON'))).outcome, 'DISPUTE_WON');
    const beforeLateWon = await state(won);
    const lateWon = await processWalletFundingEvent(event(won.intent, 'evt_dispute_won_late_created', 'DISPUTED', 80, 'dp_won'));
    assert.deepEqual(lateWon, { outcome: 'REJECTED', intentId: won.intent.id, reason: 'STALE_DISPUTE_CREATED_AFTER_RESOLUTION' });
    const afterLateWon = await state(won);
    assert.equal(afterLateWon.intent.status, 'SUCCEEDED');
    assert.equal(afterLateWon.intent.disputeStatus, 'WON');
    assert.equal(afterLateWon.intent.disputeId, 'dp_won');
    assert.equal(afterLateWon.balance.availableMinor, 100);
    assert.equal(afterLateWon.balance.heldMinor, 0);
    assert.deepEqual({ ledgerCount: afterLateWon.ledgerCount, allocationCount: afterLateWon.allocationCount }, { ledgerCount: beforeLateWon.ledgerCount, allocationCount: beforeLateWon.allocationCount });
    assert.deepEqual(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: 'evt_dispute_won_late_created' } }), 1);
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: 'evt_dispute_won_late_created' } } })).reviewReason, 'STALE_DISPUTE_CREATED_AFTER_RESOLUTION');
    assert.deepEqual(await processWalletFundingEvent(event(won.intent, 'evt_dispute_won_late_created', 'DISPUTED', 80, 'dp_won')), lateWon);
    const differentDispute = await processWalletFundingEvent(event(won.intent, 'evt_dispute_other_after_won', 'DISPUTED', 20, 'dp_other'));
    assert.deepEqual(differentDispute, { outcome: 'REJECTED', intentId: won.intent.id, reason: 'DISPUTE_ID_MISMATCH' });
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: 'evt_dispute_other_after_won' } } })).reviewReason, 'DISPUTE_ID_MISMATCH');
    assert.deepEqual(await processWalletFundingEvent(event(won.intent, 'evt_dispute_other_after_won', 'DISPUTED', 20, 'dp_other')), differentDispute);
    const afterOtherWon = await state(won);
    assert.deepEqual({ ledgerCount: afterOtherWon.ledgerCount, allocationCount: afterOtherWon.allocationCount, availableMinor: afterOtherWon.balance.availableMinor, heldMinor: afterOtherWon.balance.heldMinor }, { ledgerCount: afterLateWon.ledgerCount, allocationCount: afterLateWon.allocationCount, availableMinor: 100, heldMinor: 0 });
    await assertReconciled(won);

    const lost = await createCase(100, 'lost');
    await success(lost.intent);
    assert.equal((await processWalletFundingEvent(event(lost.intent, 'evt_dispute_lost_created', 'DISPUTED', 30, 'dp_lost'))).outcome, 'DISPUTED');
    assert.equal((await processWalletFundingEvent(event(lost.intent, 'evt_dispute_lost_resolved', 'DISPUTE_LOST', 30, 'dp_lost', 'LOST'))).outcome, 'DISPUTE_LOST');
    const beforeLateLost = await state(lost);
    const lateLost = await processWalletFundingEvent(event(lost.intent, 'evt_dispute_lost_late_created', 'DISPUTED', 80, 'dp_lost'));
    assert.deepEqual(lateLost, { outcome: 'REJECTED', intentId: lost.intent.id, reason: 'STALE_DISPUTE_CREATED_AFTER_RESOLUTION' });
    const afterLateLost = await state(lost);
    assert.equal(afterLateLost.intent.status, 'REVIEW');
    assert.equal(afterLateLost.intent.disputeStatus, 'LOST');
    assert.equal(afterLateLost.intent.disputeId, 'dp_lost');
    assert.equal(afterLateLost.balance.availableMinor, 70);
    assert.equal(afterLateLost.balance.heldMinor, 0);
    assert.deepEqual({ ledgerCount: afterLateLost.ledgerCount, allocationCount: afterLateLost.allocationCount }, { ledgerCount: beforeLateLost.ledgerCount, allocationCount: beforeLateLost.allocationCount });
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: 'evt_dispute_lost_late_created' } } })).reviewReason, 'STALE_DISPUTE_CREATED_AFTER_RESOLUTION');
    await assertReconciled(lost);

    const normal = await createCase(60, 'normal');
    await success(normal.intent);
    assert.equal((await processWalletFundingEvent(event(normal.intent, 'evt_dispute_normal_created', 'DISPUTED', 20, 'dp_normal'))).outcome, 'DISPUTED');
    assert.deepEqual(await processWalletFundingEvent(event(normal.intent, 'evt_dispute_normal_created', 'DISPUTED', 20, 'dp_normal')), { outcome: 'DUPLICATE' });
    assert.equal((await processWalletFundingEvent(event(normal.intent, 'evt_dispute_normal_distinct_duplicate', 'DISPUTED', 20, 'dp_normal'))).alreadyApplied, true);
    const normalResolution = await processWalletFundingEvent(event(normal.intent, 'evt_dispute_normal_resolved', 'DISPUTE_WON', 20, 'dp_normal', 'WON'));
    assert.equal(normalResolution.outcome, 'DISPUTE_WON');
    const normalState = await state(normal);
    assert.equal(normalState.intent.status, 'SUCCEEDED');
    assert.equal(normalState.intent.disputeStatus, 'WON');
    assert.equal(normalState.balance.availableMinor, 60);
    assert.equal(normalState.balance.heldMinor, 0);
    await assertReconciled(normal);
  } finally {
    await prisma.$disconnect();
  }
});
