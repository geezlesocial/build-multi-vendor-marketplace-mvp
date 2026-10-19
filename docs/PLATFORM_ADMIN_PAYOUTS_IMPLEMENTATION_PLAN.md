# Platform administration, branding, governance, and seller payouts plan

## Verification status (2026-10-19)

Implemented with additive migration `20261019000005_platform_admin_payouts`. A fresh PostgreSQL 17 database was migrated and seeded successfully. Unit tests passed 19/19 and the combined Playwright suite passed 8/8 against a fresh seeded database. Typecheck, lint, production build, and Prisma validation passed. Stripe Connect and PayPal Payouts provider sandbox verification was not run because no provider payout credentials or owner approval were supplied; both remain disabled and no transfer path is exposed.

## Baseline findings

The repository is an uncommitted React/Vite + Express/TypeScript + Prisma/PostgreSQL monolith. Existing work includes CMS/media quarantine, marketplace and payment settings, seller/product status controls, audit logs, affiliate ledgers, Stripe/PayPal buyer checkout, COD, POS, and live-shopping gates. There is no seller payout subsystem, no platform branding model, no brand taxonomy model, and no seller theme model. `Category` and seller/product status models already exist and will be extended rather than duplicated.

The checkout payment records represent money received by the platform owner. They are not seller settlement records. This increment will keep that boundary explicit and will not assume who funds seller payouts, seller country eligibility, fee treatment, tax treatment, or provider approval.

## Additive design

- Add versioned platform branding drafts/assets using the existing `MediaAsset` quarantine and delivery rules.
- Extend marketplace settings with typed seller/product approval policies and payout-method feature flags. Do not store secrets in settings.
- Add safe seller-store theme JSON and publish/version records, scoped by seller.
- Add `Brand`, category parent/depth and governance fields, and slug redirect support where compatible with the current catalog.
- Add payout method, encrypted manual detail reference, seller payout ledger, payout request, provider event, and audit records. Ledger corrections are compensating entries.
- Keep seller payout state separate from `Payment`, `ParentOrder`, affiliate commissions, and buyer checkout state. Settlement eligibility will require configured policy and authoritative order/refund/COD state.

## API/UI and permissions

- `ADMIN` manages global settings, branding, seller/product policies, taxonomy, payout methods, payout queue, reconciliation, and sensitive payout reads.
- `SELLER` manages only their own store theme, eligible catalog data, and payout setup; private payout fields are masked.
- `CONTENT_EDITOR` retains existing CMS permissions and cannot change payout, global branding, indexing, or approval controls.
- Buyers and cashiers receive only public catalog/store data and no payout details.
- All privileged changes and sensitive payout reads use the existing audit helper.

## Provider boundary and blockers

Manual bank/e-wallet methods will be implemented as reviewable records only. Stripe Connect and PayPal Payouts will have readiness/configuration gates, provider-reference storage, idempotency, webhook verification, and disabled-by-default behavior. No live transfer will be made without owner approval, provider credentials, country/currency eligibility, business policy, and sandbox evidence. Required funding source, reserve/hold window, seller agreements, tax/identity process, supported countries/currencies, and fee/commission rules remain owner decisions.

## Verification plan

Use a new disposable local PostgreSQL cluster and additive Prisma migrations only. Run schema validation, migration deploy, seed, unit tests, database-backed authorization/taxonomy/ledger tests, API tests, browser E2E for admin branding/vendor review/store preview/payout setup, existing CMS/affiliate/payment/COD/POS/live regressions, typecheck, lint, build, and source/secret scans. Provider sandbox checks will be reported separately and remain skipped when credentials are absent.
