-- One versioned commission policy may target all free Stores without using
-- Store Plan IDs or a commission currency. Historical policy versions remain.
ALTER TABLE "SellerCommissionPolicyVersion"
  ADD COLUMN "freeStoreScopeKey" VARCHAR(20);

-- Preserve historical Store/plan-scoped rows while adding the global free-Store scope.
ALTER TABLE "SellerCommissionPolicyVersion"
  DROP CONSTRAINT "SellerCommissionPolicyVersion_one_scope_check",
  ADD CONSTRAINT "SellerCommissionPolicyVersion_one_scope_check"
    CHECK (num_nonnulls("storeId", "planVersionId", "freeStoreScopeKey") = 1);

CREATE UNIQUE INDEX "SellerCommissionPolicyVersion_freeStoreScopeKey_version_key"
  ON "SellerCommissionPolicyVersion"("freeStoreScopeKey", "version");
CREATE INDEX "SellerCommissionPolicyVersion_freeStoreScopeKey_status_effectiveFrom_idx"
  ON "SellerCommissionPolicyVersion"("freeStoreScopeKey", "status", "effectiveFrom");

CREATE TABLE "StoreCustomDomain" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "domain" VARCHAR(253) NOT NULL,
  "verificationTokenHash" VARCHAR(64) NOT NULL,
  "cnameTarget" VARCHAR(253) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING_DNS',
  "verifiedAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreCustomDomain_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreCustomDomain_status_check" CHECK ("status" IN ('PENDING_DNS', 'DNS_VERIFIED')),
  CONSTRAINT "StoreCustomDomain_storeId_fkey" FOREIGN KEY ("storeId")
    REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoreCustomDomain_storeId_key" ON "StoreCustomDomain"("storeId");
CREATE UNIQUE INDEX "StoreCustomDomain_domain_key" ON "StoreCustomDomain"("domain");
CREATE INDEX "StoreCustomDomain_status_lastCheckedAt_idx" ON "StoreCustomDomain"("status", "lastCheckedAt");

CREATE TABLE "StoreEmailProviderConfiguration" (
  "storeId" TEXT NOT NULL,
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
  "active" BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt" TIMESTAMP(3),
  "lastTestAt" TIMESTAMP(3),
  "lastTestCode" VARCHAR(40),
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreEmailProviderConfiguration_pkey" PRIMARY KEY ("storeId"),
  CONSTRAINT "StoreEmailProviderConfiguration_port_check" CHECK ("port" BETWEEN 1 AND 65535),
  CONSTRAINT "StoreEmailProviderConfiguration_tls_check" CHECK ("secure" OR "requireTls"),
  CONSTRAINT "StoreEmailProviderConfiguration_storeId_fkey" FOREIGN KEY ("storeId")
    REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StoreEmailProviderConfiguration_provider_active_idx"
  ON "StoreEmailProviderConfiguration"("provider", "active");
