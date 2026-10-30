ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'PLATFORM_STAFF';

CREATE TABLE "PlatformCollaborator" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" VARCHAR(32) NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformCollaborator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformCollaborator_userId_key" ON "PlatformCollaborator"("userId");
CREATE INDEX "PlatformCollaborator_enabled_position_idx" ON "PlatformCollaborator"("enabled", "position");

ALTER TABLE "PlatformCollaborator"
  ADD CONSTRAINT "PlatformCollaborator_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformCollaborator"
  ADD CONSTRAINT "PlatformCollaborator_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
