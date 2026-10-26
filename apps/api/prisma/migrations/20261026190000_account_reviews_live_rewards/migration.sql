ALTER TABLE "User"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "emailVerificationTokenHash" TEXT,
  ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "emailVerificationSentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_emailVerificationTokenHash_key"
  ON "User"("emailVerificationTokenHash");

CREATE TYPE "ProductReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED');

CREATE TABLE "ProductReview" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sellerOrderId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "body" VARCHAR(3000) NOT NULL,
  "status" "ProductReviewStatus" NOT NULL DEFAULT 'PENDING',
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT true,
  "moderationNote" VARCHAR(1000),
  "moderatedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductReview_productId_userId_key"
  ON "ProductReview"("productId", "userId");
CREATE INDEX "ProductReview_status_createdAt_idx"
  ON "ProductReview"("status", "createdAt");
CREATE INDEX "ProductReview_productId_status_createdAt_idx"
  ON "ProductReview"("productId", "status", "createdAt");
CREATE INDEX "ProductReview_sellerOrderId_status_idx"
  ON "ProductReview"("sellerOrderId", "status");

ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_sellerOrderId_fkey"
  FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_moderatedById_fkey"
  FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LiveSessionAttendance" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "eligibleDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "rewardedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveSessionAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveSessionAttendance_sessionId_userId_key"
  ON "LiveSessionAttendance"("sessionId", "userId");
CREATE INDEX "LiveSessionAttendance_sessionId_eligibleDurationSeconds_idx"
  ON "LiveSessionAttendance"("sessionId", "eligibleDurationSeconds");
CREATE INDEX "LiveSessionAttendance_userId_createdAt_idx"
  ON "LiveSessionAttendance"("userId", "createdAt");

ALTER TABLE "LiveSessionAttendance" ADD CONSTRAINT "LiveSessionAttendance_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveSessionAttendance" ADD CONSTRAINT "LiveSessionAttendance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
