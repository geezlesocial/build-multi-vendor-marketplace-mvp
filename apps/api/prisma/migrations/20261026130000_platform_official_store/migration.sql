ALTER TABLE "Store"
  ADD COLUMN "isPlatformStore" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX "Store_single_platform_store_key"
  ON "Store" ("isPlatformStore")
  WHERE "isPlatformStore" = TRUE;
