import Stripe from 'stripe';
import { env } from './config.js';

export type StoreBillingCheckoutInput = {
  subscriptionId: string;
  storeId: string;
  storeName: string;
  planName: string;
  planVersion: number;
  interval: 'MONTHLY' | 'ANNUAL';
  currency: 'USD';
  unitAmountMinor: number;
  trialDays: number;
  sellerEmail: string;
  successUrl: string;
  cancelUrl: string;
};

export type StoreBillingCheckoutResult = { id: string; url: string; subscriptionId: string | null };
export type StoreBillingCancellationResult = { currentPeriodEnd: Date | null };

export interface StoreBillingProvider {
  createCheckout(input: StoreBillingCheckoutInput): Promise<StoreBillingCheckoutResult>;
  retrieveCheckout(sessionId: string): Promise<{ id: string; url: string | null; status: string | null }>;
  cancelSubscription(providerSubscriptionId: string, immediately: boolean, idempotencyKey: string): Promise<StoreBillingCancellationResult>;
  verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event;
}

const stripeClient = env.STRIPE_STORE_BILLING_SECRET_KEY?.startsWith('sk_test_')
  ? new Stripe(env.STRIPE_STORE_BILLING_SECRET_KEY)
  : null;

export const storePlanBillingSandboxEnabled = Boolean(
  env.STORE_PLAN_BILLING_SANDBOX_ENABLED && stripeClient && env.STRIPE_STORE_BILLING_WEBHOOK_SECRET
);

export function stripeStoreBillingProvider(): StoreBillingProvider | null {
  if (!storePlanBillingSandboxEnabled || !stripeClient || !env.STRIPE_STORE_BILLING_WEBHOOK_SECRET) return null;
  return {
    async createCheckout(input) {
      const session = await stripeClient.checkout.sessions.create({
        mode: 'subscription',
        automatic_tax: { enabled: false },
        customer_email: input.sellerEmail,
        client_reference_id: input.subscriptionId,
        line_items: [{
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.unitAmountMinor,
            recurring: { interval: input.interval === 'ANNUAL' ? 'year' : 'month' },
            product_data: { name: `${input.planName} · ${input.storeName}` }
          },
          quantity: 1
        }],
        ...(input.trialDays > 0 ? { subscription_data: { trial_period_days: input.trialDays, metadata: { storeSubscriptionId: input.subscriptionId, storeId: input.storeId } } } : { subscription_data: { metadata: { storeSubscriptionId: input.subscriptionId, storeId: input.storeId } } }),
        metadata: { storeSubscriptionId: input.subscriptionId, storeId: input.storeId, planVersion: String(input.planVersion) },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl
      }, { idempotencyKey: `store-subscription-checkout-${input.subscriptionId}` });
      if (!session.url) throw new Error('Stripe did not return a checkout URL.');
      return { id: session.id, url: session.url, subscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null };
    },
    async retrieveCheckout(sessionId) {
      const session = await stripeClient.checkout.sessions.retrieve(sessionId);
      return { id: session.id, url: session.url, status: session.status };
    },
    async cancelSubscription(providerSubscriptionId, immediately, idempotencyKey) {
      const subscription = immediately
        ? await stripeClient.subscriptions.cancel(providerSubscriptionId, { prorate: false }, { idempotencyKey })
        : await stripeClient.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: true, proration_behavior: 'none' }, { idempotencyKey });
      const subscriptionData = subscription as unknown as { items?: { data?: { current_period_end?: number }[] } };
      const periodEnds = (subscriptionData.items?.data ?? []).map(item => item.current_period_end).filter((value): value is number => typeof value === 'number');
      const periodEnd = periodEnds.length ? Math.max(...periodEnds) : null;
      return { currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null };
    },
    verifyWebhook(rawBody, signature) {
      return stripeClient.webhooks.constructEvent(rawBody, signature, env.STRIPE_STORE_BILLING_WEBHOOK_SECRET!);
    }
  };
}

export function verifyStripeStoreBillingWebhook(rawBody: Buffer, signature: string) {
  if (!stripeClient || !env.STRIPE_STORE_BILLING_WEBHOOK_SECRET) throw new Error('Stripe Store billing webhook verification is not configured.');
  return stripeClient.webhooks.constructEvent(rawBody, signature, env.STRIPE_STORE_BILLING_WEBHOOK_SECRET);
}

export function stripeStoreBillingTermsSupported(input: {
  currency: string;
  monthlyPriceMinor: number;
  annualPriceMinor: number;
  introPriceMinor: number | null;
  termIntervals: number | null;
}) {
  if (input.currency !== 'USD') return { supported: false, reason: 'Stripe Store billing sandbox currently supports USD only.' } as const;
  if (input.monthlyPriceMinor <= 0 || input.annualPriceMinor <= 0) return { supported: false, reason: 'A paid monthly and annual price is required.' } as const;
  if (input.introPriceMinor !== null) return { supported: false, reason: 'Paid introductory offers are not yet supported by the Stripe billing schedule.' } as const;
  if (input.termIntervals !== null) return { supported: false, reason: 'Fixed-duration plan terms are not yet supported by the Stripe billing schedule.' } as const;
  return { supported: true, reason: null } as const;
}
