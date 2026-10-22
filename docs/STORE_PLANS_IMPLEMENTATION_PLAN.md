# Store plans and entitlements implementation plan

## Existing tenancy and boundaries

`Store` is already the storefront tenant: it belongs one-to-one to `Seller`; seller catalog rows, seller dashboard queries, and staff memberships are scoped through that seller. This increment extends `Store` with plan assignment history and does not add another tenant/organization layer.

The current schema has one seller/vendor owner and one Store per seller. `SellerStaff` represents staff seats, not additional vendors. The plan model keeps `storeLimit`, `vendorLimit`, and `staffSeatLimit` as separate integer entitlements. The current topology reports one Store and one owner-vendor per Store; it does not add multiple-store or multi-vendor membership workflows. Such workflows need a separate ownership/topology decision.

## Data and migration

- Add typed `StorePlan`, immutable `StorePlanVersion`, and append-only `StorePlanAssignment` models with effective dates/status and assigning admin/source.
- Add typed theme, connector, and responsive mobile-template enums; avoid unvalidated entitlement JSON.
- Add database checks for positive resource limits and valid assignment date ranges.
- The additive migration creates a broad `Legacy-compatible` active plan/version and assignments for every existing Store. It does not edit prior migrations, remove records, or constrain existing sellers unexpectedly.
- Seed remains idempotent and ensures the local demo Store has its migration-provided assignment.

## APIs and enforcement

- Admin-only APIs create plans/draft versions, activate versions, retire plans, list history, and assign an active version to a Store. Mutations and audit rows commit atomically.
- A seller-scoped plan API resolves the Store from the authenticated seller, never a caller-supplied tenant ID, and reports plan version, usage, and limits.
- Product creation locks the Store row and enforces the current version's product quota transactionally. Over-quota assignments preserve products but prevent additional creations with a structured upgrade/limit response.
- Store theme draft/save and publish validate the selected theme and responsive template against the effective assignment. Existing legacy assignments allow all currently supported safe themes/templates.
- Store/vendor caps are recorded and checked against the existing one-Store/one-owner topology; staff seats remain a separate count and a plan cannot silently remove existing staff. No staff-invitation API exists today.
- Connector entitlements are eligibility declarations only. They do not add seller checkout credentials, seller payment processing, Stripe Connect, or payout behavior. Custom-domain eligibility does not provision DNS/TLS. Responsive storefront templates do not publish native apps.

## UI and verification

- Add a Plans area to platform administration for draft creation/editing, activation, retirement, Store assignment, and history.
- Add a seller plan page showing the active immutable version, included capabilities, and Store/vendor/staff/product usage.
- Add unit tests for entitlement validation and API/E2E tests for admin authorization, version lifecycle, quota boundaries, retired-plan assignment denial, audit/history, seller scoping, and legacy migration bootstrap.
- Validate and generate Prisma Client; apply the full migration chain and seed only on a new uniquely named disposable PostgreSQL database; run unit, type, lint, build, focused E2E, and relevant regressions.

## Decisions deferred

Recurring billing/proration, payment collection for subscriptions, multi-Store ownership, multiple vendors within one Store, staff invitation and seat lifecycle, seller-owned payment provider integrations, custom-domain DNS/TLS, native mobile publishing, plan pricing/tax policy, and production provisioning remain out of scope. Wallet and Club Coins remain hard-disabled and are not production/live-money ready.
