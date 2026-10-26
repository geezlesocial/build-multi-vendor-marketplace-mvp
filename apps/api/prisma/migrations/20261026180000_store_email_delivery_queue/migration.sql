ALTER TYPE "StoreEmailCampaignStatus" ADD VALUE IF NOT EXISTS 'FAILED';

CREATE TYPE "StoreEmailDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

ALTER TABLE "StoreEmailSubscriber"
  ADD COLUMN "confirmationExpiresAt" TIMESTAMP(3);

ALTER TABLE "StoreEmailCampaign"
  ADD COLUMN "recipientCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sentCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "queuedAt" TIMESTAMP(3),
  ADD COLUMN "sentAt" TIMESTAMP(3);

CREATE TABLE "StoreEmailDelivery" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "subscriberId" TEXT NOT NULL,
  "status" "StoreEmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreEmailDelivery_campaignId_subscriberId_key" ON "StoreEmailDelivery"("campaignId", "subscriberId");
CREATE INDEX "StoreEmailDelivery_status_nextAttemptAt_createdAt_idx" ON "StoreEmailDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "StoreEmailDelivery_subscriberId_status_idx" ON "StoreEmailDelivery"("subscriberId", "status");

ALTER TABLE "StoreEmailDelivery" ADD CONSTRAINT "StoreEmailDelivery_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "StoreEmailCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreEmailDelivery" ADD CONSTRAINT "StoreEmailDelivery_subscriberId_fkey"
  FOREIGN KEY ("subscriberId") REFERENCES "StoreEmailSubscriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
