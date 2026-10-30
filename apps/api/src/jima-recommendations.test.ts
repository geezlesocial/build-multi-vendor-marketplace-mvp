import { describe, expect, it } from 'vitest';
import { jimaInterestCategoryIds, rankJimaRecommendations, type JimaRankableProduct, type JimaRecommendationSettings } from './jima-recommendations.js';

const now = Date.UTC(2026, 9, 28);
const settings = (overrides: Partial<JimaRecommendationSettings> = {}): JimaRecommendationSettings => ({
  limit: 8,
  maxPerStore: 8,
  weights: { category: 60, freshness: 25, popularity: 15 },
  ...overrides
});
const product = (id: string, sellerId: string | null, categoryId: string | null, ageDays: number, favoriteCount: number): JimaRankableProduct => ({
  id,
  sellerId,
  categoryId,
  createdAt: new Date(now - ageDays * 24 * 60 * 60 * 1000),
  favoriteCount
});

describe('Jima recommendation ranking', () => {
  it('learns opted-in category interests from favorites and drops a category when the corresponding favorite is removed', () => {
    const candidate = product('related', 'store-a', 'home', 45, 0);
    const unrelated = product('unrelated', 'store-b', 'garden', 0, 0);
    const fromFavorite = jimaInterestCategoryIds([], ['home']);
    expect(fromFavorite).toEqual(['home']);
    expect(rankJimaRecommendations([unrelated, candidate], fromFavorite, settings(), now).map(item => item.id)).toEqual(['related', 'unrelated']);
    expect(jimaInterestCategoryIds([], [])).toEqual([]);
  });

  it('combines and deduplicates explicit category signals and liked-product categories', () => {
    expect(jimaInterestCategoryIds(['home', null, 'books'], ['home', 'garden', null])).toEqual(['home', 'books', 'garden']);
  });

  it('prioritizes opted-in category relevance while retaining other candidates', () => {
    const matching = product('matching', 'store-a', 'home', 30, 0);
    const popular = product('popular', 'store-b', 'garden', 0, 100);
    const ranked = rankJimaRecommendations([popular, matching], ['home'], settings(), now);
    expect(ranked.map(item => item.id)).toEqual(['matching', 'popular']);
  });

  it('uses freshness and aggregate favorites when there are no consented category signals', () => {
    const popular = product('popular', 'store-a', null, 90, 30);
    const recent = product('recent', 'store-b', null, 0, 0);
    const ranked = rankJimaRecommendations([recent, popular], [], settings({ weights: { category: 80, freshness: 20, popularity: 80 } }), now);
    expect(ranked.map(item => item.id)).toEqual(['popular', 'recent']);
  });

  it('limits each seller and the total result count, including the platform store', () => {
    const items = [
      product('a1', 'seller-a', null, 0, 50),
      product('a2', 'seller-a', null, 1, 45),
      product('a3', 'seller-a', null, 2, 40),
      product('b1', 'seller-b', null, 3, 35),
      product('platform-1', null, null, 4, 30),
      product('platform-2', null, null, 5, 25)
    ];
    const ranked = rankJimaRecommendations(items, [], settings({ limit: 4, maxPerStore: 1 }), now);
    expect(ranked.map(item => item.id)).toEqual(['a1', 'b1', 'platform-1']);
  });

  it('returns no candidates if all ranking weights are zero', () => {
    expect(rankJimaRecommendations([product('item', 'store-a', 'home', 0, 0)], ['home'], settings({ weights: { category: 0, freshness: 0, popularity: 0 } }), now)).toEqual([]);
  });
});
