ALTER TYPE "PaymentMethod" ADD VALUE 'PAYMONGO';
ALTER TYPE "PaymentMethod" ADD VALUE 'PAYSTACK';
ALTER TYPE "IntegrationProvider" ADD VALUE 'PAYMONGO';
ALTER TYPE "IntegrationProvider" ADD VALUE 'PAYSTACK';

ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN "normalizedAmountMinor" INTEGER,
  ADD COLUMN "normalizedCurrency" VARCHAR(3);
