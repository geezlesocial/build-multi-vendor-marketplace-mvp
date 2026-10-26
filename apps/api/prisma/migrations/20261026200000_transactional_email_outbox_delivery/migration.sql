-- Durable transactional email processing. Existing queued rows remain pending.
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE 'SENDING';

ALTER TABLE "EmailOutbox"
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "EmailOutbox_status_claimedAt_idx"
  ON "EmailOutbox"("status", "claimedAt");
