# Wallet-funded marketplace ads

Buyer and seller accounts can create a product ad from `/ads`; sellers are restricted to products in their own approved Store. Store Plan entitlements do not gate this module. Campaigns can tag an approved, in-stock product and its Store, include up to ten images and one video, use a verified HTTPS external link, and enable direct inbox contact. Media remains private until the existing scanner approves it.

Every submitted ad is moderation-gated. The admin dashboard exposes **Growth -> Wallet-funded marketplace ads** (also `/admin/ads`) to configure limits and the per-view rate, review creatives, approve/reject campaigns, pause a campaign, and audit decisions. Users receive in-app notifications when a campaign is submitted, approved, rejected, or its budget is spent.

## Budget and view billing

The administrator sets a price per 100 viewable views in the platform's `CURRENCY`; amounts are integer minor units. For example, 100 USD cents means USD 1.00 per 100 views, or USD 0.01 per view. The advertiser can enter a budget in the platform currency or their active preferred display currency. The estimated view count updates as they type, using the current reference rate when conversion is needed. A fresh rate is checked and snapshotted at submission, and the campaign's per-view price is snapshotted too; later FX or policy edits do not alter a submitted campaign. Clicks are analytics only and do not add a charge.

The entered budget is converted into the platform wallet charge currency using a fresh, administrator-approved reference rate. That converted platform-currency amount—not the display amount—is moved from the advertiser's available wallet balance to held funds. FX estimates do not change product prices, checkout, payment currency, or order snapshots. Each billable view is recorded at most once with a short-lived token, and its spend, wallet ledger posting, and daily metric are committed together. The public card is counted after at least 50% visibility for one continuous second; a direct interaction records the view before logging its click. Rejection, pausing, or expiry returns unused held funds; spent amounts are not refunded by pausing.

The homepage requests active placements periodically and labels them as sponsored. View and click accounting uses short-lived, one-use server tokens, but this is not a guarantee against sophisticated automated traffic and does not yet include a third-party ad-fraud service.

## Campaign placements

Advertisers choose one or more destinations when saving a draft: Marketplace home, Collections (the homepage featured collection), Category pages, Storefronts, and Blog posts. “Select all” targets every available surface. The API validates the supported values and stores them on the campaign; changing a draft's placement selection does not change its budget or existing order/payment currency.

Each page requests only campaigns eligible for that placement. Category chips open real category pages showing active-category descendants and approved in-stock products. Marketplace home, its featured collection, store pages, and published platform or seller blog posts render their own clearly marked sponsored slots. Blog placements use same-origin server-served JavaScript and CSS, and previews/drafts do not show ads. A view is measured and billed through the existing one-use impression token only after the viewability rule is met; clicks remain analytics-only. A campaign selected for multiple placements can receive views on each selected surface, subject to its single prepaid campaign budget.

The `20261030130000_marketplace_ad_placements` migration adds a placement enum array with a Marketplace-home default, so campaigns that existed before this feature retain a valid destination.

## Admin email-verification waiver

Administrators can mark an account email verified from **Members & security**. The action requires an audit reason, invalidates any outstanding verification token, and records that mailbox ownership was waived. It does not award email-verification rewards or establish that the user controls the mailbox; use only after an approved manual review.

## Required local rollout

The ad schema is extended by `20261030110000_marketplace_ads_per_view_billing`, `20261030120000_marketplace_ad_preferred_budget_currency`, and `20261030130000_marketplace_ad_placements` after `20261030100000_wallet_funded_marketplace_ads`.

```powershell
npm run db:generate
npm run db:deploy
npm exec --workspace=apps/api -- prisma migrate status --config apps/api/prisma.config.ts
```

These commands do not seed or reset the database. Start/restart the dev app after generation and migration, sign in with a verified buyer or approved seller, activate the eWallet, and open `/ads`. An admin must enable ad submissions and set the policy first.

## Financial and provider safety gate

A paid submission fails closed unless the eWallet is active, platform wallet funding/spending is enabled, and `MONEY_MOVEMENT_HARD_DISABLED` is false. The current wallet funding implementation supports only the explicitly isolated Stripe sandbox path; PayPal, Paystack, and PayMongo are not yet connected to wallet top-ups. Do not turn on real-money movement based on this ad feature alone. Complete provider checkout, signed webhook reconciliation, settlement/reversal handling, monitoring, and disposable-database integration tests for each gateway before enabling production funding or ad spend.

Seller and buyer ads spend the same eWallet balance as other enabled wallet flows. There is no independent campaign credit source or hidden Store Plan charge.
