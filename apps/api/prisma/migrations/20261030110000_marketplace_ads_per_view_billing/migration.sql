ALTER TABLE "MarketplaceProductAdSettings"
ADD COLUMN "pricePerHundredViewsMinor" INTEGER NOT NULL DEFAULT 100;

ALTER TABLE "MarketplaceProductAd"
ADD COLUMN "pricePerHundredViewsSnapshotMinor" INTEGER NOT NULL DEFAULT 100;
