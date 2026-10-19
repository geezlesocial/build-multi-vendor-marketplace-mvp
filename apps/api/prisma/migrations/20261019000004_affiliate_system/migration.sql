CREATE TYPE "AffiliateAttributionRule" AS ENUM ('LAST_VALID_CLICK', 'FIRST_VALID_CLICK');
CREATE TYPE "CommissionEntryType" AS ENUM ('EARNED', 'REVERSAL', 'ADJUSTMENT');
CREATE TYPE "AffiliateAdjustmentType" AS ENUM ('REFUND', 'CHARGEBACK', 'CANCELLATION');

ALTER TABLE "MarketplaceSettings"
  ADD COLUMN "affiliateEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "affiliateFundingConfigured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "affiliateAttributionRule" "AffiliateAttributionRule" NOT NULL DEFAULT 'LAST_VALID_CLICK',
  ADD COLUMN "affiliateAttributionWindowDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "affiliateMinimumPayoutMinor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AffiliateProfile"
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "AffiliateClick"
  ADD COLUMN "consentGivenAt" TIMESTAMP(3),
  ADD COLUMN "visitorKeyHash" TEXT;
CREATE INDEX "AffiliateClick_affiliateId_visitorKeyHash_clickedAt_idx" ON "AffiliateClick"("affiliateId", "visitorKeyHash", "clickedAt");

ALTER TABLE "CommissionLedger"
  ADD COLUMN "entryType" "CommissionEntryType" NOT NULL DEFAULT 'EARNED',
  ADD COLUMN "eligibleBaseMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ruleName" TEXT,
  ADD COLUMN "basisPointsSnapshot" INTEGER,
  ADD COLUMN "fixedMinorSnapshot" INTEGER,
  ADD COLUMN "sourceEventId" TEXT,
  ADD COLUMN "reversalOfId" TEXT;
CREATE INDEX "CommissionLedger_sourceEventId_idx" ON "CommissionLedger"("sourceEventId");
CREATE INDEX "CommissionLedger_reversalOfId_idx" ON "CommissionLedger"("reversalOfId");
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "CommissionLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AffiliatePayout" ADD COLUMN "reviewNote" TEXT;

CREATE TABLE "AffiliateAdjustment" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT,
  "type" "AffiliateAdjustmentType" NOT NULL,
  "quantity" INTEGER,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "providerEventId" TEXT,
  "reason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateAdjustment_idempotencyKey_key" ON "AffiliateAdjustment"("idempotencyKey");
CREATE INDEX "AffiliateAdjustment_orderId_createdAt_idx" ON "AffiliateAdjustment"("orderId", "createdAt");
CREATE INDEX "AffiliateAdjustment_providerEventId_idx" ON "AffiliateAdjustment"("providerEventId");
ALTER TABLE "AffiliateAdjustment" ADD CONSTRAINT "AffiliateAdjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ParentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateAdjustment" ADD CONSTRAINT "AffiliateAdjustment_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
