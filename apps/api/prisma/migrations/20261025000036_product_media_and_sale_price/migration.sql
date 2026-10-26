ALTER TABLE "Product"
  ADD COLUMN "salePriceMinor" INTEGER;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_salePriceMinor_valid_check"
  CHECK ("salePriceMinor" IS NULL OR ("salePriceMinor" > 0 AND "salePriceMinor" < "priceMinor"));

CREATE TABLE "ProductMedia" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "label" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductMedia_productId_mediaAssetId_key"
  ON "ProductMedia"("productId", "mediaAssetId");
CREATE INDEX "ProductMedia_productId_position_idx"
  ON "ProductMedia"("productId", "position");
CREATE INDEX "ProductMedia_mediaAssetId_idx"
  ON "ProductMedia"("mediaAssetId");

ALTER TABLE "ProductMedia"
  ADD CONSTRAINT "ProductMedia_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMedia"
  ADD CONSTRAINT "ProductMedia_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
