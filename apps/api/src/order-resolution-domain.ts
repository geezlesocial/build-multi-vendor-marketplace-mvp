export const ORDER_RESOLUTION_ACTIVE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'REFUND_APPROVED'] as const;
export const ORDER_RESOLUTION_REVIEW_STATUSES = ['OPEN', 'UNDER_REVIEW'] as const;

export function orderCaseBlocksFinancialRelease(status: string) {
  return ORDER_RESOLUTION_ACTIVE_STATUSES.includes(status as typeof ORDER_RESOLUTION_ACTIVE_STATUSES[number]);
}

export function refundEventMatchesCase(input: {
  paymentMethod: string | null;
  parentOrderId: string;
  parentTotalMinor: number;
  currency: string;
  approvedAmountMinor: number;
  event: {
    provider: string;
    parentOrderId: string | null;
    eventType: string | null;
    identityVerified: boolean;
    reviewReason: string | null;
    currency: string | null;
    amountMinor: number | null;
    providerTotalMinor: number | null;
  };
}) {
  const { event } = input;
  const expectedType = event.provider === 'STRIPE' ? 'charge.refunded' : event.provider === 'PAYPAL' ? 'PAYMENT.CAPTURE.REFUNDED' : null;
  return Boolean(expectedType
    && input.paymentMethod === event.provider
    && event.parentOrderId === input.parentOrderId
    && event.eventType === expectedType
    && event.identityVerified
    && event.reviewReason === null
    && event.currency?.toUpperCase() === input.currency.toUpperCase()
    && Number.isSafeInteger(event.amountMinor)
    && (event.amountMinor ?? 0) >= input.approvedAmountMinor
    && (event.provider !== 'STRIPE' || event.providerTotalMinor === input.parentTotalMinor));
}

export function canRecordManualCodRefund(paymentMethod: string | null, paymentStatus: string | null) {
  return paymentMethod === 'COD' && paymentStatus === 'PAID';
}
