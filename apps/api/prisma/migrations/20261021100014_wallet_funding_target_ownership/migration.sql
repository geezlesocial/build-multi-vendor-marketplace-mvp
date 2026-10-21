-- Refuse to install the invariant over inconsistent historical funding rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "WalletFundingIntent" intent
    LEFT JOIN "WalletAccount" account ON account."id" = intent."accountId"
    WHERE account."id" IS NULL
       OR account."userId" IS DISTINCT FROM intent."userId"
       OR account."type" <> 'USER'
  ) THEN
    RAISE EXCEPTION 'WalletFundingIntent contains a non-user or mismatched wallet target; manual review is required before migration';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "wallet_assert_funding_intent_user_wallet"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_user_id TEXT;
  account_type "WalletAccountType";
BEGIN
  -- Funding-intent ownership/target is immutable after creation. This keeps
  -- target changes from reversing the account -> intent lock order.
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId" THEN
      RAISE EXCEPTION 'Wallet funding intent owner and target are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'WalletFundingIntent_target_immutable';
    END IF;
    RETURN NEW;
  END IF;

  -- Lock order: a new intent takes its WalletAccount row lock before inserting
  -- the WalletFundingIntent row. FOR UPDATE conflicts with both UPDATE's
  -- FOR NO KEY UPDATE lock (for type) and FOR UPDATE lock (for owner/key).
  -- The reciprocal account trigger already holds this account row before it
  -- checks references and never locks intent rows, so there is no reverse wait.
  SELECT "userId", "type"
    INTO account_user_id, account_type
  FROM "WalletAccount"
  WHERE "id" = NEW."accountId"
  FOR UPDATE;

  IF NOT FOUND
     OR account_user_id IS DISTINCT FROM NEW."userId"
     OR account_type <> 'USER' THEN
    RAISE EXCEPTION 'Wallet funding intent must target its owner user wallet'
      USING ERRCODE = '23514', CONSTRAINT = 'WalletFundingIntent_user_wallet_check';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "WalletFundingIntent_user_wallet_guard_trigger"
BEFORE INSERT OR UPDATE OF "userId", "accountId" ON "WalletFundingIntent"
FOR EACH ROW EXECUTE FUNCTION "wallet_assert_funding_intent_user_wallet"();

CREATE OR REPLACE FUNCTION "wallet_prevent_funding_target_reassignment"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- UPDATE has acquired this WalletAccount row before this BEFORE ROW trigger.
  -- New funding intents take the same row lock before insertion, so whichever
  -- operation gets it first is observed by this check or by the intent guard.
  IF (NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."type" IS DISTINCT FROM OLD."type")
     AND EXISTS (
       SELECT 1 FROM "WalletFundingIntent" intent
       WHERE intent."accountId" = OLD."id"
     ) THEN
    RAISE EXCEPTION 'Wallet account owner and type cannot change while funding intents reference it'
      USING ERRCODE = '23503', CONSTRAINT = 'WalletAccount_funding_target_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WalletAccount_funding_target_immutable_trigger"
BEFORE UPDATE OF "userId", "type" ON "WalletAccount"
FOR EACH ROW EXECUTE FUNCTION "wallet_prevent_funding_target_reassignment"();
