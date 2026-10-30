export const PLATFORM_PERMISSIONS = [
  'OVERVIEW',
  'MARKETPLACE',
  'PLANS_BILLING',
  'PAYMENTS',
  'WALLET_MANAGEMENT',
  'GROWTH',
  'MEMBERS_SECURITY',
  'SUPPORT_MESSAGING',
  'AI_OPERATIONS',
  'INTEGRATIONS',
  'PLATFORM_SETTINGS',
  'GOVERNANCE',
  'CONTENT_MANAGEMENT'
] as const;

export type PlatformPermission = typeof PLATFORM_PERMISSIONS[number];
export const PLATFORM_POSITIONS = ['ADMINISTRATOR', 'SUPERVISOR', 'ACCOUNTANT', 'WRITER', 'EDITOR'] as const;
export type PlatformPosition = typeof PLATFORM_POSITIONS[number] | (string & {});

export const PLATFORM_POSITION_LABELS: Record<PlatformPosition, string> = {
  ADMINISTRATOR: 'Administrator',
  SUPERVISOR: 'Supervisor',
  ACCOUNTANT: 'Accountant',
  WRITER: 'Writer',
  EDITOR: 'Editor'
};

export const PLATFORM_PERMISSION_LABELS: Record<PlatformPermission, string> = {
  OVERVIEW: 'Overview',
  MARKETPLACE: 'Marketplace operations',
  PLANS_BILLING: 'Store plans and billing',
  PAYMENTS: 'Payments, commissions, payouts and refunds',
  WALLET_MANAGEMENT: 'Platform wallet administration',
  GROWTH: 'Growth, promotions and advertising',
  MEMBERS_SECURITY: 'Members and security',
  SUPPORT_MESSAGING: 'Support and messaging',
  AI_OPERATIONS: 'Jima AI operations',
  INTEGRATIONS: 'Integrations and providers',
  PLATFORM_SETTINGS: 'Platform settings and currency',
  GOVERNANCE: 'Audit log and governance',
  CONTENT_MANAGEMENT: 'Blog and page content'
};

export const POSITION_DEFAULT_PERMISSIONS: Record<PlatformPosition, PlatformPermission[]> = {
  ADMINISTRATOR: [...PLATFORM_PERMISSIONS],
  SUPERVISOR: ['OVERVIEW', 'MARKETPLACE', 'GROWTH', 'SUPPORT_MESSAGING'],
  ACCOUNTANT: ['OVERVIEW', 'PLANS_BILLING', 'PAYMENTS'],
  WRITER: ['CONTENT_MANAGEMENT'],
  EDITOR: ['CONTENT_MANAGEMENT']
};

const startsWithAny = (path: string, prefixes: string[]) => prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}-`));

/** Fail closed: only explicitly classified administrative APIs are available to collaborators. */
export function requiredPlatformPermission(method: string, path: string, body?: unknown): PlatformPermission | null {
  const verb = method.toUpperCase();
  if (path === '/api/admin/settings' && verb === 'PATCH' && body && typeof body === 'object') {
    if ('method' in body) return 'PAYMENTS';
    if ('multiVendorEnabled' in body || 'liveShoppingEnabled' in body) return 'MARKETPLACE';
    return null;
  }
  if (path === '/api/admin/platform/settings' && verb === 'PATCH' && body && typeof body === 'object') {
    const keys = Object.keys(body).filter(key => key !== 'reason');
    const marketplace = ['sellerShippingEnabled', 'sellerApprovalPolicy', 'productApprovalPolicy'];
    const payments = ['codMaxMinor', 'sellerPayoutsEnabled', 'payoutFundingConfigured', 'manualBankPayoutsEnabled', 'manualEwalletPayoutsEnabled', 'stripeConnectPayoutsEnabled', 'paypalPayoutsEnabled', 'payoutHoldDays', 'payoutMinimumMinor'];
    const scopes = new Set(keys.map(key => marketplace.includes(key) ? 'MARKETPLACE' : payments.includes(key) ? 'PAYMENTS' : 'PLATFORM_SETTINGS'));
    return scopes.size === 1 ? [...scopes][0] as PlatformPermission : null;
  }
  if (startsWithAny(path, ['/api/admin/collaborators'])) return null;
  if (startsWithAny(path, ['/api/admin/payment-settings', '/api/admin/integrations/payment-methods'])) return 'PAYMENTS';
  if (startsWithAny(path, ['/api/admin/content'])) return 'CONTENT_MANAGEMENT';
  if (startsWithAny(path, ['/api/admin/members', '/api/admin/auth', '/api/admin/onboarding'])) return 'MEMBERS_SECURITY';
  if (startsWithAny(path, ['/api/admin/audit'])) return 'GOVERNANCE';
  if (startsWithAny(path, ['/api/admin/wallet'])) return 'WALLET_MANAGEMENT';
  if (startsWithAny(path, ['/api/admin/seller-commission', '/api/admin/payouts', '/api/admin/order-resolution-cases', '/api/admin/refunds', '/api/admin/payment-methods'])) return 'PAYMENTS';
  if (startsWithAny(path, ['/api/admin/store-plans', '/api/admin/store-plan-stores', '/api/admin/store-billing'])) return 'PLANS_BILLING';
  if (startsWithAny(path, ['/api/admin/club-coins'])) return 'WALLET_MANAGEMENT';
  if (startsWithAny(path, ['/api/admin/affiliate', '/api/admin/affiliates', '/api/admin/campaigns', '/api/admin/marketplace-ads', '/api/admin/store-buster', '/api/marketplace-ads/settings'])) return 'GROWTH';
  if (startsWithAny(path, ['/api/admin/store-email/providers'])) return 'INTEGRATIONS';
  if (startsWithAny(path, ['/api/admin/jima'])) return 'AI_OPERATIONS';
  if (startsWithAny(path, ['/api/admin/integrations', '/api/admin/providers', '/api/admin/webhooks'])) return 'INTEGRATIONS';
  if (startsWithAny(path, ['/api/admin/store-email'])) return 'GROWTH';
  if (startsWithAny(path, ['/api/admin/currencies', '/api/admin/fx', '/api/admin/platform/branding', '/api/admin/platform/branding-media', '/api/admin/platform/availability', '/api/admin/platform/settings'])) return 'PLATFORM_SETTINGS';
  if (startsWithAny(path, ['/api/admin/platform-store', '/api/admin/catalog', '/api/admin/categories', '/api/admin/brands', '/api/admin/product-reviews', '/api/admin/products', '/api/admin/sellers', '/api/admin/vendors', '/api/admin/orders', '/api/admin/shipping', '/api/admin/live-provider', '/api/admin/live-sessions', '/api/admin/live-reports', '/api/admin/wholesale', '/api/admin/carriers'])) return 'MARKETPLACE';
  if (startsWithAny(path, ['/api/support/tickets'])) return 'SUPPORT_MESSAGING';
  return null;
}

export function hasPlatformPermission(granted: string[], permission: PlatformPermission | null) {
  return permission !== null && granted.includes(permission);
}
