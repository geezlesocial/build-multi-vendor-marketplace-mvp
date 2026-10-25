-- Add nullable idempotency and checkout-session references. Existing rows are
-- preserved; PostgreSQL unique indexes permit multiple NULL values.
ALTER TABLE "StoreSubscription"
  ADD COLUMN "providerCheckoutSessionId" TEXT,
  ADD COLUMN "requestKeyHash" TEXT;

CREATE UNIQUE INDEX "StoreSubscription_provider_providerCheckoutSessionId_key"
  ON "StoreSubscription"("provider", "providerCheckoutSessionId");

CREATE UNIQUE INDEX "StoreSubscription_storeId_requestKeyHash_key"
  ON "StoreSubscription"("storeId", "requestKeyHash");
