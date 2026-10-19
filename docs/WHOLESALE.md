# Wholesale purchasing

Products can declare wholesale eligibility, minimum quantity, pack-size increments, and integer-minor-unit tier prices. Wholesale applications are persisted per buyer and require admin approval. Restricted tier data is not returned to unauthenticated or unapproved buyers.

Current endpoints are `/api/wholesale/apply`, `/api/wholesale/me`, and `/api/products/:productId/wholesale-prices`. Product variants have independent SKU, price, status, and stock fields. Cart and checkout revalidate product/variant availability and use server-calculated variant prices.

No tax, shipping, currency conversion, quote settlement, or unpaid quote-to-order conversion is invented here. A complete quote workflow and any seller-specific wholesale terms require a separate tested product decision.

