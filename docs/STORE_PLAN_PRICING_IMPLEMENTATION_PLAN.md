# SaaS Store plan pricing increment

## Repository and architecture findings

- Work starts on `feature/store-plan-pricing-billing`, branched from the verified latest `main` commit `1559f592e2f3e03ddf81e0997f962d33a38e4426`.
- The only pre-existing worktree item was the untracked `.vscode/` directory. It is preserved and excluded from this increment.
- `Store` is already the tenant boundary and has one `Seller` owner. Existing `StorePlan`, `StorePlanVersion`, and `StorePlanAssignment` models and `/api/admin/store-plans` routes are the plan system to extend; no duplicate tenant or plan catalog will be introduced.
- Admin plan management is in `apps/web/src/StorePlanAdmin.tsx`; seller entitlement display is in `apps/web/src/SellerStorePlan.tsx`. Existing plan authorization and entitlement checks are server-side and must remain so.
- Existing Stripe Checkout and PayPal Orders flows are one-time buyer payments to the platform merchant. They are not subscription billing. This increment will not reuse those flows or initiate provider calls.

## Implementation plan

1. Extend `StorePlanVersion` additively with description, currency, integer-minor monthly/annual/intro prices, optional annual discount, billing interval, term/expiration/cancellation rules, trial and introductory-offer durations, and effective dates. Keep migration defaults free and legacy-compatible for existing stores.
2. Add subscription, invoice, and provider-event history models with immutable agreed-term snapshots, idempotency uniqueness, integer money, and validated state transitions. No browser action or unsigned event will grant paid entitlements.
3. Extend the existing admin routes with strict server validation, exact decimal-string-to-minor-unit parsing, draft versioning, audit reasons, effective-date checks, and confirmation-driven activation/retirement. Prevent manual assignment of paid versions while subscription collection is disabled.
4. Add seller-scoped plan/billing and active offer APIs. Provide a read-only seller billing page and an explicit disabled checkout response. Keep subscription billing separate from buyer checkout, seller settlements, wallet, and Club Coins.
5. Extend the current admin plan screen with accessible pricing fields, annual savings and trial-vs-intro preview, version history, and high-impact confirmations. Preserve the existing entitlement manager and assignment history.
6. Add unit tests for exact money arithmetic and pricing combinations, API/database tests for authorization, immutable versions, free legacy compatibility, subscription snapshots/idempotency and disabled checkout, plus focused Playwright coverage.
7. Add one additive migration after `20261022000016_store_plans_entitlements`, validate/generate Prisma from the updated schema, and run the complete verification sequence only against a new unique loopback-only disposable PostgreSQL 17 database. Preserve the existing marketplace database/container.

## Billing boundary and unresolved decisions

Recurring checkout remains disabled because no SaaS subscription provider adapter, subscription-specific credentials, verified subscription webhooks, or sandbox verification exists in the current code. A later decision must select/configure a provider and decide tax treatment, platform funding/merchant eligibility, refunds/chargebacks, proration, grace periods, trial eligibility, cancellation and renewal policy, and operational reconciliation. This work will not claim subscription billing readiness and will not change wallet, Club Coins, buyer checkout, or seller payout gates.

## Verification and cleanup

Use the project E2E database safety guard, an isolated temporary Prisma schema/migration copy, a unique test-only database name and loopback port, and isolated temporary media storage. Do not read `.env` or `.env.example`; do not use provider/network services, destructive schema commands, owner data, or deployment resources. Remove only resources created for the verification run and confirm their absence. Stop at the first genuine test failure.
