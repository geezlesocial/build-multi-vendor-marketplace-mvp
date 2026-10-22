# SaaS Store plans and entitlements

## Tenant model

The existing `Store` is the tenant boundary. It has one `Seller` owner; seller-owned products and staff memberships are scoped through that Seller. The schema continues to enforce one Store per Seller. This increment adds plan records and assignment history to that boundary; it does not introduce a parallel tenant/account model.

`StorePlan` is the administrative plan identity. Each edit to entitlements creates a new `StorePlanVersion`; activated versions are immutable. `StorePlanAssignment` records the Store, exact version, status, effective dates, assignment source, assigning administrator, and reason. A partial unique index permits at most one active assignment per Store. Reassignment closes the prior assignment and creates a new history row in one transaction. Admin audit records commit atomically with the corresponding plan or assignment change.

## Entitlements and enforcement

- `productLimit` counts all non-archived seller products, including pending/rejected listings. Product creation locks the Store row and checks the count in the same transaction. At the limit, the API returns HTTP 409 with `PLAN_LIMIT_REACHED`, the usage/limit, and an upgrade link. Archiving frees a slot; order history and product records remain intact.
- `storeLimit` is the maximum Store count per Seller account. The current schema makes that count at most one; multiple stores per account are not implemented.
- `vendorLimit` is distinct from `staffSeatLimit`. Each current Store has exactly one Seller owner/vendor, while `staffSeatLimit` counts `SellerStaff` rows only. Store-plan assignment refuses a cap below the Store/vendor topology already in use. A database trigger serializes staff-seat inserts against Store plan changes and rejects a new staff seat when the active cap is reached. There is no staff-invitation UI/API in this increment.
- `allowedThemes` and `mobileTemplates` are typed allowlists. Seller theme draft and publish operations check the effective Store assignment under the Store lock. Existing persisted choices are grandfathered when a plan is downgraded; changing to an unentitled choice returns HTTP 409 `PLAN_ENTITLEMENT_REQUIRED`. Supported theme presets are fixed, code-owned designs; arbitrary HTML/CSS/JavaScript remains unsupported.
- `customDomainEligible` is an eligibility flag only. DNS, TLS, domain ownership verification, and routing are not implemented.
- `paymentConnectors` records eligibility only. It does not connect seller merchant accounts or alter existing platform-owner Stripe/PayPal checkout, payouts, or money flows. Seller-specific checkout connectors remain unimplemented.
- Mobile templates are responsive web storefront variations. Native iOS/Android builds, store submission, app provisioning, and publishing are not implemented.

Entitlement failures never remove products, staff, orders, or published content. A plan downgrade may leave a Store over a product/staff quota; current data and access remain, while new product or staff-seat additions are blocked until within the limit or reassigned. Retiring a plan blocks new assignments, but existing Stores continue using their assigned version. The system-managed `legacy-compatible` plan cannot be edited or retired.

## Compatibility migration and seed

Migration `20261022000016_store_plans_entitlements` is additive. It creates a high-limit, active `Legacy compatible` version and assigns each Store present at migration time to that version. For a newly seeded local database, the idempotent seed creates the demo Store assignment after migration. Stores created outside this seed/migration path without an assignment use the same generous server fallback until an administrator assigns a version. No existing migration is rewritten, no records are deleted, and the compatibility product/staff limits avoid blocking current sellers.

## API and screens

Admin-only API:

- `GET/POST /api/admin/store-plans`
- `PATCH /api/admin/store-plans/:id` (name plus a new draft version)
- `POST /api/admin/store-plans/:id/activate`
- `POST /api/admin/store-plans/:id/retire`
- `GET /api/admin/store-plan-stores`
- `GET/POST /api/admin/store-plan-stores/:storeId/assignments`

Seller/cashier API: `GET /api/seller/plan`. It derives the Store from the authenticated seller scope; it does not accept a Store ID from the client. Admin plans are managed under Platform administration → Store plans. Sellers can view their active version and usage at `/seller/plan`.

## Deferred decisions

Before recurring billing or more advanced tenant plans, decide plan pricing/currency, tax treatment, billing provider and funding model, trial/proration/grace-period/cancellation policy, and subscription collection/refunds. Before enabling multiple Stores per account or multiple vendors inside a Store, redesign and review ownership, roles, data isolation, orders, inventory, messaging, and billing. Seller payment connectors, custom-domain provider/ownership/DNS/TLS operations, staff invitation/revocation, native mobile publishing, and production plan operations require separate designs and verification. Local tests and this entitlement implementation do not imply production readiness.

Wallet and Club Coins remain hard-disabled by server defaults. The latest reported disposable-database regression matrix passed, including refund isolation and target-ownership concurrency coverage; this is test evidence only and does not mean live-money, provider, finance, or production readiness.
