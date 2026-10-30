ALTER TABLE "WalletAccount"
ADD COLUMN "walletId" VARCHAR(16);

CREATE UNIQUE INDEX "WalletAccount_walletId_key" ON "WalletAccount"("walletId");

ALTER TABLE "WalletTransfer"
ADD COLUMN "adminReason" VARCHAR(500),
ADD COLUMN "adminReference" VARCHAR(160);
