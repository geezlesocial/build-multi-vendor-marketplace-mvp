export type InterestSignal = { categoryId: string | null; type: 'FAVORITE' | 'PRODUCT_VIEW' | 'SEARCH_CATEGORY' };

const weights: Record<InterestSignal['type'], number> = {
  FAVORITE: 4,
  PRODUCT_VIEW: 2,
  SEARCH_CATEGORY: 1
};

export function scoreInterestCategories(signals: InterestSignal[]) {
  const score = new Map<string, number>();
  for (const signal of signals) {
    if (signal.categoryId) score.set(signal.categoryId, (score.get(signal.categoryId) ?? 0) + weights[signal.type]);
  }
  return [...score.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([categoryId, points]) => ({ categoryId, points }));
}

export function rankInterestCategories(signals: InterestSignal[], limit = 10) {
  return scoreInterestCategories(signals).slice(0, Math.max(0, limit)).map(item => item.categoryId);
}
