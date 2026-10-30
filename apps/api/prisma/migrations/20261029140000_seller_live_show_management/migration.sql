ALTER TABLE "LiveSession"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "LiveSession_sellerId_deletedAt_createdAt_idx"
  ON "LiveSession"("sellerId", "deletedAt", "createdAt");
