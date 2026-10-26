import { describe, expect, it } from 'vitest';
import { displayCurrencyAvailable, enabledMarketplaceLanguages, normalizeMarketplaceSearch, publicSearchLabel } from './marketplace-domain.js';

describe('marketplace domain rules', () => {
  it('normalizes bounded public search input', () => {
    expect(normalizeMarketplaceSearch({ q: '  studio  ', limit: '4' })).toEqual({ q: 'studio', limit: 4 });
    expect(() => normalizeMarketplaceSearch({ q: 'x' })).toThrow();
  });

  it('keeps search result types explicit', () => {
    expect(publicSearchLabel('product')).toBe('Product');
    expect(publicSearchLabel('store')).toBe('Store');
  });

  it('allows display currency only when an active, rate-backed currency is configured', () => {
    expect(displayCurrencyAvailable('usd', ['USD'])).toBe(true);
    expect(displayCurrencyAvailable('php', ['USD', 'PHP'])).toBe(true);
    expect(displayCurrencyAvailable('EUR', ['USD', 'PHP'])).toBe(false);
  });

  it('keeps English available and exposes only supported enabled languages', () => {
    expect(enabledMarketplaceLanguages(['fil', 'xx', 'fil'])).toEqual(['en', 'fil']);
    expect(enabledMarketplaceLanguages([])).toEqual(['en']);
    expect(enabledMarketplaceLanguages(null)).toEqual(['en']);
  });
});
