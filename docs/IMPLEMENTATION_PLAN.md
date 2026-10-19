# Implementation plan

## Assumptions

- The target folder was empty and had no existing package manager or Git repository.
- The application uses PostgreSQL through Prisma and npm workspaces.
- Currency is a configured ISO currency (`CURRENCY`, default USD); all amounts are integer minor units.
- Delivery is captured as an address only. No tax, shipping-rate, carrier, or advanced financial-reporting engine is included.
- Platform-owned products have no seller ID. Seller products require an approved seller and an enabled multi-vendor setting.

## Architecture

`apps/web` is a responsive React/Vite client. `apps/api` is an Express TypeScript API. Prisma owns the normalized PostgreSQL schema. Sessions are revocable, httpOnly cookies backed by hashed session tokens. Payment provider credentials are environment values only.

## Phase status

1. Inspect and plan — complete. Empty folder, Node 22, npm 10, Git, and Docker detected.
2. Foundation — complete in source: workspaces, TypeScript, Docker Compose, Prisma schema, environment validation, seed, scripts.
3. Authentication/authorization — complete baseline: registration/login/logout, roles, seller status checks, server-side seller scoping.
4. Catalog/storefront — complete baseline: searchable approved catalog, cart, buyer UI, seller product creation/update routes, admin seller moderation.
5. Checkout/orders/inventory — complete baseline: parent and seller orders, integer money, transactional stock decrement, COD, explicit order/payment state.
6. Payments/switches — Stripe Checkout and PayPal Orders v2 adapters plus admin switches are present; provider sandbox verification remains environment-dependent.
7. POS — complete baseline: approved seller/cashier cash POS, transactional stock decrement, persisted POS order and printable receipt.
8. Hardening — baseline security middleware, rate limits, validation, audit records, health/readiness, and unit validation tests are present. Static checks passed locally. Database-backed migration/seed and browser/provider E2E execution remain to be run after Docker PostgreSQL is available.
9. Handover — documentation delivered in `docs/`.

## Risks and follow-up decisions

- PayPal webhook verification must be configured with the registered webhook ID and verified using the PayPal verification flow before staging.
- A production deployment needs a real secret manager, HTTPS, MFA enforcement for admins, backups, monitoring, and operational runbooks.
- The verification host's Docker daemon did not respond during the final persistence smoke test; no database-backed acceptance result is claimed from this run.
- Payment failure after stock reservation needs a documented reservation-release policy before a high-volume deployment.
- Seller settlement is a separate product/financial scope decision and must not be inferred from payment success.
