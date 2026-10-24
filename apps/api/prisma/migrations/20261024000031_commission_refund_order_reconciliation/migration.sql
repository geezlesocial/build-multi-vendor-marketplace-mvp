ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN "providerOccurredAt" TIMESTAMP(3),
  ADD COLUMN "providerObjectRef" TEXT,
  ADD COLUMN "metadataOrderId" TEXT,
  ADD COLUMN "providerTotalMinor" INTEGER;

-- Preserve existing verified source-event usability. The old handler only
-- stored a clean parent binding after matching a local Payment; its current
-- providerRef is therefore the strongest available provider-object reference.
UPDATE "ProcessedWebhookEvent" AS event
SET "providerObjectRef" = payment."providerRef",
    "providerTotalMinor" = CASE
      WHEN event."provider" = 'STRIPE' AND event."eventType" = 'charge.refunded' THEN parent."totalMinor"
      ELSE NULL
    END
FROM "ParentOrder" AS parent
JOIN "Payment" AS payment ON payment."parentId" = parent."id"
WHERE event."parentOrderId" = parent."id"
  AND payment."method" = event."provider"
  AND event."reviewReason" IS NULL;

CREATE INDEX "ProcessedWebhookEvent_provider_providerObjectRef_reviewReason_idx"
  ON "ProcessedWebhookEvent"("provider", "providerObjectRef", "reviewReason");

ALTER TABLE "SellerCommissionReviewEvent"
  ADD COLUMN "resolutionReason" VARCHAR(500);

ALTER TABLE "SellerCommissionReviewEvent"
  DROP CONSTRAINT "SellerCommissionReviewEvent_reviewed_check",
  ADD CONSTRAINT "SellerCommissionReviewEvent_reviewed_check" CHECK (
    ("status" = 'NEEDS_ALLOCATION' AND "reviewedAt" IS NULL AND "resolutionReason" IS NULL) OR
    ("status" = 'POSTED' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "resolutionReason" IS NULL) OR
    ("status" = 'IGNORED' AND "reviewedAt" IS NOT NULL AND (
      ("reviewedById" IS NOT NULL AND "resolutionReason" IS NULL) OR
      ("reviewedById" IS NULL AND "resolutionReason" IS NOT NULL)
    ))
  );
