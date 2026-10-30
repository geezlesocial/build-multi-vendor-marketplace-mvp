import { describe, expect, it } from 'vitest';
import { canRecordManualCodRefund, orderCaseBlocksFinancialRelease, refundEventMatchesCase } from './order-resolution-domain.js';

describe('order resolution safety rules', () => {
  it('blocks receipt release and seller payouts while a case needs review or refund settlement', () => {
    expect(orderCaseBlocksFinancialRelease('OPEN')).toBe(true);
    expect(orderCaseBlocksFinancialRelease('UNDER_REVIEW')).toBe(true);
    expect(orderCaseBlocksFinancialRelease('REFUND_APPROVED')).toBe(true);
    expect(orderCaseBlocksFinancialRelease('RESOLVED')).toBe(false);
    expect(orderCaseBlocksFinancialRelease('REJECTED')).toBe(false);
  });

  it('matches an online refund to the same verified provider, order, currency, and approved amount', () => {
    const input = {
      paymentMethod: 'STRIPE', parentOrderId: 'order-1', parentTotalMinor: 5000, currency: 'USD', approvedAmountMinor: 1200,
      event: { provider: 'STRIPE', parentOrderId: 'order-1', eventType: 'charge.refunded', identityVerified: true, reviewReason: null, currency: 'usd', amountMinor: 1200, providerTotalMinor: 5000 }
    };
    expect(refundEventMatchesCase(input)).toBe(true);
    expect(refundEventMatchesCase({ ...input, event: { ...input.event, parentOrderId: 'other-order' } })).toBe(false);
    expect(refundEventMatchesCase({ ...input, event: { ...input.event, reviewReason: 'REVIEW_REQUIRED' } })).toBe(false);
    expect(refundEventMatchesCase({ ...input, event: { ...input.event, amountMinor: 1199 } })).toBe(false);
    expect(refundEventMatchesCase({ ...input, event: { ...input.event, providerTotalMinor: 4999 } })).toBe(false);
  });

  it('permits off-platform refund evidence only for COD recorded as collected', () => {
    expect(canRecordManualCodRefund('COD', 'PAID')).toBe(true);
    expect(canRecordManualCodRefund('COD', 'PENDING')).toBe(false);
    expect(canRecordManualCodRefund('STRIPE', 'PAID')).toBe(false);
  });

  it('matches a localized-provider refund using its normalized base-currency amount', () => {
    expect(refundEventMatchesCase({
      paymentMethod: 'PAYMONGO', parentOrderId: 'order-1', parentTotalMinor: 5000, currency: 'USD', approvedAmountMinor: 1200,
      event: {
        provider: 'PAYMONGO', parentOrderId: 'order-1', eventType: 'refund.succeeded', identityVerified: true,
        reviewReason: null, currency: 'PHP', amountMinor: 69000, providerTotalMinor: null,
        normalizedCurrency: 'USD', normalizedAmountMinor: 1200
      }
    })).toBe(true);
  });
});
