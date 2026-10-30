CREATE TABLE "MarketingCampaignMedia" (
    "campaignId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "destinationUrl" VARCHAR(2000),
    "altText" VARCHAR(300),
    "buttonLabel" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingCampaignMedia_pkey" PRIMARY KEY ("campaignId", "mediaAssetId")
);

CREATE UNIQUE INDEX "MarketingCampaignMedia_mediaAssetId_key" ON "MarketingCampaignMedia"("mediaAssetId");
CREATE UNIQUE INDEX "MarketingCampaignMedia_campaignId_position_key" ON "MarketingCampaignMedia"("campaignId", "position");
CREATE INDEX "MarketingCampaignMedia_campaignId_position_idx" ON "MarketingCampaignMedia"("campaignId", "position");

ALTER TABLE "MarketingCampaignMedia"
ADD CONSTRAINT "MarketingCampaignMedia_campaignId_fkey"
FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketingCampaignMedia"
ADD CONSTRAINT "MarketingCampaignMedia_mediaAssetId_fkey"
FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
