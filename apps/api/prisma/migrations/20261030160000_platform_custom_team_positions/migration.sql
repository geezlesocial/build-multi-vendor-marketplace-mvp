CREATE TABLE "PlatformTeamPosition" (
    "id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(48) NOT NULL,
    "nameNormalized" VARCHAR(96) NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformTeamPosition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformTeamPosition_enabled_name_idx" ON "PlatformTeamPosition"("enabled", "name");
CREATE UNIQUE INDEX "PlatformTeamPosition_nameNormalized_key" ON "PlatformTeamPosition"("nameNormalized");

ALTER TABLE "PlatformTeamPosition"
  ADD CONSTRAINT "PlatformTeamPosition_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
