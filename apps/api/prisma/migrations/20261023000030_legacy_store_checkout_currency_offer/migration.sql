-- Existing Store base currencies are initialized to USD, matching the
-- pre-catalog listing currency. Preserve their current checkout path by
-- adding a USD Store offer only where one does not already exist. Never
-- overwrite an explicit Store-level capability choice.
INSERT INTO "StoreCurrencyOffer"
  ("id", "storeId", "currency", "displayEnabled", "checkoutEnabled", "createdAt", "updatedAt")
SELECT
  'legacy-usd-' || store."id",
  store."id",
  'USD',
  TRUE,
  currency."active" AND currency."checkoutEnabled",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Store" AS store
JOIN "CurrencyCatalogEntry" AS currency ON currency."code" = store."baseCurrency"
WHERE store."baseCurrency" = 'USD'
ON CONFLICT ("storeId", "currency") DO NOTHING;
