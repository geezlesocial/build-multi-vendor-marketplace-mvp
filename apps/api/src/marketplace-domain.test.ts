import { describe, expect, it } from 'vitest';
import { displayCurrencyAvailable, normalizeMarketplaceSearch, publicSearchLabel } from './marketplace-domain.js';

describe('marketplace domain rules', () => {
  it('normalizes bounded public search input', () => {
    expect(normalizeMarketplaceSearch({ q: '  studio  ', limit: '4' })).toEqual({ q: 'studio', limit: 4 });
    expect(() => normalizeMarketplaceSearch({ q: 'x' })).toThrow();
  });

  it('keeps search result types explicit', () => {
    expect(publicSearchLabel('product')).toBe('Product');
    expect(publicSearchLabel('store')).toBe('Store');
  });

  it('allows only configured base-currency display', () => {
    expect(displayCurrencyAvailable('usd', 'USD', ['USD'])).toBe(true);
    expect(displayCurrencyAvailable('PHP', 'USD', ['USD', 'PHP'])).toBe(false);
    expect(displayCurrencyAvailable('USD', 'PHP', ['USD'])).toBe(false);
  });
});
