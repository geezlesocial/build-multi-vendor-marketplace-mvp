# SaaS Store plans and entitlements

## Tenant model

The existing `Store` is the tenant boundary. It has one `Seller` owner; seller-owned products and staff memberships are scoped through that Seller. The schema continues to enforce one Store per Seller. This increment adds plan records and assignment history to that boundary; it does not introduce a parallel tenant/account model.

`StorePlan` is the administrative plan identity. Each edit to entitlements or commercial terms creates a new `StorePlanVersion`; activated versions are immutable in both the API and database trigger. Plan versions snapshot currency, integer-minor monthly and annual amounts, discount, interval, trial, paid introductory terms, term length, cancellation/expiration behavior, effective dates, and entitlements. `StorePlanAssignment` records the Store, exact version, status, effective dates, assignment source, assigning administrator, and reason. A partial unique index permits at most one active assignment per Store. Reassignment closes the prior assignment and creates a new history row in one transaction. Admin audit records commit atomically with the corresponding plan or assignment change.

All price entry is parsed from decimal strings into integer minor units; persisted amounts and provider comparisons do not use floating point. This increment permits USD, SGD, EUR, GBP, AUD, CAD, and NZD, all with two decimal places. Annual discount arithmetic uses integer rounding; the admin preview displays the annual total and savings against twelve monthly payments. Free-trial days are separate from a paid introductory amount/duration. If both are configured, the free trial precedes the paid intro, then normal recurring billing. A paid intro cannot be zero; a zero-price period must be represented as a free trial. Terms shown to sellers include price, currency, interval, trial/intro distinction, and cancellation terms.

## Entitlements and enforcement

- `productLimit` counts all non-archived seller products, including pending/rejected listings. Product creation locks the Store row and checks the count in the same transaction. At the limit, the API returns HTTP 409 with `PLAN_LIMIT_REACHED`, the usage/limit, and an upgrade link. Archiving frees a slot; order history and product records remain intact.
- `storeLimit` is the maximum Store count per Seller account. The current schema makes that count at most one; multiple stores per account are not implemented.
- `vendorLimit` is distinct from `staffSeatLimit`. Each current Store has exactly one Seller owner/vendor, while `staffSeatLimit` counts `SellerStaff` rows only. Store-plan assignment refuses a cap below the Store/vendor topology already in use. A database trigger serializes staff-seat inserts against Store plan changes and rejects a new staff seat when the active cap is reached. There is no staff-invitation UI/API in this increment.
- `allowedThemes` and `mobileTemplates` are typed allowlists. Seller theme draft and publish operations check the effective Store assignment under the Store lock. Existing persisted choices are grandfathered when a plan is downgraded; changing to an unentitled choice returns HTTP 409 `PLAN_ENTITLEMENT_REQUIRED`. Supported theme presets are fixed, code-owned designs; arbitrary HTML/CSS/JavaScript remains unsupported.
- `seofyEnabled` gates SEO-FY audits, optional privacy-safe aggregate learning, and seller-approved Store/product metadata updates. It defaults to false for legacy and platform Stores. Plan administration rejects enabling it on a free plan; each seller API operation independently verifies the approved seller, own-Store scope, active paid subscription, and active entitled plan version. Downgrades preserve saved SEO metadata and reports, but immediately block new audits, learning changes, and apply operations until a valid paid entitlement is active again.
- `customDomainEligible` gates the seller dashboard's custom-domain setup. The app verifies a seller ownership TXT proof and the configured `CUSTOM_DOMAIN_TARGET` CNAME, then resolves verified hostnames to the Store storefront. Hosting-provider hostname registration, edge routing, and HTTPS/TLS certificate provisioning remain deployment responsibilities; a DNS-verified state is not proof that a public website is live.
- Seller commission policies now have an additive all-free-Stores scope. The active policy is applied in each new order's currency only when the Store's effective plan is free; paid Store Plan subscribers and the official platform Store are exempt. Legacy per-Store/per-plan policies remain stored for audit/history but are not used for new orders. Existing order snapshots and ledger entries are unchanged.
- `paymentConnectors` records eligibility only. It does not connect seller merchant accounts or alter existing platform-owner Stripe/PayPal checkout, payouts, or money flows. Seller-specific checkout connectors remain unimplemented.
- Mobile templates are responsive web storefront variations. Native iOS/Android builds, store submission, app provisioning, and publishing are not implemented.

Entitlement failures never remove products, staff, orders, or published content. A plan downgrade may leave a Store over a product/staff quota; current data and access remain, while new product or staff-seat additions are blocked until within the limit or reassigned. Retiring a plan blocks new assignments, but existing Stores continue using their assigned version. The system-managed `legacy-compatible` plan cannot be edited or retired.

## Compatibility migration and seed

Migration `20261022000016_store_plans_entitlements` is additive. It creates a high-limit, active `Legacy compatible` version and assigns each Store present at migration time to that version. For a newly seeded local database, the idempotent seed creates the demo Store assignment after migration. Stores created outside this seed/migration path without an assignment use the same generous server fallback until an administrator assigns a version. No existing migration is rewritten, no records are deleted, and the compatibility product/staff limits avoid blocking current sellers.

Migration `20261022000017_store_plan_pricing_billing` is additive. Pricing columns default to zero and compatible terms for existing versions; it creates subscription, invoice, and provider-event history tables with money/date checks and provider-event/idempotency uniqueness. It does not create subscriptions, require payment, or alter existing Store assignments. Activated version terms cannot be updated or deleted by direct SQL; lifecycle status may only move from active to superseded.

## API and screens

Admin-only API:

- `GET/POST /api/admin/store-plans`
- `PATCH /api/admin/store-plans/:id` (name plus a new draft version)
- `POST /api/admin/store-plans/:id/activate`
- `POST /api/admin/store-plans/:id/retire`
- `GET /api/admin/store-plan-stores`
- `GET/POST /api/admin/store-plan-stores/:storeId/assignments`

Seller/cashier API: `GET /api/seller/plan`. It derives the Store from the authenticated seller scope; it does not accept a Store ID from the client. Admin plans are managed under Platform administration → Store plans. Sellers can view their active version and usage at `/seller/plan`.

## Subscription billing status and boundary

Seller billing APIs are `GET /api/seller/plan-options`, `GET /api/seller/billing`, and `POST /api/seller/billing/subscribe`. All derive Store scope from the authenticated approved seller. The seller page shows current terms, usage, available offers, subscription/invoice history when present, and an explicit unavailable state. Subscribe returns `503 PLAN_BILLING_DISABLED` without creating a subscription or extending entitlements. Manual Store assignment accepts only genuinely free versions while checkout is disabled.

The subscription, invoice, and provider-event models are reserved for a future verified billing integration. Subscription/invoice amounts use integer minor units; immutable agreed terms are snapshotted; provider IDs and invoice idempotency keys have uniqueness constraints. There is currently no subscription provider adapter, subscription-specific credential configuration, signed SaaS billing webhook handler, or sandbox-verified recurring checkout. Existing Stripe Checkout and PayPal Orders are one-time buyer purchases to the platform and are not reused. No API/browser signal can mark a subscription paid or assign paid entitlements. SaaS fees are paid to the platform owner and remain separate from buyer product checkout, seller payouts, wallet, and Club Coins.

Before enabling billing, decide provider/account eligibility and funding, taxes, refunds and chargebacks, grace periods, trial eligibility, proration, cancellation/renewal/expiration semantics, reconciliation, and support procedures. Then build and sandbox-verify the provider adapter, signed/idempotent webhooks, retries, cancellation/refund cases, and entitlement assignment transition. Until then plan checkout is disabled and this increment is not production or live-billing ready.

## Deferred decisions

Before enabling multiple Stores per account or multiple vendors inside a Store, redesign and review ownership, roles, data isolation, orders, inventory, messaging, and billing. Seller payment connectors, custom-domain provider/ownership/DNS/TLS operations, staff invitation/revocation, native mobile publishing, and production plan operations require separate designs and verification. Local tests and this entitlement implementation do not imply production readiness.

Wallet and Club Coins remain hard-disabled by server defaults. The latest reported disposable-database regression matrix passed, including refund isolation and target-ownership concurrency coverage; this is test evidence only and does not mean live-money, provider, finance, or production readiness.
