CREATE TYPE "CatalogSuggestionKind" AS ENUM ('CATEGORY', 'CHILD_CATEGORY', 'FEATURE', 'BRAND');
CREATE TYPE "CatalogSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Product"
  ADD COLUMN "color" TEXT;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_color_length_check"
  CHECK ("color" IS NULL OR char_length("color") <= 80);

CREATE TABLE "CatalogFeature" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "categoryId" TEXT,
  "status" "TaxonomyStatus" NOT NULL DEFAULT 'ACTIVE',
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogFeature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogFeature_slug_key" ON "CatalogFeature"("slug");
CREATE INDEX "CatalogFeature_categoryId_status_displayOrder_idx" ON "CatalogFeature"("categoryId", "status", "displayOrder");
ALTER TABLE "CatalogFeature"
  ADD CONSTRAINT "CatalogFeature_name_length_check"
  CHECK (char_length("name") BETWEEN 2 AND 120);
ALTER TABLE "CatalogFeature"
  ADD CONSTRAINT "CatalogFeature_displayOrder_nonnegative_check"
  CHECK ("displayOrder" >= 0);

ALTER TABLE "CatalogFeature"
  ADD CONSTRAINT "CatalogFeature_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CatalogSuggestion" (
  "id" TEXT NOT NULL,
  "kind" "CatalogSuggestionKind" NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "parentCategoryId" TEXT,
  "categoryId" TEXT,
  "status" "CatalogSuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "submittedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "reviewNote" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogSuggestion_status_createdAt_idx" ON "CatalogSuggestion"("status", "createdAt");
CREATE INDEX "CatalogSuggestion_kind_normalizedName_idx" ON "CatalogSuggestion"("kind", "normalizedName");
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_name_length_check"
  CHECK (char_length("name") BETWEEN 2 AND 120);
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_kind_category_fields_check"
  CHECK (("kind" = 'CHILD_CATEGORY') = ("parentCategoryId" IS NOT NULL));
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_scope_category_check"
  CHECK ("kind" = 'FEATURE' OR "categoryId" IS NULL);
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_reviewNote_length_check"
  CHECK ("reviewNote" IS NULL OR char_length("reviewNote") <= 500);
CREATE UNIQUE INDEX "CatalogSuggestion_pending_dedup_key"
  ON "CatalogSuggestion"("kind", "normalizedName", COALESCE("parentCategoryId", ''), COALESCE("categoryId", ''))
  WHERE "status" = 'PENDING';

ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_parentCategoryId_fkey"
  FOREIGN KEY ("parentCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CatalogSuggestion"
  ADD CONSTRAINT "CatalogSuggestion_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProductFeatureAssignment" (
  "productId" TEXT NOT NULL,
  "featureId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductFeatureAssignment_pkey" PRIMARY KEY ("productId", "featureId")
);

CREATE INDEX "ProductFeatureAssignment_featureId_idx" ON "ProductFeatureAssignment"("featureId");

ALTER TABLE "ProductFeatureAssignment"
  ADD CONSTRAINT "ProductFeatureAssignment_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductFeatureAssignment"
  ADD CONSTRAINT "ProductFeatureAssignment_featureId_fkey"
  FOREIGN KEY ("featureId") REFERENCES "CatalogFeature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
