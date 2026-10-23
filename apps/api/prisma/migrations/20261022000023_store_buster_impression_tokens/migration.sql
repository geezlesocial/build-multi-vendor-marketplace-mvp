-- Bind organic click metrics to a single, short-lived impression token.
-- Tokens are stored as hashes and do not expose buyer identity to stores.
CREATE TABLE "StoreBusterImpression" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "clickedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreBusterImpression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoreBusterImpression_tokenHash_key" ON "StoreBusterImpression"("tokenHash");
CREATE INDEX "StoreBusterImpression_campaignId_day_idx" ON "StoreBusterImpression"("campaignId", "day");
CREATE INDEX "StoreBusterImpression_expiresAt_idx" ON "StoreBusterImpression"("expiresAt");
ALTER TABLE "StoreBusterImpression" ADD CONSTRAINT "StoreBusterImpression_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StoreBusterCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
