import { describe, expect, it, vi } from 'vitest';
import {
  recoverWalletFundingPaymentIntent,
  validateWalletFundingPaymentIntent,
  type WalletFundingPaymentIntent,
  type WalletFundingRecoveryExpectation
} from './wallet-funding.js';

const expectation: WalletFundingRecoveryExpectation = {
  requestingUserId: 'buyer_owner',
  fundingIntentId: 'funding_intent_123',
  userId: 'buyer_owner',
  providerIntentId: 'pi_test_recoverable',
  idempotencyKey: 'wallet-funding-idempotency-123',
  amountMinor: 2750,
  currency: 'USD'
};

const providerPayment: WalletFundingPaymentIntent = {
  providerIntentId: expectation.providerIntentId,
  clientSecret: 'pi_test_recoverable_secret_synthetic',
  amountMinor: expectation.amountMinor,
  currency: expectation.currency,
  status: 'requires_payment_method',
  liveMode: false,
  metadata: {
    scrolithFundingIntentId: expectation.fundingIntentId,
    scrolithFundingUserId: expectation.userId,
    scrolithIdempotencyKey: expectation.idempotencyKey,
    scrolithPurpose: 'wallet_top_up'
  }
};

describe('wallet funding PaymentIntent recovery', () => {
  it('recovers the same existing PaymentIntent after the original response was lost', async () => {
    const retrievePaymentIntent = vi.fn().mockResolvedValue(providerPayment);
    const recovered = await recoverWalletFundingPaymentIntent(expectation, { retrievePaymentIntent });

    expect(retrievePaymentIntent).toHaveBeenCalledOnce();
    expect(retrievePaymentIntent).toHaveBeenCalledWith(expectation.providerIntentId);
    expect(recovered).toEqual({
      providerIntentId: expectation.providerIntentId,
      clientSecret: providerPayment.clientSecret,
      providerStatus: 'requires_payment_method'
    });
  });

  it('returns a client secret only to the authenticated intent owner', async () => {
    const retrievePaymentIntent = vi.fn().mockResolvedValue(providerPayment);
    await expect(recoverWalletFundingPaymentIntent({ ...expectation, requestingUserId: 'different_buyer' }, { retrievePaymentIntent }))
      .rejects.toThrow('could not be safely recovered');
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['provider reference', { providerIntentId: 'pi_other' }],
    ['funding intent metadata', { metadata: { ...providerPayment.metadata, scrolithFundingIntentId: 'another_intent' } }],
    ['owner metadata', { metadata: { ...providerPayment.metadata, scrolithFundingUserId: 'another_buyer' } }],
    ['idempotency metadata', { metadata: { ...providerPayment.metadata, scrolithIdempotencyKey: 'another_key' } }],
    ['purpose metadata', { metadata: { ...providerPayment.metadata, scrolithPurpose: 'unrelated' } }],
    ['amount', { amountMinor: providerPayment.amountMinor + 1 }],
    ['currency', { currency: 'EUR' }],
    ['payment state', { status: 'succeeded' }],
    ['live mode', { liveMode: true }],
    ['missing client secret', { clientSecret: null }]
  ])('rejects a mismatched %s without returning its secret', (_label, changes) => {
    expect(() => validateWalletFundingPaymentIntent(expectation, { ...providerPayment, ...changes } as WalletFundingPaymentIntent))
      .toThrow('could not be safely recovered');
  });

  it('converts provider errors to a generic recoverable failure without leaking details', async () => {
    const retrievePaymentIntent = vi.fn().mockRejectedValue(new Error('synthetic provider diagnostic with private details'));
    await expect(recoverWalletFundingPaymentIntent(expectation, { retrievePaymentIntent }))
      .rejects.toThrow('Sandbox payment intent could not be safely recovered');
  });
});
