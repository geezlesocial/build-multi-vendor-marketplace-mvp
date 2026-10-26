export type ClubCoinRuleWindow = {
  enabled: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  eligibleGroups: string[];
  expiresAfterDays: number | null;
};

export function clubCoinRuleAppliesAt(rule: ClubCoinRuleWindow, now: Date) {
  if (!rule.enabled) return false;
  if (rule.effectiveFrom && now < rule.effectiveFrom) return false;
  if (rule.effectiveTo && now >= rule.effectiveTo) return false;
  // Group membership and expiry processing are not yet modeled by the platform.
  // Never silently award a targeted or expiring rule as if those controls worked.
  if (rule.eligibleGroups.length > 0 || rule.expiresAfterDays !== null) return false;
  return true;
}

export type ClubCoinAwardCaps = {
  awardAmount: number;
  perUserCap: number | null;
  perOrderCap: number | null;
  dailyCap: number | null;
  userAwarded: number;
  orderAwarded: number;
  dailyAwarded: number;
};

export function clubCoinAwardAmount(input: ClubCoinAwardCaps) {
  const limits = [input.awardAmount];
  if (input.perUserCap !== null) limits.push(input.perUserCap - Math.max(0, input.userAwarded));
  if (input.perOrderCap !== null) limits.push(input.perOrderCap - Math.max(0, input.orderAwarded));
  if (input.dailyCap !== null) limits.push(input.dailyCap - Math.max(0, input.dailyAwarded));
  return Math.max(0, Math.min(...limits));
}

export type CompletedPurchasePayment = { method: string; status: string } | null;
export type CompletedPurchaseLine = { status: string; receivedAt: Date | null };

export function isClubCoinPurchaseComplete(payment: CompletedPurchasePayment, sellerOrders: CompletedPurchaseLine[]) {
  if (!payment || payment.status !== 'PAID' || !['STRIPE', 'PAYPAL', 'COD'].includes(payment.method)) return false;
  return sellerOrders.length > 0 && sellerOrders.every(order => order.status !== 'CANCELLED' && order.receivedAt !== null);
}

export function clubCoinAwardIdempotencyKey(ruleId: string, parentOrderId: string) {
  return `club-coins-award:${ruleId}:${parentOrderId}`;
}

export function clubCoinEventAwardIdempotencyKey(ruleId: string, eventType: string, eventId: string) {
  const base = clubCoinAwardIdempotencyKey(ruleId, eventId);
  return eventType === 'PURCHASE_COMPLETED' ? base : `${base}:${eventType}`;
}

export function clubCoinReversalIdempotencyKey(awardEntryId: string) {
  return `club-coins-reversal:${awardEntryId}`;
}

export function clubCoinBalanceAfterReversal(balance: number, awardAmount: number) {
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(awardAmount) || awardAmount <= 0) throw new Error('Club Coin reversal requires an integer balance and positive award amount');
  const nextBalance = balance - awardAmount;
  if (!Number.isSafeInteger(nextBalance)) throw new Error('Club Coin reversal exceeds the supported balance range');
  return nextBalance;
}

export type LiveAttendanceWindow = {
  eligibleDurationSeconds: number;
  lastHeartbeatAt: Date;
};

/** Credit only bounded, continuous server-observed intervals; the caller enforces an active provider-backed stream. */
export function creditLiveAttendance(
  current: LiveAttendanceWindow,
  now: Date,
  options: { maxHeartbeatGapSeconds?: number; maxCreditPerHeartbeatSeconds?: number } = {}
) {
  const maxGap = options.maxHeartbeatGapSeconds ?? 90;
  const maxCredit = options.maxCreditPerHeartbeatSeconds ?? 45;
  const elapsed = Math.floor((now.getTime() - current.lastHeartbeatAt.getTime()) / 1000);
  const credited = elapsed > 0 && elapsed <= maxGap ? Math.min(elapsed, maxCredit) : 0;
  return { eligibleDurationSeconds: current.eligibleDurationSeconds + credited, creditedSeconds: credited };
}

export const LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS = 5 * 60;
