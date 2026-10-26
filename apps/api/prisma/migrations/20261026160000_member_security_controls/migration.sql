ALTER TABLE "User"
  ADD COLUMN "accountStatus" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD CONSTRAINT "User_accountStatus_check" CHECK ("accountStatus" IN ('ACTIVE', 'SUSPENDED'));

CREATE INDEX "User_role_accountStatus_createdAt_idx" ON "User"("role", "accountStatus", "createdAt");
