export type PayoutEligibilityOrder = {
  receivedAt: Date | null;
  status: string;
  payment: { status: string; method: string } | null;
  refundReviewPending?: boolean;
};

export function payoutEligibilityFailure(order: PayoutEligibilityOrder, holdDays: number, now = new Date()): string | null {
  if (!order.receivedAt) return 'Buyer receipt is not confirmed.';
  if (order.receivedAt.getTime() + holdDays * 86_400_000 > now.getTime()) return 'The configured post-receipt hold has not elapsed.';
  if (!order.payment || order.payment.status !== 'PAID' || !['STRIPE', 'PAYPAL'].includes(order.payment.method)) return 'This sale is not backed by eligible, settled online payment.';
  if (order.status === 'CANCELLED') return 'Cancelled orders cannot be paid out.';
  if (order.refundReviewPending) return 'A provider refund or dispute adjustment is awaiting reconciliation.';
  return null;
}

export function remainingSaleMinor(grossMinor: number, refundedMinor: number) {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0 || !Number.isSafeInteger(refundedMinor) || refundedMinor < 0) {
    throw new Error('Payout and refund amounts must be non-negative safe integers.');
  }
  return Math.max(0, grossMinor - refundedMinor);
}
