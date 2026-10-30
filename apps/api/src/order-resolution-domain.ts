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
    normalizedCurrency?: string | null;
    normalizedAmountMinor?: number | null;
  };
}) {
  const { event } = input;
  const expectedTypes: Record<string, string> = {
    STRIPE: 'charge.refunded',
    PAYPAL: 'PAYMENT.CAPTURE.REFUNDED',
    PAYMONGO: 'refund.succeeded',
    PAYSTACK: 'refund.processed'
  };
  const expectedType = expectedTypes[event.provider];
  const amountMinor = event.normalizedAmountMinor ?? event.amountMinor;
  const currency = event.normalizedCurrency ?? event.currency;
  return Boolean(expectedType
    && input.paymentMethod === event.provider
    && event.parentOrderId === input.parentOrderId
    && event.eventType === expectedType
    && event.identityVerified
    && event.reviewReason === null
    && currency?.toUpperCase() === input.currency.toUpperCase()
    && Number.isSafeInteger(amountMinor)
    && (amountMinor ?? 0) >= input.approvedAmountMinor
    && (event.provider !== 'STRIPE' || event.providerTotalMinor === input.parentTotalMinor));
}

export function canRecordManualCodRefund(paymentMethod: string | null, paymentStatus: string | null) {
  return paymentMethod === 'COD' && paymentStatus === 'PAID';
}
