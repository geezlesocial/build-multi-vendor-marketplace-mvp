CREATE TYPE "MediaPurpose" AS ENUM (
    'GENERAL',
    'AVATAR',
    'PLATFORM_CONTENT',
    'PLATFORM_BRANDING',
    'STORE_MEDIA'
);

ALTER TABLE "MediaAsset"
    ADD COLUMN "purpose" "MediaPurpose" NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN "scanAttemptCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "scanAttemptId" TEXT,
    ADD COLUMN "scanStartedAt" TIMESTAMP(3),
    ADD COLUMN "scanCompletedAt" TIMESTAMP(3),
    ADD COLUMN "scanErrorCode" VARCHAR(64),
    ADD COLUMN "scannerProvider" VARCHAR(32);

CREATE UNIQUE INDEX "MediaAsset_scanAttemptId_key" ON "MediaAsset"("scanAttemptId");
CREATE INDEX "MediaAsset_scan_retry_idx" ON "MediaAsset"("scanStatus", "uploadStatus", "scanStartedAt");

ALTER TABLE "MediaAsset"
    ADD CONSTRAINT "MediaAsset_scanAttemptCount_nonnegative_check"
    CHECK ("scanAttemptCount" >= 0);
