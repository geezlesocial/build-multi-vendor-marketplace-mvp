ALTER TABLE "MarketplaceSettings"
  ADD COLUMN "enabledLanguages" TEXT[] NOT NULL DEFAULT ARRAY['en', 'fil']::TEXT[];
