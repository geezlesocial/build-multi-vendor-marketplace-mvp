ALTER TABLE "StorePlanVersion"
  ADD COLUMN "dropshippingEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "StoreDropshippingConnection" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "encryptedCredentials" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CONNECTED',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreDropshippingConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreDropshippingConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SupplierProductImport" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalProductId" TEXT NOT NULL,
  "externalSku" TEXT,
  "supplierCostUsdMinor" INTEGER,
  "sourceUrl" TEXT,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierProductImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierProductImport_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupplierProductImport_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StoreDropshippingConnection_storeId_provider_key" ON "StoreDropshippingConnection"("storeId", "provider");
CREATE INDEX "StoreDropshippingConnection_provider_status_idx" ON "StoreDropshippingConnection"("provider", "status");
CREATE UNIQUE INDEX "SupplierProductImport_productId_key" ON "SupplierProductImport"("productId");
CREATE UNIQUE INDEX "SupplierProductImport_storeId_provider_externalProductId_key" ON "SupplierProductImport"("storeId", "provider", "externalProductId");
CREATE INDEX "SupplierProductImport_storeId_importedAt_idx" ON "SupplierProductImport"("storeId", "importedAt");
