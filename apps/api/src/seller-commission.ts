import { Prisma, SellerCommissionEntryType } from '@prisma/client';
import { env } from './config.js';
import { calculateCommissionMinor, allocateCommission, type CommissionTerms } from './currency-domain.js';
import { effectiveStorePlan } from './store-plan-domain.js';
import { freeStoreCommissionApplies } from './seller-commission-policy-domain.js';

type CommissionDb = Prisma.TransactionClient;
type Policy = CommissionTerms & { id: string; version: number; currency: string; reason: string; storeId: string | null; planVersionId: string | null; freeStoreScopeKey: string | null };
const netItemBase = (item: { unitPriceMinor: number; quantity: number; discountMinor?: number }) => Math.max(0, item.unitPriceMinor * item.quantity - (item.discountMinor ?? 0));

export async function applicableSellerCommissionPolicy(db: CommissionDb, storeId: string, currency: string, now = new Date()): Promise<Policy | null> {
  void currency; // Percentage commission is calculated in the order's own currency.
  const store = await db.store.findUnique({ where: { id: storeId }, select: { isPlatformStore: true } });
  if (!store) return null;
  const plan = await effectiveStorePlan(db, storeId, now);
  if (!freeStoreCommissionApplies(store.isPlatformStore, plan.version)) return null;
  return db.sellerCommissionPolicyVersion.findFirst({
    where: {
      freeStoreScopeKey: 'FREE_STORES',
      status: 'ACTIVE',
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }]
    },
    orderBy: { version: 'desc' }
  });
}

export function makeCommissionSnapshot(policy: Policy | null, currency: string, now = new Date()) {
  if (!policy) return {
    version: 1, policyVersionId: null, source: 'DEFAULT_ZERO', type: 'ZERO', fixedMinor: null,
    basisPoints: null, minimumMinor: null, capMinor: null, currency, capturedAt: now.toISOString(), reason: 'No active policy; zero commission applies.'
  };
  return {
    version: 1, policyVersionId: policy.id, policyVersion: policy.version,
    source: policy.freeStoreScopeKey ? 'FREE_STORES' : policy.storeId ? 'LEGACY_STORE' : 'LEGACY_PLAN', type: policy.type, fixedMinor: policy.fixedMinor,
    basisPoints: policy.basisPoints, minimumMinor: policy.minimumMinor, capMinor: policy.capMinor,
    currency, capturedAt: now.toISOString(), reason: policy.reason
  };
}

function snapshotTerms(snapshot: Prisma.JsonValue): CommissionTerms | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const value = snapshot as Record<string, Prisma.JsonValue>;
  if (!['ZERO', 'FIXED_PER_ORDER', 'PERCENTAGE', 'PERCENTAGE_PLUS_FIXED'].includes(String(value.type))) return null;
  return {
    type: String(value.type) as CommissionTerms['type'],
    fixedMinor: typeof value.fixedMinor === 'number' ? value.fixedMinor : null,
    basisPoints: typeof value.basisPoints === 'number' ? value.basisPoints : null,
    minimumMinor: typeof value.minimumMinor === 'number' ? value.minimumMinor : null,
    capMinor: typeof value.capMinor === 'number' ? value.capMinor : null
  };
}

async function lockSellerOrders(db: CommissionDb, parentId: string) {
  await db.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "parentId" = ${parentId} ORDER BY "id" FOR UPDATE`;
}

async function lockParentOrder(db: CommissionDb, parentId: string) {
  const locked = await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ParentOrder" WHERE "id" = ${parentId} FOR UPDATE`;
  return locked.length === 1;
}

export async function accrueSellerCommissionsForPaidOrder(db: CommissionDb, parentId: string, eventId: string) {
  if (!await lockParentOrder(db, parentId)) return 0;
  await lockSellerOrders(db, parentId);
  const order = await db.parentOrder.findUnique({ where: { id: parentId }, include: { payment: true, sellerOrders: { include: { items: true } } } });
  if (!order || order.payment?.status !== 'PAID') return 0;
  if (order.payment.method === 'COD' && order.sellerOrders.some(row => row.sellerId && row.status !== 'FULFILLED')) return 0;
  let posted = 0;
  for (const sellerOrder of order.sellerOrders) {
    if (!sellerOrder.sellerId || sellerOrder.status === 'CANCELLED' || !sellerOrder.commissionSnapshotJson) continue;
    const terms = snapshotTerms(sellerOrder.commissionSnapshotJson);
    if (!terms) throw new Error('Commission snapshot is invalid; order requires finance review.');
    const eligibleItems = sellerOrder.items.map(item => ({ id: item.id, eligibleBaseMinor: netItemBase(item) }));
    const baseTotal = eligibleItems.reduce((sum, item) => sum + item.eligibleBaseMinor, 0);
    if (!Number.isSafeInteger(baseTotal) || baseTotal < 0) throw new Error('Commission eligible base is outside the supported amount range.');
    const amount = calculateCommissionMinor(terms, baseTotal);
    if (!amount) continue;
    const allocations = allocateCommission(amount, eligibleItems);
    const snapshot = sellerOrder.commissionSnapshotJson as Record<string, Prisma.JsonValue>;
    const reporting = order.currency === env.CURRENCY ? {
      reportingAmountMinor: amount,
      reportingCurrency: env.CURRENCY,
      reportingSnapshotJson: { baseCurrency: order.currency, quoteCurrency: env.CURRENCY, rate: '1', source: 'IDENTITY', capturedAt: new Date().toISOString() } as Prisma.InputJsonValue
    } : {};
    const result = await db.sellerCommissionLedgerEntry.createMany({
      data: allocations.filter(item => item.amountMinor > 0).map(item => ({
        sellerId: sellerOrder.sellerId!, sellerOrderId: sellerOrder.id, orderItemId: item.id,
        policyVersionId: typeof snapshot.policyVersionId === 'string' ? snapshot.policyVersionId : null,
        entryType: SellerCommissionEntryType.ACCRUAL, amountMinor: item.amountMinor,
        eligibleBaseMinor: eligibleItems.find(value => value.id === item.id)?.eligibleBaseMinor ?? 0,
        currency: order.currency, idempotencyKey: `seller-commission:accrual:${order.id}:${item.id}`,
        sourceEventId: eventId, ...reporting
      })), skipDuplicates: true
    });
    posted += result.count;
  }
  return posted;
}

export async function reverseSellerCommissionForOrder(db: CommissionDb, parentId: string, eventId: string, reason: string, sellerOrderId?: string) {
  if (!await lockParentOrder(db, parentId)) return 0;
  await lockSellerOrders(db, parentId);
  const accruals = await db.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId, ...(sellerOrderId ? { id: sellerOrderId } : {}) }, entryType: SellerCommissionEntryType.ACCRUAL }, orderBy: { id: 'asc' } });
  let reversed = 0;
  for (const accrual of accruals) {
    const prior = await db.sellerCommissionLedgerEntry.aggregate({ where: { reversalOfId: accrual.id }, _sum: { amountMinor: true, eligibleBaseMinor: true } });
    const alreadyReversedAmount = -(prior._sum.amountMinor ?? 0);
    const alreadyReversedBase = prior._sum.eligibleBaseMinor ?? 0;
    if (alreadyReversedAmount < 0 || alreadyReversedAmount > accrual.amountMinor
      || alreadyReversedBase < 0 || alreadyReversedBase > accrual.eligibleBaseMinor) {
      throw new Error('Existing commission reversals exceed their source accrual; finance review is required.');
    }
    const remainingAmount = accrual.amountMinor - alreadyReversedAmount;
    const remainingBase = accrual.eligibleBaseMinor - alreadyReversedBase;
    if (remainingAmount > 0 || remainingBase > 0) {
      const reversal = {
        sellerId: accrual.sellerId, sellerOrderId: accrual.sellerOrderId, orderItemId: accrual.orderItemId,
        policyVersionId: accrual.policyVersionId, entryType: SellerCommissionEntryType.REVERSAL,
        amountMinor: -remainingAmount, eligibleBaseMinor: remainingBase, currency: accrual.currency,
        idempotencyKey: `seller-commission:reverse:${eventId}:${accrual.id}`, sourceEventId: eventId,
        reversalOfId: accrual.id, reason
      };
      const inserted = await db.sellerCommissionLedgerEntry.createMany({ data: [reversal], skipDuplicates: true });
      if (inserted.count === 1) reversed += 1;
      else {
        const existing = await db.sellerCommissionLedgerEntry.findUnique({ where: { idempotencyKey: reversal.idempotencyKey } });
        if (!existing || existing.entryType !== reversal.entryType || existing.amountMinor !== reversal.amountMinor
          || existing.eligibleBaseMinor !== reversal.eligibleBaseMinor || existing.reversalOfId !== reversal.reversalOfId
          || existing.orderItemId !== reversal.orderItemId || existing.sellerOrderId !== reversal.sellerOrderId
          || existing.currency !== reversal.currency) {
          throw new Error('The seller commission reversal could not be confirmed; finance review is required.');
        }
      }
    }
  }
  return reversed;
}

export async function createPartialRefundReview(db: CommissionDb, input: { parentOrderId: string; provider: string; providerEventId: string; amountMinor: number; currency: string; reason: string }) {
  const result = await db.sellerCommissionReviewEvent.createMany({ data: [{
    parentOrderId: input.parentOrderId, provider: input.provider, providerEventId: input.providerEventId,
    status: 'NEEDS_ALLOCATION', amountMinor: input.amountMinor, currency: input.currency,
    idempotencyKey: `seller-commission:refund-review:${input.provider}:${input.providerEventId}`, reason: input.reason
  }], skipDuplicates: true });
  return result.count;
}

export async function allocatePartialRefund(db: CommissionDb, input: {
  parentOrderId: string; reviewEventId: string; actorId: string; allocations: { orderItemId: string; refundMinor: number }[]
}) {
  await db.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${input.parentOrderId} FOR UPDATE`;
  const review = await db.sellerCommissionReviewEvent.findFirst({ where: { id: input.reviewEventId, parentOrderId: input.parentOrderId, status: 'NEEDS_ALLOCATION' } });
  if (!review) throw Object.assign(new Error('Refund review event not found or already resolved.'), { statusCode: 404 });
  const payment = await db.payment.findUnique({ where: { parentId: input.parentOrderId }, select: { method: true, status: true, paidAt: true } });
  const order = await db.parentOrder.findUnique({ where: { id: input.parentOrderId }, select: { currency: true, totalMinor: true } });
  const provider = review.provider === 'STRIPE' || review.provider === 'PAYPAL' || review.provider === 'PAYMONGO' || review.provider === 'PAYSTACK' ? review.provider : null;
  const supportedEventTypes = provider === 'STRIPE'
    ? ['charge.refunded', 'charge.dispute.created']
    : provider === 'PAYPAL'
      ? ['PAYMENT.CAPTURE.REFUNDED', 'CUSTOMER.DISPUTE.CREATED']
      : provider === 'PAYMONGO'
        ? ['refund.succeeded', 'dispute.created']
        : provider === 'PAYSTACK'
          ? ['refund.processed', 'charge.dispute.create']
          : [];
  const sourceEvent = provider && review.providerEventId && supportedEventTypes.length
    ? await db.processedWebhookEvent.findFirst({
      where: {
        provider, eventId: review.providerEventId, parentOrderId: input.parentOrderId,
        reviewReason: null, eventType: { in: supportedEventTypes }
      },
      select: { eventType: true, amountMinor: true, currency: true, normalizedAmountMinor: true, normalizedCurrency: true, providerTotalMinor: true }
    })
    : null;
  const sourceAmountMinor = sourceEvent?.normalizedAmountMinor ?? sourceEvent?.amountMinor;
  const sourceCurrency = sourceEvent?.normalizedCurrency ?? sourceEvent?.currency;
  const sourceAmountMatches = sourceEvent?.eventType === 'charge.refunded'
    ? sourceAmountMinor != null && sourceAmountMinor >= review.amountMinor && (sourceEvent.normalizedAmountMinor !== null || sourceEvent.providerTotalMinor === order?.totalMinor)
    : sourceAmountMinor === review.amountMinor;
  if (!sourceEvent?.eventType || !provider || payment?.method !== provider || !order
    || sourceCurrency !== review.currency || review.currency !== order.currency || !sourceAmountMatches) {
    throw Object.assign(new Error('The verified provider event for this refund review is unavailable or does not match the order.'), { statusCode: 409, code: 'COMMISSION_REFUND_EVENT_MISSING' });
  }
  // A partial dispute can put a captured payment in DISPUTED while a separate
  // refund allocation is still valid. paidAt proves capture; a full refund is
  // terminal and its pending allocation reviews are superseded in the webhook tx.
  const disputeReview = sourceEvent.eventType.toLowerCase().includes('dispute');
  const captured = payment?.paidAt != null;
  const paymentStateValid = disputeReview
    ? payment?.status === 'DISPUTED' && captured
    : ['PAID', 'DISPUTED'].includes(payment?.status ?? '') && captured;
  if (!paymentStateValid) {
    throw Object.assign(new Error(disputeReview
      ? 'The related payment is not in a captured, verified dispute state.'
      : 'The related payment must be captured and not fully refunded before an allocation can be posted.'), {
      statusCode: 409,
      code: captured ? 'COMMISSION_PAYMENT_STATE_MISMATCH' : 'COMMISSION_PAYMENT_NOT_CAPTURED'
    });
  }
  await lockSellerOrders(db, input.parentOrderId);
  if (input.allocations.reduce((sum, item) => sum + item.refundMinor, 0) !== review.amountMinor) throw Object.assign(new Error('Item refund allocations must equal the verified refund amount.'), { statusCode: 400 });
  const itemIds = input.allocations.map(item => item.orderItemId);
  if (new Set(itemIds).size !== itemIds.length || input.allocations.some(item => !Number.isSafeInteger(item.refundMinor) || item.refundMinor <= 0)) throw Object.assign(new Error('Refund allocations must contain unique items and positive integer minor amounts.'), { statusCode: 400 });
  const items = await db.orderItem.findMany({ where: { id: { in: itemIds }, sellerOrder: { parentId: input.parentOrderId, sellerId: { not: null } } }, include: { sellerOrder: { include: { items: true } } } });
  if (items.length !== itemIds.length) throw Object.assign(new Error('Refund item is not part of this order.'), { statusCode: 400 });
  const allocationJson: { orderItemId: string; refundMinor: number }[] = [];
  for (const allocation of input.allocations) {
    const item = items.find(candidate => candidate.id === allocation.orderItemId)!;
    const itemBase = netItemBase(item);
    const priorReviews = await db.sellerCommissionReviewEvent.findMany({ where: { parentOrderId: input.parentOrderId, status: 'POSTED', id: { not: review.id } }, select: { allocationJson: true } });
    const priorRefunded = priorReviews.flatMap(row => Array.isArray(row.allocationJson) ? row.allocationJson as unknown as { orderItemId: string; refundMinor: number }[] : []).filter(row => row.orderItemId === item.id).reduce((sum, row) => sum + row.refundMinor, 0);
    if (priorRefunded + allocation.refundMinor > itemBase) throw Object.assign(new Error('Refund allocation exceeds the remaining item value.'), { statusCode: 409 });
    const accrual = await db.sellerCommissionLedgerEntry.findFirst({ where: { orderItemId: item.id, entryType: 'ACCRUAL' } });
    const terms = item.sellerOrder.commissionSnapshotJson ? snapshotTerms(item.sellerOrder.commissionSnapshotJson) : null;
    if (!terms) throw Object.assign(new Error('The order has no valid commission policy snapshot; manual finance review is required.'), { statusCode: 409, code: 'COMMISSION_POLICY_SNAPSHOT_MISSING' });
    const eligibleItems = item.sellerOrder.items.map(orderItem => ({ id: orderItem.id, eligibleBaseMinor: netItemBase(orderItem) }));
    const sellerOrderBase = eligibleItems.reduce((sum, eligibleItem) => sum + eligibleItem.eligibleBaseMinor, 0);
    if (!Number.isSafeInteger(sellerOrderBase) || sellerOrderBase < 0) throw Object.assign(new Error('The saved commission base is outside the supported amount range.'), { statusCode: 409, code: 'COMMISSION_BASE_INVALID' });
    const expectedCommission = allocateCommission(calculateCommissionMinor(terms, sellerOrderBase), eligibleItems).find(row => row.id === item.id)?.amountMinor;
    if (expectedCommission == null) throw Object.assign(new Error('The item is missing from its saved commission allocation.'), { statusCode: 409, code: 'COMMISSION_ITEM_ALLOCATION_MISSING' });
    if (!accrual && expectedCommission > 0) throw Object.assign(new Error('The captured order is missing its expected commission accrual; the refund remains pending finance review.'), { statusCode: 409, code: 'COMMISSION_ACCRUAL_MISSING' });
    if (accrual && (expectedCommission === 0 || accrual.amountMinor !== expectedCommission || accrual.eligibleBaseMinor !== itemBase)) {
      throw Object.assign(new Error('The commission accrual does not match the immutable order policy snapshot.'), { statusCode: 409, code: 'COMMISSION_ACCRUAL_MISMATCH' });
    }
    if (accrual) {
      const priorReversals = await db.sellerCommissionLedgerEntry.aggregate({ where: { reversalOfId: accrual.id }, _sum: { amountMinor: true, eligibleBaseMinor: true } });
      const priorCommission = -(priorReversals._sum.amountMinor ?? 0);
      const commissionBaseReversed = priorReversals._sum.eligibleBaseMinor ?? 0;
      const newBase = commissionBaseReversed + allocation.refundMinor;
      const targetReversed = newBase === accrual.eligibleBaseMinor
        ? accrual.amountMinor
        : Number((BigInt(accrual.amountMinor) * BigInt(newBase) * 2n + BigInt(accrual.eligibleBaseMinor)) / (2n * BigInt(accrual.eligibleBaseMinor)));
      const commissionDelta = Math.max(0, targetReversed - priorCommission);
      const idempotencyKey = `seller-commission:partial:${review.id}:${accrual.id}`;
      const reversal = {
        sellerId: accrual.sellerId, sellerOrderId: accrual.sellerOrderId, orderItemId: accrual.orderItemId,
        policyVersionId: accrual.policyVersionId, entryType: SellerCommissionEntryType.REVERSAL, amountMinor: -commissionDelta,
        eligibleBaseMinor: allocation.refundMinor, currency: accrual.currency,
        idempotencyKey, sourceEventId: review.providerEventId ?? review.id,
        reversalOfId: accrual.id, reason: `Allocated partial refund ${review.providerEventId ?? review.id}`
      };
      const inserted = await db.sellerCommissionLedgerEntry.createMany({ data: [reversal], skipDuplicates: true });
      if (inserted.count !== 1) {
        const existing = await db.sellerCommissionLedgerEntry.findUnique({ where: { idempotencyKey } });
        if (!existing || existing.entryType !== reversal.entryType || existing.amountMinor !== reversal.amountMinor || existing.eligibleBaseMinor !== reversal.eligibleBaseMinor || existing.reversalOfId !== reversal.reversalOfId || existing.orderItemId !== reversal.orderItemId || existing.sellerOrderId !== reversal.sellerOrderId || existing.currency !== reversal.currency) {
          throw Object.assign(new Error('The commission reversal could not be confirmed; the refund remains pending.'), { statusCode: 409, code: 'COMMISSION_REVERSAL_NOT_RECORDED' });
        }
      }
    } else if (expectedCommission !== 0) {
      // Missing accruals are never treated as zero; only the saved ZERO policy
      // (or an explicitly zero item allocation from that policy) may have none.
      throw Object.assign(new Error('A commission reversal cannot be posted without its source accrual.'), { statusCode: 409, code: 'COMMISSION_ACCRUAL_MISSING' });
    }
    allocationJson.push(allocation);
  }
  await db.sellerCommissionReviewEvent.update({ where: { id: review.id }, data: { status: 'POSTED', allocationJson: allocationJson as Prisma.InputJsonValue, reviewedById: input.actorId, reviewedAt: new Date() } });
}
