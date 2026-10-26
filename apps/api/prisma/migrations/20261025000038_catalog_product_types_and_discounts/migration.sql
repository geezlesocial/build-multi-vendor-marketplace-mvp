CREATE TYPE "ProductDiscountKind" AS ENUM ('PERCENTAGE', 'FIXED');
CREATE TYPE "ProductDiscountScope" AS ENUM ('ALL_PRODUCTS', 'SELECTED_PRODUCTS', 'SELECTED_CATEGORIES');

CREATE TABLE "CatalogProductType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "requiresShipping" BOOLEAN NOT NULL DEFAULT true,
    "status" "TaxonomyStatus" NOT NULL DEFAULT 'ACTIVE',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogProductType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CatalogProductType_name_key" ON "CatalogProductType"("name");
CREATE UNIQUE INDEX "CatalogProductType_slug_key" ON "CatalogProductType"("slug");
CREATE INDEX "CatalogProductType_status_displayOrder_idx" ON "CatalogProductType"("status", "displayOrder");

INSERT INTO "CatalogProductType" ("id", "name", "slug", "description", "requiresShipping", "status", "displayOrder", "updatedAt") VALUES
('ct_physical_default', 'Physical product', 'physical-product', 'A tangible item delivered to the buyer.', TRUE, 'ACTIVE', 0, CURRENT_TIMESTAMP),
('ct_digital_default', 'Digital product', 'digital-product', 'A non-physical product delivered digitally.', FALSE, 'ACTIVE', 10, CURRENT_TIMESTAMP),
('ct_downloadable_default', 'Downloadable files', 'downloadable-files', 'A digital product with files the buyer can download.', FALSE, 'ACTIVE', 20, CURRENT_TIMESTAMP),
('ct_service_default', 'Service', 'service', 'A service or appointment rather than a shipped item.', FALSE, 'ACTIVE', 30, CURRENT_TIMESTAMP);

ALTER TABLE "CatalogFeature" ADD COLUMN "productTypeId" TEXT;
CREATE INDEX "CatalogFeature_productTypeId_status_displayOrder_idx" ON "CatalogFeature"("productTypeId", "status", "displayOrder");
ALTER TABLE "CatalogFeature" ADD CONSTRAINT "CatalogFeature_productTypeId_fkey" FOREIGN KEY ("productTypeId") REFERENCES "CatalogProductType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Product" ADD COLUMN "productTypeId" TEXT;
UPDATE "Product" SET "productTypeId" = 'ct_physical_default' WHERE "productTypeId" IS NULL;
ALTER TABLE "Product" ALTER COLUMN "productTypeId" SET NOT NULL;
CREATE INDEX "Product_productTypeId_status_idx" ON "Product"("productTypeId", "status");
ALTER TABLE "Product" ADD CONSTRAINT "Product_productTypeId_fkey" FOREIGN KEY ("productTypeId") REFERENCES "CatalogProductType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SellerOrder" ADD COLUMN "discountCode" TEXT;
ALTER TABLE "SellerOrder" ADD COLUMN "discountMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "discountMinor" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "SellerProductDiscount" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "normalizedCode" VARCHAR(64) NOT NULL,
    "kind" "ProductDiscountKind" NOT NULL,
    "scope" "ProductDiscountScope" NOT NULL,
    "percentBasisPoints" INTEGER,
    "amountMinor" INTEGER,
    "currency" VARCHAR(3) NOT NULL,
    "minimumSubtotalMinor" INTEGER,
    "usageLimit" INTEGER,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SellerProductDiscount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SellerProductDiscount_value_check" CHECK (
      ("kind" = 'PERCENTAGE' AND "percentBasisPoints" BETWEEN 1 AND 10000 AND "amountMinor" IS NULL)
      OR ("kind" = 'FIXED' AND "amountMinor" > 0 AND "percentBasisPoints" IS NULL)
    ),
    CONSTRAINT "SellerProductDiscount_scope_check" CHECK (
      ("scope" = 'ALL_PRODUCTS')
      OR ("scope" = 'SELECTED_PRODUCTS')
      OR ("scope" = 'SELECTED_CATEGORIES')
    ),
    CONSTRAINT "SellerProductDiscount_window_check" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt"),
    CONSTRAINT "SellerProductDiscount_usage_check" CHECK ("usageLimit" IS NULL OR "usageLimit" > 0),
    CONSTRAINT "SellerProductDiscount_amount_check" CHECK ("minimumSubtotalMinor" IS NULL OR "minimumSubtotalMinor" >= 0)
);
CREATE UNIQUE INDEX "SellerProductDiscount_normalizedCode_key" ON "SellerProductDiscount"("normalizedCode");
CREATE INDEX "SellerProductDiscount_sellerId_enabled_startsAt_endsAt_idx" ON "SellerProductDiscount"("sellerId", "enabled", "startsAt", "endsAt");
ALTER TABLE "SellerProductDiscount" ADD CONSTRAINT "SellerProductDiscount_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SellerProductDiscountProduct" (
    "discountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    CONSTRAINT "SellerProductDiscountProduct_pkey" PRIMARY KEY ("discountId", "productId")
);
CREATE INDEX "SellerProductDiscountProduct_productId_idx" ON "SellerProductDiscountProduct"("productId");
ALTER TABLE "SellerProductDiscountProduct" ADD CONSTRAINT "SellerProductDiscountProduct_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "SellerProductDiscount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerProductDiscountProduct" ADD CONSTRAINT "SellerProductDiscountProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SellerProductDiscountCategory" (
    "discountId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    CONSTRAINT "SellerProductDiscountCategory_pkey" PRIMARY KEY ("discountId", "categoryId")
);
CREATE INDEX "SellerProductDiscountCategory_categoryId_idx" ON "SellerProductDiscountCategory"("categoryId");
ALTER TABLE "SellerProductDiscountCategory" ADD CONSTRAINT "SellerProductDiscountCategory_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "SellerProductDiscount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerProductDiscountCategory" ADD CONSTRAINT "SellerProductDiscountCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

