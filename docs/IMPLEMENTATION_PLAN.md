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
# Admin control center and provider configuration increment (2026-10-22)

This additive increment organizes the Platform Administration view around existing routes and introduces a reference-only registry for the Stripe and PayPal adapter contexts implemented in the repository. It does not change subscription billing, seller-owned payment accounts, payout rails, wallet funding, Club Coins, or buyer payment-provider behavior. `LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE` defaults to `false`; provider setup records do not make network calls and do not imply provider verification. The admin guide and `docs/INTEGRATIONS_AND_PAYMENT_METHODS.md` describe the control boundaries and remaining setup decisions.

The implementation adds ProviderConfiguration and ProviderCredentialReference as append-preserving records with a uniqueness rule for current provider/context/environment entries. Context/provider/credential validation is enforced in the API and database. Admin mutations are CSRF-protected, role-protected, and audited transactionally with credential references omitted from audit data. Archived records remain stored. The admin interface marks unfinished refund/dispute, promotion, member-security, support, and webhook/API-status workflows as planned rather than presenting empty controls.

Verification status: the 19-migration chain and seed completed successfully on a fresh disposable PostgreSQL 17 database earlier in this increment. Prisma schema validation, a prior client generation, typecheck, lint, 102 unit tests, production build, and `git diff --check` passed. The focused integrations browser test passed (1/1). A broader selected browser run passed its first four tests, then found a stale assertion expecting the former admin heading; the assertion was updated to the control-center heading. The rerun is blocked: on a newly created guarded database, Prisma `migrate deploy` returned an empty `Schema engine error` before creating `_prisma_migrations`; direct read-only PostgreSQL access succeeded. No migrations were applied by that failed attempt. A later client-generation retry also encountered a Windows `EPERM` while replacing a Prisma engine DLL. Therefore the corrected broader browser suite has not been verified. No owner database, provider account, or deployment was used.

# Store content, media, and growth entitlements increment (2026-10-22)

This increment extends existing Store Plan versions and keeps `Store` as the tenant boundary. Basic blog and page publishing remain available for every plan; positive post/page quotas, media storage, scheduled publishing, advanced SEO, Store Buster, email marketing, and Store affiliate participation are separately configured entitlements. Existing plan versions and stores retain compatibility defaults, and activated plan versions remain immutable.

Store-scoped content APIs enforce ownership, quotas, revisions, publish states, media scan state, and audit records. Global CMS routes remain scoped to platform records. Seller media reservations use a Store lock and expire after one hour; direct object-storage uploads are short-lived and deployment-gated. Database media-reference guards preserve tenant scope and prevent public/private references from being reassigned or deleted. Because no malware scanner is provisioned, uploaded media remains quarantined and cannot be used in published content or public delivery. Browser editor drafts are optional local working copies, not durable backups.

Store Buster delivers only explainable organic recommendations based on first-party product/category signals and affirmative personalization consent. Opt-out clears stored signals; sellers see aggregate daily metrics only. Click metrics require one-use expiring impression tokens. Paid/sponsored placement has no delivery or billing implementation and remains disabled. Email plans currently provide plan limits and draft/list scaffolding only: there is no verified email provider, subscriber confirmation, or campaign delivery, and public signup fails closed. Store affiliate participation is plan-gated and reuses the existing platform affiliate ledger; it does not create seller commissions or seller payouts. Stores without a Store-specific participation record retain the legacy platform affiliate behavior.

Validation in progress for this local worktree: additive migrations 19-23, Prisma generation/validation, a fresh uniquely named loopback-only PostgreSQL 17 migration/seed, focused Store growth browser coverage, unit tests, typecheck, lint, build, and diff checks. No live provider calls, paid resources, deployment, wallet/Club Coins money movement, or live billing are authorized by this increment. Results will be recorded in the handoff after the disposable verification run.

# Platform and Store logo/favicon controls (2026-10-23)

The existing managed-media pipeline already supports admin-only platform logo/favicon assets and Store-owned image uploads with explicit owner/staff authorization, Store Plan media quotas, signature verification, server-side image decoding/normalization, quarantine, private previews, and approved-only public delivery. This increment adds the missing Store favicon field to the existing theme JSON (no Prisma data column is needed), validates it during draft save and publish, applies it to the public Store SPA and server-rendered Store content pages, and adds migration `20261023000025_store_favicon_media_guard` to preflight and enforce complete IMAGE references and tenant scope. Reference writes and media-kind changes share ordered transaction advisory locks. No records are rewritten. Existing logo/banner, avatar, payment, and plan behavior is unchanged. Managed object storage and a malware scanner remain deployment prerequisites.

# Durable media storage and malware scanning increment (2026-10-23)

Migration `20261023000026_durable_media_scanning` additively records media purpose, scan attempt IDs/counts/timestamps, safe error/provider codes, and retry indexes. It does not rewrite existing media rows. New avatar, platform/store branding, Store product, and platform CMS uploads reserve a short-lived object-scoped upload, upload directly from the browser to managed storage, then finalize through server-side size/type/signature/hash checks and raster normalization. Store media reservation/finalization remains scoped to the authenticated owner or explicitly authorized staff and enforces Store Plan quota. Approved-only delivery and private avatar access are unchanged.

An explicit ClamAV `clamd` INSTREAM adapter approves only a clean response; malware results reject, while unavailable scanner, protocol errors, timeouts, stale/duplicate attempts, or persistence errors remain private. Prior approved avatar/branding references are preserved until replacement approval and explicit publication where needed. Local object storage and scanner gates default off, and normal uploads do not fall back to disk or use a fake clean result. Tests use local synthetic adapters; they do not verify cloud storage or a real ClamAV service. Deployment decisions remain: select/configure the managed object service and server identity, private bucket CORS/lifecycle/backup policy, deploy ClamAV on a trusted private network with signature/health operations, define orphan cleanup and retention, and run a real staging smoke test before enabling uploads.
