-- Wallet and Club Coins are additive. Real-money movement remains disabled by
-- database defaults and server-side hard-disable configuration.

CREATE TYPE "WalletAccountType" AS ENUM ('USER', 'TREASURY');
CREATE TYPE "WalletAccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "WalletLedgerStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "WalletLedgerEntryType" AS ENUM ('FUNDING', 'TRANSFER', 'CHECKOUT', 'REFUND', 'CASHBACK', 'WITHDRAWAL_RESERVE', 'WITHDRAWAL_RELEASE', 'ADJUSTMENT', 'REVERSAL');
CREATE TYPE "WalletPostingDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "WalletFundingStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REVERSED');
CREATE TYPE "WalletTransferStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED', 'FAILED', 'REVERSED');
CREATE TYPE "WalletWithdrawalStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PROCESSING', 'PAID', 'FAILED', 'RELEASED');
CREATE TYPE "ClubCoinAccountStatus" AS ENUM ('ACTIVE', 'FROZEN');
CREATE TYPE "ClubCoinEntryType" AS ENUM ('AWARD', 'REDEMPTION', 'EXPIRY', 'REVERSAL', 'ADJUSTMENT');
CREATE TYPE "ClubCoinEventType" AS ENUM ('ACCOUNT_VERIFIED', 'PURCHASE_COMPLETED', 'REVIEW_SUBMITTED', 'LIVE_ATTENDANCE', 'CUSTOM');
CREATE TYPE "ClubCoinRedemptionStatus" AS ENUM ('RESERVED', 'APPLIED', 'REVERSED', 'EXPIRED');

ALTER TABLE "MarketplaceSettings"
  ADD COLUMN "walletEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "walletFundingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "walletTransfersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "walletCheckoutEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "walletWithdrawalsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "walletEmergencyPause" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "clubCoinsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clubCoinsEarnEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clubCoinsRedeemEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clubCoinTransfersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clubCoinConversionEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clubCoinRedemptionRatio" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "clubCoinMaxDiscountMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "clubCoinName" TEXT NOT NULL DEFAULT 'Club Coins',
  ADD COLUMN "clubCoinIconUrl" TEXT;

CREATE TABLE "WalletAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" "WalletAccountType" NOT NULL,
  "status" "WalletAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletAccount_type_user_check" CHECK (("type" = 'USER' AND "userId" IS NOT NULL) OR ("type" = 'TREASURY' AND "userId" IS NULL))
);

CREATE TABLE "WalletBalance" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "availableMinor" INTEGER NOT NULL DEFAULT 0,
  "pendingMinor" INTEGER NOT NULL DEFAULT 0,
  "heldMinor" INTEGER NOT NULL DEFAULT 0,
  "frozenMinor" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WalletBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletBalance_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency")),
  CONSTRAINT "WalletBalance_nonnegative_check" CHECK ("availableMinor" >= 0 AND "pendingMinor" >= 0 AND "heldMinor" >= 0 AND "frozenMinor" >= 0)
);

CREATE TABLE "WalletLedgerTransaction" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "entryType" "WalletLedgerEntryType" NOT NULL,
  "status" "WalletLedgerStatus" NOT NULL DEFAULT 'POSTED',
  "currency" TEXT NOT NULL,
  "referenceType" TEXT,
  "referenceId" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletLedgerTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletLedgerTransaction_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency"))
);

CREATE TABLE "WalletLedgerPosting" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "direction" "WalletPostingDirection" NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletLedgerPosting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletLedgerPosting_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "WalletLedgerPosting_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency"))
);

CREATE TABLE "WalletFundingIntent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerIntentId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" "WalletFundingStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "WalletFundingIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletFundingIntent_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "WalletFundingIntent_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency"))
);

CREATE TABLE "WalletTransfer" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "sourceAccountId" TEXT NOT NULL,
  "destinationAccountId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "WalletTransferStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "ledgerTransactionId" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletTransfer_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "WalletTransfer_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency")),
  CONSTRAINT "WalletTransfer_not_self_check" CHECK ("senderId" <> "recipientId")
);

CREATE TABLE "WalletWithdrawalRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "payoutMethodId" TEXT,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "WalletWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
  "idempotencyKey" TEXT NOT NULL,
  "destinationType" TEXT NOT NULL,
  "destinationRef" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "WalletWithdrawalRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletWithdrawalRequest_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "WalletWithdrawalRequest_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency"))
);

CREATE TABLE "ClubCoinAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "status" "ClubCoinAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubCoinAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClubCoinAccount_balance_check" CHECK ("balance" >= 0)
);

CREATE TABLE "ClubCoinEntry" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "entryType" "ClubCoinEntryType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "referenceType" TEXT,
  "referenceId" TEXT,
  "policyVersion" TEXT,
  "expiresAt" TIMESTAMP(3),
  "reversalOfId" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubCoinEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClubCoinEntry_amount_check" CHECK ("amount" <> 0)
);

CREATE TABLE "ClubCoinRule" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "eventType" "ClubCoinEventType" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "awardAmount" INTEGER NOT NULL,
  "perUserCap" INTEGER,
  "perOrderCap" INTEGER,
  "dailyCap" INTEGER,
  "expiresAfterDays" INTEGER,
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "eligibleGroupsJson" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubCoinRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClubCoinRule_award_check" CHECK ("awardAmount" > 0),
  CONSTRAINT "ClubCoinRule_caps_check" CHECK (("perUserCap" IS NULL OR "perUserCap" > 0) AND ("perOrderCap" IS NULL OR "perOrderCap" > 0) AND ("dailyCap" IS NULL OR "dailyCap" > 0) AND ("expiresAfterDays" IS NULL OR "expiresAfterDays" > 0))
);

CREATE TABLE "ClubCoinRedemption" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "coins" INTEGER NOT NULL,
  "discountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "ClubCoinRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
  "idempotencyKey" TEXT NOT NULL,
  "orderReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubCoinRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClubCoinRedemption_amount_check" CHECK ("coins" > 0 AND "discountMinor" > 0),
  CONSTRAINT "ClubCoinRedemption_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency"))
);

CREATE UNIQUE INDEX "WalletAccount_userId_key" ON "WalletAccount"("userId");
CREATE UNIQUE INDEX "WalletBalance_accountId_currency_key" ON "WalletBalance"("accountId", "currency");
CREATE UNIQUE INDEX "WalletLedgerTransaction_idempotencyKey_key" ON "WalletLedgerTransaction"("idempotencyKey");
CREATE UNIQUE INDEX "WalletFundingIntent_providerIntentId_key" ON "WalletFundingIntent"("providerIntentId");
CREATE UNIQUE INDEX "WalletFundingIntent_idempotencyKey_key" ON "WalletFundingIntent"("idempotencyKey");
CREATE UNIQUE INDEX "WalletTransfer_idempotencyKey_key" ON "WalletTransfer"("idempotencyKey");
CREATE UNIQUE INDEX "WalletTransfer_ledgerTransactionId_key" ON "WalletTransfer"("ledgerTransactionId");
CREATE UNIQUE INDEX "WalletWithdrawalRequest_idempotencyKey_key" ON "WalletWithdrawalRequest"("idempotencyKey");
CREATE UNIQUE INDEX "ClubCoinAccount_userId_key" ON "ClubCoinAccount"("userId");
CREATE UNIQUE INDEX "ClubCoinEntry_idempotencyKey_key" ON "ClubCoinEntry"("idempotencyKey");
CREATE UNIQUE INDEX "ClubCoinRule_code_key" ON "ClubCoinRule"("code");
CREATE UNIQUE INDEX "ClubCoinRedemption_idempotencyKey_key" ON "ClubCoinRedemption"("idempotencyKey");

CREATE INDEX "WalletAccount_type_status_idx" ON "WalletAccount"("type", "status");
CREATE INDEX "WalletBalance_currency_updatedAt_idx" ON "WalletBalance"("currency", "updatedAt");
CREATE INDEX "WalletLedgerTransaction_referenceType_referenceId_createdAt_idx" ON "WalletLedgerTransaction"("referenceType", "referenceId", "createdAt");
CREATE INDEX "WalletLedgerTransaction_currency_createdAt_idx" ON "WalletLedgerTransaction"("currency", "createdAt");
CREATE INDEX "WalletLedgerPosting_accountId_currency_createdAt_idx" ON "WalletLedgerPosting"("accountId", "currency", "createdAt");
CREATE INDEX "WalletLedgerPosting_transactionId_direction_idx" ON "WalletLedgerPosting"("transactionId", "direction");
CREATE INDEX "WalletFundingIntent_userId_status_createdAt_idx" ON "WalletFundingIntent"("userId", "status", "createdAt");
CREATE INDEX "WalletTransfer_senderId_status_createdAt_idx" ON "WalletTransfer"("senderId", "status", "createdAt");
CREATE INDEX "WalletTransfer_recipientId_status_createdAt_idx" ON "WalletTransfer"("recipientId", "status", "createdAt");
CREATE INDEX "WalletWithdrawalRequest_userId_status_createdAt_idx" ON "WalletWithdrawalRequest"("userId", "status", "createdAt");
CREATE INDEX "ClubCoinAccount_status_updatedAt_idx" ON "ClubCoinAccount"("status", "updatedAt");
CREATE INDEX "ClubCoinEntry_accountId_createdAt_idx" ON "ClubCoinEntry"("accountId", "createdAt");
CREATE INDEX "ClubCoinEntry_userId_referenceType_referenceId_idx" ON "ClubCoinEntry"("userId", "referenceType", "referenceId");
CREATE INDEX "ClubCoinEntry_expiresAt_idx" ON "ClubCoinEntry"("expiresAt");
CREATE INDEX "ClubCoinRule_eventType_enabled_effectiveFrom_idx" ON "ClubCoinRule"("eventType", "enabled", "effectiveFrom");
CREATE INDEX "ClubCoinRedemption_userId_status_createdAt_idx" ON "ClubCoinRedemption"("userId", "status", "createdAt");

ALTER TABLE "WalletAccount" ADD CONSTRAINT "WalletAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletBalance" ADD CONSTRAINT "WalletBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedgerPosting" ADD CONSTRAINT "WalletLedgerPosting_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "WalletLedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedgerPosting" ADD CONSTRAINT "WalletLedgerPosting_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletFundingIntent" ADD CONSTRAINT "WalletFundingIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletFundingIntent" ADD CONSTRAINT "WalletFundingIntent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_destinationAccountId_fkey" FOREIGN KEY ("destinationAccountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "SellerPayoutMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClubCoinAccount" ADD CONSTRAINT "ClubCoinAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClubCoinEntry" ADD CONSTRAINT "ClubCoinEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ClubCoinAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClubCoinEntry" ADD CONSTRAINT "ClubCoinEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClubCoinRule" ADD CONSTRAINT "ClubCoinRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClubCoinRedemption" ADD CONSTRAINT "ClubCoinRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClubCoinRedemption" ADD CONSTRAINT "ClubCoinRedemption_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ClubCoinAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "wallet_assert_balanced_transaction"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_id TEXT;
  posting_count INTEGER;
  debit_total BIGINT;
  credit_total BIGINT;
  transaction_currency TEXT;
BEGIN
  IF TG_RELID = '"WalletLedgerTransaction"'::regclass THEN
    transaction_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    transaction_id := OLD."transactionId";
  ELSE
    transaction_id := NEW."transactionId";
  END IF;
  SELECT "currency" INTO transaction_currency FROM "WalletLedgerTransaction" WHERE "id" = transaction_id;
  SELECT COUNT(*), COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE 0 END), 0), COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE 0 END), 0)
    INTO posting_count, debit_total, credit_total
  FROM "WalletLedgerPosting" WHERE "transactionId" = transaction_id;
  IF posting_count = 0 OR debit_total <> credit_total OR EXISTS (SELECT 1 FROM "WalletLedgerPosting" WHERE "transactionId" = transaction_id AND "currency" <> transaction_currency) THEN
    RAISE EXCEPTION 'Wallet ledger transaction % is not balanced', transaction_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WalletLedgerTransaction_balanced_trigger"
AFTER INSERT OR UPDATE ON "WalletLedgerTransaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_balanced_transaction"();

CREATE CONSTRAINT TRIGGER "WalletLedgerPosting_balanced_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "WalletLedgerPosting"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_balanced_transaction"();

-- Financial and loyalty ledger records are append-only. Corrections must be
-- represented by a compensating entry, never by rewriting or deleting the
-- original economic record. Wallet balance snapshots remain mutable only as
-- part of an approved posting transaction.
CREATE OR REPLACE FUNCTION "wallet_reject_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are immutable; create a compensating entry instead';
END;
$$;

CREATE TRIGGER "WalletLedgerTransaction_immutable_trigger"
BEFORE UPDATE OR DELETE ON "WalletLedgerTransaction"
FOR EACH ROW EXECUTE FUNCTION "wallet_reject_ledger_mutation"();

CREATE TRIGGER "WalletLedgerPosting_immutable_trigger"
BEFORE UPDATE OR DELETE ON "WalletLedgerPosting"
FOR EACH ROW EXECUTE FUNCTION "wallet_reject_ledger_mutation"();

CREATE TRIGGER "ClubCoinEntry_immutable_trigger"
BEFORE UPDATE OR DELETE ON "ClubCoinEntry"
FOR EACH ROW EXECUTE FUNCTION "wallet_reject_ledger_mutation"();
