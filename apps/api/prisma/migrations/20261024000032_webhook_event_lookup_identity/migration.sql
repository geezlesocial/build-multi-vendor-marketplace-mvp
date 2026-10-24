-- Persist the complete normalized identity needed to safely retry a webhook
-- that was first received before its local Payment reference existed.
-- Historical rows remain NULL where the original lookup/capture assertion was
-- not recorded; new deliveries persist both values transactionally.
ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN "paymentLookupRef" TEXT,
  ADD COLUMN "captureConfirmed" BOOLEAN;
