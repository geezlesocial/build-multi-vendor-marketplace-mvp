import { describe, expect, it } from 'vitest';
import { evaluateProviderReadiness, maskCredentialReference, providerStatusVerifiedForActivation, redactProviderAuditReason, validateCredentialReferences } from './provider-integrations-domain.js';

describe('provider integration registry and secret references', () => {
  it('allows only implemented provider/context combinations and known environment keys', () => {
    expect(() => validateCredentialReferences('PAYPAL', 'WALLET_FUNDING', {})).toThrow(/not implemented/i);
    expect(() => validateCredentialReferences('STRIPE', 'STORE_SUBSCRIPTION', {})).toThrow(/not implemented/i);
    expect(() => validateCredentialReferences('STRIPE', 'MARKETPLACE_CHECKOUT', { adapterUrl: 'https://example.test' })).toThrow(/unsupported credential/i);
    expect(() => validateCredentialReferences('STRIPE', 'MARKETPLACE_CHECKOUT', { apiSecret: ['sk', 'live', 'very-real-looking'].join('_') })).toThrow(/environment-variable name or secret-manager reference/i);
    expect(() => validateCredentialReferences('STRIPE', 'MARKETPLACE_CHECKOUT', { apiSecret: 'env:PAYPAL_CLIENT_SECRET' })).toThrow(/may only reference STRIPE_SECRET_KEY/i);
    expect(validateCredentialReferences('STRIPE', 'MARKETPLACE_CHECKOUT', { apiSecret: 'env:STRIPE_SECRET_KEY', webhookSecret: 'secret-ref:payments/stripe/webhookSecret' })).toMatchObject({ apiSecret: 'env:STRIPE_SECRET_KEY' });
    expect(() => validateCredentialReferences('STRIPE', 'MARKETPLACE_CHECKOUT', { apiSecret: 'secret-ref:payments/paypal/apiSecret' })).toThrow(/fixed secret-manager reference path/i);
  });

  it('fails closed for live configurations unless the deployment gate and matching credentials are present', () => {
    const base = {
      provider: 'STRIPE' as const, context: 'MARKETPLACE_CHECKOUT' as const, environment: 'LIVE' as const,
      references: { apiSecret: 'env:STRIPE_SECRET_KEY', webhookSecret: 'env:STRIPE_WEBHOOK_SECRET' },
      runtime: { STRIPE_SECRET_KEY: ['sk', 'live', 'synthetic_not_a_real_key'].join('_'), STRIPE_WEBHOOK_SECRET: ['whsec', 'synthetic'].join('_') },
      liveConfigurationsAvailable: false, moneyMovementHardDisabled: true
    };
    expect(evaluateProviderReadiness(base)).toMatchObject({ ready: false, code: 'LIVE_GATE_DISABLED' });
    expect(evaluateProviderReadiness({ ...base, liveConfigurationsAvailable: true })).toMatchObject({ ready: true, code: 'CONFIGURED_NOT_PROVIDER_VERIFIED' });
    expect(evaluateProviderReadiness({ ...base, liveConfigurationsAvailable: true, runtime: { ...base.runtime, STRIPE_SECRET_KEY: ['sk', 'test', 'synthetic'].join('_') } })).toMatchObject({ ready: false, code: 'CREDENTIALS_NOT_READY' });
  });

  it('keeps wallet configuration blocked by the independent money-movement gate', () => {
    const result = evaluateProviderReadiness({
      provider: 'STRIPE', context: 'WALLET_FUNDING', environment: 'SANDBOX',
      references: { apiSecret: 'env:STRIPE_SECRET_KEY', webhookSecret: 'env:STRIPE_WEBHOOK_SECRET' },
      runtime: { STRIPE_SECRET_KEY: ['sk', 'test', 'synthetic'].join('_'), STRIPE_WEBHOOK_SECRET: ['whsec', 'synthetic'].join('_') },
      liveConfigurationsAvailable: false, moneyMovementHardDisabled: true
    });
    expect(result).toMatchObject({ ready: false, code: 'WALLET_HARD_DISABLED' });
  });

  it('requires PayPal endpoint and credential environment to agree with sandbox/live selection', () => {
    const input = {
      provider: 'PAYPAL' as const, context: 'MARKETPLACE_CHECKOUT' as const, environment: 'SANDBOX' as const,
      references: { clientId: 'env:PAYPAL_CLIENT_ID', clientSecret: 'env:PAYPAL_CLIENT_SECRET', webhookId: 'env:PAYPAL_WEBHOOK_ID' },
      runtime: { PAYPAL_CLIENT_ID: 'synthetic-client', PAYPAL_CLIENT_SECRET: 'synthetic-secret', PAYPAL_WEBHOOK_ID: 'synthetic-webhook', PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com' },
      liveConfigurationsAvailable: false, moneyMovementHardDisabled: true
    };
    expect(evaluateProviderReadiness(input).ready).toBe(true);
    expect(evaluateProviderReadiness({ ...input, runtime: { ...input.runtime, PAYPAL_BASE_URL: 'https://attacker.invalid' } })).toMatchObject({ ready: false, code: 'ENVIRONMENT_MISMATCH' });
  });

  it('masks secret-manager paths and redacts common credential forms in audit reasons', () => {
    expect(maskCredentialReference('secret-ref:production/payments/stripe-secret')).toBe('secret-ref:••••••••');
    const stripeKey = ['sk', 'test', 'syntheticcredential123'].join('_');
    const webhookKey = ['whsec', 'syntheticcredential123'].join('_');
    const reason = redactProviderAuditReason(`Rotate ${stripeKey} and ${webhookKey}; api_secret=still-private`);
    expect(reason).not.toContain(stripeKey);
    expect(reason).not.toContain(webhookKey);
    expect(reason).not.toContain('still-private');
    expect(reason.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it('does not treat locally configured live credentials as verified for live payment activation', () => {
    const readiness = evaluateProviderReadiness({
      provider: 'STRIPE', context: 'MARKETPLACE_CHECKOUT', environment: 'LIVE',
      references: { apiSecret: 'env:STRIPE_SECRET_KEY', webhookSecret: 'env:STRIPE_WEBHOOK_SECRET' },
      runtime: { STRIPE_SECRET_KEY: ['sk', 'live', 'synthetic_not_a_real_key'].join('_'), STRIPE_WEBHOOK_SECRET: ['whsec', 'synthetic_not_a_real_secret'].join('_') },
      liveConfigurationsAvailable: true, moneyMovementHardDisabled: true
    });
    expect(readiness).toMatchObject({ ready: true, code: 'CONFIGURED_NOT_PROVIDER_VERIFIED' });
    expect(providerStatusVerifiedForActivation(readiness)).toBe(false);
  });
});
