# Monetization and Growth Implementation Plan

## Verified baseline

The repository is an uncommitted independent React/Vite + Express/TypeScript + Prisma/PostgreSQL application. Existing checks run before this work:

- `npm run test`: 10 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Prisma migration/seed and database-backed tests: blocked because the local Docker/PostgreSQL service did not respond.
- Browser E2E and real payment/provider sandbox tests: not configured or not run.
- There is no native Android or iOS client in this repository. Android-capable web push can be supported by a browser/PWA, but native Android push is a separate mobile scope.

## Delivery order

1. Extend the existing structured CMS and media rules for reusable storefront campaigns. Keep executable code, arbitrary HTML, and hidden tracking out of editable content.
2. Add server-authoritative catalog variants, favorites, and wholesale eligibility/tier data. Integrate variants into cart and order snapshots only after the additive migration is applied against PostgreSQL.
3. Add the affiliate application, consent-aware signed referral links, commission ledger snapshots, verified payment/COD settlement, append-only refund/chargeback/cancellation reversals, and manual payout workflow. Commissions are platform-funded liabilities; seller payouts, escrow, and automated affiliate settlement rails are not added.
4. Add durable in-app notification records, notification preferences, push-subscription registration, and an email outbox/provider adapter boundary. Do not send real mail or push notifications in local/test mode.
5. Add buyer/seller conversations with strict participant authorization and a provider-neutral AI adapter. AI remains optional, rate-limited, privacy-conscious, and fail-open for browsing and checkout.
6. Add operational dashboards, campaign delivery controls, reconciliation jobs, browser journeys, and PostgreSQL-backed tests.

## Current implementation boundary

This increment adds the affiliate workflow on top of the existing growth schema. It does not create paid provider accounts, send live messages, issue payouts, or claim delivery, AI accuracy, legal compliance, or ranking results.

## Owner decisions and blockers

- Select and approve an email delivery provider and sender domain. Credentials must be supplied through the deployment secret store; local mode remains non-delivering.
- Approve a payout rail, identity/tax process, jurisdiction, minimum threshold, and budget before any affiliate payout can be marked paid.
- Approve whether a native Android client is in scope. Until then, only server registration and compatible web push are supported.
- Approve an AI provider, privacy notice/consent, retention period, and usage budget. No API key is committed or invented.
- Configure production object storage and malware scanning before public media release. Local disk is development-only.
- Run the additive migration chain, seed, database-backed affiliate checks, regression checks, and browser E2E against a disposable local PostgreSQL instance before any staging decision.

## Security and consistency rules

All money remains integer minor units with an explicit currency. Affiliate clicks are server records with hashed single-use tokens and expiry; a browser query parameter is never accepted as conversion proof by itself. Ledger entries are append-only and idempotent. Every privileged mutation is authorized, rate-limited, and audited. Notification and message reads are scoped to the authenticated user or conversation participant. AI output is advisory and may only link to records returned by authorized catalog/content queries.

