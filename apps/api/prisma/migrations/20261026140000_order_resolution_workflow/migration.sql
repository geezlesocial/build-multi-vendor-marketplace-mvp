CREATE TABLE "OrderResolutionCase" (
  "id" TEXT NOT NULL,
  "parentOrderId" TEXT NOT NULL,
  "sellerOrderId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT,
  "type" VARCHAR(32) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  "reason" VARCHAR(80) NOT NULL,
  "description" VARCHAR(3000) NOT NULL,
  "requestedAmountMinor" INTEGER,
  "approvedAmountMinor" INTEGER,
  "resolutionNote" VARCHAR(1500),
  "providerWebhookEventRowId" TEXT,
  "manualRefundReference" VARCHAR(200),
  "decidedById" TEXT,
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderResolutionCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderResolutionCase_type_check" CHECK ("type" IN ('REFUND_REQUEST', 'DELIVERY_DISPUTE')),
  CONSTRAINT "OrderResolutionCase_status_check" CHECK ("status" IN ('OPEN', 'UNDER_REVIEW', 'REFUND_APPROVED', 'RESOLVED', 'REJECTED')),
  CONSTRAINT "OrderResolutionCase_requestedAmountMinor_check" CHECK ("requestedAmountMinor" IS NULL OR "requestedAmountMinor" > 0),
  CONSTRAINT "OrderResolutionCase_approvedAmountMinor_check" CHECK ("approvedAmountMinor" IS NULL OR "approvedAmountMinor" > 0),
  CONSTRAINT "OrderResolutionCase_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "ParentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderResolutionCase_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderResolutionCase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderResolutionCase_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "OrderResolutionCase_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "OrderResolutionCase_providerWebhookEventRowId_fkey" FOREIGN KEY ("providerWebhookEventRowId") REFERENCES "ProcessedWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderResolutionCase_sellerOrderId_key" ON "OrderResolutionCase"("sellerOrderId");
CREATE INDEX "OrderResolutionCase_status_updatedAt_idx" ON "OrderResolutionCase"("status", "updatedAt");
CREATE INDEX "OrderResolutionCase_buyerId_createdAt_idx" ON "OrderResolutionCase"("buyerId", "createdAt");
CREATE INDEX "OrderResolutionCase_sellerId_createdAt_idx" ON "OrderResolutionCase"("sellerId", "createdAt");
CREATE INDEX "OrderResolutionCase_parentOrderId_status_idx" ON "OrderResolutionCase"("parentOrderId", "status");

CREATE TABLE "OrderResolutionMessage" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "authorRole" VARCHAR(24) NOT NULL,
  "body" VARCHAR(3000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderResolutionMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderResolutionMessage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OrderResolutionCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderResolutionMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "OrderResolutionMessage_caseId_createdAt_idx" ON "OrderResolutionMessage"("caseId", "createdAt");
