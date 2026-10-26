ALTER TABLE "StorePlanVersion"
  ADD COLUMN "sellerManagedPaymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sellerManagedCarrierAccountsEnabled" BOOLEAN NOT NULL DEFAULT false;
