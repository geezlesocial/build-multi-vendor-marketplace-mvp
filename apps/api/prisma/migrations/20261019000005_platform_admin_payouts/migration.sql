-- CreateEnum
CREATE TYPE "TaxonomyStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ApprovalPolicy" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "PayoutMethodType" AS ENUM ('MANUAL_BANK', 'MANUAL_EWALLET', 'STRIPE_CONNECT', 'PAYPAL_PAYOUTS');

-- CreateEnum
CREATE TYPE "PayoutMethodStatus" AS ENUM ('NOT_STARTED', 'ACTION_REQUIRED', 'READY', 'DISABLED');

-- CreateEnum
CREATE TYPE "SellerPayoutStatus" AS ENUM ('PENDING', 'ELIGIBLE', 'HELD', 'REQUESTED', 'APPROVED', 'REJECTED', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED', 'RETURNED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SellerPayoutLedgerType" AS ENUM ('SALE_FUNDING', 'REFUND', 'REVERSAL', 'PLATFORM_FEE', 'AFFILIATE_FUNDING', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "description" TEXT,
ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "status" "TaxonomyStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "MarketplaceSettings" ADD COLUMN     "manualBankPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manualEwalletPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutFundingConfigured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutHoldDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "payoutMinimumMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paypalPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "productApprovalPolicy" "ApprovalPolicy" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sellerApprovalPolicy" "ApprovalPolicy" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sellerPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeConnectPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "bannerMediaId" TEXT,
ADD COLUMN     "contactJson" JSONB,
ADD COLUMN     "logoMediaId" TEXT,
ADD COLUMN     "policyLinksJson" JSONB,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "themeDraftJson" JSONB,
ADD COLUMN     "themePublishedAt" TIMESTAMP(3),
ADD COLUMN     "themePublishedJson" JSONB;

UPDATE "Store" SET "slug" = 'store-' || "id" WHERE "slug" IS NULL;
ALTER TABLE "Store" ALTER COLUMN "slug" SET NOT NULL;

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "status" "TaxonomyStatus" NOT NULL DEFAULT 'ACTIVE',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformBranding" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "draftJson" JSONB NOT NULL,
    "publishedJson" JSONB,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedVersion" INTEGER,
    "updatedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformBranding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformBrandingRevision" (
    "id" TEXT NOT NULL,
    "brandingId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "brandingJson" JSONB NOT NULL,
    "editorId" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformBrandingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreThemeRevision" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "themeJson" JSONB NOT NULL,
    "editorId" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreThemeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerAdminNote" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerAdminNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerModerationEvent" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "fromStatus" "SellerStatus",
    "toStatus" "SellerStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerModerationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPayoutMethod" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "type" "PayoutMethodType" NOT NULL,
    "status" "PayoutMethodStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maskedIdentifier" TEXT,
    "encryptedDetails" TEXT,
    "providerAccountRef" TEXT,
    "providerRecipientRef" TEXT,
    "providerStatus" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayoutMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPayoutLedgerEntry" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sellerOrderId" TEXT,
    "orderItemId" TEXT,
    "type" "SellerPayoutLedgerType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerPayoutLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPayout" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "payoutMethodId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "SellerPayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "manualReference" TEXT,
    "evidenceNote" TEXT,
    "failureReason" TEXT,
    "providerBatchRef" TEXT,
    "providerItemRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPayoutItem" (
    "payoutId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,

    CONSTRAINT "SellerPayoutItem_pkey" PRIMARY KEY ("payoutId","ledgerId")
);

-- CreateTable
CREATE TABLE "SellerPayoutProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" "PayoutMethodType" NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payoutId" TEXT,
    "payloadJson" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerPayoutProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- CreateIndex
CREATE INDEX "Brand_status_displayOrder_idx" ON "Brand"("status", "displayOrder");

-- CreateIndex
CREATE INDEX "PlatformBrandingRevision_brandingId_createdAt_idx" ON "PlatformBrandingRevision"("brandingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformBrandingRevision_brandingId_version_key" ON "PlatformBrandingRevision"("brandingId", "version");

-- CreateIndex
CREATE INDEX "StoreThemeRevision_storeId_createdAt_idx" ON "StoreThemeRevision"("storeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoreThemeRevision_storeId_version_key" ON "StoreThemeRevision"("storeId", "version");

-- CreateIndex
CREATE INDEX "SellerAdminNote_sellerId_createdAt_idx" ON "SellerAdminNote"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerModerationEvent_sellerId_createdAt_idx" ON "SellerModerationEvent"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerPayoutMethod_status_type_idx" ON "SellerPayoutMethod"("status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutMethod_sellerId_type_key" ON "SellerPayoutMethod"("sellerId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutLedgerEntry_idempotencyKey_key" ON "SellerPayoutLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SellerPayoutLedgerEntry_sellerId_createdAt_idx" ON "SellerPayoutLedgerEntry"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerPayoutLedgerEntry_sellerOrderId_idx" ON "SellerPayoutLedgerEntry"("sellerOrderId");

-- CreateIndex
CREATE INDEX "SellerPayoutLedgerEntry_orderItemId_idx" ON "SellerPayoutLedgerEntry"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayout_idempotencyKey_key" ON "SellerPayout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SellerPayout_sellerId_status_createdAt_idx" ON "SellerPayout"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SellerPayoutProviderEvent_payoutId_receivedAt_idx" ON "SellerPayoutProviderEvent"("payoutId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutProviderEvent_provider_eventId_key" ON "SellerPayoutProviderEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "CartItem_variantId_idx" ON "CartItem"("variantId");

-- CreateIndex
CREATE INDEX "Category_parentId_status_displayOrder_idx" ON "Category"("parentId", "status", "displayOrder");

-- CreateIndex
CREATE INDEX "OrderItem_variantId_idx" ON "OrderItem"("variantId");

-- CreateIndex
CREATE INDEX "Product_brandId_status_idx" ON "Product"("brandId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Store_slug_key" ON "Store"("slug");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_logoMediaId_fkey" FOREIGN KEY ("logoMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_bannerMediaId_fkey" FOREIGN KEY ("bannerMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBranding" ADD CONSTRAINT "PlatformBranding_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBrandingRevision" ADD CONSTRAINT "PlatformBrandingRevision_brandingId_fkey" FOREIGN KEY ("brandingId") REFERENCES "PlatformBranding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBrandingRevision" ADD CONSTRAINT "PlatformBrandingRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreThemeRevision" ADD CONSTRAINT "StoreThemeRevision_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreThemeRevision" ADD CONSTRAINT "StoreThemeRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerAdminNote" ADD CONSTRAINT "SellerAdminNote_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerAdminNote" ADD CONSTRAINT "SellerAdminNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerModerationEvent" ADD CONSTRAINT "SellerModerationEvent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerModerationEvent" ADD CONSTRAINT "SellerModerationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutMethod" ADD CONSTRAINT "SellerPayoutMethod_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutMethod" ADD CONSTRAINT "SellerPayoutMethod_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLedgerEntry" ADD CONSTRAINT "SellerPayoutLedgerEntry_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLedgerEntry" ADD CONSTRAINT "SellerPayoutLedgerEntry_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLedgerEntry" ADD CONSTRAINT "SellerPayoutLedgerEntry_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLedgerEntry" ADD CONSTRAINT "SellerPayoutLedgerEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "SellerPayoutMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutItem" ADD CONSTRAINT "SellerPayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "SellerPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutItem" ADD CONSTRAINT "SellerPayoutItem_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "SellerPayoutLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutProviderEvent" ADD CONSTRAINT "SellerPayoutProviderEvent_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "SellerPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;


