CREATE TYPE "LiveRecordingStatus" AS ENUM (
  'NOT_CONFIGURED',
  'STARTING',
  'RECORDING',
  'PROCESSING',
  'READY',
  'FAILED'
);

ALTER TABLE "LiveSession"
  ADD COLUMN "recordingStatus" "LiveRecordingStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN "recordingEgressId" TEXT,
  ADD COLUMN "recordingStorageKey" TEXT,
  ADD COLUMN "recordingStartedAt" TIMESTAMP(3),
  ADD COLUMN "recordingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "recordingErrorCode" VARCHAR(64),
  ADD COLUMN "replayPublishedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "LiveSession_recordingEgressId_key" ON "LiveSession"("recordingEgressId");
CREATE INDEX "LiveSession_status_recordingStatus_replayPublishedAt_idx"
  ON "LiveSession"("status", "recordingStatus", "replayPublishedAt");
