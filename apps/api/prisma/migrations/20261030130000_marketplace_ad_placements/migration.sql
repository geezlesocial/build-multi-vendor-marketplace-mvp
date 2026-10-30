CREATE TYPE "MarketplaceProductAdPlacement" AS ENUM (
  'MARKETPLACE_HOME',
  'COLLECTIONS',
  'CATEGORY_PAGES',
  'STOREFRONTS',
  'BLOG_POSTS'
);

ALTER TABLE "MarketplaceProductAd"
ADD COLUMN "placements" "MarketplaceProductAdPlacement"[] NOT NULL
DEFAULT ARRAY['MARKETPLACE_HOME']::"MarketplaceProductAdPlacement"[];
