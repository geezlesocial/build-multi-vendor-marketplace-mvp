ALTER TYPE "MediaPurpose" ADD VALUE 'MARKETPLACE_AD';

CREATE TYPE "MarketplaceProductAdStatus" AS ENUM (
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'COMPLETED'
);

CREATE TABLE "MarketplaceProductAdSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "moderationRequired" BOOLEAN NOT NULL DEFAULT true,
  "minimumBudgetMinor" INTEGER NOT NULL DEFAULT 1000,
  "maximumBudgetMinor" INTEGER NOT NULL DEFAULT 1000000,
  "pricePerClickMinor" INTEGER NOT NULL DEFAULT 50,
  "maxDurationDays" INTEGER NOT NULL DEFAULT 30,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceProductAdSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceProductAd" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "storeId" TEXT,
  "status" "MarketplaceProductAdStatus" NOT NULL DEFAULT 'DRAFT',
  "headline" VARCHAR(120) NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "externalUrl" VARCHAR(2000),
  "messageEnabled" BOOLEAN NOT NULL DEFAULT true,
  "currency" VARCHAR(3) NOT NULL,
  "budgetMinor" INTEGER NOT NULL DEFAULT 0,
  "spentMinor" INTEGER NOT NULL DEFAULT 0,
  "reservedMinor" INTEGER NOT NULL DEFAULT 0,
  "durationDays" INTEGER NOT NULL DEFAULT 7,
  "reviewNote" VARCHAR(500),
  "reviewerId" TEXT,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceProductAd_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceProductAdCreative" (
  "id" TEXT NOT NULL,
  "adId" TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceProductAdCreative_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceProductAdImpression" (
  "id" TEXT NOT NULL,
  "adId" TEXT NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observedAt" TIMESTAMP(3),
  "clickedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceProductAdImpression_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceProductAdDailyMetric" (
  "id" TEXT NOT NULL,
  "adId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spendMinor" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "MarketplaceProductAdDailyMetric_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Conversation" ALTER COLUMN "sellerId" DROP NOT NULL;
ALTER TABLE "Conversation" ADD COLUMN "directRecipientId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "marketplaceProductAdId" TEXT;

CREATE UNIQUE INDEX "MarketplaceProductAdImpression_tokenHash_key" ON "MarketplaceProductAdImpression"("tokenHash");
CREATE UNIQUE INDEX "MarketplaceProductAdDailyMetric_adId_day_key" ON "MarketplaceProductAdDailyMetric"("adId", "day");
CREATE UNIQUE INDEX "MarketplaceProductAdCreative_adId_mediaAssetId_key" ON "MarketplaceProductAdCreative"("adId", "mediaAssetId");
CREATE UNIQUE INDEX "MarketplaceProductAdCreative_adId_position_key" ON "MarketplaceProductAdCreative"("adId", "position");
CREATE UNIQUE INDEX "Conversation_buyerId_directRecipientId_marketplaceProductAdId_key" ON "Conversation"("buyerId", "directRecipientId", "marketplaceProductAdId");
CREATE INDEX "MarketplaceProductAd_ownerId_status_updatedAt_idx" ON "MarketplaceProductAd"("ownerId", "status", "updatedAt");
CREATE INDEX "MarketplaceProductAd_status_startsAt_endsAt_idx" ON "MarketplaceProductAd"("status", "startsAt", "endsAt");
CREATE INDEX "MarketplaceProductAd_productId_status_idx" ON "MarketplaceProductAd"("productId", "status");
CREATE INDEX "MarketplaceProductAdCreative_mediaAssetId_idx" ON "MarketplaceProductAdCreative"("mediaAssetId");
CREATE INDEX "MarketplaceProductAdImpression_adId_seenAt_idx" ON "MarketplaceProductAdImpression"("adId", "seenAt");
CREATE INDEX "MarketplaceProductAdImpression_expiresAt_idx" ON "MarketplaceProductAdImpression"("expiresAt");
CREATE INDEX "MarketplaceProductAdDailyMetric_day_idx" ON "MarketplaceProductAdDailyMetric"("day");
CREATE INDEX "Conversation_directRecipientId_updatedAt_idx" ON "Conversation"("directRecipientId", "updatedAt");

ALTER TABLE "MarketplaceProductAdSettings" ADD CONSTRAINT "MarketplaceProductAdSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAd" ADD CONSTRAINT "MarketplaceProductAd_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAd" ADD CONSTRAINT "MarketplaceProductAd_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAd" ADD CONSTRAINT "MarketplaceProductAd_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAd" ADD CONSTRAINT "MarketplaceProductAd_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAdCreative" ADD CONSTRAINT "MarketplaceProductAdCreative_adId_fkey" FOREIGN KEY ("adId") REFERENCES "MarketplaceProductAd"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAdCreative" ADD CONSTRAINT "MarketplaceProductAdCreative_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAdImpression" ADD CONSTRAINT "MarketplaceProductAdImpression_adId_fkey" FOREIGN KEY ("adId") REFERENCES "MarketplaceProductAd"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProductAdDailyMetric" ADD CONSTRAINT "MarketplaceProductAdDailyMetric_adId_fkey" FOREIGN KEY ("adId") REFERENCES "MarketplaceProductAd"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_directRecipientId_fkey" FOREIGN KEY ("directRecipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_marketplaceProductAdId_fkey" FOREIGN KEY ("marketplaceProductAdId") REFERENCES "MarketplaceProductAd"("id") ON DELETE SET NULL ON UPDATE CASCADE;
