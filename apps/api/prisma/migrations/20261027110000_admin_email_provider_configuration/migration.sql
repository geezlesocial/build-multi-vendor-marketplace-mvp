CREATE TABLE "EmailProviderConfiguration" (
    "provider" VARCHAR(32) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "requireTls" BOOLEAN NOT NULL DEFAULT true,
    "username" VARCHAR(255),
    "passwordCiphertext" TEXT,
    "senderName" VARCHAR(120) NOT NULL,
    "senderEmail" VARCHAR(320) NOT NULL,
    "replyTo" VARCHAR(320),
    "verifiedAt" TIMESTAMP(3),
    "lastTestAt" TIMESTAMP(3),
    "lastTestCode" VARCHAR(40),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailProviderConfiguration_pkey" PRIMARY KEY ("provider")
);

CREATE TABLE "PlatformEmailProviderSelection" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformEmailProviderSelection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformEmailProviderSelection_provider_key" ON "PlatformEmailProviderSelection"("provider");
ALTER TABLE "PlatformEmailProviderSelection" ADD CONSTRAINT "PlatformEmailProviderSelection_provider_fkey" FOREIGN KEY ("provider") REFERENCES "EmailProviderConfiguration"("provider") ON DELETE SET NULL ON UPDATE CASCADE;
