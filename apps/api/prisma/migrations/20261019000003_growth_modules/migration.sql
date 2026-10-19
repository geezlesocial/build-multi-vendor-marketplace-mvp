-- Additive growth modules. No existing orders, payments, seller records, or content are deleted.
CREATE TYPE "AffiliateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'TERMINATED');
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REVERSED', 'PAYABLE', 'PAID');
CREATE TYPE "AffiliatePayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PAID');
CREATE TYPE "WholesaleStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'WEB_PUSH', 'ANDROID_PUSH');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'PAUSED', 'ARCHIVED');
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED', 'BLOCKED');

ALTER TABLE "Product" ADD COLUMN "wholesaleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "wholesaleMinQuantity" INTEGER;
ALTER TABLE "Product" ADD COLUMN "wholesalePackSize" INTEGER;
ALTER TABLE "CartItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "ParentOrder" ADD COLUMN "affiliateClickId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantName" TEXT;

CREATE TABLE "ProductVariant" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "stock" INTEGER NOT NULL DEFAULT 0,
  "status" "ProductStatus" NOT NULL DEFAULT 'APPROVED',
  "imageUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");
CREATE INDEX "ProductVariant_productId_status_idx" ON "ProductVariant"("productId", "status");
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Favorite" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Favorite_userId_productId_key" ON "Favorite"("userId", "productId");
CREATE INDEX "Favorite_productId_createdAt_idx" ON "Favorite"("productId", "createdAt");
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WholesaleApplication" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "WholesaleStatus" NOT NULL DEFAULT 'PENDING',
  "note" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WholesaleApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WholesaleApplication_userId_key" ON "WholesaleApplication"("userId");
CREATE INDEX "WholesaleApplication_status_createdAt_idx" ON "WholesaleApplication"("status", "createdAt");
ALTER TABLE "WholesaleApplication" ADD CONSTRAINT "WholesaleApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WholesaleTierPrice" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "minQuantity" INTEGER NOT NULL,
  "unitPriceMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WholesaleTierPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WholesaleTierPrice_productId_variantId_minQuantity_key" ON "WholesaleTierPrice"("productId", "variantId", "minQuantity");
CREATE INDEX "WholesaleTierPrice_productId_minQuantity_idx" ON "WholesaleTierPrice"("productId", "minQuantity");
ALTER TABLE "WholesaleTierPrice" ADD CONSTRAINT "WholesaleTierPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WholesaleTierPrice" ADD CONSTRAINT "WholesaleTierPrice_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AffiliateProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "AffiliateStatus" NOT NULL DEFAULT 'PENDING',
  "referralCode" TEXT NOT NULL,
  "termsAcceptedAt" TIMESTAMP(3),
  "attributionWindowDays" INTEGER NOT NULL DEFAULT 30,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AffiliateProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateProfile_userId_key" ON "AffiliateProfile"("userId");
CREATE UNIQUE INDEX "AffiliateProfile_referralCode_key" ON "AffiliateProfile"("referralCode");
CREATE INDEX "AffiliateProfile_status_createdAt_idx" ON "AffiliateProfile"("status", "createdAt");
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AffiliateLink" (
  "id" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "productId" TEXT,
  "sellerId" TEXT,
  "targetPath" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateLink_code_key" ON "AffiliateLink"("code");
CREATE INDEX "AffiliateLink_affiliateId_createdAt_idx" ON "AffiliateLink"("affiliateId", "createdAt");
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AffiliateClick" (
  "id" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "productId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "ipHash" TEXT,
  "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "convertedAt" TIMESTAMP(3),
  CONSTRAINT "AffiliateClick_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateClick_tokenHash_key" ON "AffiliateClick"("tokenHash");
CREATE INDEX "AffiliateClick_affiliateId_clickedAt_idx" ON "AffiliateClick"("affiliateId", "clickedAt");
CREATE INDEX "AffiliateClick_expiresAt_convertedAt_idx" ON "AffiliateClick"("expiresAt", "convertedAt");
ALTER TABLE "AffiliateClick" ADD CONSTRAINT "AffiliateClick_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateClick" ADD CONSTRAINT "AffiliateClick_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AffiliateLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateClick" ADD CONSTRAINT "AffiliateClick_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ParentOrder" ADD CONSTRAINT "ParentOrder_affiliateClickId_key" UNIQUE ("affiliateClickId");
ALTER TABLE "ParentOrder" ADD CONSTRAINT "ParentOrder_affiliateClickId_fkey" FOREIGN KEY ("affiliateClickId") REFERENCES "AffiliateClick"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AffiliateCommissionRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "basisPoints" INTEGER,
  "fixedMinor" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "productId" TEXT,
  "categoryId" TEXT,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateCommissionRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AffiliateCommissionRule_effectiveFrom_effectiveTo_idx" ON "AffiliateCommissionRule"("effectiveFrom", "effectiveTo");
ALTER TABLE "AffiliateCommissionRule" ADD CONSTRAINT "AffiliateCommissionRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AffiliateCommissionRule" ADD CONSTRAINT "AffiliateCommissionRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CommissionLedger" (
  "id" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "orderItemId" TEXT,
  "ruleId" TEXT,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommissionLedger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommissionLedger_idempotencyKey_key" ON "CommissionLedger"("idempotencyKey");
CREATE INDEX "CommissionLedger_affiliateId_status_createdAt_idx" ON "CommissionLedger"("affiliateId", "status", "createdAt");
CREATE INDEX "CommissionLedger_orderItemId_idx" ON "CommissionLedger"("orderItemId");
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AffiliateCommissionRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AffiliatePayout" (
  "id" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "AffiliatePayoutStatus" NOT NULL DEFAULT 'REQUESTED',
  "method" TEXT,
  "reference" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliatePayout_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AffiliatePayout_affiliateId_status_createdAt_idx" ON "AffiliatePayout"("affiliateId", "status", "createdAt");
ALTER TABLE "AffiliatePayout" ADD CONSTRAINT "AffiliatePayout_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AffiliatePayoutItem" (
  "payoutId" TEXT NOT NULL,
  "commissionId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  CONSTRAINT "AffiliatePayoutItem_pkey" PRIMARY KEY ("payoutId", "commissionId")
);
ALTER TABLE "AffiliatePayoutItem" ADD CONSTRAINT "AffiliatePayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "AffiliatePayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliatePayoutItem" ADD CONSTRAINT "AffiliatePayoutItem_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "CommissionLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MarketingCampaign" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "placements" TEXT[] NOT NULL,
  "contentJson" JSONB NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MarketingCampaign_status_startsAt_endsAt_idx" ON "MarketingCampaign"("status", "startsAt", "endsAt");
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "MarketingCampaignProduct" (
  "campaignId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  CONSTRAINT "MarketingCampaignProduct_pkey" PRIMARY KEY ("campaignId", "productId")
);
ALTER TABLE "MarketingCampaignProduct" ADD CONSTRAINT "MarketingCampaignProduct_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingCampaignProduct" ADD CONSTRAINT "MarketingCampaignProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
  "eventType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "payloadJson" JSONB,
  "deliveryStatus" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "category" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationPreference_userId_channel_category_key" ON "NotificationPreference"("userId", "channel", "category");
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "PushSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_expiresAt_idx" ON "PushSubscription"("userId", "expiresAt");
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmailOutbox" (
  "id" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "recipientUserId" TEXT,
  "templateKey" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailOutbox_idempotencyKey_key" ON "EmailOutbox"("idempotencyKey");
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status", "nextAttemptAt");
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "productId" TEXT,
  "orderId" TEXT,
  "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Conversation_buyerId_updatedAt_idx" ON "Conversation"("buyerId", "updatedAt");
CREATE INDEX "Conversation_sellerId_updatedAt_idx" ON "Conversation"("sellerId", "updatedAt");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ParentOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "attachmentId" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Message_conversationId_sentAt_idx" ON "Message"("conversationId", "sentAt");
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AiUsageLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "feature" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "costMinor" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiUsageLog_feature_createdAt_idx" ON "AiUsageLog"("feature", "createdAt");
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
