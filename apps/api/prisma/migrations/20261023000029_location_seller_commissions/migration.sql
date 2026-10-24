ALTER TYPE "PaymentStatus" ADD VALUE 'DISPUTED';

ALTER TABLE "SavedAddress"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD CONSTRAINT "SavedAddress_coordinates_pair_check"
    CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  ADD CONSTRAINT "SavedAddress_latitude_range_check"
    CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "SavedAddress_longitude_range_check"
    CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);

ALTER TABLE "SellerStaff" ADD COLUMN "canManageCurrency" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN "parentOrderId" TEXT,
  ADD COLUMN "amountMinor" INTEGER,
  ADD COLUMN "currency" VARCHAR(3);
CREATE INDEX "ProcessedWebhookEvent_parentOrderId_provider_receivedAt_idx"
  ON "ProcessedWebhookEvent"("parentOrderId", "provider", "receivedAt");
ALTER TABLE "ProcessedWebhookEvent" ADD CONSTRAINT "ProcessedWebhookEvent_parentOrderId_fkey"
  FOREIGN KEY ("parentOrderId") REFERENCES "ParentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem"
  ADD COLUMN "currencySnapshot" VARCHAR(3),
  ADD COLUMN "displayAmountMinor" INTEGER,
  ADD COLUMN "displayCurrency" VARCHAR(3),
  ADD COLUMN "fxSnapshotJson" JSONB;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_currencySnapshot_fkey"
  FOREIGN KEY ("currencySnapshot") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_displayCurrency_fkey"
  FOREIGN KEY ("displayCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "SellerCommissionPolicyType" AS ENUM ('ZERO', 'FIXED_PER_ORDER', 'PERCENTAGE', 'PERCENTAGE_PLUS_FIXED');
CREATE TYPE "SellerCommissionPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED');
CREATE TYPE "SellerCommissionEntryType" AS ENUM ('ACCRUAL', 'REVERSAL', 'ADJUSTMENT');
CREATE TYPE "SellerCommissionReviewStatus" AS ENUM ('NEEDS_ALLOCATION', 'POSTED', 'IGNORED');

ALTER TABLE "SellerOrder"
  ADD COLUMN "commissionSnapshotJson" JSONB,
  ADD COLUMN "commissionPolicyVersionId" TEXT;

CREATE TABLE "SellerCommissionPolicyVersion" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "SellerCommissionPolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "storeId" TEXT,
  "planVersionId" TEXT,
  "type" "SellerCommissionPolicyType" NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "fixedMinor" INTEGER,
  "basisPoints" INTEGER,
  "minimumMinor" INTEGER,
  "capMinor" INTEGER,
  "effectiveFrom" TIMESTAMP(3),
  "effectiveUntil" TIMESTAMP(3),
  "reason" VARCHAR(500) NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  CONSTRAINT "SellerCommissionPolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerCommissionPolicyVersion_one_scope_check" CHECK (("storeId" IS NOT NULL) <> ("planVersionId" IS NOT NULL)),
  CONSTRAINT "SellerCommissionPolicyVersion_version_check" CHECK ("version" > 0),
  CONSTRAINT "SellerCommissionPolicyVersion_fixed_check" CHECK ("fixedMinor" IS NULL OR "fixedMinor" >= 0),
  CONSTRAINT "SellerCommissionPolicyVersion_basis_points_check" CHECK ("basisPoints" IS NULL OR "basisPoints" BETWEEN 0 AND 10000),
  CONSTRAINT "SellerCommissionPolicyVersion_minimum_check" CHECK ("minimumMinor" IS NULL OR "minimumMinor" >= 0),
  CONSTRAINT "SellerCommissionPolicyVersion_cap_check" CHECK ("capMinor" IS NULL OR "capMinor" >= 0),
  CONSTRAINT "SellerCommissionPolicyVersion_min_cap_check" CHECK ("minimumMinor" IS NULL OR "capMinor" IS NULL OR "minimumMinor" <= "capMinor"),
  CONSTRAINT "SellerCommissionPolicyVersion_effective_check" CHECK ("effectiveUntil" IS NULL OR ("effectiveFrom" IS NOT NULL AND "effectiveUntil" > "effectiveFrom")),
  CONSTRAINT "SellerCommissionPolicyVersion_terms_check" CHECK (
    ("type" = 'ZERO' AND "fixedMinor" IS NULL AND "basisPoints" IS NULL) OR
    ("type" = 'FIXED_PER_ORDER' AND "fixedMinor" IS NOT NULL AND "basisPoints" IS NULL) OR
    ("type" = 'PERCENTAGE' AND "fixedMinor" IS NULL AND "basisPoints" IS NOT NULL) OR
    ("type" = 'PERCENTAGE_PLUS_FIXED' AND "fixedMinor" IS NOT NULL AND "basisPoints" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "SellerCommissionPolicyVersion_storeId_version_key"
  ON "SellerCommissionPolicyVersion"("storeId", "version");
CREATE UNIQUE INDEX "SellerCommissionPolicyVersion_planVersionId_version_key"
  ON "SellerCommissionPolicyVersion"("planVersionId", "version");
CREATE UNIQUE INDEX "SellerCommissionPolicyVersion_store_active_key"
  ON "SellerCommissionPolicyVersion"("storeId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "SellerCommissionPolicyVersion_plan_active_key"
  ON "SellerCommissionPolicyVersion"("planVersionId") WHERE "status" = 'ACTIVE';
CREATE INDEX "SellerCommissionPolicyVersion_storeId_status_effectiveFrom_idx"
  ON "SellerCommissionPolicyVersion"("storeId", "status", "effectiveFrom");
CREATE INDEX "SellerCommissionPolicyVersion_planVersionId_status_effectiveFrom_idx"
  ON "SellerCommissionPolicyVersion"("planVersionId", "status", "effectiveFrom");
ALTER TABLE "SellerCommissionPolicyVersion" ADD CONSTRAINT "SellerCommissionPolicyVersion_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionPolicyVersion" ADD CONSTRAINT "SellerCommissionPolicyVersion_planVersionId_fkey"
  FOREIGN KEY ("planVersionId") REFERENCES "StorePlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionPolicyVersion" ADD CONSTRAINT "SellerCommissionPolicyVersion_currency_fkey"
  FOREIGN KEY ("currency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionPolicyVersion" ADD CONSTRAINT "SellerCommissionPolicyVersion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerOrder" ADD CONSTRAINT "SellerOrder_commissionPolicyVersionId_fkey"
  FOREIGN KEY ("commissionPolicyVersionId") REFERENCES "SellerCommissionPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION seller_commission_policy_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUPERSEDED', 'RETIRED')
       AND (to_jsonb(NEW) - 'status' - 'effectiveUntil') = (to_jsonb(OLD) - 'status' - 'effectiveUntil')
       AND (OLD."effectiveUntil" IS NULL OR NEW."effectiveUntil" >= OLD."effectiveUntil") THEN
      RETURN NEW;
    END IF;
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'Activated seller commission policy terms are immutable; create a new version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SellerCommissionPolicyVersion_lifecycle_guard"
  BEFORE UPDATE ON "SellerCommissionPolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION seller_commission_policy_lifecycle_guard();

CREATE TABLE "SellerCommissionLedgerEntry" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "sellerOrderId" TEXT NOT NULL,
  "orderItemId" TEXT,
  "policyVersionId" TEXT,
  "entryType" "SellerCommissionEntryType" NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "eligibleBaseMinor" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "sourceEventId" TEXT,
  "reversalOfId" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerCommissionLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerCommissionLedgerEntry_idempotencyKey_key" UNIQUE ("idempotencyKey"),
  CONSTRAINT "SellerCommissionLedgerEntry_amount_sign_check" CHECK (
    ("entryType" = 'ACCRUAL' AND "amountMinor" > 0 AND "reversalOfId" IS NULL) OR
    ("entryType" = 'REVERSAL' AND "amountMinor" <= 0 AND "reversalOfId" IS NOT NULL AND "eligibleBaseMinor" > 0) OR
    ("entryType" = 'ADJUSTMENT' AND "amountMinor" <> 0)
  ),
  CONSTRAINT "SellerCommissionLedgerEntry_base_check" CHECK ("eligibleBaseMinor" >= 0)
);
ALTER TABLE "SellerCommissionLedgerEntry"
  ADD COLUMN "reportingAmountMinor" INTEGER,
  ADD COLUMN "reportingCurrency" VARCHAR(3),
  ADD COLUMN "reportingSnapshotJson" JSONB;
CREATE INDEX "SellerCommissionLedgerEntry_sellerId_currency_createdAt_idx"
  ON "SellerCommissionLedgerEntry"("sellerId", "currency", "createdAt");
CREATE INDEX "SellerCommissionLedgerEntry_sellerOrderId_createdAt_idx"
  ON "SellerCommissionLedgerEntry"("sellerOrderId", "createdAt");
CREATE INDEX "SellerCommissionLedgerEntry_orderItemId_idx" ON "SellerCommissionLedgerEntry"("orderItemId");
CREATE INDEX "SellerCommissionLedgerEntry_sourceEventId_idx" ON "SellerCommissionLedgerEntry"("sourceEventId");
CREATE INDEX "SellerCommissionLedgerEntry_reversalOfId_idx" ON "SellerCommissionLedgerEntry"("reversalOfId");
ALTER TABLE "SellerCommissionLedgerEntry" ADD CONSTRAINT "SellerCommissionLedgerEntry_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionLedgerEntry" ADD CONSTRAINT "SellerCommissionLedgerEntry_sellerOrderId_fkey"
  FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionLedgerEntry" ADD CONSTRAINT "SellerCommissionLedgerEntry_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionLedgerEntry" ADD CONSTRAINT "SellerCommissionLedgerEntry_policyVersionId_fkey"
  FOREIGN KEY ("policyVersionId") REFERENCES "SellerCommissionPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionLedgerEntry" ADD CONSTRAINT "SellerCommissionLedgerEntry_reportingCurrency_fkey"
  FOREIGN KEY ("reportingCurrency") REFERENCES "CurrencyCatalogEntry"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionLedgerEntry" ADD CONSTRAINT "SellerCommissionLedgerEntry_reversalOfId_fkey"
  FOREIGN KEY ("reversalOfId") REFERENCES "SellerCommissionLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION seller_commission_ledger_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_entry "SellerCommissionLedgerEntry"%ROWTYPE;
  order_seller_id TEXT;
  item_seller_order_id TEXT;
  already_reversed BIGINT;
  already_reversed_base BIGINT;
BEGIN
  SELECT "sellerId" INTO order_seller_id FROM "SellerOrder" WHERE "id" = NEW."sellerOrderId" FOR UPDATE;
  IF order_seller_id IS NULL OR order_seller_id <> NEW."sellerId" THEN
    RAISE EXCEPTION 'Commission seller must own the seller order' USING ERRCODE = '23514';
  END IF;
  IF NEW."orderItemId" IS NOT NULL THEN
    SELECT "sellerOrderId" INTO item_seller_order_id FROM "OrderItem" WHERE "id" = NEW."orderItemId";
    IF item_seller_order_id IS DISTINCT FROM NEW."sellerOrderId" THEN
      RAISE EXCEPTION 'Commission item must belong to its seller order' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT * INTO source_entry FROM "SellerCommissionLedgerEntry" WHERE "id" = NEW."reversalOfId" FOR UPDATE;
    IF source_entry."entryType" <> 'ACCRUAL'
       OR source_entry."sellerId" <> NEW."sellerId"
       OR source_entry."sellerOrderId" <> NEW."sellerOrderId"
       OR source_entry."currency" <> NEW."currency"
       OR source_entry."orderItemId" IS DISTINCT FROM NEW."orderItemId" THEN
      RAISE EXCEPTION 'Commission reversal must match its source accrual' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(-SUM("amountMinor"), 0) INTO already_reversed
      FROM "SellerCommissionLedgerEntry" WHERE "reversalOfId" = source_entry."id";
    SELECT COALESCE(SUM("eligibleBaseMinor"), 0) INTO already_reversed_base
      FROM "SellerCommissionLedgerEntry" WHERE "reversalOfId" = source_entry."id";
    IF already_reversed + -NEW."amountMinor" > source_entry."amountMinor" THEN
      RAISE EXCEPTION 'Commission reversal exceeds remaining accrual' USING ERRCODE = '23514';
    END IF;
    IF already_reversed_base + NEW."eligibleBaseMinor" > source_entry."eligibleBaseMinor" THEN
      RAISE EXCEPTION 'Commission reversal base exceeds remaining eligible item amount' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SellerCommissionLedgerEntry_insert_guard"
  BEFORE INSERT ON "SellerCommissionLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION seller_commission_ledger_insert_guard();

CREATE FUNCTION seller_commission_ledger_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Seller commission ledger entries are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "SellerCommissionLedgerEntry_immutable_guard"
  BEFORE UPDATE OR DELETE ON "SellerCommissionLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION seller_commission_ledger_immutable_guard();

CREATE TABLE "SellerCommissionReviewEvent" (
  "id" TEXT NOT NULL,
  "parentOrderId" TEXT NOT NULL,
  "provider" VARCHAR(30),
  "providerEventId" VARCHAR(200),
  "status" "SellerCommissionReviewStatus" NOT NULL DEFAULT 'NEEDS_ALLOCATION',
  "amountMinor" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "allocationJson" JSONB,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerCommissionReviewEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerCommissionReviewEvent_idempotencyKey_key" UNIQUE ("idempotencyKey"),
  CONSTRAINT "SellerCommissionReviewEvent_provider_providerEventId_key" UNIQUE ("provider", "providerEventId"),
  CONSTRAINT "SellerCommissionReviewEvent_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "SellerCommissionReviewEvent_reviewed_check" CHECK (("status" = 'NEEDS_ALLOCATION' AND "reviewedAt" IS NULL) OR ("status" <> 'NEEDS_ALLOCATION' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL))
);
CREATE INDEX "SellerCommissionReviewEvent_status_createdAt_idx" ON "SellerCommissionReviewEvent"("status", "createdAt");
CREATE INDEX "SellerCommissionReviewEvent_parentOrderId_createdAt_idx" ON "SellerCommissionReviewEvent"("parentOrderId", "createdAt");
ALTER TABLE "SellerCommissionReviewEvent" ADD CONSTRAINT "SellerCommissionReviewEvent_parentOrderId_fkey"
  FOREIGN KEY ("parentOrderId") REFERENCES "ParentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerCommissionReviewEvent" ADD CONSTRAINT "SellerCommissionReviewEvent_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION seller_order_commission_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."commissionSnapshotJson" IS NOT NULL AND (
       NEW."commissionSnapshotJson" IS DISTINCT FROM OLD."commissionSnapshotJson"
       OR NEW."commissionPolicyVersionId" IS DISTINCT FROM OLD."commissionPolicyVersionId") THEN
    RAISE EXCEPTION 'Seller order commission snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SellerOrder_commission_snapshot_immutable"
  BEFORE UPDATE ON "SellerOrder"
  FOR EACH ROW EXECUTE FUNCTION seller_order_commission_snapshot_guard();
