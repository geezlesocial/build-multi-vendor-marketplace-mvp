CREATE TYPE "SellerShippingDiscountType" AS ENUM ('FREE', 'FIXED', 'PERCENTAGE');

ALTER TABLE "MarketplaceSettings"
  ADD COLUMN "sellerShippingEnabled" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "SellerStaff"
  ADD COLUMN "canManageShipping" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "SellerOrder"
  ADD COLUMN "shippingSnapshotJson" JSONB;

CREATE TABLE "SellerShippingService" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "feeMinor" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "estimatedMinDays" INTEGER,
  "estimatedMaxDays" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerShippingService_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerShippingService_fee_nonnegative_check" CHECK ("feeMinor" >= 0),
  CONSTRAINT "SellerShippingService_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "SellerShippingService_estimates_check" CHECK (
    ("estimatedMinDays" IS NULL OR "estimatedMinDays" >= 0) AND
    ("estimatedMaxDays" IS NULL OR "estimatedMaxDays" >= 0) AND
    ("estimatedMinDays" IS NULL OR "estimatedMaxDays" IS NULL OR "estimatedMaxDays" >= "estimatedMinDays")
  )
);
CREATE INDEX "SellerShippingService_sellerId_enabled_idx" ON "SellerShippingService"("sellerId", "enabled");
ALTER TABLE "SellerShippingService" ADD CONSTRAINT "SellerShippingService_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SellerShippingZone" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "countryCode" VARCHAR(2) NOT NULL,
  "regionKey" VARCHAR(100) NOT NULL DEFAULT '',
  "regionLabel" VARCHAR(100),
  "cityKey" VARCHAR(100) NOT NULL DEFAULT '',
  "cityLabel" VARCHAR(100),
  CONSTRAINT "SellerShippingZone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerShippingZone_country_check" CHECK ("countryCode" ~ '^[A-Z]{2}$'),
  CONSTRAINT "SellerShippingZone_location_normalized_check" CHECK (
    "regionKey" = lower(btrim("regionKey")) AND "cityKey" = lower(btrim("cityKey")) AND
    ("cityKey" = '' OR "regionKey" <> '')
  ),
  CONSTRAINT "SellerShippingZone_unique_service_scope" UNIQUE ("serviceId", "countryCode", "regionKey", "cityKey")
);
CREATE INDEX "SellerShippingZone_countryCode_regionKey_cityKey_idx"
  ON "SellerShippingZone"("countryCode", "regionKey", "cityKey");
ALTER TABLE "SellerShippingZone" ADD CONSTRAINT "SellerShippingZone_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "SellerShippingService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SellerShippingDiscount" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "type" "SellerShippingDiscountType" NOT NULL,
  "amountMinor" INTEGER,
  "basisPoints" INTEGER,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "minimumQuantity" INTEGER,
  "minimumSubtotalMinor" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerShippingDiscount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerShippingDiscount_value_check" CHECK (
    ("type" = 'FREE' AND "amountMinor" IS NULL AND "basisPoints" IS NULL) OR
    ("type" = 'FIXED' AND "amountMinor" IS NOT NULL AND "amountMinor" >= 0 AND "basisPoints" IS NULL) OR
    ("type" = 'PERCENTAGE' AND "amountMinor" IS NULL AND "basisPoints" IS NOT NULL AND "basisPoints" BETWEEN 0 AND 10000)
  ),
  CONSTRAINT "SellerShippingDiscount_conditions_check" CHECK (
    ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt") AND
    ("minimumQuantity" IS NULL OR "minimumQuantity" > 0) AND
    ("minimumSubtotalMinor" IS NULL OR "minimumSubtotalMinor" >= 0)
  )
);
CREATE INDEX "SellerShippingDiscount_serviceId_enabled_priority_idx"
  ON "SellerShippingDiscount"("serviceId", "enabled", "priority");
ALTER TABLE "SellerShippingDiscount" ADD CONSTRAINT "SellerShippingDiscount_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "SellerShippingService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SellerShippingDiscountProduct" (
  "discountId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  CONSTRAINT "SellerShippingDiscountProduct_pkey" PRIMARY KEY ("discountId", "productId")
);
CREATE INDEX "SellerShippingDiscountProduct_productId_idx"
  ON "SellerShippingDiscountProduct"("productId");
ALTER TABLE "SellerShippingDiscountProduct" ADD CONSTRAINT "SellerShippingDiscountProduct_discountId_fkey"
  FOREIGN KEY ("discountId") REFERENCES "SellerShippingDiscount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerShippingDiscountProduct" ADD CONSTRAINT "SellerShippingDiscountProduct_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "protect_seller_order_shipping_snapshot"() RETURNS trigger AS $$
BEGIN
  IF NEW."shippingSnapshotJson" IS DISTINCT FROM OLD."shippingSnapshotJson" THEN
    RAISE EXCEPTION 'Seller order shipping snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SellerOrder_shipping_snapshot_immutable"
  BEFORE UPDATE ON "SellerOrder"
  FOR EACH ROW EXECUTE FUNCTION "protect_seller_order_shipping_snapshot"();
