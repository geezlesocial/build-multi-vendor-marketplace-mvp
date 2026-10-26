CREATE TABLE "LiveKitConfiguration" (
    "id" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "apiKeyCiphertext" TEXT,
    "apiSecretCiphertext" TEXT,
    "deploymentGateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "LiveKitConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LiveKitConfiguration_deploymentGateEnabled_idx" ON "LiveKitConfiguration"("deploymentGateEnabled");
