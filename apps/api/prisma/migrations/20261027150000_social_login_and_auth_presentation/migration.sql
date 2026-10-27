CREATE TYPE "SocialLoginProvider" AS ENUM ('GOOGLE', 'LINKEDIN', 'FACEBOOK', 'X', 'SCROLITH');
CREATE TYPE "AuthPageLayout" AS ENUM ('CENTERED', 'SPLIT', 'EDITORIAL');
CREATE TYPE "AuthPageMotion" AS ENUM ('NONE', 'FADE', 'SLIDE');

CREATE TABLE "SocialLoginProviderConfiguration" (
    "id" TEXT NOT NULL,
    "provider" "SocialLoginProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "clientSecretCiphertext" TEXT,
    "issuerUrl" TEXT,
    "logoUrl" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialLoginProviderConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SocialLoginIdentity" (
    "id" TEXT NOT NULL,
    "provider" "SocialLoginProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialLoginIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthLoginAttempt" (
    "id" TEXT NOT NULL,
    "provider" "SocialLoginProvider" NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "nonce" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthLoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthPageCustomization" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "signInHeading" VARCHAR(100) NOT NULL DEFAULT 'Sign in',
    "signInText" VARCHAR(240) NOT NULL DEFAULT 'Welcome back. Sign in to continue.',
    "signUpHeading" VARCHAR(100) NOT NULL DEFAULT 'Create account',
    "signUpText" VARCHAR(240) NOT NULL DEFAULT 'Join the marketplace and discover independent stores.',
    "logoMediaId" TEXT,
    "layout" "AuthPageLayout" NOT NULL DEFAULT 'CENTERED',
    "motion" "AuthPageMotion" NOT NULL DEFAULT 'FADE',
    "accentColor" VARCHAR(7) NOT NULL DEFAULT '#315d47',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthPageCustomization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialLoginProviderConfiguration_provider_key" ON "SocialLoginProviderConfiguration"("provider");
CREATE UNIQUE INDEX "SocialLoginIdentity_provider_subject_key" ON "SocialLoginIdentity"("provider", "subject");
CREATE INDEX "SocialLoginIdentity_userId_createdAt_idx" ON "SocialLoginIdentity"("userId", "createdAt");
CREATE UNIQUE INDEX "OAuthLoginAttempt_stateHash_key" ON "OAuthLoginAttempt"("stateHash");
CREATE INDEX "OAuthLoginAttempt_expiresAt_consumedAt_idx" ON "OAuthLoginAttempt"("expiresAt", "consumedAt");
CREATE UNIQUE INDEX "AuthPageCustomization_logoMediaId_key" ON "AuthPageCustomization"("logoMediaId");

ALTER TABLE "SocialLoginProviderConfiguration"
    ADD CONSTRAINT "SocialLoginProviderConfiguration_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SocialLoginIdentity"
    ADD CONSTRAINT "SocialLoginIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthPageCustomization"
    ADD CONSTRAINT "AuthPageCustomization_logoMediaId_fkey"
    FOREIGN KEY ("logoMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuthPageCustomization"
    ADD CONSTRAINT "AuthPageCustomization_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
