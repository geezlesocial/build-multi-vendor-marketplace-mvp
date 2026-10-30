export type ProviderName = 'STRIPE' | 'PAYPAL' | 'PAYMONGO' | 'PAYSTACK';
export type ProviderContext = 'MARKETPLACE_CHECKOUT' | 'WALLET_FUNDING';
export type ProviderEnvironment = 'SANDBOX' | 'LIVE';

export type CredentialKey = 'apiSecret' | 'webhookSecret' | 'clientId' | 'clientSecret' | 'webhookId';
export type CredentialReferences = Partial<Record<CredentialKey, string>>;

const registry: Record<ProviderName, Partial<Record<ProviderContext, Partial<Record<CredentialKey, string>>>>> = {
  STRIPE: {
    MARKETPLACE_CHECKOUT: { apiSecret: 'STRIPE_SECRET_KEY', webhookSecret: 'STRIPE_WEBHOOK_SECRET' },
    WALLET_FUNDING: { apiSecret: 'STRIPE_SECRET_KEY', webhookSecret: 'STRIPE_WEBHOOK_SECRET' }
  },
  PAYPAL: {
    MARKETPLACE_CHECKOUT: { clientId: 'PAYPAL_CLIENT_ID', clientSecret: 'PAYPAL_CLIENT_SECRET', webhookId: 'PAYPAL_WEBHOOK_ID' }
  },
  PAYMONGO: {
    MARKETPLACE_CHECKOUT: { apiSecret: 'PAYMONGO_SECRET_KEY', webhookSecret: 'PAYMONGO_WEBHOOK_SECRET' }
  },
  PAYSTACK: {
    MARKETPLACE_CHECKOUT: { apiSecret: 'PAYSTACK_SECRET_KEY' }
  }
};

const referencePattern = /^(?:env:[A-Z][A-Z0-9_]{1,99}|secret-ref:[A-Za-z0-9][A-Za-z0-9/_-]{0,127})$/;

export function credentialKeysFor(provider: string, context: string): CredentialKey[] | null {
  const credentials = registry[provider as ProviderName]?.[context as ProviderContext];
  return credentials ? Object.keys(credentials) as CredentialKey[] : null;
}

export function environmentNameFor(provider: ProviderName, context: ProviderContext, key: CredentialKey) {
  return registry[provider]?.[context]?.[key] ?? null;
}

export function validateCredentialReferences(provider: string, context: string, values: Record<string, unknown>): CredentialReferences {
  const allowed = registry[provider as ProviderName]?.[context as ProviderContext];
  if (!allowed) throw new Error('This provider is not implemented for the selected integration context.');
  const result: CredentialReferences = {};
  for (const [key, value] of Object.entries(values)) {
    const environmentName = allowed[key as CredentialKey];
    if (!environmentName) throw new Error('Unsupported credential reference field.');
    if (typeof value !== 'string' || !referencePattern.test(value)) throw new Error('Use an environment-variable name or secret-manager reference; credential values and URLs are not accepted.');
    if (value.startsWith('env:') && value !== `env:${environmentName}`) throw new Error(`This field may only reference ${environmentName} in the process environment.`);
    if (value.startsWith('secret-ref:') && value !== `secret-ref:payments/${provider.toLowerCase()}/${key}`) throw new Error('Use the fixed secret-manager reference path for this provider credential field.');
    result[key as CredentialKey] = value;
  }
  return result;
}

export function maskCredentialReference(reference: string) {
  if (reference.startsWith('env:')) {
    const name = reference.slice(4);
    return `env:${name.slice(0, 3)}••••${name.slice(-3)}`;
  }
  return 'secret-ref:••••••••';
}

export function redactProviderAuditReason(value: string) {
  return value
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\bwhsec_[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\b(?:client[_ -]?secret|api[_ -]?secret)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, '[REDACTED]');
}

export type ProviderReadinessInput = {
  provider: ProviderName;
  context: ProviderContext;
  environment: ProviderEnvironment;
  references: CredentialReferences;
  runtime: Record<string, string | undefined>;
  liveConfigurationsAvailable: boolean;
  moneyMovementHardDisabled: boolean;
};

export type ProviderReadiness = { ready: boolean; code: string; message: string; credentials: { key: CredentialKey; referenceConfigured: boolean; referenceType: 'ENVIRONMENT' | 'SECRET_MANAGER' | 'MISSING'; maskedReference: string | null; runtimeValuePresent: boolean }[] };

export function providerStatusVerifiedForActivation(readiness: ProviderReadiness) {
  return readiness.ready && readiness.code === 'PROVIDER_VERIFIED';
}

export function evaluateProviderReadiness(input: ProviderReadinessInput): ProviderReadiness {
  const keys = credentialKeysFor(input.provider, input.context);
  if (!keys) return { ready: false, code: 'UNSUPPORTED_CONTEXT', message: 'No provider adapter is implemented for this context.', credentials: [] };
  const credentials = keys.map(key => {
    const reference = input.references[key];
    const envName = environmentNameFor(input.provider, input.context, key)!;
    const value = input.runtime[envName];
    const nonPlaceholder = Boolean(value?.trim()) && !value!.toLowerCase().includes('placeholder');
    const modeMatches = !['STRIPE', 'PAYMONGO', 'PAYSTACK'].includes(input.provider) || key !== 'apiSecret' || (value?.startsWith(input.environment === 'SANDBOX' ? 'sk_test_' : 'sk_live_') ?? false);
    return {
      key,
      referenceConfigured: Boolean(reference),
      referenceType: reference?.startsWith('env:') ? 'ENVIRONMENT' as const : reference?.startsWith('secret-ref:') ? 'SECRET_MANAGER' as const : 'MISSING' as const,
      maskedReference: reference ? maskCredentialReference(reference) : null,
      runtimeValuePresent: Boolean(nonPlaceholder && modeMatches)
    };
  });
  if (input.environment === 'LIVE' && !input.liveConfigurationsAvailable) return { ready: false, code: 'LIVE_GATE_DISABLED', message: 'Live provider configuration is blocked by the deployment-level safety gate.', credentials };
  if (input.context === 'WALLET_FUNDING' && input.moneyMovementHardDisabled) return { ready: false, code: 'WALLET_HARD_DISABLED', message: 'Wallet funding remains blocked by the platform money-movement hard-disable.', credentials };
  if (credentials.some(item => !item.referenceConfigured || !item.runtimeValuePresent)) {
    return { ready: false, code: 'CREDENTIALS_NOT_READY', message: 'Required references or matching environment-injected credentials are missing. No provider check was performed.', credentials };
  }
  if (input.provider === 'PAYPAL') {
    const baseUrl = input.runtime.PAYPAL_BASE_URL;
    const expected = input.environment === 'SANDBOX' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
    if (baseUrl !== expected) return { ready: false, code: 'ENVIRONMENT_MISMATCH', message: 'PayPal API endpoint does not match the selected environment.', credentials };
  }
  return { ready: true, code: 'CONFIGURED_NOT_PROVIDER_VERIFIED', message: 'Required configuration is present and matches the selected environment. Provider connectivity and credentials have not been verified.', credentials };
}
