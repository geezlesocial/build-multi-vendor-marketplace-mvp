# Store subscription billing lifecycle

Status: implementation is locally testable but not provider-verified. Store subscription checkout remains disabled by default. This is a platform subscription capability and is separate from buyer checkout, seller-owned payment accounts, seller payouts, wallet funding, and Club Coins.

## Scope and policy

- The only implemented provider adapter is Stripe Billing in test mode, behind `STORE_PLAN_BILLING_SANDBOX_ENABLED=false` by default. Enabling it is rejected in production and requires a dedicated `sk_test_` key plus a separate Stripe Billing webhook signing secret. These values are deployment configuration only; the UI and database contain no secret material.
- USD is the only supported subscription currency. The Stripe adapter creates monthly or annual recurring Checkout sessions from immutable plan-version prices. Tax collection and proration are disabled. Annual savings are calculated by the existing plan-pricing domain.
- A Store may consume one free trial, enforced while holding the Store row lock. Trial entitlements begin only after a signed provider event confirms the exact configured trial duration. A subscription object with `active` status does not grant a paid plan; a matching, correctly priced paid invoice is required.
- Paid introductory offers and fixed-duration terms are deliberately unavailable for Stripe checkout in this increment. Their plan versions remain visible with a precise unavailable reason; they are not re-labelled as trials and no alternative price is charged.
- `CANCEL_AT_TERM_END` schedules cancellation without proration. `CANCEL_ANYTIME` requests immediate cancellation without proration. No automatic refund is issued. Refund events update invoice history only and do not change entitlements.
- A first delinquency receives a seven-day grace period. Repeated failure/status notifications do not extend the original deadline. Stale invoice-period events cannot move subscription state backwards. At expiry, the immutable plan's configured behavior either restores the legacy-compatible assignment or suspends the seller.

## Persistence and recovery

Migration `20261025000035_store_subscription_sandbox_idempotency` additively adds nullable checkout-session and hashed request-key references with uniqueness constraints; existing subscription rows are preserved. The subscription row snapshots the exact agreed prices, currency, interval, plan version, trial, cancellation, expiration, no-tax, and no-proration terms. A Store can have only one outstanding checkout/subscription at a time.

Checkout requires an `Idempotency-Key`; only its SHA-256 hash is stored. Provider requests use a stable local-subscription idempotency key. A retry returns the same open checkout session. If the local request is too old to rely on Stripe's idempotency retention and no session reference was saved, it fails closed rather than creating another session.

The signed webhook inbox has a unique provider/event identity and records only a safe object summary. Subscription, invoice, plan assignment, and audit changes run atomically in one PostgreSQL transaction under Store-then-subscription locks. Failed processing is recorded separately and returns a non-2xx response so a provider retry can resume it; APPLIED and IGNORED duplicate events are idempotent. Trial/paid entitlement changes and audit records commit together. A minute scheduler applies due expiry behavior; repeated scheduler execution is safe.

## Seller experience and operations

The seller Plan & Billing page shows the current plan/usage, current subscription state, saved price and interval, trial/next-charge/access-expiry dates, cancellation terms, invoice history, and unavailable reasons. Before any supported checkout redirect it confirms the recurring price, trial, next charge, no-tax treatment, and cancellation terms. The admin Integrations view reports only whether the dedicated sandbox gate is enabled; existing marketplace provider switches remain separate.

No Stripe request is made by tests. Browser tests use locally generated Stripe-compatible signatures and synthetic webhook payloads. They exercise event authentication and lifecycle logic only—not a Stripe account, Checkout session, subscription schedule, tax, card collection, or actual payment.

Before enabling even the sandbox gate, provision a dedicated Stripe test account, restricted test-mode key, webhook endpoint restricted to the Store billing route, signing secret, delivery/retry monitoring, and an operator runbook. A controlled sandbox smoke test is still required to verify Stripe's current Checkout and cancellation behavior. Before live billing, separately review tax, consumer cancellation/refund law, accounting, dunning, invoice rendering, support processes, service availability, and secret-manager/rotation controls. No live billing is implemented or approved here.

## Local verification — 2026-10-25

A fresh uniquely identified loopback-only PostgreSQL 17 database passed the E2E guards; all 36 migrations deployed and the seed passed. The focused Store Plan billing spec passed 3/3 and the latest full serial Playwright suite passed 66/66. Typecheck, lint, API unit tests (130/130), production build, and `git diff --check` passed. The suite includes regression coverage proving delayed paid-invoice and trial events cannot reactivate a cancelled subscription; paid invoice history is retained, duplicates do not duplicate audit work, and Store entitlement state remains unchanged. Test-mode webhook lifecycle coverage used locally signed synthetic fixtures; no Stripe or other provider was contacted. These results do not verify a Stripe account, Checkout session, live billing, PayPal signatures, seller funding/payout settlement, or production readiness. The billing gate remains disabled by default.
