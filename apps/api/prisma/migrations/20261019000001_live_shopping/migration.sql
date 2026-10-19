-- Additive live-shopping domain migration. No existing financial or seller records are deleted.
CREATE TYPE "LiveSessionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'STARTING', 'LIVE', 'PAUSED', 'ENDED', 'CANCELLED', 'FAILED');
CREATE TYPE "LiveReportStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED');

ALTER TABLE "MarketplaceSettings" ADD COLUMN "liveShoppingEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "LiveSession" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coverImageUrl" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL,
    "provider" TEXT,
    "providerSessionRef" TEXT,
    "playbackRef" TEXT,
    "status" "LiveSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "providerStatus" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LiveSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LiveSessionProduct" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "LiveSessionProduct_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LiveSessionReport" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reporterId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "LiveReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveSessionReport_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LiveProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sessionId" TEXT,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveSession_providerSessionRef_key" ON "LiveSession"("providerSessionRef");
CREATE INDEX "LiveSession_status_scheduledAt_idx" ON "LiveSession"("status", "scheduledAt");
CREATE INDEX "LiveSession_sellerId_status_idx" ON "LiveSession"("sellerId", "status");
CREATE UNIQUE INDEX "LiveSessionProduct_sessionId_productId_key" ON "LiveSessionProduct"("sessionId", "productId");
CREATE UNIQUE INDEX "LiveSessionProduct_sessionId_sortOrder_key" ON "LiveSessionProduct"("sessionId", "sortOrder");
CREATE INDEX "LiveSessionProduct_productId_idx" ON "LiveSessionProduct"("productId");
CREATE INDEX "LiveSessionReport_sessionId_status_createdAt_idx" ON "LiveSessionReport"("sessionId", "status", "createdAt");
CREATE UNIQUE INDEX "LiveProviderEvent_provider_eventId_key" ON "LiveProviderEvent"("provider", "eventId");
CREATE INDEX "LiveProviderEvent_sessionId_receivedAt_idx" ON "LiveProviderEvent"("sessionId", "receivedAt");

ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveSessionProduct" ADD CONSTRAINT "LiveSessionProduct_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveSessionProduct" ADD CONSTRAINT "LiveSessionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveSessionReport" ADD CONSTRAINT "LiveSessionReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveSessionReport" ADD CONSTRAINT "LiveSessionReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveSessionReport" ADD CONSTRAINT "LiveSessionReport_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveProviderEvent" ADD CONSTRAINT "LiveProviderEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
