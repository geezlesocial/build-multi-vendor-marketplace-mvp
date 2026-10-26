import { z } from 'zod';

export const marketplaceSearchSchema = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(10).default(8)
}).strict();

export const accountPreferencesSchema = z.object({
  language: z.enum(['en', 'fil']).optional(),
  displayCurrency: z.string().trim().length(3).transform(value => value.toUpperCase()).optional()
}).strict();

export const supportedMarketplaceLanguages = ['en', 'fil'] as const;

export function enabledMarketplaceLanguages(languages: readonly string[] | null | undefined) {
  const enabled = new Set(languages ?? []);
  return supportedMarketplaceLanguages.filter(language => language === 'en' || enabled.has(language));
}

export function normalizeMarketplaceSearch(value: unknown) {
  return marketplaceSearchSchema.parse(value);
}

export function publicSearchLabel(type: 'product' | 'store') {
  return type === 'product' ? 'Product' : 'Store';
}

export function displayCurrencyAvailable(currency: string, configuredCurrencies: string[]) {
  const normalized = currency.trim().toUpperCase();
  return configuredCurrencies.some(configured => configured.toUpperCase() === normalized);
}
