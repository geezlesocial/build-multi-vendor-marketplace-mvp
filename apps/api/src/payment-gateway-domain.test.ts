import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createProviderChargeQuote,
  paymongoEventToVerifiedPaymentEvent,
  paystackEventToVerifiedPaymentEvent,
  verifyPaymongoSignature,
  verifyPaystackSignature
} from './payment-gateway-domain.js';

describe('localized payment gateway boundaries', () => {
  it('saves an exact currency-conversion quote for the gateway charge', () => {
    expect(createProviderChargeQuote({
      provider: 'PAYMONGO', baseCurrency: 'USD', baseAmountMinor: 2500, baseExponent: 2,
      rate: { rate: '57.5', provider: 'manual-admin-rate', sourceDate: '2026-10-29', fetchedAt: '2026-10-29T00:00:00.000Z' },
      quoteExponent: 2
    })).toEqual({
      provider: 'PAYMONGO', currency: 'PHP', amountMinor: 143750, baseCurrency: 'USD', baseAmountMinor: 2500,
      rate: '57.5', rateProvider: 'manual-admin-rate', sourceDate: '2026-10-29', fetchedAt: '2026-10-29T00:00:00.000Z', rounding: 'HALF_UP'
    });
    expect(() => createProviderChargeQuote({
      provider: 'PAYSTACK', baseCurrency: 'USD', baseAmountMinor: 0, baseExponent: 2,
      rate: { rate: '1500', provider: 'manual-admin-rate', sourceDate: '2026-10-29', fetchedAt: '2026-10-29T00:00:00.000Z' },
      quoteExponent: 2
    })).toThrow(/supported amount range/);
  });

  it('verifies provider webhook signatures over the exact raw payload', () => {
    const rawBody = Buffer.from('{"event":"charge.success"}');
    const paystackSignature = createHmac('sha512', 'synthetic-test-secret').update(rawBody).digest('hex');
    expect(verifyPaystackSignature(rawBody, paystackSignature, 'synthetic-test-secret')).toBe(true);
    expect(verifyPaystackSignature(rawBody, paystackSignature, 'wrong-secret')).toBe(false);

    const timestamp = 1_798_617_600;
    const paymongoSignature = createHmac('sha256', 'synthetic-test-secret').update(`${timestamp}.${rawBody.toString()}`).digest('hex');
    expect(verifyPaymongoSignature(rawBody, `t=${timestamp},te=${paymongoSignature},li=`, 'synthetic-test-secret', false, timestamp * 1000)).toBe(true);
    expect(verifyPaymongoSignature(rawBody, `t=${timestamp},te=${paymongoSignature},li=`, 'synthetic-test-secret', false, (timestamp + 301) * 1000)).toBe(false);
  });

  it('parses PayMongo v2 hosted-checkout events and does not require expanded PaymentIntent attributes', () => {
    const input = {
      data: {
        type: 'checkout_session.payment.paid', resource: 'checkout_session', livemode: false,
        created_at: '2026-10-29T00:00:00Z',
        data: {
          id: 'cs_test_session', type: 'checkout_session',
          attributes: {
            reference_number: 'order-local-123', payment_intent: { id: 'pi_test_intent' },
            payments: [{ id: 'pay_test_payment', attributes: { amount: 143750, currency: 'PHP', status: 'paid' } }]
          }
        }
      }
    };
    const event = paymongoEventToVerifiedPaymentEvent(input, false);
    expect(event).toMatchObject({
      provider: 'PAYMONGO', eventType: 'checkout_session.payment.paid', paymentLookupRef: 'cs_test_session',
      providerObjectRef: 'pay_test_payment', metadataOrderId: 'order-local-123', amountMinor: 143750,
      currency: 'PHP', captureConfirmed: true
    });
    expect(event?.eventId).toMatch(/^paymongo_[a-f0-9]{64}$/);
    expect(paymongoEventToVerifiedPaymentEvent(input, true)).toBeNull();
  });

  it('parses PayMongo refund references from the payment_id field', () => {
    const event = paymongoEventToVerifiedPaymentEvent({
      data: { id: 'evt_refund_1', attributes: { type: 'refund.succeeded', livemode: false, created_at: 1798617600, data: { id: 'ref_1', attributes: { amount: 1000, currency: 'PHP', status: 'succeeded', payment_id: 'pay_1' } } } }
    }, false);
    expect(event).toMatchObject({ provider: 'PAYMONGO', eventId: 'evt_refund_1', eventType: 'refund.succeeded', providerObjectRef: 'pay_1', paymentLookupRef: 'pay_1', amountMinor: 1000, currency: 'PHP' });
  });

  it('parses Paystack amount strings and binds the event to its transaction reference', () => {
    const event = paystackEventToVerifiedPaymentEvent({
      event: 'charge.success', data: { id: 123, reference: 'ML-order123', status: 'success', amount: '150000', currency: 'NGN', paid_at: '2026-10-29T00:00:00.000Z', metadata: { orderId: 'order123' } }
    });
    expect(event).toMatchObject({ provider: 'PAYSTACK', eventId: '123', eventType: 'charge.success', paymentLookupRef: 'ML-order123', providerObjectRef: 'ML-order123', metadataOrderId: 'order123', amountMinor: 150000, currency: 'NGN', captureConfirmed: true });
  });
});
