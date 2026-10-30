export type MarketplaceAdRole = 'BUYER' | 'SELLER' | 'ADMIN' | 'CASHIER' | 'CONTENT_EDITOR';
export type MarketplaceAdCreativeKind = 'IMAGE' | 'VIDEO';
export type MarketplaceAdDestination = 'PRODUCT' | 'STORE' | 'EXTERNAL';
export const MARKETPLACE_AD_PLACEMENTS = ['MARKETPLACE_HOME', 'COLLECTIONS', 'CATEGORY_PAGES', 'STOREFRONTS', 'BLOG_POSTS'] as const;
export type MarketplaceAdPlacement = typeof MARKETPLACE_AD_PLACEMENTS[number];

export function validMarketplaceAdPlacements(value: unknown): value is MarketplaceAdPlacement[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= MARKETPLACE_AD_PLACEMENTS.length
    && value.every(item => typeof item === 'string' && (MARKETPLACE_AD_PLACEMENTS as readonly string[]).includes(item))
    && new Set(value).size === value.length;
}

/** A whole-minor-unit price per view, derived from the configured price per 100 views. */
export function marketplaceAdPricePerView(pricePerHundredViewsMinor: number) {
  if (!Number.isSafeInteger(pricePerHundredViewsMinor) || pricePerHundredViewsMinor < 100 || pricePerHundredViewsMinor % 100 !== 0) return null;
  return pricePerHundredViewsMinor / 100;
}

export function estimateMarketplaceAdViews(budgetMinor: number, pricePerHundredViewsMinor: number) {
  const pricePerView = marketplaceAdPricePerView(pricePerHundredViewsMinor);
  if (!pricePerView || !Number.isSafeInteger(budgetMinor) || budgetMinor <= 0) return 0;
  return Math.floor(budgetMinor / pricePerView);
}

export function adCreatorFailure(role: MarketplaceAdRole): string | null {
  return role === 'BUYER' || role === 'SELLER' ? null : 'Only buyer and seller accounts can create marketplace ads.';
}

export function sellerAdProductFailure(role: MarketplaceAdRole, sellerId: string | undefined, productSellerId: string | null): string | null {
  return role === 'SELLER' && (!sellerId || !productSellerId || sellerId !== productSellerId)
    ? 'Sellers can create ads only for products in their own Store.'
    : null;
}

export function adCreativeLimitFailure(existing: MarketplaceAdCreativeKind[], next: MarketplaceAdCreativeKind): string | null {
  if (existing.length >= 11) return 'An ad can include at most 10 images and one video.';
  if (next === 'VIDEO' && existing.includes('VIDEO')) return 'An ad can include only one video.';
  if (next === 'IMAGE' && existing.filter(kind => kind === 'IMAGE').length >= 10) return 'An ad can include at most 10 images.';
  return null;
}

export function marketplaceAdDestination(input: { destination: MarketplaceAdDestination; productId: string; storeSlug: string | null; externalUrl: string | null }): string | null {
  if (input.destination === 'EXTERNAL') return input.externalUrl;
  if (input.destination === 'STORE' && input.storeSlug) return `/store/${encodeURIComponent(input.storeSlug)}`;
  return `/products/${encodeURIComponent(input.productId)}`;
}
