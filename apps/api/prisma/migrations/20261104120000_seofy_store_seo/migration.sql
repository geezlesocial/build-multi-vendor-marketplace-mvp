-- SEOFY keeps seller-approved SEO metadata separate from operational fields.
-- All additions are nullable/defaulted so existing rows retain their behavior.
CREATE TYPE "SeofyAuditTargetType" AS ENUM ('STORE', 'PRODUCT');
CREATE TYPE "SeofyAuditStatus" AS ENUM ('READY', 'APPLIED', 'PARTIALLY_APPLIED', 'STALE');
CREATE TYPE "SeofyAuditAiStatus" AS ENUM ('NOT_CONFIGURED', 'USED', 'INVALID_RESPONSE', 'BUSY', 'UNAVAILABLE');
CREATE TYPE "SeofySuggestionField" AS ENUM ('SEO_TITLE', 'SEO_DESCRIPTION');
CREATE TYPE "SeofySuggestionStatus" AS ENUM ('PENDING', 'APPLIED', 'STALE');

ALTER TABLE "Store"
  ADD COLUMN "seoTitle" VARCHAR(160),
  ADD COLUMN "seoDescription" VARCHAR(320),
  ADD COLUMN "seofyLearningEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Product"
  ADD COLUMN "seoTitle" VARCHAR(160),
  ADD COLUMN "seoDescription" VARCHAR(320);

ALTER TABLE "StorePlanVersion"
  ADD COLUMN "seofyEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "StorePlanVersion"
  ADD CONSTRAINT "StorePlanVersion_seofy_paid_plan_check"
  CHECK (NOT "seofyEnabled" OR "monthlyPriceMinor" > 0);

-- Keep the new entitlement immutable with the rest of an activated plan version.
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
            NEW."scheduledPublishingEnabled", NEW."advancedContentSeoEnabled", NEW."seofyEnabled", NEW."storeBusterEnabled",
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
            OLD."scheduledPublishingEnabled", OLD."advancedContentSeoEnabled", OLD."seofyEnabled", OLD."storeBusterEnabled",
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

CREATE TABLE "SeofyAudit" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "targetType" "SeofyAuditTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "status" "SeofyAuditStatus" NOT NULL DEFAULT 'READY',
  "aiStatus" "SeofyAuditAiStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "learningUsed" BOOLEAN NOT NULL DEFAULT false,
  "sourceHash" VARCHAR(64) NOT NULL,
  "findings" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  CONSTRAINT "SeofyAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeofyAudit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SeofyAudit_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SeofySuggestion" (
  "id" TEXT NOT NULL,
  "auditId" TEXT NOT NULL,
  "field" "SeofySuggestionField" NOT NULL,
  "currentValue" VARCHAR(320),
  "recommendedValue" VARCHAR(320) NOT NULL,
  "rationale" VARCHAR(500) NOT NULL,
  "evidence" VARCHAR(500) NOT NULL,
  "status" "SeofySuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  CONSTRAINT "SeofySuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeofySuggestion_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SeofyAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SeofyAudit_storeId_createdAt_idx" ON "SeofyAudit"("storeId", "createdAt");
CREATE INDEX "SeofyAudit_storeId_targetType_targetId_createdAt_idx" ON "SeofyAudit"("storeId", "targetType", "targetId", "createdAt");
CREATE UNIQUE INDEX "SeofySuggestion_auditId_field_key" ON "SeofySuggestion"("auditId", "field");
CREATE INDEX "SeofySuggestion_auditId_status_idx" ON "SeofySuggestion"("auditId", "status");
