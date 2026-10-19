import { AffiliateStatus, CommissionEntryType, CommissionStatus, AffiliateAdjustmentType } from '@prisma/client';
import { env } from './config.js';
import { commissionMinor, proportionalCommission } from './growth-domain.js';
import { prisma } from './security.js';

type AdjustmentInput = {
  type: AffiliateAdjustmentType;
  eventId?: string;
  idempotencyKey: string;
  reason?: string;
  orderItemId?: string;
  quantity?: number;
  amountMinor?: number;
  createdById?: string;
};

function chooseRule(rules: Array<{ id: string; name: string; productId: string | null; categoryId: string | null; basisPoints: number | null; fixedMinor: number | null }>, productId: string, categoryId: string | null) {
  return rules.sort((a, b) => {
    const score = (rule: typeof a) => rule.productId === productId ? 4 : rule.categoryId === categoryId && categoryId ? 3 : rule.productId === null && rule.categoryId === null ? 1 : 0;
    return score(b) - score(a);
  })[0];
}

/** Creates pending, idempotent platform-funded commission entries after an authoritative payment. */
export async function settleAffiliateForPaidOrder(orderId: string) {
  const settings = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (!settings?.affiliateEnabled) return { created: 0 };
  const now = new Date();
  const order = await prisma.parentOrder.findUnique({ where: { id: orderId }, include: { payment: true, affiliateClick: { include: { affiliate: true, link: true } }, sellerOrders: { include: { items: { include: { product: { include: { category: true } } } } } } } });
  if (!order?.affiliateClick || order.payment?.status !== 'PAID' || order.affiliateClick.affiliate.status !== AffiliateStatus.APPROVED) return { created: 0 };

  return prisma.$transaction(async tx => {
    const click = await tx.affiliateClick.findUnique({ where: { id: order.affiliateClick!.id } });
    if (!click || click.convertedAt || click.expiresAt <= now || !click.consentGivenAt) return { created: 0 };
    let created = 0;
    for (const sellerOrder of order.sellerOrders) {
      for (const item of sellerOrder.items) {
        const eligible = (!click.productId || click.productId === item.productId) && (!order.affiliateClick!.link.sellerId || order.affiliateClick!.link.sellerId === sellerOrder.sellerId);
        if (!eligible) continue;
        const rules = await tx.affiliateCommissionRule.findMany({ where: { currency: order.currency, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }], AND: [{ OR: [{ productId: item.productId }, ...(item.product.categoryId ? [{ categoryId: item.product.categoryId }] : []), { productId: null, categoryId: null }] }] } });
        const rule = chooseRule(rules, item.productId, item.product.categoryId);
        const eligibleBaseMinor = item.unitPriceMinor * item.quantity;
        const amountMinor = commissionMinor(eligibleBaseMinor, rule?.basisPoints ?? env.AFFILIATE_DEFAULT_BASIS_POINTS, rule?.fixedMinor);
        if (amountMinor < 1) continue;
        const key = `${order.id}:${item.id}`;
        if (await tx.commissionLedger.findUnique({ where: { idempotencyKey: key } })) continue;
        await tx.commissionLedger.create({ data: { affiliateId: click.affiliateId, orderItemId: item.id, ruleId: rule?.id, amountMinor, currency: order.currency, status: CommissionStatus.PENDING, entryType: CommissionEntryType.EARNED, eligibleBaseMinor, ruleName: rule?.name ?? 'Default affiliate rule', basisPointsSnapshot: rule?.basisPoints ?? env.AFFILIATE_DEFAULT_BASIS_POINTS, fixedMinorSnapshot: rule?.fixedMinor, idempotencyKey: key } });
        created += 1;
      }
    }
    await tx.affiliateClick.update({ where: { id: click.id }, data: { convertedAt: now } });
    return { created };
  });
}

/** Adds an append-only negative ledger entry. It never edits an earned financial record. */
export async function reverseAffiliateForOrder(orderId: string, input: AdjustmentInput) {
  return prisma.$transaction(async tx => {
    const adjustmentKey = `affiliate-adjustment:${input.idempotencyKey}`;
    const existingAdjustment = await tx.affiliateAdjustment.findUnique({ where: { idempotencyKey: adjustmentKey } });
    if (existingAdjustment) return { adjustment: existingAdjustment, reversed: 0, duplicate: true };
    const order = await tx.parentOrder.findUnique({ where: { id: orderId }, include: { affiliateClick: { include: { affiliate: true } }, payment: true } });
    if (!order?.affiliateClick || order.affiliateClick.affiliate.status !== AffiliateStatus.APPROVED) return { adjustment: null, reversed: 0, duplicate: false };
    const entries = await tx.commissionLedger.findMany({ where: { affiliateId: order.affiliateClick.affiliateId, entryType: CommissionEntryType.EARNED, ...(input.orderItemId ? { orderItemId: input.orderItemId } : {}), orderItem: { sellerOrder: { parentId: orderId } } }, include: { reversals: true, orderItem: true } });
    let remainingAdjustment = input.amountMinor ?? Number.MAX_SAFE_INTEGER;
    let reversed = 0;
    for (const entry of entries) {
      const alreadyReversed = entry.reversals.reduce((sum, reversal) => sum + Math.abs(reversal.amountMinor), 0);
      const remainingCommission = Math.max(0, entry.amountMinor - alreadyReversed);
      if (!remainingCommission) continue;
      const requestedBase = input.quantity && entry.orderItem ? entry.orderItem.unitPriceMinor * Math.min(input.quantity, entry.orderItem.quantity) : entry.eligibleBaseMinor;
      const proportional = proportionalCommission(entry.amountMinor, entry.eligibleBaseMinor, requestedBase);
      const amount = Math.min(remainingCommission, proportional, remainingAdjustment);
      if (amount <= 0) continue;
      await tx.commissionLedger.create({ data: { affiliateId: entry.affiliateId, orderItemId: entry.orderItemId, ruleId: entry.ruleId, amountMinor: -amount, currency: entry.currency, status: CommissionStatus.REVERSED, entryType: CommissionEntryType.REVERSAL, eligibleBaseMinor: -Math.min(entry.eligibleBaseMinor, requestedBase), ruleName: entry.ruleName, basisPointsSnapshot: entry.basisPointsSnapshot, fixedMinorSnapshot: entry.fixedMinorSnapshot, idempotencyKey: `${adjustmentKey}:${entry.id}`, sourceEventId: input.eventId, reversalOfId: entry.id, reason: input.reason } });
      reversed += amount;
      remainingAdjustment -= amount;
      if (alreadyReversed + amount >= entry.amountMinor) await tx.commissionLedger.update({ where: { id: entry.id }, data: { status: CommissionStatus.REVERSED } });
    }
    const adjustment = await tx.affiliateAdjustment.create({ data: { orderId, orderItemId: input.orderItemId, type: input.type, quantity: input.quantity, amountMinor: reversed, currency: order.currency, idempotencyKey: adjustmentKey, providerEventId: input.eventId, reason: input.reason, createdById: input.createdById } });
    return { adjustment, reversed, duplicate: false };
  });
}
