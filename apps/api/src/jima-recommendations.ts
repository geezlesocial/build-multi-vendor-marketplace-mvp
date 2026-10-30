export type JimaRecommendationSettings = {
  limit: number;
  maxPerStore: number;
  weights: { category: number; freshness: number; popularity: number };
};

export type JimaRankableProduct = {
  id: string;
  sellerId: string | null;
  categoryId: string | null;
  createdAt: Date;
  favoriteCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function jimaInterestCategoryIds(signalCategories: readonly (string | null)[], favoriteCategories: readonly (string | null)[]) {
  return [...new Set([...signalCategories, ...favoriteCategories].filter((categoryId): categoryId is string => Boolean(categoryId)))];
}

export function rankJimaRecommendations<T extends JimaRankableProduct>(
  products: readonly T[],
  categoryIds: readonly string[],
  settings: JimaRecommendationSettings,
  now = Date.now()
): T[] {
  const categorySet = new Set(categoryIds);
  const categoryWeight = categorySet.size ? settings.weights.category : 0;
  const totalWeight = categoryWeight + settings.weights.freshness + settings.weights.popularity;
  if (totalWeight <= 0) return [];

  const ranked = products.map(product => {
    const ageDays = Math.max(0, now - product.createdAt.getTime()) / DAY_MS;
    const freshness = 1 / (1 + ageDays / 30);
    const popularity = Math.max(0, product.favoriteCount) / (Math.max(0, product.favoriteCount) + 10);
    const categoryMatch = product.categoryId && categorySet.has(product.categoryId) ? 1 : 0;
    const score = (
      categoryMatch * categoryWeight
      + freshness * settings.weights.freshness
      + popularity * settings.weights.popularity
    ) / totalWeight;
    return { product, score };
  }).sort((left, right) => right.score - left.score
    || right.product.createdAt.getTime() - left.product.createdAt.getTime()
    || left.product.id.localeCompare(right.product.id));

  const perStore = new Map<string, number>();
  const selected: T[] = [];
  for (const { product } of ranked) {
    const storeKey = product.sellerId ?? '__platform_store__';
    const count = perStore.get(storeKey) ?? 0;
    if (count >= settings.maxPerStore) continue;
    selected.push(product);
    perStore.set(storeKey, count + 1);
    if (selected.length >= settings.limit) break;
  }
  return selected;
}
