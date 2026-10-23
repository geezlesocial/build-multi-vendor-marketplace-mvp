-- Consent/suppression records only. Delivery remains unavailable until an
-- owner-configured provider and its suppression/bounce webhooks are verified.
CREATE TYPE "StoreEmailSubscriberStatus" AS ENUM ('PENDING_CONFIRMATION', 'SUBSCRIBED', 'UNSUBSCRIBED', 'SUPPRESSED', 'BOUNCED');
CREATE TYPE "StoreEmailCampaignStatus" AS ENUM ('DRAFT', 'QUEUED', 'SENT', 'CANCELLED');

CREATE TABLE "StoreAffiliateProgram" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreAffiliateProgram_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoreAffiliateProgram_storeId_key" ON "StoreAffiliateProgram"("storeId");
ALTER TABLE "StoreAffiliateProgram" ADD CONSTRAINT "StoreAffiliateProgram_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreEmailSubscriber" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "StoreEmailSubscriberStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "consentRecordedAt" TIMESTAMP(3),
    "consentSource" TEXT,
    "confirmationTokenHash" TEXT,
    "unsubscribeTokenHash" TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3),
    "suppressionReason" TEXT,
    "bouncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreEmailSubscriber_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreEmailSubscriber_email_check" CHECK ("email" = lower(btrim("email")) AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
    CONSTRAINT "StoreEmailSubscriber_consent_check" CHECK ("status" <> 'SUBSCRIBED' OR "consentRecordedAt" IS NOT NULL),
    CONSTRAINT "StoreEmailSubscriber_suppression_check" CHECK ("status" <> 'SUPPRESSED' OR "suppressedAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "StoreEmailSubscriber_storeId_email_key" ON "StoreEmailSubscriber"("storeId", "email");
CREATE UNIQUE INDEX "StoreEmailSubscriber_confirmationTokenHash_key" ON "StoreEmailSubscriber"("confirmationTokenHash");
CREATE UNIQUE INDEX "StoreEmailSubscriber_unsubscribeTokenHash_key" ON "StoreEmailSubscriber"("unsubscribeTokenHash");
CREATE INDEX "StoreEmailSubscriber_storeId_status_createdAt_idx" ON "StoreEmailSubscriber"("storeId", "status", "createdAt");
ALTER TABLE "StoreEmailSubscriber" ADD CONSTRAINT "StoreEmailSubscriber_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreEmailCampaign" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "contentJson" JSONB NOT NULL,
    "status" "StoreEmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreEmailCampaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreEmailCampaign_text_check" CHECK (length(btrim("name")) BETWEEN 2 AND 100 AND length(btrim("subject")) BETWEEN 2 AND 160)
);
CREATE INDEX "StoreEmailCampaign_storeId_status_updatedAt_idx" ON "StoreEmailCampaign"("storeId", "status", "updatedAt");
ALTER TABLE "StoreEmailCampaign" ADD CONSTRAINT "StoreEmailCampaign_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_store_email_send_without_consent() RETURNS trigger AS $$
BEGIN
    IF NEW."status" IN ('QUEUED', 'SENT') THEN
        RAISE EXCEPTION 'Store email delivery is disabled until an approved delivery service is configured';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "StoreEmailCampaign_delivery_gate" BEFORE INSERT OR UPDATE OF "status" ON "StoreEmailCampaign"
FOR EACH ROW EXECUTE FUNCTION prevent_store_email_send_without_consent();
