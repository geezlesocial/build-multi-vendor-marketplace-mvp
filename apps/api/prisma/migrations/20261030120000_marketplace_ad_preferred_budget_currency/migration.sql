ALTER TABLE "MarketplaceProductAd"
ADD COLUMN "budgetInputMinor" INTEGER,
ADD COLUMN "budgetInputCurrency" VARCHAR(3),
ADD COLUMN "budgetFxRate" VARCHAR(32);
