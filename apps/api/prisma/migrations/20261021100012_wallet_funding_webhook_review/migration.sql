ALTER TABLE "ProcessedWebhookEvent" ADD COLUMN "eventType" TEXT;
ALTER TABLE "ProcessedWebhookEvent" ADD COLUMN "reviewReason" TEXT;
CREATE INDEX "ProcessedWebhookEvent_provider_reviewReason_idx" ON "ProcessedWebhookEvent"("provider", "reviewReason");
