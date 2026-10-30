ALTER TABLE "Product" ADD COLUMN "wholesaleMaxQuantity" INTEGER;

-- Keep historical wholesale listings purchasable under the platform's existing
-- 99-unit cart ceiling while retaining their previously configured minimum.
UPDATE "Product"
SET "wholesaleMinQuantity" = COALESCE("wholesaleMinQuantity", 1),
    "wholesaleMaxQuantity" = 99
WHERE "wholesaleEnabled" = TRUE
  AND ("wholesaleMinQuantity" IS NULL OR "wholesaleMinQuantity" <= 99);
