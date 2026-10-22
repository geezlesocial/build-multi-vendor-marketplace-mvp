-- Add versioned SaaS pricing and billing history. Defaults preserve all existing
-- assignments as free/legacy-compatible; this migration never charges a Store.
ALTER TYPE "StorePlanAssignmentSource" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';
CREATE TYPE "StorePlanBillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "StorePlanExpirationBehavior" AS ENUM ('DOWNGRADE_TO_LEGACY', 'SUSPEND_SELLER');
CREATE TYPE "StorePlanCancellationPolicy" AS ENUM ('CANCEL_ANYTIME', 'CANCEL_AT_TERM_END');

ALTER TABLE "StorePlanVersion"
    ADD COLUMN "name" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD',
    ADD COLUMN "monthlyPriceMinor" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "annualPriceMinor" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "annualDiscountPercent" INTEGER,
    ADD COLUMN "defaultInterval" "StorePlanBillingInterval" NOT NULL DEFAULT 'MONTHLY',
    ADD COLUMN "termIntervals" INTEGER,
    ADD COLUMN "expirationBehavior" "StorePlanExpirationBehavior" NOT NULL DEFAULT 'DOWNGRADE_TO_LEGACY',
    ADD COLUMN "cancellationPolicy" "StorePlanCancellationPolicy" NOT NULL DEFAULT 'CANCEL_ANYTIME',
    ADD COLUMN "freeTrialDays" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "introPriceMinor" INTEGER,
    ADD COLUMN "introDurationDays" INTEGER,
    ADD COLUMN "effectiveFrom" TIMESTAMP(3),
    ADD COLUMN "effectiveUntil" TIMESTAMP(3);

UPDATE "StorePlanVersion" AS version
SET "name" = plan."name"
FROM "StorePlan" AS plan
WHERE version."planId" = plan."id";
ALTER TABLE "StorePlanVersion" ALTER COLUMN "name" DROP DEFAULT;

-- Fail before installing constraints if any row is unexpectedly outside the
-- compatibility defaults. The migration is additive and deliberately refuses
-- to rewrite incompatible pre-existing plan data.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "StorePlanVersion"
        WHERE "currency" <> 'USD' OR "monthlyPriceMinor" <> 0 OR "annualPriceMinor" <> 0
          OR "annualDiscountPercent" IS NOT NULL OR "freeTrialDays" <> 0
          OR "introPriceMinor" IS NOT NULL OR "introDurationDays" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Store plan pricing migration preflight failed: unexpected non-legacy pricing values exist';
    END IF;
END $$;

ALTER TABLE "StorePlanVersion"
    ADD CONSTRAINT "StorePlanVersion_currency_check" CHECK ("currency" IN ('AUD', 'CAD', 'EUR', 'GBP', 'NZD', 'SGD', 'USD')),
    ADD CONSTRAINT "StorePlanVersion_monthly_price_check" CHECK ("monthlyPriceMinor" >= 0 AND "monthlyPriceMinor" <= 2000000000),
    ADD CONSTRAINT "StorePlanVersion_annual_price_check" CHECK ("annualPriceMinor" >= 0 AND "annualPriceMinor" <= 2000000000 AND "annualPriceMinor" <= "monthlyPriceMinor"::BIGINT * 12),
    ADD CONSTRAINT "StorePlanVersion_annual_discount_check" CHECK (
        "annualDiscountPercent" IS NULL OR (
            "annualDiscountPercent" BETWEEN 1 AND 90
            AND "annualPriceMinor" = floor(("monthlyPriceMinor"::NUMERIC * 12 * (100 - "annualDiscountPercent") + 50) / 100)::INTEGER
        )
    ),
    ADD CONSTRAINT "StorePlanVersion_trial_check" CHECK ("freeTrialDays" BETWEEN 0 AND 90),
    ADD CONSTRAINT "StorePlanVersion_intro_check" CHECK (
        ("introPriceMinor" IS NULL AND "introDurationDays" IS NULL)
        OR ("introPriceMinor" BETWEEN 1 AND 2000000000 AND "introDurationDays" BETWEEN 1 AND 365
            AND "monthlyPriceMinor" > 0 AND "introPriceMinor" < "monthlyPriceMinor")
    ),
    ADD CONSTRAINT "StorePlanVersion_free_price_terms_check" CHECK (
        "monthlyPriceMinor" <> 0 OR ("annualPriceMinor" = 0 AND "annualDiscountPercent" IS NULL
            AND "freeTrialDays" = 0 AND "introPriceMinor" IS NULL AND "introDurationDays" IS NULL)
    ),
    ADD CONSTRAINT "StorePlanVersion_effective_range_check" CHECK (
        "effectiveFrom" IS NULL OR "effectiveUntil" IS NULL OR "effectiveUntil" > "effectiveFrom"
    ),
    ADD CONSTRAINT "StorePlanVersion_term_intervals_check" CHECK ("termIntervals" IS NULL OR "termIntervals" BETWEEN 1 AND 120),
    ADD CONSTRAINT "StorePlanVersion_active_timestamp_check" CHECK ("status" <> 'ACTIVE' OR "activatedAt" IS NOT NULL);

CREATE FUNCTION protect_activated_store_plan_version() RETURNS trigger AS $$
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
            NEW."customDomainEligible", NEW."paymentConnectors", NEW."mobileTemplates", NEW."createdById",
            NEW."createdAt", NEW."activatedAt"
        ) IS DISTINCT FROM ROW(
            OLD."planId", OLD."version", OLD."name", OLD."description", OLD."currency", OLD."monthlyPriceMinor",
            OLD."annualPriceMinor", OLD."annualDiscountPercent", OLD."defaultInterval", OLD."termIntervals",
            OLD."expirationBehavior", OLD."cancellationPolicy", OLD."freeTrialDays", OLD."introPriceMinor",
            OLD."introDurationDays", OLD."effectiveFrom", OLD."effectiveUntil", OLD."productLimit",
            OLD."storeLimit", OLD."vendorLimit", OLD."staffSeatLimit", OLD."allowedThemes",
            OLD."customDomainEligible", OLD."paymentConnectors", OLD."mobileTemplates", OLD."createdById",
            OLD."createdAt", OLD."activatedAt"
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

CREATE TRIGGER "StorePlanVersion_immutable_after_activation"
BEFORE UPDATE OR DELETE ON "StorePlanVersion"
FOR EACH ROW EXECUTE FUNCTION protect_activated_store_plan_version();

CREATE TYPE "StoreSubscriptionStatus" AS ENUM ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'UNPAID');
CREATE TYPE "StoreSubscriptionProvider" AS ENUM ('STRIPE', 'PAYPAL');
CREATE TYPE "StoreSubscriptionInvoiceStatus" AS ENUM ('OPEN', 'PAID', 'FAILED', 'VOID', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "StoreSubscriptionEventStatus" AS ENUM ('RECEIVED', 'APPLIED', 'IGNORED', 'FAILED');

CREATE TABLE "StoreSubscription" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "requestedById" TEXT,
    "provider" "StoreSubscriptionProvider",
    "providerSubscriptionId" TEXT,
    "status" "StoreSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "interval" "StorePlanBillingInterval" NOT NULL,
    "currency" TEXT NOT NULL,
    "monthlyPriceMinor" INTEGER NOT NULL,
    "annualPriceMinor" INTEGER,
    "introPriceMinor" INTEGER,
    "introDurationDays" INTEGER,
    "freeTrialDays" INTEGER NOT NULL,
    "termIntervals" INTEGER,
    "expirationBehavior" "StorePlanExpirationBehavior" NOT NULL,
    "cancellationPolicy" "StorePlanCancellationPolicy" NOT NULL,
    "termsSnapshot" JSONB NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "introEndsAt" TIMESTAMP(3),
    "nextChargeAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreSubscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreSubscription_currency_check" CHECK ("currency" IN ('AUD', 'CAD', 'EUR', 'GBP', 'NZD', 'SGD', 'USD')),
    CONSTRAINT "StoreSubscription_price_check" CHECK ("monthlyPriceMinor" >= 0 AND ("annualPriceMinor" IS NULL OR "annualPriceMinor" >= 0)
        AND ("introPriceMinor" IS NULL OR "introPriceMinor" > 0) AND "freeTrialDays" BETWEEN 0 AND 90),
    CONSTRAINT "StoreSubscription_dates_check" CHECK (("currentPeriodEnd" IS NULL OR "currentPeriodStart" IS NULL OR "currentPeriodEnd" > "currentPeriodStart")
        AND ("expiresAt" IS NULL OR "currentPeriodStart" IS NULL OR "expiresAt" >= "currentPeriodStart"))
);

CREATE TABLE "StoreSubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" "StoreSubscriptionProvider",
    "providerInvoiceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "StoreSubscriptionInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "amountMinor" INTEGER NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreSubscriptionInvoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreSubscriptionInvoice_idempotencyKey_key" UNIQUE ("idempotencyKey"),
    CONSTRAINT "StoreSubscriptionInvoice_amount_check" CHECK ("amountMinor" >= 0 AND "refundedMinor" BETWEEN 0 AND "amountMinor"),
    CONSTRAINT "StoreSubscriptionInvoice_currency_check" CHECK ("currency" IN ('AUD', 'CAD', 'EUR', 'GBP', 'NZD', 'SGD', 'USD')),
    CONSTRAINT "StoreSubscriptionInvoice_period_check" CHECK ("periodEnd" IS NULL OR "periodStart" IS NULL OR "periodEnd" > "periodStart")
);

CREATE TABLE "StoreSubscriptionEvent" (
    "id" TEXT NOT NULL,
    "provider" "StoreSubscriptionProvider" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "StoreSubscriptionEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionId" TEXT,
    "safeSummary" JSONB,
    "errorCode" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "StoreSubscriptionEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreSubscriptionEvent_provider_event_key" UNIQUE ("provider", "providerEventId")
);

CREATE UNIQUE INDEX "StoreSubscription_provider_providerSubscriptionId_key" ON "StoreSubscription"("provider", "providerSubscriptionId");
CREATE INDEX "StoreSubscription_storeId_status_createdAt_idx" ON "StoreSubscription"("storeId", "status", "createdAt");
CREATE INDEX "StoreSubscription_planVersionId_status_idx" ON "StoreSubscription"("planVersionId", "status");
CREATE UNIQUE INDEX "StoreSubscriptionInvoice_provider_providerInvoiceId_key" ON "StoreSubscriptionInvoice"("provider", "providerInvoiceId");
CREATE INDEX "StoreSubscriptionInvoice_subscriptionId_createdAt_idx" ON "StoreSubscriptionInvoice"("subscriptionId", "createdAt");
CREATE INDEX "StoreSubscriptionEvent_subscriptionId_receivedAt_idx" ON "StoreSubscriptionEvent"("subscriptionId", "receivedAt");
CREATE INDEX "StoreSubscriptionEvent_status_receivedAt_idx" ON "StoreSubscriptionEvent"("status", "receivedAt");

ALTER TABLE "StoreSubscription" ADD CONSTRAINT "StoreSubscription_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreSubscription" ADD CONSTRAINT "StoreSubscription_planVersionId_fkey"
FOREIGN KEY ("planVersionId") REFERENCES "StorePlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreSubscription" ADD CONSTRAINT "StoreSubscription_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StoreSubscriptionInvoice" ADD CONSTRAINT "StoreSubscriptionInvoice_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId") REFERENCES "StoreSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreSubscriptionEvent" ADD CONSTRAINT "StoreSubscriptionEvent_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId") REFERENCES "StoreSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
