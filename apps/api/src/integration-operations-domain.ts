export type WebhookProvider = 'STRIPE' | 'PAYPAL';

const retryablePaymentEvents: Record<WebhookProvider, ReadonlySet<string>> = {
  STRIPE: new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'charge.refunded',
    'charge.dispute.created'
  ]),
  PAYPAL: new Set([
    'PAYMENT.CAPTURE.COMPLETED',
    'CHECKOUT.ORDER.COMPLETED',
    'PAYMENT.CAPTURE.REFUNDED',
    'CUSTOMER.DISPUTE.CREATED'
  ])
};

export function isRetryablePaymentWebhookEvent(provider: string, eventType: string | null): provider is WebhookProvider {
  return (provider === 'STRIPE' || provider === 'PAYPAL')
    && eventType !== null
    && retryablePaymentEvents[provider].has(eventType);
}

export type WebhookEndpointConfiguration = {
  key: string;
  label: string;
  path: string;
  status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'DISABLED';
  note: string;
};

export function webhookEndpointConfiguration(input: {
  stripeCheckoutConfigured: boolean;
  paypalCheckoutConfigured: boolean;
  storeBillingConfigured: boolean;
  storeBillingEnabled: boolean;
  walletFundingConfigured: boolean;
  walletFundingEnabled: boolean;
}): WebhookEndpointConfiguration[] {
  const endpoint = (key: string, label: string, path: string, configured: boolean, enabled = true, disabledNote?: string): WebhookEndpointConfiguration => ({
    key,
    label,
    path,
    status: !enabled ? 'DISABLED' : configured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    note: !enabled
      ? disabledNote ?? 'This webhook integration is disabled by the current safety policy.'
      : configured
        ? 'Required runtime verification configuration is present. Provider-side registration and delivery have not been checked.'
        : 'Required runtime verification configuration is missing.'
  });

  return [
    endpoint('stripe-checkout', 'Stripe marketplace checkout', '/api/webhooks/stripe', input.stripeCheckoutConfigured),
    endpoint('paypal-checkout', 'PayPal marketplace checkout', '/api/webhooks/paypal', input.paypalCheckoutConfigured),
    endpoint('stripe-store-billing', 'Stripe Store billing sandbox', '/api/webhooks/stripe/store-billing', input.storeBillingConfigured, input.storeBillingEnabled, 'Store-plan billing is disabled; no subscription checkout is available.'),
    endpoint('stripe-wallet-funding', 'Stripe wallet funding sandbox', '/api/webhooks/stripe/wallet-funding', input.walletFundingConfigured, input.walletFundingEnabled, 'Wallet funding webhook is disabled by the sandbox and money-movement safety gates.')
  ];
}
