import assert from 'node:assert/strict';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_PARTIAL_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_PARTIAL_TEST_DATABASE_URL is required in CI; refusing to skip partial wallet funding verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('partial refunds and disputes remain balanced, idempotent, and reviewable', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  const treasuryId = 'wallet-funding-partial-outcomes-treasury';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = treasuryId;

  const [{ prisma }, funding, ledger] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts'),
    import('../apps/api/src/wallet-ledger.ts')
  ]);
  const { processWalletFundingEvent } = funding;
  const { buildPostingAllocations } = ledger;

  await prisma.walletAccount.create({ data: { id: treasuryId, type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: treasuryId, currency: 'USD', availableMinor: 100_000, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletBalanceAllocation.create({ data: { accountId: treasuryId, currency: 'USD', state: 'AVAILABLE', deltaMinor: 100_000, idempotencyKey: 'wallet-funding-partial-opening', referenceType: 'OPENING_BALANCE', referenceId: treasuryId, isOpeningBaseline: true, baselineEvidenceRef: 'DISPOSABLE-PARTIAL-OUTCOMES', baselineVerified: true } });

  const cases = new Map();
  const createCase = async (amountMinor, label) => {
    const user = await prisma.user.create({ data: { email: `wallet-funding-partial-${label}-${Date.now()}@example.test`, name: `Partial Funding ${label}`, role: 'BUYER', passwordHash: 'synthetic-only' } });
    const account = await prisma.walletAccount.create({ data: { userId: user.id, type: 'USER', status: 'ACTIVE' } });
    await prisma.walletBalance.create({ data: { accountId: account.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
    const intent = await prisma.walletFundingIntent.create({ data: { userId: user.id, accountId: account.id, amountMinor, currency: 'USD', provider: 'STRIPE', providerIntentId: `pi_partial_${label}`, idempotencyKey: `funding-partial-${label}` } });
    const value = { user, account, intent };
    cases.set(label, value);
    return value;
  };
  const event = (intent, eventId, eventType, outcome, amountMinor, extra = {}) => ({ provider: 'STRIPE', eventId, eventType, outcome, providerIntentId: intent.providerIntentId, fundingIntentId: null, amountMinor, amountReceivedMinor: null, currency: 'USD', purpose: null, liveMode: false, ...extra });
  const success = async intent => processWalletFundingEvent({ provider: 'STRIPE', eventId: `evt_success_${intent.id}`, eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', providerIntentId: intent.providerIntentId, fundingIntentId: intent.id, amountMinor: intent.amountMinor, amountReceivedMinor: intent.amountMinor, currency: 'USD', purpose: 'wallet_top_up', liveMode: false });
  const balance = accountId => prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: accountId, currency: 'USD' } } });

  const assertReconciled = async accountId => {
    const [snapshot, allocations, postings] = await Promise.all([
      balance(accountId),
      prisma.walletBalanceAllocation.findMany({ where: { accountId }, select: { state: true, deltaMinor: true, isOpeningBaseline: true, baselineVerified: true } }),
      prisma.walletLedgerPosting.findMany({ where: { accountId, transaction: { status: 'POSTED' } }, select: { direction: true, amountMinor: true } })
    ]);
    const stateValues = { AVAILABLE: snapshot.availableMinor, PENDING: snapshot.pendingMinor, HELD: snapshot.heldMinor, FROZEN: snapshot.frozenMinor };
    const allocationValues = { AVAILABLE: 0, PENDING: 0, HELD: 0, FROZEN: 0 };
    for (const allocation of allocations) allocationValues[allocation.state] += allocation.deltaMinor;
    assert.deepEqual(allocationValues, stateValues);
    const allocationTotal = Object.values(allocationValues).reduce((sum, value) => sum + value, 0);
    const snapshotTotal = Object.values(stateValues).reduce((sum, value) => sum + value, 0);
    const economicTotal = postings.reduce((sum, posting) => sum + (posting.direction === 'DEBIT' ? posting.amountMinor : -posting.amountMinor), 0);
    const openingTotal = allocations.filter(item => item.isOpeningBaseline && item.baselineVerified).reduce((sum, item) => sum + item.deltaMinor, 0);
    assert.equal(snapshotTotal, allocationTotal);
    assert.equal(snapshotTotal, economicTotal + openingTotal);
  };

  const spend = async (sourceAccountId, amountMinor, label) => {
    const recipient = await prisma.user.create({ data: { email: `wallet-funding-recipient-${label}-${Date.now()}@example.test`, name: `Funding Recipient ${label}`, role: 'BUYER', passwordHash: 'synthetic-only' } });
    const recipientAccount = await prisma.walletAccount.create({ data: { userId: recipient.id, type: 'USER', status: 'ACTIVE' } });
    await prisma.walletBalance.create({ data: { accountId: recipientAccount.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
    await prisma.$transaction(async tx => {
      const debit = await tx.walletBalance.updateMany({ where: { accountId: sourceAccountId, currency: 'USD', availableMinor: { gte: amountMinor } }, data: { availableMinor: { decrement: amountMinor } } });
      assert.equal(debit.count, 1);
      await tx.walletBalance.update({ where: { accountId_currency: { accountId: recipientAccount.id, currency: 'USD' } }, data: { availableMinor: { increment: amountMinor } } });
      const transaction = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: `partial-spend-${label}`, entryType: 'TRANSFER', status: 'POSTED', currency: 'USD', referenceType: 'WalletTransfer', referenceId: label } });
      const postings = [
        { transactionId: transaction.id, accountId: sourceAccountId, direction: 'CREDIT', amountMinor, currency: 'USD' },
        { transactionId: transaction.id, accountId: recipientAccount.id, direction: 'DEBIT', amountMinor, currency: 'USD' }
      ];
      await tx.walletLedgerPosting.createMany({ data: postings });
      await tx.walletBalanceAllocation.createMany({ data: buildPostingAllocations(transaction.id, `partial-spend-${label}`, postings) });
    });
  };

  try {
    const fullyAvailable = await createCase(100, 'available');
    assert.equal((await success(fullyAvailable.intent)).outcome, 'SUCCEEDED');
    assert.equal((await processWalletFundingEvent(event(fullyAvailable.intent, 'evt_refund_available_30', 'charge.refunded', 'PARTIAL_REFUND', 30))).outcome, 'PARTIAL_REFUND');
    assert.equal((await balance(fullyAvailable.account.id)).availableMinor, 70);
    let intent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: fullyAvailable.intent.id } });
    assert.equal(intent.refundObservedMinor, 30);
    assert.equal(intent.refundAppliedMinor, 30);
    assert.equal(intent.refundShortfallMinor, 0);
    assert.equal((await processWalletFundingEvent(event(fullyAvailable.intent, 'evt_refund_available_30', 'charge.refunded', 'PARTIAL_REFUND', 30))).outcome, 'DUPLICATE');
    assert.equal((await processWalletFundingEvent(event(fullyAvailable.intent, 'evt_refund_available_30_again', 'charge.refunded', 'PARTIAL_REFUND', 30))).alreadyApplied, true);
    assert.equal((await processWalletFundingEvent(event(fullyAvailable.intent, 'evt_refund_available_60', 'charge.refunded', 'PARTIAL_REFUND', 60))).appliedMinor, 30);
    assert.equal((await balance(fullyAvailable.account.id)).availableMinor, 40);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingRefund', referenceId: fullyAvailable.intent.id } }), 2);
    await assertReconciled(fullyAvailable.account.id);

    const spent = await createCase(80, 'spent');
    await success(spent.intent);
    await spend(spent.account.id, 60, 'refund-shortfall');
    const spentRefund = await processWalletFundingEvent(event(spent.intent, 'evt_refund_spent_40', 'charge.refunded', 'PARTIAL_REFUND', 40));
    assert.equal(spentRefund.reviewRequired, true);
    assert.equal((await balance(spent.account.id)).availableMinor, 20);
    const spentAccount = await prisma.walletAccount.findUniqueOrThrow({ where: { id: spent.account.id } });
    intent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: spent.intent.id } });
    assert.equal(spentAccount.status, 'FROZEN');
    assert.equal(intent.refundShortfallMinor, 40);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingRefund', referenceId: spent.intent.id } }), 0);
    await assertReconciled(spent.account.id);

    const disputeWon = await createCase(100, 'dispute-won');
    await success(disputeWon.intent);
    await processWalletFundingEvent(event(disputeWon.intent, 'evt_dispute_won_open', 'charge.dispute.created', 'DISPUTED', 40));
    assert.deepEqual((await balance(disputeWon.account.id)).availableMinor, 60);
    assert.deepEqual((await balance(disputeWon.account.id)).heldMinor, 40);
    await processWalletFundingEvent(event(disputeWon.intent, 'evt_dispute_won_duplicate', 'charge.dispute.created', 'DISPUTED', 40));
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingDisputeHold', referenceId: disputeWon.intent.id } }), 1);
    const won = await processWalletFundingEvent(event(disputeWon.intent, 'evt_dispute_won_close', 'charge.dispute.closed', 'DISPUTE_WON', 40, { disputeResolution: 'WON' }));
    assert.equal(won.outcome, 'DISPUTE_WON');
    assert.deepEqual((await balance(disputeWon.account.id)).availableMinor, 100);
    assert.deepEqual((await balance(disputeWon.account.id)).heldMinor, 0);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: disputeWon.intent.id } })).status, 'SUCCEEDED');
    await assertReconciled(disputeWon.account.id);

    const disputeLost = await createCase(100, 'dispute-lost');
    await success(disputeLost.intent);
    await processWalletFundingEvent(event(disputeLost.intent, 'evt_dispute_lost_open', 'charge.dispute.created', 'DISPUTED', 30));
    const lost = await processWalletFundingEvent(event(disputeLost.intent, 'evt_dispute_lost_close', 'charge.dispute.closed', 'DISPUTE_LOST', 30, { disputeResolution: 'LOST' }));
    assert.equal(lost.outcome, 'DISPUTE_LOST');
    assert.deepEqual((await balance(disputeLost.account.id)).availableMinor, 70);
    assert.deepEqual((await balance(disputeLost.account.id)).heldMinor, 0);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: disputeLost.intent.id } })).status, 'REVIEW');
    const lostDuplicate = await processWalletFundingEvent(event(disputeLost.intent, 'evt_dispute_lost_close_again', 'charge.dispute.closed', 'DISPUTE_LOST', 30, { disputeResolution: 'LOST' }));
    assert.equal(lostDuplicate.alreadyApplied, true);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingDisputeLost', referenceId: disputeLost.intent.id } }), 1);
    await assertReconciled(disputeLost.account.id);

    const disputeLostWithoutOpen = await createCase(50, 'dispute-lost-without-open');
    await success(disputeLostWithoutOpen.intent);
    const lostWithoutOpen = await processWalletFundingEvent(event(disputeLostWithoutOpen.intent, 'evt_dispute_lost_without_open', 'charge.dispute.closed', 'DISPUTE_LOST', 20, { disputeResolution: 'LOST' }));
    assert.equal(lostWithoutOpen.outcome, 'DISPUTE_LOST');
    assert.equal((await balance(disputeLostWithoutOpen.account.id)).availableMinor, 30);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: disputeLostWithoutOpen.intent.id } })).status, 'REVIEW');
    await assertReconciled(disputeLostWithoutOpen.account.id);

    const concurrent = await createCase(100, 'concurrent');
    await success(concurrent.intent);
    const concurrentResults = await Promise.all([
      processWalletFundingEvent(event(concurrent.intent, 'evt_concurrent_refund_30', 'charge.refunded', 'PARTIAL_REFUND', 30)),
      processWalletFundingEvent(event(concurrent.intent, 'evt_concurrent_dispute_20', 'charge.dispute.created', 'DISPUTED', 20))
    ]);
    assert.equal(concurrentResults.filter(result => ['PARTIAL_REFUND', 'DISPUTED'].includes(result.outcome)).length, 2);
    const concurrentBalance = await balance(concurrent.account.id);
    assert.equal(concurrentBalance.availableMinor + concurrentBalance.heldMinor, 70);
    intent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: concurrent.intent.id } });
    assert.equal(intent.refundAppliedMinor, 30);
    assert.equal(intent.disputeHeldMinor, 20);
    await assertReconciled(concurrent.account.id);

    const disputeShortfall = await createCase(50, 'dispute-shortfall');
    await success(disputeShortfall.intent);
    await spend(disputeShortfall.account.id, 45, 'dispute-shortfall');
    const shortfall = await processWalletFundingEvent(event(disputeShortfall.intent, 'evt_dispute_shortfall_20', 'charge.dispute.created', 'DISPUTED', 20));
    assert.equal(shortfall.reviewRequired, true);
    assert.equal((await prisma.walletAccount.findUniqueOrThrow({ where: { id: disputeShortfall.account.id } })).status, 'FROZEN');
    intent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: disputeShortfall.intent.id } });
    assert.equal(intent.disputeShortfallMinor, 20);
    assert.equal(intent.disputeHeldMinor, 0);
    await assertReconciled(disputeShortfall.account.id);

    await assertReconciled(treasuryId);
  } finally {
    await prisma.$disconnect();
  }
});
