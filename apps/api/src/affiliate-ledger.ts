import { AffiliateStatus, CommissionEntryType, CommissionStatus, AffiliateAdjustmentType, Prisma } from '@prisma/client';
import { env } from './config.js';
import { commissionMinor, proportionalCommission } from './growth-domain.js';
import { prisma } from './security.js';
import { effectiveStorePlan, storeEntitlements } from './store-plan-domain.js';

type AdjustmentInput = {
  type: AffiliateAdjustmentType;
  eventId?: string;
  idempotencyKey: string;
  reason?: string;
  orderItemId?: string;
  quantity?: number;
  /** Gross refunded/disputed order value, not an affiliate commission amount. */
  eligibleBaseMinor?: number;
  amountMinor?: number;
  createdById?: string;
};
type Tx = Prisma.TransactionClient;
const netItemBase = (item: { unitPriceMinor: number; quantity: number; discountMinor?: number }) => Math.max(0, item.unitPriceMinor * item.quantity - (item.discountMinor ?? 0));

function allocateRefundBase(totalMinor: number, weights: number[]) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || weights.some(weight => !Number.isSafeInteger(weight) || weight < 0)) throw new Error('Invalid affiliate refund allocation');
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isSafeInteger(totalWeight) || totalWeight <= 0) return weights.map(() => 0);
  const allocated = weights.map(weight => Number(BigInt(totalMinor) * BigInt(weight) / BigInt(totalWeight)));
  let remainder = totalMinor - allocated.reduce((sum, value) => sum + value, 0);
  const byRemainder = weights.map((weight, index) => ({ index, remainder: BigInt(totalMinor) * BigInt(weight) % BigInt(totalWeight) }))
    .sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  for (const part of byRemainder) {
    if (remainder <= 0) break;
    if (weights[part.index] === 0) continue;
    allocated[part.index] = (allocated[part.index] ?? 0) + 1;
    remainder -= 1;
  }
  return allocated;
}

function chooseRule(rules: Array<{ id: string; name: string; productId: string | null; categoryId: string | null; basisPoints: number | null; fixedMinor: number | null }>, productId: string, categoryId: string | null) {
  return rules.sort((a, b) => {
    const score = (rule: typeof a) => rule.productId === productId ? 4 : rule.categoryId === categoryId && categoryId ? 3 : rule.productId === null && rule.categoryId === null ? 1 : 0;
    return score(b) - score(a);
  })[0];
}

/** Creates pending, idempotent affiliate entries in the caller's payment transaction. */
export async function settleAffiliateForPaidOrderInTransaction(tx: Tx, orderId: string, sourceEventId?: string) {
  // Settlement and cancellation share the parent-order serialization point.
  // Always lock it before reading seller orders or writing ledger rows.
  await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${orderId} FOR UPDATE`;
  const settings = await tx.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (!settings?.affiliateEnabled) return { created: 0 };
  const now = new Date();
  const order = await tx.parentOrder.findUnique({ where: { id: orderId }, include: { payment: true, affiliateClick: { include: { affiliate: true, link: true } }, sellerOrders: { include: { items: { include: { product: { include: { category: true } } } } } } } });
  if (!order?.affiliateClick || order.payment?.status !== 'PAID' || order.affiliateClick.affiliate.status !== AffiliateStatus.APPROVED) return { created: 0 };

  const click = await tx.affiliateClick.findUnique({ where: { id: order.affiliateClick.id } });
  if (!click || click.convertedAt || click.expiresAt <= now || !click.consentGivenAt) return { created: 0 };
  let created = 0;
  for (const sellerOrder of order.sellerOrders) {
    if (sellerOrder.status === 'CANCELLED') continue;
    let storeAffiliateEligible = true;
    if (sellerOrder.sellerId) {
      const store = await tx.store.findUnique({ where: { sellerId: sellerOrder.sellerId }, select: { id: true } });
      if (store) {
        const participation = await tx.storeAffiliateProgram.findUnique({ where: { storeId: store.id } });
        if (participation) {
          const plan = await effectiveStorePlan(tx, store.id, now);
          storeAffiliateEligible = participation.enabled && (await storeEntitlements(tx, store.id, plan.version)).affiliateToolsEnabled;
        }
      }
    }
    for (const item of sellerOrder.items) {
      if (!storeAffiliateEligible) continue;
      const eligible = (!click.productId || click.productId === item.productId) && (!order.affiliateClick.link.sellerId || order.affiliateClick.link.sellerId === sellerOrder.sellerId);
      if (!eligible) continue;
      const rules = await tx.affiliateCommissionRule.findMany({ where: { currency: order.currency, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }], AND: [{ OR: [{ productId: item.productId }, ...(item.product.categoryId ? [{ categoryId: item.product.categoryId }] : []), { productId: null, categoryId: null }] }] } });
      const rule = chooseRule(rules, item.productId, item.product.categoryId);
      const eligibleBaseMinor = netItemBase(item);
      const amountMinor = commissionMinor(eligibleBaseMinor, rule?.basisPoints ?? env.AFFILIATE_DEFAULT_BASIS_POINTS, rule?.fixedMinor);
      if (amountMinor < 1) continue;
      const key = `${order.id}:${item.id}`;
      if (await tx.commissionLedger.findUnique({ where: { idempotencyKey: key } })) continue;
      await tx.commissionLedger.create({ data: { affiliateId: click.affiliateId, orderItemId: item.id, ruleId: rule?.id, amountMinor, currency: order.currency, status: CommissionStatus.PENDING, entryType: CommissionEntryType.EARNED, eligibleBaseMinor, ruleName: rule?.name ?? 'Default affiliate rule', basisPointsSnapshot: rule?.basisPoints ?? env.AFFILIATE_DEFAULT_BASIS_POINTS, fixedMinorSnapshot: rule?.fixedMinor, idempotencyKey: key, sourceEventId: sourceEventId ?? `payment-capture:${order.id}` } });
      created += 1;
    }
  }
  if (order.sellerOrders.some(sellerOrder => sellerOrder.status !== 'CANCELLED')) {
    await tx.affiliateClick.update({ where: { id: click.id }, data: { convertedAt: now } });
  }
  return { created };
}

/** Preserves the non-webhook caller API; webhook reconciliation uses the transaction-scoped variant. */
export async function settleAffiliateForPaidOrder(orderId: string) {
  return prisma.$transaction(tx => settleAffiliateForPaidOrderInTransaction(tx, orderId));
}

/** Adds an append-only negative ledger entry. It never edits an earned financial record. */
export async function reverseAffiliateForOrderInTransaction(tx: Tx, orderId: string, input: AdjustmentInput) {
  // Shared lock order for every reversal path: ParentOrder, then earned
  // CommissionLedger rows in stable ID order. Webhook callers acquire their
  // provider-reference advisory lock before this parent-order lock.
  await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${orderId} FOR UPDATE`;
  const adjustmentKey = `affiliate-adjustment:${input.idempotencyKey}`;
  const existingAdjustment = await tx.affiliateAdjustment.findUnique({ where: { idempotencyKey: adjustmentKey } });
  if (existingAdjustment) return { adjustment: existingAdjustment, reversed: 0, duplicate: true };
  const order = await tx.parentOrder.findUnique({ where: { id: orderId }, include: { affiliateClick: { include: { affiliate: true } }, payment: true } });
  // Existing earnings remain reversible even if an affiliate is later
  // suspended or rejected; current eligibility must not erase ledger history.
  if (!order?.affiliateClick) return { adjustment: null, reversed: 0, duplicate: false };
  await tx.$queryRaw`SELECT entry."id"
    FROM "CommissionLedger" AS entry
    JOIN "OrderItem" AS item ON item."id" = entry."orderItemId"
    JOIN "SellerOrder" AS seller_order ON seller_order."id" = item."sellerOrderId"
    WHERE seller_order."parentId" = ${orderId}
      AND entry."affiliateId" = ${order.affiliateClick.affiliateId}
      AND entry."entryType"::text = 'EARNED'
    ORDER BY entry."id"
    FOR UPDATE OF entry`;
  const entries = await tx.commissionLedger.findMany({ where: { affiliateId: order.affiliateClick.affiliateId, entryType: CommissionEntryType.EARNED, ...(input.orderItemId ? { orderItemId: input.orderItemId } : {}), orderItem: { sellerOrder: { parentId: orderId } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { reversals: true, orderItem: true } });
  if (input.eligibleBaseMinor !== undefined) {
    if (!Number.isSafeInteger(input.eligibleBaseMinor) || input.eligibleBaseMinor < 1) throw new Error('Invalid affiliate refund base');
    const remainingBases = entries.map(entry => Math.max(0, entry.eligibleBaseMinor - entry.reversals.reduce((sum, reversal) => sum + Math.abs(reversal.eligibleBaseMinor), 0)));
    const baseToAllocate = Math.min(input.eligibleBaseMinor, remainingBases.reduce((sum, amount) => sum + amount, 0));
    const allocations = allocateRefundBase(baseToAllocate, remainingBases);
    let reversed = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const allocatedBase = allocations[index] ?? 0;
      if (allocatedBase <= 0) continue;
      const alreadyReversedBase = entry.eligibleBaseMinor - (remainingBases[index] ?? 0);
      const alreadyReversedCommission = entry.reversals.reduce((sum, reversal) => sum + Math.abs(reversal.amountMinor), 0);
      const targetReversed = Number(BigInt(entry.amountMinor) * BigInt(alreadyReversedBase + allocatedBase) / BigInt(entry.eligibleBaseMinor));
      const amount = Math.min(Math.max(0, entry.amountMinor - alreadyReversedCommission), Math.max(0, targetReversed - alreadyReversedCommission));
      if (amount <= 0) continue;
      await tx.commissionLedger.create({ data: { affiliateId: entry.affiliateId, orderItemId: entry.orderItemId, ruleId: entry.ruleId, amountMinor: -amount, currency: entry.currency, status: CommissionStatus.REVERSED, entryType: CommissionEntryType.REVERSAL, eligibleBaseMinor: -allocatedBase, ruleName: entry.ruleName, basisPointsSnapshot: entry.basisPointsSnapshot, fixedMinorSnapshot: entry.fixedMinorSnapshot, idempotencyKey: `${adjustmentKey}:${entry.id}`, sourceEventId: input.eventId, reversalOfId: entry.id, reason: input.reason } });
      reversed += amount;
      if (alreadyReversedCommission + amount >= entry.amountMinor) await tx.commissionLedger.update({ where: { id: entry.id }, data: { status: CommissionStatus.REVERSED } });
    }
    const adjustment = await tx.affiliateAdjustment.create({ data: { orderId, type: input.type, amountMinor: reversed, currency: order.currency, idempotencyKey: adjustmentKey, providerEventId: input.eventId, reason: input.reason, createdById: input.createdById } });
    await tx.auditLog.create({ data: {
      actorId: input.createdById ?? null,
      action: 'AFFILIATE_COMMISSION_ADJUSTMENT_POSTED',
      entity: 'AffiliateAdjustment',
      entityId: adjustment.id,
      metadata: { orderId, type: input.type, amountMinor: reversed, currency: order.currency, eventId: input.eventId ?? null, reason: input.reason ?? null }
    } });
    return { adjustment, reversed, duplicate: false };
  }
  let remainingAdjustment = input.amountMinor ?? Number.MAX_SAFE_INTEGER;
  let reversed = 0;
  for (const entry of entries) {
    const alreadyReversed = entry.reversals.reduce((sum, reversal) => sum + Math.abs(reversal.amountMinor), 0);
    const remainingCommission = Math.max(0, entry.amountMinor - alreadyReversed);
    if (!remainingCommission) continue;
    const requestedQuantity = input.quantity && entry.orderItem ? Math.min(input.quantity, entry.orderItem.quantity) : null;
    const requestedBase = requestedQuantity !== null && entry.orderItem
      ? Math.max(0, entry.orderItem.unitPriceMinor * requestedQuantity - Math.round((entry.orderItem.discountMinor ?? 0) * requestedQuantity / entry.orderItem.quantity))
      : entry.eligibleBaseMinor;
    const proportional = proportionalCommission(entry.amountMinor, entry.eligibleBaseMinor, requestedBase);
    const amount = Math.min(remainingCommission, proportional, remainingAdjustment);
    if (amount <= 0) continue;
    await tx.commissionLedger.create({ data: { affiliateId: entry.affiliateId, orderItemId: entry.orderItemId, ruleId: entry.ruleId, amountMinor: -amount, currency: entry.currency, status: CommissionStatus.REVERSED, entryType: CommissionEntryType.REVERSAL, eligibleBaseMinor: -Math.min(entry.eligibleBaseMinor, requestedBase), ruleName: entry.ruleName, basisPointsSnapshot: entry.basisPointsSnapshot, fixedMinorSnapshot: entry.fixedMinorSnapshot, idempotencyKey: `${adjustmentKey}:${entry.id}`, sourceEventId: input.eventId, reversalOfId: entry.id, reason: input.reason } });
    reversed += amount;
    remainingAdjustment -= amount;
    if (alreadyReversed + amount >= entry.amountMinor) await tx.commissionLedger.update({ where: { id: entry.id }, data: { status: CommissionStatus.REVERSED } });
  }
  const adjustment = await tx.affiliateAdjustment.create({ data: { orderId, orderItemId: input.orderItemId, type: input.type, quantity: input.quantity, amountMinor: reversed, currency: order.currency, idempotencyKey: adjustmentKey, providerEventId: input.eventId, reason: input.reason, createdById: input.createdById } });
  await tx.auditLog.create({ data: {
    actorId: input.createdById ?? null,
    action: 'AFFILIATE_COMMISSION_ADJUSTMENT_POSTED',
    entity: 'AffiliateAdjustment',
    entityId: adjustment.id,
    metadata: { orderId, type: input.type, amountMinor: reversed, currency: order.currency, eventId: input.eventId ?? null, reason: input.reason ?? null }
  } });
  return { adjustment, reversed, duplicate: false };
}

export async function reverseAffiliateForOrder(orderId: string, input: AdjustmentInput) {
  return prisma.$transaction(tx => reverseAffiliateForOrderInTransaction(tx, orderId, input));
}
