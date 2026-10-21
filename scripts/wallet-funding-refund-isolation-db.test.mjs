import assert from 'node:assert/strict';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_REFUND_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('WALLET_FUNDING_REFUND_TEST_DATABASE_URL is required');
validateE2EDatabaseURL(databaseUrl);

test('full refund consumes only the current intent dispute hold', async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  const treasuryId = 'wallet-funding-refund-isolation-treasury';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = treasuryId;

  const [{ prisma }, funding, reconciliation] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts'),
    import('../apps/api/src/wallet-reconciliation.ts')
  ]);
  const { processWalletFundingEvent } = funding;
  const { buildWalletReconciliationReport } = reconciliation;

  const balance = accountId => prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId, currency: 'USD' } } });
  const user = await prisma.user.create({ data: { email: `wallet-funding-refund-isolation-${Date.now()}@example.test`, name: 'Refund Isolation', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const account = await prisma.walletAccount.create({ data: { userId: user.id, type: 'USER', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: account.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletAccount.create({ data: { id: treasuryId, type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: treasuryId, currency: 'USD', availableMinor: 100, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletBalanceAllocation.create({ data: { accountId: treasuryId, currency: 'USD', state: 'AVAILABLE', deltaMinor: 100, idempotencyKey: 'wallet-funding-refund-isolation-opening', referenceType: 'OPENING_BALANCE', referenceId: treasuryId, isOpeningBaseline: true, baselineEvidenceRef: 'DISPOSABLE-REFUND-ISOLATION', baselineVerified: true } });

  const makeIntent = async (amountMinor, label) => prisma.walletFundingIntent.create({ data: { userId: user.id, accountId: account.id, amountMinor, currency: 'USD', provider: 'STRIPE', providerIntentId: `pi_wallet_funding_refund_${label}`, idempotencyKey: `wallet-funding-refund-${label}` } });
  const successEvent = (intent, eventId) => ({ provider: 'STRIPE', eventId, eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', providerIntentId: intent.providerIntentId, fundingIntentId: intent.id, amountMinor: intent.amountMinor, amountReceivedMinor: intent.amountMinor, currency: 'USD', purpose: 'wallet_top_up', liveMode: false });
  const refundEvent = (intent, eventId) => ({ provider: 'STRIPE', eventId, eventType: 'charge.refunded', outcome: 'REVERSED', providerIntentId: intent.providerIntentId, fundingIntentId: intent.id, amountMinor: intent.amountMinor, amountReceivedMinor: null, currency: 'USD', purpose: null, liveMode: false });

  try {
    const unrelatedHold = await makeIntent(5, 'unrelated-hold');
    await processWalletFundingEvent(successEvent(unrelatedHold, 'evt_refund_isolation_unrelated_success'));
    await processWalletFundingEvent({ ...refundEvent(unrelatedHold, 'evt_refund_isolation_unrelated_dispute'), eventType: 'charge.dispute.created', outcome: 'DISPUTED', disputeId: 'dp_refund_isolation_unrelated' });

    const refundIntent = await makeIntent(8, 'target');
    const beforeSuccess = await balance(account.id);
    await processWalletFundingEvent(successEvent(refundIntent, 'evt_refund_isolation_target_success'));
    const afterSuccess = await balance(account.id);
    const refundResult = await processWalletFundingEvent(refundEvent(refundIntent, 'evt_refund_isolation_target_full'));
    const finalBalance = await balance(account.id);
    const finalIntent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: refundIntent.id }, select: { status: true, refundObservedMinor: true, refundAppliedMinor: true, refundShortfallMinor: true, disputeHeldMinor: true, disputeStatus: true } });
    const heldIntent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: unrelatedHold.id }, select: { disputeHeldMinor: true, disputeStatus: true } });
    const refundTransactions = await prisma.walletLedgerTransaction.findMany({ where: { referenceId: refundIntent.id, entryType: 'REFUND' }, select: { entryType: true, idempotencyKey: true } });
    const refundAllocations = await prisma.walletBalanceAllocation.findMany({ where: { referenceId: refundIntent.id, referenceType: 'WALLET_FUNDING_REFUND' }, select: { state: true, deltaMinor: true }, orderBy: { createdAt: 'asc' } });
    const [targetBalance, postings, allocations] = await Promise.all([
      prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: account.id, currency: 'USD' } } }),
      prisma.walletLedgerPosting.findMany({ where: { accountId: account.id, transaction: { status: 'POSTED' } }, select: { accountId: true, currency: true, direction: true, amountMinor: true } }),
      prisma.walletBalanceAllocation.findMany({ where: { accountId: account.id }, select: { accountId: true, currency: true, state: true, deltaMinor: true, isOpeningBaseline: true, baselineVerified: true } })
    ]);
    const report = buildWalletReconciliationReport([{ accountId: account.id, userId: user.id, currency: 'USD', availableMinor: targetBalance.availableMinor, pendingMinor: targetBalance.pendingMinor, heldMinor: targetBalance.heldMinor, frozenMinor: targetBalance.frozenMinor }], postings, allocations);

    assert.equal(beforeSuccess.availableMinor, 0);
    assert.equal(beforeSuccess.heldMinor, 5);
    assert.equal(afterSuccess.availableMinor, 8);
    assert.equal(afterSuccess.heldMinor, 5);
    assert.deepEqual(refundResult, { outcome: 'REVERSED', intentId: refundIntent.id, appliedMinor: 8, cumulativeMinor: 8 });
    assert.equal(finalBalance.availableMinor, afterSuccess.availableMinor - refundResult.appliedMinor);
    assert.equal(finalBalance.heldMinor, afterSuccess.heldMinor);
    assert.deepEqual(finalIntent, { status: 'REVERSED', refundObservedMinor: 8, refundAppliedMinor: 8, refundShortfallMinor: 0, disputeHeldMinor: 0, disputeStatus: null });
    assert.deepEqual(heldIntent, { disputeHeldMinor: 5, disputeStatus: 'OPEN' });
    assert.equal(refundTransactions.length, 1);
    assert.deepEqual(refundAllocations, [{ state: 'AVAILABLE', deltaMinor: -8 }, { state: 'AVAILABLE', deltaMinor: 8 }]);
    assert.equal(report.status, 'MATCHED', JSON.stringify(report));
  } finally {
    await prisma.$disconnect();
  }
});
