CREATE TYPE "StoreBusterAdAccountStatus" AS ENUM ('ACTIVE', 'FROZEN');
CREATE TYPE "StoreBusterAdLedgerEntryType" AS ENUM ('TOP_UP', 'CLICK_SPEND', 'ADMIN_ADJUSTMENT', 'REFUND_REVERSAL');
CREATE TYPE "StoreBusterFundingStatus" AS ENUM ('PENDING', 'PAID', 'REVIEW', 'FAILED', 'EXPIRED');

ALTER TABLE "StoreBusterDailyMetric" ADD COLUMN "spendMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StoreBusterDailyMetric" ADD CONSTRAINT "StoreBusterDailyMetric_spend_check" CHECK ("spendMinor" >= 0);

ALTER TABLE "StoreBusterImpression" ADD COLUMN "shownAt" TIMESTAMP(3);
ALTER TABLE "StoreBusterImpression" ADD COLUMN "productId" TEXT;
CREATE INDEX "StoreBusterImpression_productId_idx" ON "StoreBusterImpression"("productId");
ALTER TABLE "StoreBusterImpression" ADD CONSTRAINT "StoreBusterImpression_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreBusterAdAccount" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "availableMinor" INTEGER NOT NULL DEFAULT 0,
    "status" "StoreBusterAdAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreBusterAdAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterAdAccount_balance_check" CHECK ("availableMinor" >= 0),
    CONSTRAINT "StoreBusterAdAccount_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "StoreBusterAdAccount_storeId_key" ON "StoreBusterAdAccount"("storeId");
CREATE INDEX "StoreBusterAdAccount_status_updatedAt_idx" ON "StoreBusterAdAccount"("status", "updatedAt");
ALTER TABLE "StoreBusterAdAccount" ADD CONSTRAINT "StoreBusterAdAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreBusterAdFundingIntent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "status" "StoreBusterFundingStatus" NOT NULL DEFAULT 'PENDING',
    "providerOrderRef" TEXT,
    "providerPaymentRef" TEXT,
    "providerCheckoutRef" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreBusterAdFundingIntent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterAdFundingIntent_amount_check" CHECK ("amountMinor" > 0),
    CONSTRAINT "StoreBusterAdFundingIntent_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "StoreBusterAdFundingIntent_provider_check" CHECK ("provider" IN ('STRIPE', 'PAYPAL'))
);
CREATE UNIQUE INDEX "StoreBusterAdFundingIntent_providerOrderRef_key" ON "StoreBusterAdFundingIntent"("providerOrderRef");
CREATE UNIQUE INDEX "StoreBusterAdFundingIntent_providerPaymentRef_key" ON "StoreBusterAdFundingIntent"("providerPaymentRef");
CREATE UNIQUE INDEX "StoreBusterAdFundingIntent_providerCheckoutRef_key" ON "StoreBusterAdFundingIntent"("providerCheckoutRef");
CREATE INDEX "StoreBusterAdFundingIntent_accountId_status_createdAt_idx" ON "StoreBusterAdFundingIntent"("accountId", "status", "createdAt");
CREATE INDEX "StoreBusterAdFundingIntent_status_expiresAt_idx" ON "StoreBusterAdFundingIntent"("status", "expiresAt");
ALTER TABLE "StoreBusterAdFundingIntent" ADD CONSTRAINT "StoreBusterAdFundingIntent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoreBusterAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreBusterAdFundingIntent" ADD CONSTRAINT "StoreBusterAdFundingIntent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreBusterFundingEvent" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "eventId" VARCHAR(255) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "fundingIntentId" TEXT,
    "amountMinor" INTEGER,
    "currency" VARCHAR(3),
    "reviewReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreBusterFundingEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterFundingEvent_provider_check" CHECK ("provider" IN ('STRIPE', 'PAYPAL')),
    CONSTRAINT "StoreBusterFundingEvent_amount_check" CHECK ("amountMinor" IS NULL OR "amountMinor" >= 0)
);
CREATE UNIQUE INDEX "StoreBusterFundingEvent_provider_eventId_key" ON "StoreBusterFundingEvent"("provider", "eventId");
CREATE INDEX "StoreBusterFundingEvent_fundingIntentId_createdAt_idx" ON "StoreBusterFundingEvent"("fundingIntentId", "createdAt");
CREATE INDEX "StoreBusterFundingEvent_reviewReason_createdAt_idx" ON "StoreBusterFundingEvent"("reviewReason", "createdAt");
ALTER TABLE "StoreBusterFundingEvent" ADD CONSTRAINT "StoreBusterFundingEvent_fundingIntentId_fkey" FOREIGN KEY ("fundingIntentId") REFERENCES "StoreBusterAdFundingIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StoreBusterAdLedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fundingIntentId" TEXT,
    "campaignId" TEXT,
    "type" "StoreBusterAdLedgerEntryType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "balanceAfterMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreBusterAdLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreBusterAdLedgerEntry_amount_check" CHECK ("amountMinor" <> 0),
    CONSTRAINT "StoreBusterAdLedgerEntry_balance_check" CHECK ("balanceAfterMinor" >= 0),
    CONSTRAINT "StoreBusterAdLedgerEntry_type_amount_check" CHECK (("type" = 'TOP_UP' AND "amountMinor" > 0) OR ("type" = 'CLICK_SPEND' AND "amountMinor" < 0) OR "type" IN ('ADMIN_ADJUSTMENT', 'REFUND_REVERSAL')),
    CONSTRAINT "StoreBusterAdLedgerEntry_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "StoreBusterAdLedgerEntry_fundingIntentId_key" ON "StoreBusterAdLedgerEntry"("fundingIntentId");
CREATE UNIQUE INDEX "StoreBusterAdLedgerEntry_idempotencyKey_key" ON "StoreBusterAdLedgerEntry"("idempotencyKey");
CREATE INDEX "StoreBusterAdLedgerEntry_accountId_createdAt_idx" ON "StoreBusterAdLedgerEntry"("accountId", "createdAt");
CREATE INDEX "StoreBusterAdLedgerEntry_campaignId_createdAt_idx" ON "StoreBusterAdLedgerEntry"("campaignId", "createdAt");
ALTER TABLE "StoreBusterAdLedgerEntry" ADD CONSTRAINT "StoreBusterAdLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoreBusterAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreBusterAdLedgerEntry" ADD CONSTRAINT "StoreBusterAdLedgerEntry_fundingIntentId_fkey" FOREIGN KEY ("fundingIntentId") REFERENCES "StoreBusterAdFundingIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreBusterAdLedgerEntry" ADD CONSTRAINT "StoreBusterAdLedgerEntry_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StoreBusterCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
