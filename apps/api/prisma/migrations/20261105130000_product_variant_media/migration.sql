ALTER TABLE "ProductVariant" ADD COLUMN "mediaAssetId" TEXT;

CREATE INDEX "ProductVariant_mediaAssetId_idx" ON "ProductVariant"("mediaAssetId");

ALTER TABLE "ProductVariant"
ADD CONSTRAINT "ProductVariant_mediaAssetId_fkey"
FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "CartItem_cartId_productId_key";

CREATE UNIQUE INDEX "CartItem_cartId_productId_variantId_key"
ON "CartItem"("cartId", "productId", "variantId");

-- PostgreSQL unique indexes treat NULL values as distinct. Keep one base-product
-- line per cart while allowing a separate line for each non-null variant.
CREATE UNIQUE INDEX "CartItem_cartId_productId_null_variant_key"
ON "CartItem"("cartId", "productId")
WHERE "variantId" IS NULL;
