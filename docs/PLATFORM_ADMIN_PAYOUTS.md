# Platform administration and seller payouts

This increment adds audited platform branding drafts, seller/vendor administration, manual seller/product approval policies, safe seller storefront themes, category/brand governance, and a separate seller payout subsystem.

## Boundaries

Buyer checkout still collects funds into the platform merchant accounts. A checkout payment is not a seller payout. The payout funding policy is an explicit setting and defaults off. No payout obligation is created until an authorized owner configures and enables that policy.

The current implementation supports manual bank and e-wallet method records, encrypted at-rest details, append-only funding entries, seller payout requests, admin review, and evidence-backed manual settlement records. Stripe Connect and PayPal Payouts are readiness-gated references only: no live transfer is sent, no provider onboarding is completed, and no payout is marked paid from a create-request response.

## Admin operation

Use `/admin/platform` as an authenticated administrator. The controls cover:

- branding draft/save/publish and revision rollback;
- seller and product approval policies, with manual approval as the default;
- vendor directory and seller moderation reasons/history;
- category nesting (maximum three levels), brands, status, ordering, and delete constraints;
- payout feature/funding switches, hold days, threshold, method readiness, and the review queue.

Published branding can be read through `GET /api/platform/branding`. Quarantined media may be referenced by a draft, but publication rejects it until the existing media scanner marks it `APPROVED`.

## Seller operation

Approved sellers can use `/seller/platform` to save/publish the allowlisted store theme and configure an enabled manual payout method. Sensitive manual details are encrypted with `PAYOUT_ENCRYPTION_KEY` when configured; local development derives a key from `PASSWORD_PEPPER`. Only a masked identifier is returned.

Payout eligibility is deliberately conservative: funding must be enabled, the seller order must be paid and fulfilled, the configured hold period must have passed, and the seller must have a ready method. The ledger is append-only and payout items prevent reuse of the same funding entry.

Manual settlement requires an authorized admin to approve the request and provide a payment reference plus evidence note before marking it paid. Provider modes remain disabled unless the owner verifies account eligibility, credentials, webhooks, sandbox behavior, failure handling, and reconciliation.

## Required environment names

`PAYOUT_ENCRYPTION_KEY` is optional for local development but required by the owner’s production secret-management policy. Never place its value, bank/e-wallet identifiers, provider secrets, or webhook credentials in source, logs, screenshots, or ordinary admin responses.

## Rollback and limitations

The migration is additive: `20261019000005_platform_admin_payouts`. Roll back by restoring a database backup and following the project’s migration policy; do not delete payout or audit history manually. Existing checkout, affiliate, CMS, POS, and live-shopping records are preserved.

This is not a claim of legal, tax, PCI, financial, or provider compliance. Country eligibility, seller identity/KYC, tax treatment, funding source, reserve/chargeback rules, refund windows, and payout terms remain owner decisions requiring qualified review.
