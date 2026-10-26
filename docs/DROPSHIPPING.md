# Seller dropshipping integrations

Supplier integrations appear under Seller dashboard → Dropshipping only when the active Store plan includes the `dropshippingEnabled` entitlement. Administrators control this entitlement in Store plan administration; the API independently enforces it for connection, search, and import operations. Free/legacy plans cannot connect supplier accounts.

## Available providers

- CJdropshipping: implemented account-key connection, access-token refresh, catalog search, and seller-selected product import through CJ API 2.0.
- AliExpress Dropshipping: listed as an approval-dependent provider, not connected yet. AliExpress requires a Dropshipping AppKey application/approval and participating users to join its Dropshipping Center.
- Alibaba.com Open Platform: listed as an approval-dependent provider, not connected yet. Developer/app registration and API permissions are required, and its API surface is not a substitute for AliExpress dropshipping.

These are commercial supplier platforms, not open-source software. CJ documents free API access, but its current API is points-metered; product, shipping, quota, and supplier terms may still apply. Sellers must obtain their supplier credentials and comply with provider terms.

## CJ credentials and setup

1. In Admin → Store plans, create/activate a paid plan version with supplier dropshipping enabled.
2. Assign/subscribe an eligible Store to that plan.
3. The seller creates an API key in their own CJ account and connects it in the seller dashboard.
4. In production set a unique, long, server-only `DROPSHIPPING_ENCRYPTION_KEY` (at least 32 characters). The API key, access token, and refresh token are encrypted with AES-256-GCM before persistence. They are never returned by the API or logged. Development derives a separate key from `PASSWORD_PEPPER` if the dedicated variable is absent.
5. Apply the new database migration and regenerate Prisma Client before starting the app.

The importer fetches a supplier item, asks the seller to provide the listing price in the Store currency's minor units and starting stock, then creates a `PENDING` physical product with a unique supplier mapping. This keeps imports unpublished until reviewed and prevents the same supplier product being imported twice into one Store.

## Explicit current limits

The current adapter imports catalog data only. It does not place supplier orders, route marketplace buyer orders to suppliers, synchronize stock or cost continuously, calculate supplier shipping, or guarantee supplier/marketplace tracking. The displayed stock is an API snapshot; the seller-entered stock is a manual listing value. Sellers remain responsible for item descriptions, image rights, retail pricing, stock accuracy, shipping expectations, refunds, and supplier terms. AliExpress and Alibaba.com do not accept credentials in the UI until their approved APIs have a reviewed implementation.

## Official references

- [CJ API overview and product API](https://developers.cjdropshipping.com/en/api/api2/api/product.html)
- [CJ authentication and token refresh](https://developers.cjdropshipping.com/en/api/api2/api/auth.html)
- [CJ API points and usage limits](https://developers.cjdropshipping.com/en/api/api2/standard/points.html)
- [AliExpress official dropshipping API onboarding](https://developer.alibaba.com/docs/doc.htm?articleId=120418&docType=1&treeId=762)
- [Alibaba.com Open Platform onboarding](https://openapi.alibaba.com/doc/doc.htm)
