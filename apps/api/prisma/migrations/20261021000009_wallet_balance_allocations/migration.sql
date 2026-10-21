-- State-aware wallet reconciliation is additive. Existing ledger rows and
-- snapshots are not rewritten. Future flows must append allocations in the
-- same transaction as their economic posting or state transition.

CREATE TYPE "WalletBalanceState" AS ENUM ('AVAILABLE', 'PENDING', 'HELD', 'FROZEN');

CREATE TABLE "WalletBalanceAllocation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "transactionId" TEXT,
  "currency" TEXT NOT NULL,
  "state" "WalletBalanceState" NOT NULL,
  "deltaMinor" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "referenceType" TEXT,
  "referenceId" TEXT,
  "isOpeningBaseline" BOOLEAN NOT NULL DEFAULT false,
  "baselineEvidenceRef" TEXT,
  "baselineVerified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletBalanceAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletBalanceAllocation_delta_check" CHECK ("deltaMinor" <> 0),
  CONSTRAINT "WalletBalanceAllocation_currency_check" CHECK (char_length("currency") = 3 AND "currency" = upper("currency")),
  CONSTRAINT "WalletBalanceAllocation_baseline_check" CHECK (NOT "baselineVerified" OR "isOpeningBaseline")
);

CREATE UNIQUE INDEX "WalletBalanceAllocation_idempotencyKey_key" ON "WalletBalanceAllocation"("idempotencyKey");
CREATE INDEX "WalletBalanceAllocation_accountId_currency_state_createdAt_idx" ON "WalletBalanceAllocation"("accountId", "currency", "state", "createdAt");
CREATE INDEX "WalletBalanceAllocation_transactionId_idx" ON "WalletBalanceAllocation"("transactionId");
CREATE INDEX "WalletBalanceAllocation_referenceType_referenceId_idx" ON "WalletBalanceAllocation"("referenceType", "referenceId");

ALTER TABLE "WalletBalanceAllocation" ADD CONSTRAINT "WalletBalanceAllocation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletBalanceAllocation" ADD CONSTRAINT "WalletBalanceAllocation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "WalletLedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Allocations are append-only. Corrections are compensating allocations.
CREATE TRIGGER "WalletBalanceAllocation_immutable_trigger"
BEFORE UPDATE OR DELETE ON "WalletBalanceAllocation"
FOR EACH ROW EXECUTE FUNCTION "wallet_reject_ledger_mutation"();

CREATE OR REPLACE FUNCTION "wallet_assert_balance_allocation_consistency"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_account_id TEXT;
  affected_currency TEXT;
  affected_transaction_id TEXT;
  transaction_currency TEXT;
  posting_total BIGINT;
  allocation_total BIGINT;
  state_total BIGINT;
  state_name "WalletBalanceState";
  snapshot_available INTEGER;
  snapshot_pending INTEGER;
  snapshot_held INTEGER;
  snapshot_frozen INTEGER;
  allocation_available BIGINT;
  allocation_pending BIGINT;
  allocation_held BIGINT;
  allocation_frozen BIGINT;
  transition_count INTEGER;
  transition_total BIGINT;
BEGIN
  IF TG_RELID = '"WalletLedgerTransaction"'::regclass THEN
    affected_transaction_id := NEW."id";
  ELSE
    affected_transaction_id := NEW."transactionId";
    affected_account_id := NEW."accountId";
    affected_currency := NEW."currency";
  END IF;

  IF affected_transaction_id IS NOT NULL THEN
    SELECT "currency" INTO transaction_currency
    FROM "WalletLedgerTransaction"
    WHERE "id" = affected_transaction_id;

    IF transaction_currency IS NULL OR EXISTS (
      SELECT 1 FROM "WalletLedgerPosting"
      WHERE "transactionId" = affected_transaction_id AND "currency" <> transaction_currency
    ) OR EXISTS (
      SELECT 1 FROM "WalletBalanceAllocation"
      WHERE "transactionId" = affected_transaction_id AND "currency" <> transaction_currency
    ) THEN
      RAISE EXCEPTION 'Wallet allocation currency does not match ledger transaction %', affected_transaction_id;
    END IF;

    FOR affected_account_id, affected_currency IN
      SELECT "accountId", "currency" FROM "WalletLedgerPosting" WHERE "transactionId" = affected_transaction_id
      UNION
      SELECT "accountId", "currency" FROM "WalletBalanceAllocation" WHERE "transactionId" = affected_transaction_id
    LOOP
      SELECT COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)
      INTO posting_total
      FROM "WalletLedgerPosting"
      WHERE "transactionId" = affected_transaction_id AND "accountId" = affected_account_id AND "currency" = affected_currency;

      SELECT COALESCE(SUM("deltaMinor"), 0)
      INTO allocation_total
      FROM "WalletBalanceAllocation"
      WHERE "transactionId" = affected_transaction_id AND "accountId" = affected_account_id AND "currency" = affected_currency;

      IF posting_total <> allocation_total THEN
        RAISE EXCEPTION 'Wallet allocation total does not match ledger postings for transaction % and account %', affected_transaction_id, affected_account_id;
      END IF;
    END LOOP;
  END IF;

  IF TG_RELID = '"WalletBalanceAllocation"'::regclass THEN
    IF NEW."transactionId" IS NULL AND NEW."referenceType" = 'STATE_TRANSITION' THEN
      SELECT COUNT(*), COALESCE(SUM("deltaMinor"), 0)
      INTO transition_count, transition_total
      FROM "WalletBalanceAllocation"
      WHERE "referenceType" = 'STATE_TRANSITION'
        AND "referenceId" = NEW."referenceId"
        AND "accountId" = NEW."accountId"
        AND "currency" = NEW."currency";
      IF transition_count < 2 OR transition_total <> 0 THEN
        RAISE EXCEPTION 'Wallet state transition % must have balanced allocation entries', NEW."referenceId";
      END IF;
    END IF;
  END IF;

  IF affected_account_id IS NOT NULL AND affected_currency IS NOT NULL THEN
    FOR state_name IN SELECT unnest(enum_range(NULL::"WalletBalanceState")) LOOP
      SELECT COALESCE(SUM("deltaMinor"), 0)
      INTO state_total
      FROM "WalletBalanceAllocation"
      WHERE "accountId" = affected_account_id AND "currency" = affected_currency AND "state" = state_name;
      IF state_total < 0 THEN
        RAISE EXCEPTION 'Wallet allocation state % would become negative for account %', state_name, affected_account_id;
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM "WalletBalanceAllocation"
      WHERE "accountId" = affected_account_id AND "currency" = affected_currency
        AND "isOpeningBaseline" AND "baselineVerified"
    ) THEN
      SELECT "availableMinor", "pendingMinor", "heldMinor", "frozenMinor"
      INTO snapshot_available, snapshot_pending, snapshot_held, snapshot_frozen
      FROM "WalletBalance"
      WHERE "accountId" = affected_account_id AND "currency" = affected_currency;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Verified wallet opening baseline requires a balance snapshot for account %', affected_account_id;
      END IF;
      SELECT COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'AVAILABLE'), 0),
             COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'PENDING'), 0),
             COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'HELD'), 0),
             COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'FROZEN'), 0)
      INTO allocation_available, allocation_pending, allocation_held, allocation_frozen
      FROM "WalletBalanceAllocation"
      WHERE "accountId" = affected_account_id AND "currency" = affected_currency;
      IF allocation_available <> snapshot_available OR allocation_pending <> snapshot_pending
        OR allocation_held <> snapshot_held OR allocation_frozen <> snapshot_frozen THEN
        RAISE EXCEPTION 'Wallet allocation totals do not match the approved snapshot for account %', affected_account_id;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "wallet_assert_snapshot_allocation_match"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allocation_available BIGINT;
  allocation_pending BIGINT;
  allocation_held BIGINT;
  allocation_frozen BIGINT;
BEGIN
  SELECT COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'AVAILABLE'), 0),
         COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'PENDING'), 0),
         COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'HELD'), 0),
         COALESCE(SUM("deltaMinor") FILTER (WHERE "state" = 'FROZEN'), 0)
  INTO allocation_available, allocation_pending, allocation_held, allocation_frozen
  FROM "WalletBalanceAllocation"
  WHERE "accountId" = NEW."accountId" AND "currency" = NEW."currency";
  IF allocation_available <> NEW."availableMinor" OR allocation_pending <> NEW."pendingMinor"
    OR allocation_held <> NEW."heldMinor" OR allocation_frozen <> NEW."frozenMinor" THEN
    RAISE EXCEPTION 'Wallet snapshot update for account % does not match append-only allocations', NEW."accountId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "WalletLedgerTransaction_allocation_consistency_trigger"
AFTER INSERT ON "WalletLedgerTransaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_balance_allocation_consistency"();

CREATE CONSTRAINT TRIGGER "WalletLedgerPosting_allocation_consistency_trigger"
AFTER INSERT ON "WalletLedgerPosting"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_balance_allocation_consistency"();

CREATE CONSTRAINT TRIGGER "WalletBalanceAllocation_consistency_trigger"
AFTER INSERT ON "WalletBalanceAllocation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_balance_allocation_consistency"();

CREATE CONSTRAINT TRIGGER "WalletBalance_snapshot_allocation_trigger"
AFTER UPDATE ON "WalletBalance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_snapshot_allocation_match"();
