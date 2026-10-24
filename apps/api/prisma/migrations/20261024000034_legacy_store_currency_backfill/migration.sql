-- Store.baseCurrency was introduced with a USD default because the legacy
-- application created products without setting Product.currency, so the
-- Product.currency database default (USD) applied. Reconcile from persisted
-- product and variant currencies anyway: installations may contain imported
-- or otherwise valid non-USD rows. A Store has one base currency, so mixed or
-- uncatalogued currencies must stop the upgrade rather than silently relabel
-- prices or choose an arbitrary currency.
DO $$
DECLARE
  mixed_store_count INTEGER;
  unsupported_currency_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO mixed_store_count
  FROM (
    SELECT store."id"
    FROM "Store" AS store
    JOIN (
      SELECT product."sellerId", product."currency"
      FROM "Product" AS product
      WHERE product."sellerId" IS NOT NULL
      UNION ALL
      SELECT product."sellerId", variant."currency"
      FROM "ProductVariant" AS variant
      JOIN "Product" AS product ON product."id" = variant."productId"
      WHERE product."sellerId" IS NOT NULL
    ) AS pricing ON pricing."sellerId" = store."sellerId"
    GROUP BY store."id"
    HAVING COUNT(DISTINCT pricing."currency") > 1
  ) AS mixed_stores;

  IF mixed_store_count > 0 THEN
    RAISE EXCEPTION 'Store currency backfill aborted: % Store(s) contain product or variant pricing in multiple currencies. Reconcile each Store currency before retrying migration 20261024000034.', mixed_store_count
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO unsupported_currency_count
  FROM "Store" AS store
  JOIN (
    SELECT product."sellerId", product."currency"
    FROM "Product" AS product
    WHERE product."sellerId" IS NOT NULL
    UNION ALL
    SELECT product."sellerId", variant."currency"
    FROM "ProductVariant" AS variant
    JOIN "Product" AS product ON product."id" = variant."productId"
    WHERE product."sellerId" IS NOT NULL
  ) AS pricing ON pricing."sellerId" = store."sellerId"
  LEFT JOIN "CurrencyCatalogEntry" AS currency ON currency."code" = pricing."currency"
  WHERE currency."code" IS NULL
     OR currency."active" = FALSE
     OR currency."storePricingEnabled" = FALSE
     OR pricing."currency" <> UPPER(pricing."currency");

  IF unsupported_currency_count > 0 THEN
    RAISE EXCEPTION 'Store currency backfill aborted: % product or variant pricing row(s) use a currency not available for Store pricing in the currency catalog. Map or reconcile those rows before retrying migration 20261024000034.', unsupported_currency_count
      USING ERRCODE = '23514';
  END IF;
END $$;

-- Empty Stores retain the legacy USD default. A Store with one represented
-- product currency adopts that currency without rewriting any product,
-- order, payment, or historical minor-unit amount.
UPDATE "Store" AS store
SET "baseCurrency" = product_currency."currency"
FROM (
  SELECT pricing."sellerId", MIN(pricing."currency") AS "currency"
  FROM (
    SELECT product."sellerId", product."currency"
    FROM "Product" AS product
    WHERE product."sellerId" IS NOT NULL
    UNION ALL
    SELECT product."sellerId", variant."currency"
    FROM "ProductVariant" AS variant
    JOIN "Product" AS product ON product."id" = variant."productId"
    WHERE product."sellerId" IS NOT NULL
  ) AS pricing
  GROUP BY pricing."sellerId"
  HAVING COUNT(DISTINCT pricing."currency") = 1
) AS product_currency
WHERE product_currency."sellerId" = store."sellerId";

-- Migration 30's generated USD compatibility offer is safe only while the
-- Store's inferred base currency remains USD. Preserve the row and all
-- explicit Store offers, but do not leave that generated USD capability
-- enabled after a non-USD legacy currency is inferred.
UPDATE "StoreCurrencyOffer" AS offer
SET "checkoutEnabled" = FALSE,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Store" AS store
WHERE offer."storeId" = store."id"
  AND offer."currency" = 'USD'
  AND offer."id" = 'legacy-usd-' || store."id"
  AND store."baseCurrency" <> 'USD'
  AND offer."checkoutEnabled" = TRUE;

-- Keep existing offers untouched. Add the Store's inferred base offer only
-- when absent; its checkout capability remains controlled by the catalog and
-- is not inferred from the historical currency alone.
INSERT INTO "StoreCurrencyOffer"
  ("id", "storeId", "currency", "displayEnabled", "checkoutEnabled", "createdAt", "updatedAt")
SELECT
  'legacy-base-' || store."id",
  store."id",
  store."baseCurrency",
  currency."active" AND currency."displayEnabled",
  currency."active" AND currency."checkoutEnabled",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Store" AS store
JOIN "CurrencyCatalogEntry" AS currency ON currency."code" = store."baseCurrency"
ON CONFLICT ("storeId", "currency") DO NOTHING;
