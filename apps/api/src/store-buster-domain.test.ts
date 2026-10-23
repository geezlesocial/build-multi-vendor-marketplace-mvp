import { describe, expect, it } from 'vitest';
import { rankInterestCategories, scoreInterestCategories } from './store-buster-domain.js';

describe('Store Buster relevance ranking', () => {
  it('ranks only category references with explainable weights and stable ties', () => {
    expect(rankInterestCategories([
      { categoryId: 'home', type: 'PRODUCT_VIEW' },
      { categoryId: 'home', type: 'FAVORITE' },
      { categoryId: 'books', type: 'FAVORITE' },
      { categoryId: 'garden', type: 'SEARCH_CATEGORY' },
      { categoryId: null, type: 'FAVORITE' }
    ])).toEqual(['home', 'books', 'garden']);
  });

  it('caps the number of categories and handles empty or invalid limits safely', () => {
    const signals = ['a', 'b', 'c'].map(categoryId => ({ categoryId, type: 'SEARCH_CATEGORY' as const }));
    expect(rankInterestCategories(signals, 2)).toEqual(['a', 'b']);
    expect(rankInterestCategories(signals, 0)).toEqual([]);
    expect(rankInterestCategories([], 10)).toEqual([]);
  });

  it('exposes stable scores so recommendations can be ordered by declared relevance', () => {
    expect(scoreInterestCategories([
      { categoryId: 'books', type: 'PRODUCT_VIEW' },
      { categoryId: 'home', type: 'FAVORITE' },
      { categoryId: 'books', type: 'FAVORITE' }
    ])).toEqual([{ categoryId: 'books', points: 6 }, { categoryId: 'home', points: 4 }]);
  });
});
