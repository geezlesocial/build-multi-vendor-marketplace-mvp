import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required in CI; refusing to skip disposable wallet funding verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('sandbox provider funding lifecycle is verified without live provider calls', { skip: !databaseUrl }, async () => {
  const treasuryId = 'wallet-funding-test-treasury';
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = treasuryId;

  const [{ prisma }, funding, reconciliation, { WalletFundingStatus }] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/wallet-funding.ts'),
    import('../apps/api/src/wallet-reconciliation.ts'),
    import('@prisma/client')
  ]);

  const { processWalletFundingEvent, StripeWalletFundingProvider } = funding;
  const { buildWalletReconciliationReport } = reconciliation;
  const target = await prisma.user.create({ data: { email: `wallet-funding-target-${Date.now()}@example.test`, name: 'Wallet Funding Target', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const targetAccount = await prisma.walletAccount.create({ data: { userId: target.id, type: 'USER', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: targetAccount.id, currency: 'USD', availableMinor: 0, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletAccount.create({ data: { id: treasuryId, type: 'TREASURY', status: 'ACTIVE' } });
  await prisma.walletBalance.create({ data: { accountId: treasuryId, currency: 'USD', availableMinor: 100, pendingMinor: 0, heldMinor: 0, frozenMinor: 0 } });
  await prisma.walletBalanceAllocation.create({ data: { accountId: treasuryId, currency: 'USD', state: 'AVAILABLE', deltaMinor: 100, idempotencyKey: 'wallet-funding-opening-baseline', referenceType: 'OPENING_BALANCE', referenceId: treasuryId, isOpeningBaseline: true, baselineEvidenceRef: 'DISPOSABLE-WALLET-FUNDING-BASELINE', baselineVerified: true } });

  const report = async () => {
    const [balances, postings, allocations] = await Promise.all([
      prisma.walletBalance.findMany({ select: { accountId: true, currency: true, availableMinor: true, pendingMinor: true, heldMinor: true, frozenMinor: true, account: { select: { userId: true } } } }),
      prisma.walletLedgerPosting.findMany({ where: { transaction: { status: 'POSTED' } }, select: { accountId: true, currency: true, direction: true, amountMinor: true } }),
      prisma.walletBalanceAllocation.findMany({ select: { accountId: true, currency: true, state: true, deltaMinor: true, isOpeningBaseline: true, baselineVerified: true, transactionId: true } })
    ]);
    return buildWalletReconciliationReport(balances.map(balance => ({ ...balance, userId: balance.account.userId })), postings, allocations);
  };

  const createFundingIntent = (amountMinor, idempotencyKey, providerIntentId) => prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: targetAccount.id, amountMinor, currency: 'USD', provider: 'STRIPE', providerIntentId, idempotencyKey } });
  const event = ({ eventId, eventType, outcome, intent, amountMinor, amountReceivedMinor = null, fundingIntentId = intent.id, purpose = null }) => ({ provider: 'STRIPE', eventId, eventType, outcome, providerIntentId: intent.providerIntentId, fundingIntentId, amountMinor, amountReceivedMinor, currency: 'USD', purpose, liveMode: false });
  const success = intent => processWalletFundingEvent({ provider: 'STRIPE', eventId: `evt_wallet_funding_metadata_success_${intent.id}`, eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', providerIntentId: intent.providerIntentId, fundingIntentId: intent.id, amountMinor: intent.amountMinor, amountReceivedMinor: intent.amountMinor, currency: 'USD', purpose: 'wallet_top_up', liveMode: false });
  const balance = async () => prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } });
  const balanceState = value => ({ availableMinor: value.availableMinor, pendingMinor: value.pendingMinor, heldMinor: value.heldMinor, frozenMinor: value.frozenMinor });

  try {
    const successIntent = await prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: targetAccount.id, amountMinor: 25, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_wallet_funding_success', idempotencyKey: 'wallet-funding-success' } });
    const successEvent = { provider: 'STRIPE', eventId: 'evt_wallet_funding_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', providerIntentId: successIntent.providerIntentId, fundingIntentId: successIntent.id, amountMinor: 25, amountReceivedMinor: 25, currency: 'USD', purpose: 'wallet_top_up', liveMode: false };
    assert.deepEqual((await processWalletFundingEvent(successEvent)).outcome, 'SUCCEEDED');
    assert.deepEqual((await processWalletFundingEvent(successEvent)).outcome, 'DUPLICATE');
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: successIntent.id } })).status, WalletFundingStatus.SUCCEEDED);
    assert.equal((await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } })).availableMinor, 25);
    assert.equal((await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: successIntent.id } })), 1);
    assert.equal((await report()).status, 'MATCHED');

    const mismatch = await processWalletFundingEvent({ ...successEvent, eventId: 'evt_wallet_funding_amount_mismatch', amountMinor: 26, amountReceivedMinor: 26 });
    assert.deepEqual(mismatch, { outcome: 'REJECTED', intentId: successIntent.id, reason: 'AMOUNT_MISMATCH' });
    assert.equal((await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } })).availableMinor, 25);
    assert.equal((await report()).status, 'MATCHED');

    const liveEvent = await processWalletFundingEvent({ ...successEvent, eventId: 'evt_wallet_funding_live', liveMode: true });
    assert.deepEqual(liveEvent, { outcome: 'REJECTED', intentId: successIntent.id, reason: 'LIVE_PROVIDER_EVENT_REJECTED' });
    const unknownEvent = await processWalletFundingEvent({ ...successEvent, eventId: 'evt_wallet_funding_unknown', fundingIntentId: 'missing-funding-intent' });
    assert.deepEqual(unknownEvent, { outcome: 'REJECTED', intentId: undefined, reason: 'NO_MATCHING_FUNDING_INTENT' });

    const invalidFailureIntent = await createFundingIntent(11, 'wallet-funding-invalid-failure-metadata', 'pi_wallet_funding_invalid_failure_metadata');
    const beforeInvalidFailure = await balance();
    const invalidFailureEvents = [
      event({ eventId: 'evt_wallet_funding_failure_missing_purpose', eventType: 'payment_intent.payment_failed', outcome: 'FAILED', intent: invalidFailureIntent, amountMinor: 11 }),
      event({ eventId: 'evt_wallet_funding_failure_wrong_purpose', eventType: 'payment_intent.payment_failed', outcome: 'FAILED', intent: invalidFailureIntent, amountMinor: 11, purpose: 'wallet_transfer' })
    ];
    for (const invalidEvent of invalidFailureEvents) {
      assert.deepEqual(await processWalletFundingEvent(invalidEvent), { outcome: 'REJECTED', intentId: invalidFailureIntent.id, reason: 'FUNDING_METADATA_MISMATCH' });
      assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: invalidFailureIntent.id } })).status, WalletFundingStatus.PENDING);
      assert.deepEqual(balanceState(await balance()), balanceState(beforeInvalidFailure));
    }
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: invalidFailureIntent.id } }), 0);
    assert.equal(await prisma.walletBalanceAllocation.count({ where: { referenceId: invalidFailureIntent.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REJECTED', entityId: invalidFailureIntent.id } }), 2);
    assert.deepEqual(await processWalletFundingEvent(invalidFailureEvents[0]), { outcome: 'DUPLICATE' });
    assert.equal((await success(invalidFailureIntent)).outcome, 'SUCCEEDED');
    assert.equal((await processWalletFundingEvent({ ...invalidFailureEvents[1], eventId: 'evt_wallet_funding_failure_wrong_purpose_after_success' })).outcome, 'REJECTED');
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: invalidFailureIntent.id } }), 1);

    const invalidCancellationIntent = await createFundingIntent(12, 'wallet-funding-invalid-cancellation-metadata', 'pi_wallet_funding_invalid_cancellation_metadata');
    const beforeInvalidCancellation = await balance();
    const invalidCancellationEvents = [
      event({ eventId: 'evt_wallet_funding_cancellation_missing_purpose', eventType: 'payment_intent.canceled', outcome: 'CANCELLED', intent: invalidCancellationIntent, amountMinor: 12 }),
      event({ eventId: 'evt_wallet_funding_cancellation_wrong_purpose', eventType: 'payment_intent.canceled', outcome: 'CANCELLED', intent: invalidCancellationIntent, amountMinor: 12, purpose: 'wallet_transfer' })
    ];
    for (const invalidEvent of invalidCancellationEvents) {
      assert.deepEqual(await processWalletFundingEvent(invalidEvent), { outcome: 'REJECTED', intentId: invalidCancellationIntent.id, reason: 'FUNDING_METADATA_MISMATCH' });
      assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: invalidCancellationIntent.id } })).status, WalletFundingStatus.PENDING);
      assert.deepEqual(balanceState(await balance()), balanceState(beforeInvalidCancellation));
    }
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: invalidCancellationIntent.id } }), 0);
    assert.equal(await prisma.walletBalanceAllocation.count({ where: { referenceId: invalidCancellationIntent.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'WALLET_FUNDING_WEBHOOK_REJECTED', entityId: invalidCancellationIntent.id } }), 2);
    assert.deepEqual(await processWalletFundingEvent(invalidCancellationEvents[0]), { outcome: 'DUPLICATE' });
    assert.equal((await success(invalidCancellationIntent)).outcome, 'SUCCEEDED');
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: invalidCancellationIntent.id } }), 1);

    const balanceBeforeFailure = (await balance()).availableMinor;
    const failedIntent = await prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: targetAccount.id, amountMinor: 15, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_wallet_funding_failed', idempotencyKey: 'wallet-funding-failed' } });
    const failed = await processWalletFundingEvent({ provider: 'STRIPE', eventId: 'evt_wallet_funding_failed', eventType: 'payment_intent.payment_failed', outcome: 'FAILED', providerIntentId: failedIntent.providerIntentId, fundingIntentId: failedIntent.id, amountMinor: 15, amountReceivedMinor: null, currency: 'USD', purpose: 'wallet_top_up', liveMode: false });
    assert.deepEqual(failed, { outcome: 'FAILED', intentId: failedIntent.id });
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: failedIntent.id } })).status, WalletFundingStatus.FAILED);
    assert.equal((await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } })).availableMinor, balanceBeforeFailure);
    const failedRetry = await processWalletFundingEvent({ provider: 'STRIPE', eventId: 'evt_wallet_funding_failed_retry_succeeded', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', providerIntentId: failedIntent.providerIntentId, fundingIntentId: failedIntent.id, amountMinor: 15, amountReceivedMinor: 15, currency: 'USD', purpose: 'wallet_top_up', liveMode: false });
    assert.deepEqual(failedRetry.outcome, 'SUCCEEDED');
    assert.equal((await report()).status, 'MATCHED');

    const reversalIntent = await prisma.walletFundingIntent.create({ data: { userId: target.id, accountId: targetAccount.id, amountMinor: 20, currency: 'USD', provider: 'STRIPE', providerIntentId: 'pi_wallet_funding_reversal', idempotencyKey: 'wallet-funding-reversal' } });
    const reversalSuccess = await processWalletFundingEvent({ provider: 'STRIPE', eventId: 'evt_wallet_funding_reversal_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', providerIntentId: reversalIntent.providerIntentId, fundingIntentId: reversalIntent.id, amountMinor: 20, amountReceivedMinor: 20, currency: 'USD', purpose: 'wallet_top_up', liveMode: false });
    assert.deepEqual(reversalSuccess.outcome, 'SUCCEEDED');
    const reversed = await processWalletFundingEvent({ provider: 'STRIPE', eventId: 'evt_wallet_funding_reversed', eventType: 'charge.refunded', outcome: 'REVERSED', providerIntentId: reversalIntent.providerIntentId, fundingIntentId: null, amountMinor: 20, amountReceivedMinor: null, currency: 'USD', purpose: null, liveMode: false });
    assert.deepEqual({ outcome: reversed.outcome, intentId: reversed.intentId }, { outcome: 'REVERSED', intentId: reversalIntent.id });
    assert.equal(reversed.appliedMinor, 20);
    assert.equal(reversed.cumulativeMinor, 20);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: reversalIntent.id } })).status, WalletFundingStatus.REVERSED);
    assert.equal((await prisma.walletBalance.findUniqueOrThrow({ where: { accountId_currency: { accountId: targetAccount.id, currency: 'USD' } } })).availableMinor, balanceBeforeFailure + 15);
    assert.equal((await report()).status, 'MATCHED');

    const concurrentIntent = await createFundingIntent(10, 'wallet-funding-concurrent', 'pi_wallet_funding_concurrent');
    const concurrentResults = await Promise.all([
      processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_concurrent_a', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: concurrentIntent, amountMinor: 10, amountReceivedMinor: 10, purpose: 'wallet_top_up' })),
      processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_concurrent_b', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: concurrentIntent, amountMinor: 10, amountReceivedMinor: 10, purpose: 'wallet_top_up' }))
    ]);
    assert.equal(concurrentResults.filter(result => result.outcome === 'SUCCEEDED').length, 2);
    assert.equal((await balance()).availableMinor, balanceBeforeFailure + 25);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: concurrentIntent.id } }), 1);
    assert.equal((await report()).status, 'MATCHED');

    const concurrentDuplicateIntent = await createFundingIntent(4, 'wallet-funding-concurrent-duplicate', 'pi_wallet_funding_concurrent_duplicate');
    const concurrentDuplicateEvent = event({ eventId: 'evt_wallet_funding_concurrent_duplicate', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: concurrentDuplicateIntent, amountMinor: 4, amountReceivedMinor: 4, purpose: 'wallet_top_up' });
    const concurrentDuplicateResults = await Promise.all([
      processWalletFundingEvent(concurrentDuplicateEvent),
      processWalletFundingEvent(concurrentDuplicateEvent)
    ]);
    assert.equal(concurrentDuplicateResults.filter(result => result.outcome === 'DUPLICATE').length, 1);
    assert.equal((await balance()).availableMinor, balanceBeforeFailure + 29);
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: concurrentDuplicateIntent.id } }), 1);

    const concurrentRefundIntent = await createFundingIntent(5, 'wallet-funding-concurrent-refund', 'pi_wallet_funding_concurrent_refund');
    const beforeConcurrentRefund = await balance();
    await Promise.all([
      processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_concurrent_refund_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: concurrentRefundIntent, amountMinor: 5, amountReceivedMinor: 5, purpose: 'wallet_top_up' })),
      processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_concurrent_refund_reversal', eventType: 'charge.refunded', outcome: 'REVERSED', intent: concurrentRefundIntent, amountMinor: 5 }))
    ]);
    const concurrentRefundBalance = await balance();
    assert.equal(concurrentRefundBalance.availableMinor, beforeConcurrentRefund.availableMinor);
    assert.ok([WalletFundingStatus.REVERSED, WalletFundingStatus.REVIEW].includes((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: concurrentRefundIntent.id } })).status));

    const concurrentDisputeIntent = await createFundingIntent(5, 'wallet-funding-concurrent-dispute', 'pi_wallet_funding_concurrent_dispute');
    const beforeConcurrentDispute = await balance();
    const [concurrentSuccessResult, concurrentDisputeResult] = await Promise.all([
      processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_concurrent_dispute_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: concurrentDisputeIntent, amountMinor: 5, amountReceivedMinor: 5, purpose: 'wallet_top_up' })),
      processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_concurrent_dispute', eventType: 'charge.dispute.created', outcome: 'DISPUTED', intent: concurrentDisputeIntent, amountMinor: 5 }))
    ]);
    const concurrentDisputeBalance = await balance();
    const concurrentDisputeFinalIntent = await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: concurrentDisputeIntent.id } });
    const concurrentDisputeLedgerCount = await prisma.walletLedgerTransaction.count({ where: { referenceId: concurrentDisputeIntent.id } });
    const concurrentDisputeReceiptCount = await prisma.processedWebhookEvent.count({ where: { eventId: { in: ['evt_wallet_funding_concurrent_dispute_success', 'evt_wallet_funding_concurrent_dispute'] } } });
    assert.equal(concurrentDisputeResult.outcome, 'DISPUTED');
    assert.equal(concurrentDisputeFinalIntent.status, WalletFundingStatus.REVIEW);
    assert.equal(concurrentDisputeReceiptCount, 2);
    if (concurrentSuccessResult.outcome === 'SUCCEEDED') {
      // The successful funding adds economic value; the dispute then moves
      // that new value from AVAILABLE to HELD. The total therefore increases
      // by the funding amount while spendable funds remain unchanged.
      assert.equal(concurrentDisputeBalance.availableMinor, beforeConcurrentDispute.availableMinor);
      assert.equal(concurrentDisputeBalance.heldMinor, beforeConcurrentDispute.heldMinor + concurrentDisputeIntent.amountMinor);
      assert.equal(concurrentDisputeBalance.availableMinor + concurrentDisputeBalance.heldMinor, beforeConcurrentDispute.availableMinor + beforeConcurrentDispute.heldMinor + concurrentDisputeIntent.amountMinor);
      assert.equal(concurrentDisputeLedgerCount, 2);
    } else {
      // If the dispute locks first, it is recorded for review before credit;
      // the later success cannot create spendable funds for that intent.
      assert.deepEqual(concurrentSuccessResult, { outcome: 'REJECTED', intentId: concurrentDisputeIntent.id, reason: 'FUNDING_INTENT_NOT_ACCEPTING_PAYMENT' });
      assert.equal(concurrentDisputeBalance.availableMinor + concurrentDisputeBalance.heldMinor, beforeConcurrentDispute.availableMinor + beforeConcurrentDispute.heldMinor);
      assert.equal(concurrentDisputeLedgerCount, 0);
    }
    assert.equal((await report()).status, 'MATCHED');

    const refundFirstIntent = await createFundingIntent(7, 'wallet-funding-refund-first', 'pi_wallet_funding_refund_first');
    const refundFirstResult = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_refund_first', eventType: 'charge.refunded', outcome: 'REVERSED', intent: refundFirstIntent, amountMinor: 7 }));
    assert.deepEqual({ outcome: refundFirstResult.outcome, intentId: refundFirstResult.intentId, credited: refundFirstResult.credited }, { outcome: 'REVERSED', intentId: refundFirstIntent.id, credited: false });
    assert.equal(refundFirstResult.reviewRequired, false);
    const lateSuccess = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_refund_first_late_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: refundFirstIntent, amountMinor: 7, amountReceivedMinor: 7, purpose: 'wallet_top_up' }));
    assert.deepEqual(lateSuccess, { outcome: 'REJECTED', intentId: refundFirstIntent.id, reason: 'FUNDING_INTENT_NOT_ACCEPTING_PAYMENT' });
    assert.equal(await prisma.walletLedgerTransaction.count({ where: { referenceType: 'WalletFundingIntent', referenceId: refundFirstIntent.id } }), 0);

    const successFirstIntent = await createFundingIntent(8, 'wallet-funding-success-first', 'pi_wallet_funding_success_first');
    await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_success_first', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: successFirstIntent, amountMinor: 8, amountReceivedMinor: 8, purpose: 'wallet_top_up' }));
    const afterSuccess = await balance();
    const successFirstReversal = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_success_first_refund', eventType: 'charge.refunded', outcome: 'REVERSED', intent: successFirstIntent, amountMinor: 8 }));
    assert.deepEqual({ outcome: successFirstReversal.outcome, intentId: successFirstReversal.intentId }, { outcome: 'REVERSED', intentId: successFirstIntent.id });
    assert.equal(successFirstReversal.appliedMinor, 8);
    assert.equal(successFirstReversal.cumulativeMinor, 8);
    assert.equal((await balance()).availableMinor, afterSuccess.availableMinor - 8);

    const disputeFirstIntent = await createFundingIntent(6, 'wallet-funding-dispute-first', 'pi_wallet_funding_dispute_first');
    const disputeFirst = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_dispute_first', eventType: 'charge.dispute.created', outcome: 'DISPUTED', intent: disputeFirstIntent, amountMinor: 6 }));
    assert.equal(disputeFirst.outcome, 'DISPUTED');
    const disputeLateSuccess = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_dispute_first_late_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: disputeFirstIntent, amountMinor: 6, amountReceivedMinor: 6, purpose: 'wallet_top_up' }));
    assert.deepEqual(disputeLateSuccess, { outcome: 'REJECTED', intentId: disputeFirstIntent.id, reason: 'FUNDING_INTENT_NOT_ACCEPTING_PAYMENT' });
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: disputeFirstIntent.id } })).status, WalletFundingStatus.REVIEW);

    const disputeAfterIntent = await createFundingIntent(6, 'wallet-funding-dispute-after', 'pi_wallet_funding_dispute_after');
    await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_dispute_after_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: disputeAfterIntent, amountMinor: 6, amountReceivedMinor: 6, purpose: 'wallet_top_up' }));
    const beforeDisputeHold = await balance();
    const disputeAfter = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_dispute_after', eventType: 'charge.dispute.created', outcome: 'DISPUTED', intent: disputeAfterIntent, amountMinor: 6 }));
    assert.equal(disputeAfter.outcome, 'DISPUTED');
    assert.equal((await balance()).availableMinor, beforeDisputeHold.availableMinor - 6);
    assert.equal((await balance()).heldMinor, beforeDisputeHold.heldMinor + 6);
    const disputeHoldReversal = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_dispute_after_refund', eventType: 'charge.refunded', outcome: 'REVERSED', intent: disputeAfterIntent, amountMinor: 6 }));
    assert.equal(disputeHoldReversal.outcome, 'REVERSED');
    assert.equal((await balance()).heldMinor, beforeDisputeHold.heldMinor);

    const partialIntent = await createFundingIntent(9, 'wallet-funding-partial-refund', 'pi_wallet_funding_partial_refund');
    await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_partial_success', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: partialIntent, amountMinor: 9, amountReceivedMinor: 9, purpose: 'wallet_top_up' }));
    const beforePartial = await balance();
    const partial = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_partial', eventType: 'charge.refunded', outcome: 'PARTIAL_REFUND', intent: partialIntent, amountMinor: 4 }));
    assert.equal(partial.outcome, 'PARTIAL_REFUND');
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: partialIntent.id } })).status, WalletFundingStatus.REVIEW);
    assert.equal((await balance()).availableMinor, beforePartial.availableMinor - 4);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: partialIntent.id } })).refundAppliedMinor, 4);
    const partialFullReversal = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_partial_full_refund', eventType: 'charge.refunded', outcome: 'REVERSED', intent: partialIntent, amountMinor: 9 }));
    assert.equal(partialFullReversal.outcome, 'REVERSED');

    const malformedIntent = await createFundingIntent(5, 'wallet-funding-malformed', 'pi_wallet_funding_malformed');
    const malformedCurrency = await processWalletFundingEvent({ ...event({ eventId: 'evt_wallet_funding_missing_currency', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: malformedIntent, amountMinor: 5, amountReceivedMinor: 5, purpose: 'wallet_top_up' }), currency: null });
    assert.deepEqual(malformedCurrency, { outcome: 'REJECTED', intentId: malformedIntent.id, reason: 'CURRENCY_REQUIRED' });
    const malformedAmount = await processWalletFundingEvent({ ...event({ eventId: 'evt_wallet_funding_zero_amount', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: malformedIntent, amountMinor: 0, amountReceivedMinor: 0, purpose: 'wallet_top_up' }) });
    assert.deepEqual(malformedAmount, { outcome: 'REJECTED', intentId: malformedIntent.id, reason: 'AMOUNT_REQUIRED' });
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: malformedIntent.id } })).status, WalletFundingStatus.PENDING);

    const recoveryIntent = await createFundingIntent(3, 'wallet-funding-provider-recovery', null);
    const providerCalls = [];
    const mockProvider = {
      createPaymentIntent: async input => {
        providerCalls.push(input);
        return { providerIntentId: 'pi_wallet_funding_recovered', clientSecret: null };
      }
    };
    const recoveryInput = { fundingIntentId: recoveryIntent.id, idempotencyKey: recoveryIntent.idempotencyKey, amountMinor: 3, currency: 'USD' };
    const firstProviderPayment = await mockProvider.createPaymentIntent(recoveryInput);
    await assert.rejects(() => funding.persistWalletFundingProviderReference(recoveryIntent.id, firstProviderPayment.providerIntentId, async () => { throw new Error('injected persistence failure'); }));
    const retryProviderPayment = await mockProvider.createPaymentIntent(recoveryInput);
    await funding.persistWalletFundingProviderReference(recoveryIntent.id, retryProviderPayment.providerIntentId);
    assert.equal(providerCalls.length, 2);
    assert.equal(providerCalls[0].fundingIntentId, providerCalls[1].fundingIntentId);
    assert.equal(providerCalls[0].idempotencyKey, providerCalls[1].idempotencyKey);
    assert.equal((await prisma.walletFundingIntent.findUniqueOrThrow({ where: { id: recoveryIntent.id } })).providerIntentId, 'pi_wallet_funding_recovered');
    const recoverySuccess = await processWalletFundingEvent(event({ eventId: 'evt_wallet_funding_provider_recovered', eventType: 'payment_intent.succeeded', outcome: 'SUCCEEDED', intent: { ...recoveryIntent, providerIntentId: 'pi_wallet_funding_recovered' }, amountMinor: 3, amountReceivedMinor: 3, purpose: 'wallet_top_up' }));
    assert.equal(recoverySuccess.outcome, 'SUCCEEDED');
    assert.equal((await report()).status, 'MATCHED');

    const webhookSecret = 'whsec_synthetic_wallet_funding_test';
    const stripeClient = new Stripe('sk_test_synthetic_wallet_funding');
    const provider = new StripeWalletFundingProvider(stripeClient, webhookSecret);
    const payload = JSON.stringify({ id: 'evt_signature_test', object: 'event', livemode: false, type: 'payment_intent.succeeded', data: { object: { id: 'pi_signature_test', object: 'payment_intent', amount: 25, amount_received: 25, currency: 'usd', metadata: { scrolithFundingIntentId: successIntent.id, scrolithPurpose: 'wallet_top_up' } } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    assert.equal(provider.verifyWebhook(Buffer.from(payload), signature).outcome, 'SUCCEEDED');
    assert.throws(() => provider.verifyWebhook(Buffer.from(payload), 't=1,v1=invalid'), /signature/i);
    const partialPayload = JSON.stringify({ id: 'evt_signature_partial', object: 'event', livemode: false, type: 'charge.refunded', data: { object: { id: 'ch_signature_partial', object: 'charge', amount: 100, amount_refunded: 40, currency: 'usd', payment_intent: 'pi_wallet_funding_partial_refund' } } });
    const partialSignature = Stripe.webhooks.generateTestHeaderString({ payload: partialPayload, secret: webhookSecret });
    assert.equal(provider.verifyWebhook(Buffer.from(partialPayload), partialSignature).outcome, 'PARTIAL_REFUND');
    const disputePayload = JSON.stringify({ id: 'evt_signature_dispute', object: 'event', livemode: false, type: 'charge.dispute.created', data: { object: { id: 'dp_signature_dispute', object: 'dispute', amount: 100, currency: 'usd', payment_intent: 'pi_wallet_funding_dispute_after' } } });
    const disputeSignature = Stripe.webhooks.generateTestHeaderString({ payload: disputePayload, secret: webhookSecret });
    assert.equal(provider.verifyWebhook(Buffer.from(disputePayload), disputeSignature).outcome, 'DISPUTED');
  } finally {
    await prisma.$disconnect();
  }
});
