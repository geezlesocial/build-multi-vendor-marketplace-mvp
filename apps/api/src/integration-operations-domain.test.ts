import { describe, expect, it } from 'vitest';
import { isRetryablePaymentWebhookEvent, webhookEndpointConfiguration } from './integration-operations-domain.js';

describe('integration operations policies', () => {
  it('only allows retrying known payment reconciliation event types', () => {
    expect(isRetryablePaymentWebhookEvent('STRIPE', 'checkout.session.completed')).toBe(true);
    expect(isRetryablePaymentWebhookEvent('PAYPAL', 'PAYMENT.CAPTURE.REFUNDED')).toBe(true);
    expect(isRetryablePaymentWebhookEvent('STRIPE', 'payment_intent.succeeded')).toBe(false);
    expect(isRetryablePaymentWebhookEvent('PAYPAL', 'PAYMENT.CAPTURE.DENIED')).toBe(false);
    expect(isRetryablePaymentWebhookEvent('COD', 'PAYMENT.CAPTURE.COMPLETED')).toBe(false);
    expect(isRetryablePaymentWebhookEvent('STRIPE', null)).toBe(false);
  });

  it('reports configuration without claiming provider connectivity or delivery', () => {
    const endpoints = webhookEndpointConfiguration({
      stripeCheckoutConfigured: true,
      paypalCheckoutConfigured: false,
      storeBillingConfigured: true,
      storeBillingEnabled: false,
      walletFundingConfigured: true,
      walletFundingEnabled: false
    });
    expect(endpoints.map(endpoint => endpoint.status)).toEqual(['CONFIGURED', 'NOT_CONFIGURED', 'DISABLED', 'DISABLED']);
    expect(endpoints[0]?.note).toContain('have not been checked');
    expect(endpoints[3]?.note).toContain('safety gates');
  });
});
