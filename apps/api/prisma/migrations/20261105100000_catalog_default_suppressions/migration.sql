CREATE TABLE "CatalogDefaultSuppression" (
    "id" TEXT NOT NULL,
    "defaultKey" TEXT NOT NULL,
    "entityKind" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogDefaultSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogDefaultSuppression_defaultKey_key" ON "CatalogDefaultSuppression"("defaultKey");
