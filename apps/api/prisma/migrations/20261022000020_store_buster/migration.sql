-- Privacy-first, explainable Store Buster foundations. Personalization is
-- opt-in and disabled by default. Metrics contain aggregates only.
CREATE TYPE "StoreInterestSignalType" AS ENUM ('PRODUCT_VIEW', 'SEARCH_CATEGORY', 'FAVORITE');
CREATE TYPE "StoreBusterCampaignStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED', 'ENDED');
CREATE TYPE "StoreBusterCampaignGoal" AS ENUM ('DISCOVERY', 'PRODUCT_VIEWS', 'STORE_VISITS');

ALTER TABLE "UserPreference"
    ADD COLUMN "personalizationEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "personalizationConsentAt" TIMESTAMP(3);

CREATE TABLE "StoreInterestSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "type" "StoreInterestSignalType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreInterestSignal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreInterestSignal_target_check" CHECK ("productId" IS NOT NULL OR "categoryId" IS NOT NULL)
);
CREATE INDEX "StoreInterestSignal_userId_createdAt_idx" ON "StoreInterestSignal"("userId", "createdAt");
CREATE INDEX "StoreInterestSignal_userId_categoryId_createdAt_idx" ON "StoreInterestSignal"("userId", "categoryId", "createdAt");
CREATE INDEX "StoreInterestSignal_userId_productId_createdAt_idx" ON "StoreInterestSignal"("userId", "productId", "createdAt");
ALTER TABLE "StoreInterestSignal" ADD CONSTRAINT "StoreInterestSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreInterestSignal" ADD CONSTRAINT "StoreInterestSignal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StoreInterestSignal" ADD CONSTRAINT "StoreInterestSignal_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StoreBusterSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sponsoredEnabled" BOOLEAN NOT NULL DEFAULT false,
    "moderationRequired" BOOLEAN NOT NULL DEFAULT true,
    "maxMonthlyBudgetMinor" INTEGER NOT NULL DEFAULT 0,
    "maxCampaignsPerStore" INTEGER NOT NULL DEFAULT 0,
    "pricePerClickMinor" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreBusterSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterSettings_default_key_check" CHECK ("id" = 'default'),
    CONSTRAINT "StoreBusterSettings_amounts_check" CHECK ("maxMonthlyBudgetMinor" >= 0 AND "maxCampaignsPerStore" >= 0 AND "pricePerClickMinor" >= 0),
    CONSTRAINT "StoreBusterSettings_sponsored_guard" CHECK (NOT "sponsoredEnabled" OR "enabled")
);
INSERT INTO "StoreBusterSettings" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP);
ALTER TABLE "StoreBusterSettings" ADD CONSTRAINT "StoreBusterSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StoreBusterCampaign" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" "StoreBusterCampaignGoal" NOT NULL,
    "status" "StoreBusterCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "sponsored" BOOLEAN NOT NULL DEFAULT false,
    "monthlyBudgetMinor" INTEGER NOT NULL DEFAULT 0,
    "audienceCategoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "moderationReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreBusterCampaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterCampaign_name_check" CHECK (length(btrim("name")) BETWEEN 2 AND 100),
    CONSTRAINT "StoreBusterCampaign_budget_check" CHECK ("monthlyBudgetMinor" >= 0),
    CONSTRAINT "StoreBusterCampaign_sponsored_review_check" CHECK (NOT "sponsored" OR "status" <> 'APPROVED' OR "reviewedAt" IS NOT NULL)
);
CREATE INDEX "StoreBusterCampaign_storeId_status_updatedAt_idx" ON "StoreBusterCampaign"("storeId", "status", "updatedAt");
CREATE INDEX "StoreBusterCampaign_status_sponsored_updatedAt_idx" ON "StoreBusterCampaign"("status", "sponsored", "updatedAt");
ALTER TABLE "StoreBusterCampaign" ADD CONSTRAINT "StoreBusterCampaign_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreBusterCampaign" ADD CONSTRAINT "StoreBusterCampaign_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StoreBusterCampaignProduct" (
    "campaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    CONSTRAINT "StoreBusterCampaignProduct_pkey" PRIMARY KEY ("campaignId", "productId")
);
CREATE INDEX "StoreBusterCampaignProduct_productId_idx" ON "StoreBusterCampaignProduct"("productId");
ALTER TABLE "StoreBusterCampaignProduct" ADD CONSTRAINT "StoreBusterCampaignProduct_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StoreBusterCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreBusterCampaignProduct" ADD CONSTRAINT "StoreBusterCampaignProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreBusterDailyMetric" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreBusterDailyMetric_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterDailyMetric_counts_check" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "clicks" <= "impressions")
);
CREATE UNIQUE INDEX "StoreBusterDailyMetric_campaignId_day_key" ON "StoreBusterDailyMetric"("campaignId", "day");
CREATE INDEX "StoreBusterDailyMetric_day_idx" ON "StoreBusterDailyMetric"("day");
ALTER TABLE "StoreBusterDailyMetric" ADD CONSTRAINT "StoreBusterDailyMetric_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StoreBusterCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
