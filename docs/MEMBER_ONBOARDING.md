# Member onboarding

New password and social-login accounts are marked incomplete at creation. After login or registration, the web app routes those members to `/onboarding`. The same completion state is checked by authenticated API middleware, so a client-side route change cannot unlock member APIs. Authentication, email-verification, logout, and onboarding endpoints remain available while setup is incomplete.

Onboarding loads a member-safe account summary, published platform branding assets, up to eight currently eligible stores, and display currencies permitted by the existing currency catalog and display-rate policy. A store must belong to an approved seller whose user account is active and have an approved in-stock product. Recommendations are deterministic, ordered by real follower count and then store name; no ratings, engagement, or recommendation reasons are fabricated. The composite `StoreFollow(userId, storeId)` primary key prevents duplicate follows.

Members must follow at least two eligible stores, choose a currently available display currency, and select a referral source before completing. “Others” may include at most 120 characters of plain text. Referral attribution is not marketing consent. The completion transaction rechecks store eligibility and currency activation, writes the existing `UserPreference.displayCurrency`, records referral attribution once, and sets `User.onboardingCompletedAt` atomically. The display preference does not change platform base currency, product prices, checkout, payment reconciliation, order snapshots, or commissions.

The migration backfills accounts that existed when this feature is deployed as already complete. This preserves existing member behavior and avoids a mass forced onboarding; newly created accounts remain incomplete until the transaction succeeds. Admins can inspect eligible store, currency, and pending-account counts at Admin → Members and security → Onboarding readiness. If there are fewer than two eligible stores or no display currencies, onboarding remains blocked and the admin panel links to the relevant store and currency settings.

API endpoints:

- `GET /api/onboarding` — account, published branding, eligible stores, follow state, and available currencies.
- `POST /api/onboarding/stores/:storeId/follow` and `DELETE /api/onboarding/stores/:storeId/follow` — idempotent authenticated follow changes.
- `POST /api/onboarding/complete` — validates the requirements and saves completion atomically.
- `GET /api/admin/onboarding/readiness` — admin-only configuration readiness summary.

The migration is additive: it adds onboarding/referral fields and an indexed, cascading store-follow table. Apply it through the normal deployment migration process after reviewing the migration state for the target environment; do not rewrite previously applied migration history.
