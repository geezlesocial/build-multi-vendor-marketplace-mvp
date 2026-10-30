import { describe, expect, it } from 'vitest';
import { adCreatorFailure, adCreativeLimitFailure, estimateMarketplaceAdViews, marketplaceAdDestination, marketplaceAdPricePerView, sellerAdProductFailure, validMarketplaceAdPlacements } from './marketplace-ad-domain.js';

describe('marketplace product ad policy', () => {
  it('calculates proportional per-view pricing and budget estimates in minor units', () => {
    expect(marketplaceAdPricePerView(100)).toBe(1);
    expect(marketplaceAdPricePerView(250)).toBeNull();
    expect(estimateMarketplaceAdViews(10_000, 100)).toBe(10_000);
    expect(estimateMarketplaceAdViews(10_050, 100)).toBe(10_050);
    expect(estimateMarketplaceAdViews(99, 100)).toBe(99);
  });

  it('allows buyer and seller advertisers without Store Plan checks', () => {
    expect(adCreatorFailure('BUYER')).toBeNull();
    expect(adCreatorFailure('SELLER')).toBeNull();
    expect(adCreatorFailure('ADMIN')).toBeTruthy();
    expect(adCreatorFailure('CASHIER')).toBeTruthy();
  });

  it('accepts one or more known placements, including all, and rejects empty, duplicate, or manipulated values', () => {
    expect(validMarketplaceAdPlacements(['MARKETPLACE_HOME'])).toBe(true);
    expect(validMarketplaceAdPlacements(['MARKETPLACE_HOME', 'BLOG_POSTS'])).toBe(true);
    expect(validMarketplaceAdPlacements(['MARKETPLACE_HOME', 'COLLECTIONS', 'CATEGORY_PAGES', 'STOREFRONTS', 'BLOG_POSTS'])).toBe(true);
    expect(validMarketplaceAdPlacements([])).toBe(false);
    expect(validMarketplaceAdPlacements(['MARKETPLACE_HOME', 'MARKETPLACE_HOME'])).toBe(false);
    expect(validMarketplaceAdPlacements(['HIDDEN_ADMIN_PAGE'])).toBe(false);
    expect(validMarketplaceAdPlacements('MARKETPLACE_HOME')).toBe(false);
  });

  it('fails closed when a seller identity is missing or the listing belongs to another seller', () => {
    expect(sellerAdProductFailure('SELLER', undefined, 'seller-1')).toBeTruthy();
    expect(sellerAdProductFailure('SELLER', 'seller-1', 'seller-2')).toBeTruthy();
    expect(sellerAdProductFailure('SELLER', 'seller-1', 'seller-1')).toBeNull();
    expect(sellerAdProductFailure('BUYER', undefined, 'seller-1')).toBeNull();
  });

  it('enforces at most ten images and one video', () => {
    expect(adCreativeLimitFailure(new Array<'IMAGE'>(10).fill('IMAGE'), 'IMAGE')).toBeTruthy();
    expect(adCreativeLimitFailure(['VIDEO'], 'VIDEO')).toBeTruthy();
    expect(adCreativeLimitFailure([...new Array<'IMAGE'>(10).fill('IMAGE')], 'VIDEO')).toBeNull();
    expect(adCreativeLimitFailure(['VIDEO', ...new Array<'IMAGE'>(10).fill('IMAGE')], 'IMAGE')).toBeTruthy();
  });

  it('returns only the server-selected tagged product, store, or configured HTTPS destination', () => {
    expect(marketplaceAdDestination({ destination: 'PRODUCT', productId: 'p/1', storeSlug: 'shop', externalUrl: 'https://example.test' })).toBe('/products/p%2F1');
    expect(marketplaceAdDestination({ destination: 'STORE', productId: 'p1', storeSlug: 'shop/a', externalUrl: null })).toBe('/store/shop%2Fa');
    expect(marketplaceAdDestination({ destination: 'EXTERNAL', productId: 'p1', storeSlug: 'shop', externalUrl: 'https://example.test/item' })).toBe('https://example.test/item');
    expect(marketplaceAdDestination({ destination: 'EXTERNAL', productId: 'p1', storeSlug: null, externalUrl: null })).toBeNull();
  });
});
