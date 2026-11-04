ALTER TYPE "MediaPurpose" ADD VALUE 'ONBOARDING_EXPERIENCE';

CREATE TABLE "OnboardingExperience" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "draftJson" JSONB NOT NULL,
    "publishedJson" JSONB,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedVersion" INTEGER,
    "updatedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OnboardingExperience_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OnboardingExperienceRevision" (
    "id" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configurationJson" JSONB NOT NULL,
    "editorId" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingExperienceRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OnboardingExperienceRevision_configurationId_version_key" ON "OnboardingExperienceRevision"("configurationId", "version");
CREATE INDEX "OnboardingExperience_publishedVersion_publishedAt_idx" ON "OnboardingExperience"("publishedVersion", "publishedAt");
CREATE INDEX "OnboardingExperienceRevision_configurationId_createdAt_idx" ON "OnboardingExperienceRevision"("configurationId", "createdAt");
ALTER TABLE "OnboardingExperience" ADD CONSTRAINT "OnboardingExperience_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OnboardingExperienceRevision" ADD CONSTRAINT "OnboardingExperienceRevision_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "OnboardingExperience"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnboardingExperienceRevision" ADD CONSTRAINT "OnboardingExperienceRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
