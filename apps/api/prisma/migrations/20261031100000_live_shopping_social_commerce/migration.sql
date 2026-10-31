ALTER TYPE "LiveSessionReactionKind" ADD VALUE IF NOT EXISTS 'SMILE';

ALTER TABLE "LiveSessionProduct"
  ADD COLUMN "shopFeatured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "shopSortOrder" INTEGER,
  ADD COLUMN "shopPinned" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "LiveSessionProduct_shop_sort_order_key"
  ON "LiveSessionProduct"("sessionId", "shopSortOrder")
  WHERE "shopFeatured" = true AND "shopSortOrder" IS NOT NULL;

CREATE TABLE "LiveSessionRepost" (
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveSessionRepost_pkey" PRIMARY KEY ("userId", "sessionId"),
  CONSTRAINT "LiveSessionRepost_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LiveSessionRepost_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LiveSessionRepost_userId_createdAt_idx"
  ON "LiveSessionRepost"("userId", "createdAt");
CREATE INDEX "LiveSessionRepost_sessionId_createdAt_idx"
  ON "LiveSessionRepost"("sessionId", "createdAt");
