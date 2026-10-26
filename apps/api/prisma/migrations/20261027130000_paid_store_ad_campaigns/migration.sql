CREATE TYPE "StoreBusterBillingModel" AS ENUM ('CPC', 'CPV');
CREATE TYPE "StoreBusterAdAudience" AS ENUM ('BUYERS', 'SELLERS', 'BOTH');

ALTER TYPE "StoreBusterAdLedgerEntryType" ADD VALUE 'VIEW_SPEND';

ALTER TABLE "StoreBusterSettings"
  ADD COLUMN "pricePer100ViewsMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimumCampaignUsdMinor" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "maxCampaignDurationDays" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "StoreBusterCampaign"
  ADD COLUMN "headline" VARCHAR(120),
  ADD COLUMN "adDescription" VARCHAR(1000),
  ADD COLUMN "billingModel" "StoreBusterBillingModel",
  ADD COLUMN "audience" "StoreBusterAdAudience",
  ADD COLUMN "targetCountryCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "durationDays" INTEGER,
  ADD COLUMN "dailyBudgetMinor" INTEGER,
  ADD COLUMN "lifetimeBudgetMinor" INTEGER,
  ADD COLUMN "budgetCurrency" VARCHAR(3),
  ADD COLUMN "budgetTotalMinor" INTEGER,
  ADD COLUMN "budgetFxRate" VARCHAR(32),
  ADD COLUMN "pricePerClickSnapshot" INTEGER,
  ADD COLUMN "pricePer100ViewsSnapshot" INTEGER,
  ADD COLUMN "viewBillingRemainder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "startsAt" TIMESTAMP(3),
  ADD COLUMN "endsAt" TIMESTAMP(3);

ALTER TABLE "StoreBusterImpression" ADD COLUMN "viewerDayKey" VARCHAR(64);
CREATE UNIQUE INDEX "StoreBusterImpression_viewerDayKey_key" ON "StoreBusterImpression"("viewerDayKey");

ALTER TABLE "StoreBusterCampaign"
  ADD CONSTRAINT "StoreBusterCampaign_ad_budget_check" CHECK (
    ("dailyBudgetMinor" IS NULL OR "dailyBudgetMinor" > 0) AND
    ("lifetimeBudgetMinor" IS NULL OR "lifetimeBudgetMinor" > 0) AND
    ("budgetTotalMinor" IS NULL OR "budgetTotalMinor" > 0) AND
    ("durationDays" IS NULL OR "durationDays" BETWEEN 1 AND 365) AND
    "viewBillingRemainder" BETWEEN 0 AND 99 AND
    ("budgetCurrency" IS NULL OR "budgetCurrency" ~ '^[A-Z]{3}$') AND
    ("pricePerClickSnapshot" IS NULL OR "pricePerClickSnapshot" >= 0) AND
    ("pricePer100ViewsSnapshot" IS NULL OR "pricePer100ViewsSnapshot" >= 0)
  );
CREATE INDEX "StoreBusterCampaign_sponsored_window_idx" ON "StoreBusterCampaign"("sponsored", "status", "startsAt", "endsAt");

CREATE TABLE "StoreBusterCampaignCreative" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreBusterCampaignCreative_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreBusterCampaignCreative_position_check" CHECK ("position" BETWEEN 0 AND 3)
);
CREATE UNIQUE INDEX "StoreBusterCampaignCreative_campaignId_position_key" ON "StoreBusterCampaignCreative"("campaignId", "position");
CREATE UNIQUE INDEX "StoreBusterCampaignCreative_campaignId_mediaAssetId_key" ON "StoreBusterCampaignCreative"("campaignId", "mediaAssetId");
CREATE INDEX "StoreBusterCampaignCreative_mediaAssetId_idx" ON "StoreBusterCampaignCreative"("mediaAssetId");
ALTER TABLE "StoreBusterCampaignCreative" ADD CONSTRAINT "StoreBusterCampaignCreative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StoreBusterCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreBusterCampaignCreative" ADD CONSTRAINT "StoreBusterCampaignCreative_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
