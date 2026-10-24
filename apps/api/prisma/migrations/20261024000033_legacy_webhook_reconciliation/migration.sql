ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN "identityVerified" BOOLEAN NOT NULL DEFAULT TRUE;

-- Before payment reconciliation fields existed, the marketplace webhook
-- handlers persisted only provider + event ID. Exclude any event identity
-- referenced by wallet-funding audit history because this table is shared.
UPDATE "ProcessedWebhookEvent"
SET "identityVerified" = FALSE,
    "reviewReason" = COALESCE("reviewReason", 'LEGACY_EVENT_REQUIRES_RECONCILIATION')
WHERE "provider" IN ('STRIPE', 'PAYPAL')
  AND "eventType" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "AuditLog" AS audit
    WHERE position('WALLET_FUNDING_' in audit."action") = 1
      AND audit."metadata" ->> 'providerEventId' = "ProcessedWebhookEvent"."eventId"
  );
