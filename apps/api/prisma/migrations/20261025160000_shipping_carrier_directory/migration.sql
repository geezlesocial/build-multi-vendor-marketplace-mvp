CREATE TABLE "ShippingCarrierProvider" (
  "id" TEXT NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "countries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "trackingUrlTemplate" VARCHAR(500),
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShippingCarrierProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShippingCarrierProvider_code_key" ON "ShippingCarrierProvider"("code");
CREATE INDEX "ShippingCarrierProvider_enabled_name_idx" ON "ShippingCarrierProvider"("enabled", "name");

ALTER TABLE "ShippingCarrierProvider"
  ADD CONSTRAINT "ShippingCarrierProvider_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShippingCarrierProvider"
  ADD CONSTRAINT "ShippingCarrierProvider_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SellerShippingService" ADD COLUMN "carrierProviderId" TEXT;
CREATE INDEX "SellerShippingService_carrierProviderId_idx" ON "SellerShippingService"("carrierProviderId");
ALTER TABLE "SellerShippingService"
  ADD CONSTRAINT "SellerShippingService_carrierProviderId_fkey"
  FOREIGN KEY ("carrierProviderId") REFERENCES "ShippingCarrierProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "ShippingCarrierProvider" ("id", "code", "name", "countries", "trackingUrlTemplate", "enabled", "updatedAt") VALUES
  ('shipping-carrier-lbc-express', 'lbc-express', 'LBC Express', ARRAY['PH']::TEXT[], 'https://www.lbcexpress.com/track-2/', TRUE, CURRENT_TIMESTAMP),
  ('shipping-carrier-jt-express-ph', 'jt-express-ph', 'J&T Express Philippines', ARRAY['PH']::TEXT[], 'https://www.jtexpress.ph/track-and-trace', TRUE, CURRENT_TIMESTAMP),
  ('shipping-carrier-ninja-van-ph', 'ninja-van-ph', 'Ninja Van Philippines', ARRAY['PH']::TEXT[], 'https://www.ninjavan.co/en-ph/tracking/', TRUE, CURRENT_TIMESTAMP),
  ('shipping-carrier-flash-express-ph', 'flash-express-ph', 'Flash Express Philippines', ARRAY['PH']::TEXT[], 'https://www.flashexpress.ph/fle/tracking', TRUE, CURRENT_TIMESTAMP),
  ('shipping-carrier-2go-express', '2go-express', '2GO Express', ARRAY['PH']::TEXT[], 'https://express.2go.com.ph/tracking/', TRUE, CURRENT_TIMESTAMP),
  ('shipping-carrier-phlpost', 'phlpost', 'PHLPost', ARRAY['PH']::TEXT[], 'https://tracking.phlpost.gov.ph/', TRUE, CURRENT_TIMESTAMP);
