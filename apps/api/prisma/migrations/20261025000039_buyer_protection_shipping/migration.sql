CREATE TYPE "ShipmentStatus" AS ENUM (
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION'
);

ALTER TABLE "SellerOrder"
  ADD COLUMN "shipmentStatus" "ShipmentStatus",
  ADD COLUMN "shippingCarrier" VARCHAR(120),
  ADD COLUMN "trackingNumber" VARCHAR(160),
  ADD COLUMN "trackingUrl" VARCHAR(2000),
  ADD COLUMN "shippedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "receivedAt" TIMESTAMP(3),
  ADD COLUMN "receiptConfirmedById" TEXT;

CREATE INDEX "SellerOrder_shipmentStatus_shippedAt_idx"
  ON "SellerOrder"("shipmentStatus", "shippedAt");
CREATE INDEX "SellerOrder_receivedAt_idx" ON "SellerOrder"("receivedAt");
ALTER TABLE "SellerOrder"
  ADD CONSTRAINT "SellerOrder_receiptConfirmedById_fkey"
  FOREIGN KEY ("receiptConfirmedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ShipmentUpdate" (
  "id" TEXT NOT NULL,
  "sellerOrderId" TEXT NOT NULL,
  "status" "ShipmentStatus" NOT NULL,
  "carrier" VARCHAR(120),
  "trackingNumber" VARCHAR(160),
  "trackingUrl" VARCHAR(2000),
  "note" VARCHAR(500),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShipmentUpdate_sellerOrderId_createdAt_idx"
  ON "ShipmentUpdate"("sellerOrderId", "createdAt");
ALTER TABLE "ShipmentUpdate"
  ADD CONSTRAINT "ShipmentUpdate_sellerOrderId_fkey"
  FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentUpdate"
  ADD CONSTRAINT "ShipmentUpdate_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
