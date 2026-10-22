CREATE TYPE "StorePlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE "StorePlanVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');
CREATE TYPE "StorePlanAssignmentStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "StorePlanAssignmentSource" AS ENUM ('ADMIN', 'LEGACY_BOOTSTRAP');
CREATE TYPE "StoreThemePreset" AS ENUM ('CLASSIC', 'EDITORIAL', 'BOUTIQUE');
CREATE TYPE "StorePaymentConnector" AS ENUM ('STRIPE', 'PAYPAL');
CREATE TYPE "MobileStorefrontTemplate" AS ENUM ('RESPONSIVE_STANDARD', 'MOBILE_COMPACT', 'MOBILE_EDITORIAL');

CREATE TABLE "StorePlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StorePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StorePlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorePlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "StorePlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "productLimit" INTEGER NOT NULL,
    "storeLimit" INTEGER NOT NULL,
    "vendorLimit" INTEGER NOT NULL,
    "staffSeatLimit" INTEGER NOT NULL,
    "allowedThemes" "StoreThemePreset"[] NOT NULL DEFAULT ARRAY['CLASSIC', 'EDITORIAL', 'BOUTIQUE']::"StoreThemePreset"[],
    "customDomainEligible" BOOLEAN NOT NULL DEFAULT false,
    "paymentConnectors" "StorePaymentConnector"[] NOT NULL DEFAULT ARRAY[]::"StorePaymentConnector"[],
    "mobileTemplates" "MobileStorefrontTemplate"[] NOT NULL DEFAULT ARRAY['RESPONSIVE_STANDARD']::"MobileStorefrontTemplate"[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    CONSTRAINT "StorePlanVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorePlanVersion_version_check" CHECK ("version" > 0),
    CONSTRAINT "StorePlanVersion_productLimit_check" CHECK ("productLimit" > 0),
    CONSTRAINT "StorePlanVersion_storeLimit_check" CHECK ("storeLimit" > 0),
    CONSTRAINT "StorePlanVersion_vendorLimit_check" CHECK ("vendorLimit" > 0),
    CONSTRAINT "StorePlanVersion_staffSeatLimit_check" CHECK ("staffSeatLimit" >= 0),
    CONSTRAINT "StorePlanVersion_allowedThemes_check" CHECK (cardinality("allowedThemes") > 0),
    CONSTRAINT "StorePlanVersion_mobileTemplates_check" CHECK (cardinality("mobileTemplates") > 0)
);

CREATE TABLE "StorePlanAssignment" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "status" "StorePlanAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "StorePlanAssignmentSource" NOT NULL DEFAULT 'ADMIN',
    "assignedById" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StorePlanAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorePlanAssignment_effective_range_check" CHECK ("effectiveUntil" IS NULL OR "effectiveUntil" > "effectiveFrom")
);

CREATE UNIQUE INDEX "StorePlan_key_key" ON "StorePlan"("key");
CREATE UNIQUE INDEX "StorePlanVersion_planId_version_key" ON "StorePlanVersion"("planId", "version");
CREATE UNIQUE INDEX "StorePlanVersion_one_active_per_plan_key" ON "StorePlanVersion"("planId") WHERE "status" = 'ACTIVE';
CREATE INDEX "StorePlanVersion_planId_status_version_idx" ON "StorePlanVersion"("planId", "status", "version");
CREATE UNIQUE INDEX "StorePlanAssignment_one_active_per_store_key" ON "StorePlanAssignment"("storeId") WHERE "status" = 'ACTIVE';
CREATE INDEX "StorePlanAssignment_storeId_status_effectiveFrom_idx" ON "StorePlanAssignment"("storeId", "status", "effectiveFrom");
CREATE INDEX "StorePlanAssignment_planVersionId_status_idx" ON "StorePlanAssignment"("planVersionId", "status");

ALTER TABLE "StorePlanVersion" ADD CONSTRAINT "StorePlanVersion_planId_fkey"
FOREIGN KEY ("planId") REFERENCES "StorePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StorePlanVersion" ADD CONSTRAINT "StorePlanVersion_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StorePlanAssignment" ADD CONSTRAINT "StorePlanAssignment_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StorePlanAssignment" ADD CONSTRAINT "StorePlanAssignment_planVersionId_fkey"
FOREIGN KEY ("planVersionId") REFERENCES "StorePlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StorePlanAssignment" ADD CONSTRAINT "StorePlanAssignment_assignedById_fkey"
FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A deliberately generous compatibility version keeps existing Stores usable.
-- Connector entries describe eligibility only; this does not create seller payment integrations.
INSERT INTO "StorePlan" ("id", "key", "name", "status", "updatedAt")
VALUES ('legacy-compatible-store-plan', 'legacy-compatible', 'Legacy compatible', 'ACTIVE', CURRENT_TIMESTAMP);

INSERT INTO "StorePlanVersion" (
    "id", "planId", "version", "status", "productLimit", "storeLimit", "vendorLimit", "staffSeatLimit",
    "allowedThemes", "customDomainEligible", "paymentConnectors", "mobileTemplates", "createdAt", "activatedAt"
)
VALUES (
    'legacy-compatible-store-plan-v1', 'legacy-compatible-store-plan', 1, 'ACTIVE', 2147483647, 1, 1, 2147483647,
    ARRAY['CLASSIC', 'EDITORIAL', 'BOUTIQUE']::"StoreThemePreset"[], false,
    ARRAY['STRIPE', 'PAYPAL']::"StorePaymentConnector"[],
    ARRAY['RESPONSIVE_STANDARD', 'MOBILE_COMPACT', 'MOBILE_EDITORIAL']::"MobileStorefrontTemplate"[],
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "StorePlanAssignment" (
    "id", "storeId", "planVersionId", "status", "source", "effectiveFrom", "reason"
)
SELECT
    'legacy-plan-assignment-' || "id", "id", 'legacy-compatible-store-plan-v1', 'ACTIVE', 'LEGACY_BOOTSTRAP',
    CURRENT_TIMESTAMP, 'Compatibility assignment created by store-plan migration'
FROM "Store";

-- SellerStaff is the existing staff-seat relation. Serialize writes with plan assignment
-- changes by taking the Store lock used by both operations, then enforce the versioned cap.
CREATE FUNCTION enforce_store_staff_seat_limit() RETURNS trigger AS $$
DECLARE
    store_row_id TEXT;
    seat_limit INTEGER;
    seats_in_use INTEGER;
BEGIN
    SELECT "id" INTO store_row_id
    FROM "Store"
    WHERE "sellerId" = NEW."sellerId"
    FOR UPDATE;

    IF store_row_id IS NULL THEN
        RAISE EXCEPTION 'A seller must have a Store before staff can be assigned' USING ERRCODE = '23514';
    END IF;

    SELECT version."staffSeatLimit" INTO seat_limit
    FROM "StorePlanAssignment" assignment
    JOIN "StorePlanVersion" version ON version."id" = assignment."planVersionId"
    WHERE assignment."storeId" = store_row_id
      AND assignment."status" = 'ACTIVE'
      AND assignment."effectiveFrom" <= CURRENT_TIMESTAMP
      AND (assignment."effectiveUntil" IS NULL OR assignment."effectiveUntil" > CURRENT_TIMESTAMP)
    ORDER BY assignment."effectiveFrom" DESC
    LIMIT 1;

    IF seat_limit IS NULL THEN
        SELECT "staffSeatLimit" INTO seat_limit
        FROM "StorePlanVersion"
        WHERE "id" = 'legacy-compatible-store-plan-v1';
    END IF;
    seat_limit := COALESCE(seat_limit, 2147483647);

    IF TG_OP = 'INSERT' THEN
        SELECT COUNT(*) INTO seats_in_use FROM "SellerStaff" WHERE "sellerId" = NEW."sellerId";
    ELSE
        SELECT COUNT(*) INTO seats_in_use FROM "SellerStaff" WHERE "sellerId" = NEW."sellerId" AND "id" <> OLD."id";
    END IF;

    IF seats_in_use >= seat_limit THEN
        RAISE EXCEPTION 'Store plan staff seat limit reached' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SellerStaff_plan_seat_limit"
BEFORE INSERT OR UPDATE OF "sellerId" ON "SellerStaff"
FOR EACH ROW EXECUTE FUNCTION enforce_store_staff_seat_limit();
