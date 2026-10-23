-- Store-scoped publishing and media quota foundations. Existing platform CMS
-- records remain global (storeId IS NULL); existing stores retain generous
-- compatibility limits and all current content remains untouched.
CREATE TYPE "MediaUploadStatus" AS ENUM ('PENDING', 'VERIFYING', 'COMPLETE', 'FAILED');
CREATE TYPE "MediaStorageProvider" AS ENUM ('LOCAL', 'OBJECT');

ALTER TABLE "StorePlanVersion"
    ADD COLUMN "blogPostLimit" INTEGER NOT NULL DEFAULT 2147483647,
    ADD COLUMN "contentPageLimit" INTEGER NOT NULL DEFAULT 2147483647,
    ADD COLUMN "mediaStorageLimitBytes" INTEGER NOT NULL DEFAULT 2147483647,
    ADD COLUMN "scheduledPublishingEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "advancedContentSeoEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "storeBusterEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "storeBusterCampaignLimit" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "storeBusterMonthlyBudgetMinor" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "emailMarketingEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "emailSubscriberLimit" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "emailMonthlySendLimit" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "affiliateToolsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "StorePlanVersion"
    ADD CONSTRAINT "StorePlanVersion_growth_entitlements_check" CHECK (
        "blogPostLimit" > 0 AND "contentPageLimit" > 0 AND "mediaStorageLimitBytes" > 0
        AND "storeBusterCampaignLimit" >= 0 AND "storeBusterMonthlyBudgetMinor" >= 0
        AND "emailSubscriberLimit" >= 0 AND "emailMonthlySendLimit" >= 0
        AND (NOT "storeBusterEnabled" OR "storeBusterCampaignLimit" > 0)
        AND (NOT "emailMarketingEnabled" OR ("emailSubscriberLimit" > 0 AND "emailMonthlySendLimit" > 0))
    );

ALTER TABLE "BlogPost" ADD COLUMN "storeId" TEXT;
ALTER TABLE "ContentPage" ADD COLUMN "storeId" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "storeId" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "uploadStatus" "MediaUploadStatus" NOT NULL DEFAULT 'COMPLETE';
ALTER TABLE "MediaAsset" ADD COLUMN "storageProvider" "MediaStorageProvider" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "ProductImage" ADD COLUMN "mediaAssetId" TEXT;

CREATE INDEX "BlogPost_storeId_status_updatedAt_idx" ON "BlogPost"("storeId", "status", "updatedAt");
CREATE INDEX "ContentPage_storeId_status_updatedAt_idx" ON "ContentPage"("storeId", "status", "updatedAt");
CREATE INDEX "MediaAsset_storeId_uploadStatus_createdAt_idx" ON "MediaAsset"("storeId", "uploadStatus", "createdAt");
CREATE INDEX "ProductImage_mediaAssetId_idx" ON "ProductImage"("mediaAssetId");

ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep all terms immutable once a version has been activated, including this
-- migration's new content, storage, and growth capabilities.
CREATE OR REPLACE FUNCTION protect_activated_store_plan_version() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."activatedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Activated Store plan versions are immutable and cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."activatedAt" IS NOT NULL THEN
        IF ROW(
            NEW."planId", NEW."version", NEW."name", NEW."description", NEW."currency", NEW."monthlyPriceMinor",
            NEW."annualPriceMinor", NEW."annualDiscountPercent", NEW."defaultInterval", NEW."termIntervals",
            NEW."expirationBehavior", NEW."cancellationPolicy", NEW."freeTrialDays", NEW."introPriceMinor",
            NEW."introDurationDays", NEW."effectiveFrom", NEW."effectiveUntil", NEW."productLimit",
            NEW."storeLimit", NEW."vendorLimit", NEW."staffSeatLimit", NEW."allowedThemes",
            NEW."customDomainEligible", NEW."paymentConnectors", NEW."mobileTemplates",
            NEW."blogPostLimit", NEW."contentPageLimit", NEW."mediaStorageLimitBytes",
            NEW."scheduledPublishingEnabled", NEW."advancedContentSeoEnabled", NEW."storeBusterEnabled",
            NEW."storeBusterCampaignLimit", NEW."storeBusterMonthlyBudgetMinor", NEW."emailMarketingEnabled",
            NEW."emailSubscriberLimit", NEW."emailMonthlySendLimit", NEW."affiliateToolsEnabled",
            NEW."createdById", NEW."createdAt", NEW."activatedAt"
        ) IS DISTINCT FROM ROW(
            OLD."planId", OLD."version", OLD."name", OLD."description", OLD."currency", OLD."monthlyPriceMinor",
            OLD."annualPriceMinor", OLD."annualDiscountPercent", OLD."defaultInterval", OLD."termIntervals",
            OLD."expirationBehavior", OLD."cancellationPolicy", OLD."freeTrialDays", OLD."introPriceMinor",
            OLD."introDurationDays", OLD."effectiveFrom", OLD."effectiveUntil", OLD."productLimit",
            OLD."storeLimit", OLD."vendorLimit", OLD."staffSeatLimit", OLD."allowedThemes",
            OLD."customDomainEligible", OLD."paymentConnectors", OLD."mobileTemplates",
            OLD."blogPostLimit", OLD."contentPageLimit", OLD."mediaStorageLimitBytes",
            OLD."scheduledPublishingEnabled", OLD."advancedContentSeoEnabled", OLD."storeBusterEnabled",
            OLD."storeBusterCampaignLimit", OLD."storeBusterMonthlyBudgetMinor", OLD."emailMarketingEnabled",
            OLD."emailSubscriberLimit", OLD."emailMonthlySendLimit", OLD."affiliateToolsEnabled",
            OLD."createdById", OLD."createdAt", OLD."activatedAt"
        ) THEN
            RAISE EXCEPTION 'Activated Store plan version terms are immutable; create a new draft version';
        END IF;
        IF NEW."status" IS DISTINCT FROM OLD."status"
           AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED') THEN
            RAISE EXCEPTION 'Activated Store plan version status transition is invalid';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Store ownership is checked in the database as well as at the API boundary.
-- Rows with NULL storeId are existing platform CMS/media records.
CREATE FUNCTION enforce_store_content_owner() RETURNS trigger AS $$
DECLARE
    owner_seller_id TEXT;
    editor_is_authorized BOOLEAN;
BEGIN
    IF NEW."storeId" IS NULL THEN RETURN NEW; END IF;
    SELECT "sellerId" INTO owner_seller_id FROM "Store" WHERE "id" = NEW."storeId" FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Store content tenant does not exist'; END IF;
    IF TG_TABLE_NAME = 'MediaAsset' THEN
        SELECT EXISTS (SELECT 1 FROM "Seller" WHERE "id" = owner_seller_id AND "userId" = NEW."uploaderId")
            OR EXISTS (SELECT 1 FROM "SellerStaff" WHERE "sellerId" = owner_seller_id AND "userId" = NEW."uploaderId")
          INTO editor_is_authorized;
    ELSE
        SELECT EXISTS (SELECT 1 FROM "Seller" WHERE "id" = owner_seller_id AND "userId" = NEW."editorId")
            OR EXISTS (SELECT 1 FROM "SellerStaff" WHERE "sellerId" = owner_seller_id AND "userId" = NEW."editorId")
          INTO editor_is_authorized;
    END IF;
    IF NOT editor_is_authorized THEN RAISE EXCEPTION 'Store content actor is not authorized for this tenant'; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BlogPost_store_owner_guard" BEFORE INSERT OR UPDATE OF "storeId", "editorId" ON "BlogPost"
FOR EACH ROW EXECUTE FUNCTION enforce_store_content_owner();
CREATE TRIGGER "ContentPage_store_owner_guard" BEFORE INSERT OR UPDATE OF "storeId", "editorId" ON "ContentPage"
FOR EACH ROW EXECUTE FUNCTION enforce_store_content_owner();
CREATE TRIGGER "MediaAsset_store_owner_guard" BEFORE INSERT OR UPDATE OF "storeId", "uploaderId" ON "MediaAsset"
FOR EACH ROW EXECUTE FUNCTION enforce_store_content_owner();
