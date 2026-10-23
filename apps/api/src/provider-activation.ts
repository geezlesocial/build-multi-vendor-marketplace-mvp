import { IntegrationContext, IntegrationEnvironment, IntegrationProvider, PaymentMethod } from '@prisma/client';
import { env } from './config.js';
import { prisma } from './security.js';
import { evaluateProviderReadiness, providerStatusVerifiedForActivation } from './provider-integrations-domain.js';

export async function livePaymentActivationBlock(method: PaymentMethod) {
  const provider = method === PaymentMethod.STRIPE ? IntegrationProvider.STRIPE : method === PaymentMethod.PAYPAL ? IntegrationProvider.PAYPAL : null;
  if (!provider) return null;
  const runtimeIsLive = provider === IntegrationProvider.STRIPE
    ? Boolean(env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))
    : env.PAYPAL_BASE_URL === 'https://api-m.paypal.com';
  if (!runtimeIsLive) return null;
  if (!env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE) return { code: 'LIVE_PROVIDER_CONFIGURATION_DISABLED', error: 'Live payment activation is blocked by the deployment safety gate.' };
  const configuration = await prisma.providerConfiguration.findFirst({
    where: { provider, context: IntegrationContext.MARKETPLACE_CHECKOUT, environment: IntegrationEnvironment.LIVE, enabled: true, archivedAt: null },
    include: { credentials: true }
  });
  if (!configuration) return { code: 'LIVE_PROVIDER_CONFIGURATION_REQUIRED', error: 'A ready, enabled live provider configuration is required before new live buyer payments can start.' };
  const readiness = evaluateProviderReadiness({
    provider: provider === IntegrationProvider.STRIPE ? 'STRIPE' : 'PAYPAL',
    context: 'MARKETPLACE_CHECKOUT', environment: 'LIVE',
    references: Object.fromEntries(configuration.credentials.map(item => [item.credentialKey, item.reference])),
    runtime: {
      STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
      PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
      PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID, PAYPAL_BASE_URL: env.PAYPAL_BASE_URL
    },
    liveConfigurationsAvailable: env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE,
    moneyMovementHardDisabled: env.MONEY_MOVEMENT_HARD_DISABLED
  });
  if (!readiness.ready) return { code: readiness.code, error: readiness.message };
  if (!providerStatusVerifiedForActivation(readiness)) return { code: 'LIVE_PROVIDER_VERIFICATION_REQUIRED', error: 'Live payment activation remains unavailable until provider verification is implemented and completed. Configuration presence is not verification.' };
  return null;
}
