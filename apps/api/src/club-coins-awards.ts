import { ClubCoinEntryType, ClubCoinEventType, Prisma } from '@prisma/client';
import { env } from './config.js';
import { clubCoinAwardAmount, clubCoinBalanceAfterReversal, clubCoinEventAwardIdempotencyKey, clubCoinReversalIdempotencyKey, clubCoinRuleAppliesAt, isClubCoinPurchaseComplete } from './club-coins-domain.js';

type Tx = Prisma.TransactionClient;
type RewardableEvent = Exclude<ClubCoinEventType, 'CUSTOM'>;

function eligibleGroups(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Award any connected, server-verified event. Callers must establish the event inside this transaction. */
export async function awardClubCoinsForEvent(tx: Tx, input: { eventType: RewardableEvent; eventId: string; userId: string; now?: Date }) {
  const now = input.now ?? new Date();
  if (env.CLUB_COINS_HARD_DISABLED) return { created: 0, skipped: 'HARD_DISABLED' as const };

  await tx.marketplaceSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
  await tx.$queryRaw`SELECT "id" FROM "MarketplaceSettings" WHERE "id" = 'default' FOR SHARE`;
  const settings = await tx.marketplaceSettings.findUnique({ where: { id: 'default' } });
  if (!settings?.clubCoinsEnabled || !settings.clubCoinsEarnEnabled) return { created: 0, skipped: 'EARNING_DISABLED' as const };

  const rules = await tx.clubCoinRule.findMany({ where: { eventType: input.eventType, enabled: true } });
  let createdCount = 0;
  for (const rule of rules) {
    if (!clubCoinRuleAppliesAt({
      enabled: rule.enabled,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      eligibleGroups: eligibleGroups(rule.eligibleGroupsJson),
      expiresAfterDays: rule.expiresAfterDays
    }, now)) continue;

    const idempotencyKey = clubCoinEventAwardIdempotencyKey(rule.id, input.eventType, input.eventId);
    if (await tx.clubCoinEntry.findUnique({ where: { idempotencyKey } })) continue;

    const account = await tx.clubCoinAccount.upsert({ where: { userId: input.userId }, update: {}, create: { userId: input.userId } });
    await tx.$queryRaw`SELECT "id" FROM "ClubCoinAccount" WHERE "id" = ${account.id} FOR UPDATE`;
    const lockedAccount = await tx.clubCoinAccount.findUnique({ where: { id: account.id } });
    if (!lockedAccount || lockedAccount.status !== 'ACTIVE') continue;

    const baseWhere = { userId: input.userId, policyVersion: rule.id, entryType: { in: [ClubCoinEntryType.AWARD, ClubCoinEntryType.REVERSAL] } };
    const dayStart = utcDayStart(now);
    const eventReference = input.eventType;
    const [userTotals, eventTotals, dailyTotals] = await Promise.all([
      tx.clubCoinEntry.aggregate({ where: baseWhere, _sum: { amount: true } }),
      tx.clubCoinEntry.aggregate({ where: { ...baseWhere, referenceType: eventReference, referenceId: input.eventId }, _sum: { amount: true } }),
      tx.clubCoinEntry.aggregate({ where: { ...baseWhere, createdAt: { gte: dayStart } }, _sum: { amount: true } })
    ]);
    const amount = clubCoinAwardAmount({
      awardAmount: rule.awardAmount,
      perUserCap: rule.perUserCap,
      perOrderCap: rule.perOrderCap,
      dailyCap: rule.dailyCap,
      userAwarded: userTotals._sum.amount ?? 0,
      orderAwarded: eventTotals._sum.amount ?? 0,
      dailyAwarded: dailyTotals._sum.amount ?? 0
    });
    if (amount <= 0) continue;

    await tx.clubCoinAccount.update({ where: { id: account.id }, data: { balance: { increment: amount } } });
    const entry = await tx.clubCoinEntry.create({ data: {
      accountId: account.id,
      userId: input.userId,
      entryType: ClubCoinEntryType.AWARD,
      amount,
      idempotencyKey,
      referenceType: eventReference,
      referenceId: input.eventId,
      policyVersion: rule.id,
      reason: `Earned under rule ${rule.code}`
    } });
    await tx.auditLog.create({ data: {
      actorId: null,
      action: `CLUB_COINS_${input.eventType}_AWARDED`,
      entity: 'ClubCoinEntry',
      entityId: entry.id,
      metadata: { eventType: input.eventType, eventId: input.eventId, userId: input.userId, ruleId: rule.id, ruleCode: rule.code, amount, idempotencyKey }
    } });
    createdCount += 1;
  }
  return { created: createdCount, skipped: null };
}

/** Award purchase rules only after every Store shipment is receipt-confirmed and payment is collected. */
export async function awardClubCoinsForCompletedOrder(tx: Tx, parentOrderId: string, now = new Date()) {
  const order = await tx.parentOrder.findUnique({
    where: { id: parentOrderId },
    include: { payment: true, sellerOrders: { select: { status: true, receivedAt: true } } }
  });
  if (!order?.buyerId || !isClubCoinPurchaseComplete(order.payment, order.sellerOrders)) return { created: 0, skipped: 'PURCHASE_NOT_COMPLETE' as const };
  return awardClubCoinsForEvent(tx, { eventType: ClubCoinEventType.PURCHASE_COMPLETED, eventId: order.id, userId: order.buyerId, now });
}

/** Reversals are idempotent per original award and retain a reference to the verified adjustment. */
export async function reverseClubCoinsForEvent(tx: Tx, eventType: RewardableEvent, eventId: string, sourceReference: string, reason: string) {
  const awards = await tx.clubCoinEntry.findMany({
    where: { referenceType: eventType, referenceId: eventId, entryType: ClubCoinEntryType.AWARD },
    select: { id: true, accountId: true, userId: true, amount: true, policyVersion: true }
  });
  let reversedCount = 0;
  for (const award of awards) {
    if (award.amount <= 0) continue;
    const idempotencyKey = clubCoinReversalIdempotencyKey(award.id);
    if (await tx.clubCoinEntry.findUnique({ where: { idempotencyKey }, select: { id: true } })) continue;
    await tx.$queryRaw`SELECT "id" FROM "ClubCoinAccount" WHERE "id" = ${award.accountId} FOR UPDATE`;
    const account = await tx.clubCoinAccount.findUnique({ where: { id: award.accountId } });
    if (!account) throw new Error('Club Coin account is missing for a reward reversal');
    await tx.clubCoinAccount.update({ where: { id: account.id }, data: { balance: clubCoinBalanceAfterReversal(account.balance, award.amount) } });
    const reversal = await tx.clubCoinEntry.create({ data: {
      accountId: account.id,
      userId: award.userId,
      entryType: ClubCoinEntryType.REVERSAL,
      amount: -award.amount,
      idempotencyKey,
      referenceType: 'REWARD_REVERSAL',
      referenceId: sourceReference,
      policyVersion: award.policyVersion,
      reversalOfId: award.id,
      reason
    } });
    await tx.auditLog.create({ data: {
      actorId: null,
      action: `CLUB_COINS_${eventType}_AWARD_REVERSED`,
      entity: 'ClubCoinEntry',
      entityId: reversal.id,
      metadata: { eventType, eventId, sourceReference, awardEntryId: award.id, amount: award.amount, idempotencyKey, reason }
    } });
    reversedCount += 1;
  }
  return { reversed: reversedCount };
}

/** Reverse purchase and review rewards after a verified refund/dispute; review proof is downgraded too. */
export async function reverseClubCoinsForOrder(tx: Tx, parentOrderId: string, sourceReference: string, reason: string) {
  const purchase = await reverseClubCoinsForEvent(tx, ClubCoinEventType.PURCHASE_COMPLETED, parentOrderId, sourceReference, reason);
  const verifiedReviews = await tx.productReview.findMany({ where: { sellerOrder: { parentId: parentOrderId }, verifiedPurchase: true }, select: { id: true } });
  let reviewReversed = 0;
  for (const review of verifiedReviews) {
    const result = await reverseClubCoinsForEvent(tx, ClubCoinEventType.REVIEW_SUBMITTED, review.id, sourceReference, reason);
    reviewReversed += result.reversed;
  }
  if (verifiedReviews.length) await tx.productReview.updateMany({ where: { id: { in: verifiedReviews.map(review => review.id) } }, data: { verifiedPurchase: false } });
  return { reversed: purchase.reversed + reviewReversed };
}
