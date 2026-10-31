# Live Shopping social commerce

This feature adds social engagement and an in-player shopping flow to public live shows and published replays. It uses the marketplace's existing account, cart, checkout, payment-provider, and LiveKit gates; it does not enable a provider or change payment policy.

## Viewer experience

- Signed-in viewers can choose Like, Love, Happy, Smile, or Congrats. A viewer has one current reaction per live session and can clear it. Counts update over server-sent events, with a refresh fallback when the bounded event-stream capacity is reached.
- Share actions open Facebook, WhatsApp, LinkedIn, and X/Twitter share intents, copy the canonical public live URL, or provide a responsive embed snippet. The embed resolves the public show itself; it contains no provider playback token or private stream URL.
- Signed-in viewers can repost and unrepost a visible live show or published replay. Their account timeline is available only to that signed-in account. The public social response includes an aggregate repost count and whether the requesting account reposted, not a list of other users.
- Up to six products appear on the live shopping shelf. The seller can update order and pin one featured item while a show is live. Viewers can inspect a current approved product in a dialog, select supported options, and add it to their cart without closing the show.
- Buy now uses the normal cart and checkout rules inside a same-origin checkout frame. Shipping, stock, order creation, and provider selection remain server-validated. When checkout returns an off-site payment URL, it is shown as an explicit secure link opened separately so the live show stays open; the app does not embed a payment provider page.

## API surface and access

| Route | Access and purpose |
| --- | --- |
| `GET /api/live-shopping/status` | Public readiness/effective-gate status. |
| `GET /api/live-sessions/:id` and `GET /live/:id` | Public-safe show details and public viewer page, subject to visibility and provider/replay state. |
| `GET /api/live-sessions/:id/engagement` | Active-show view/reaction counts and the signed-in viewer's own reaction. |
| `GET /api/live-sessions/:id/engagement/events` | Bounded SSE stream for aggregate reaction-count updates; clients fall back to refresh when capacity is full. |
| `POST /api/live-sessions/:id/view` | Counts a view only after provider playback verification; guest identity is represented by a random cookie whose stored identifier is hashed. |
| `PUT /api/live-sessions/:id/reaction` | Authenticated; accepts one enum reaction or `null` to clear. Limited to 30 mutations/minute per client. |
| `GET /api/live-sessions/:id/social` | Public repost count plus the current authenticated viewer's own repost state. |
| `POST` / `DELETE /api/live-sessions/:id/repost` | Authenticated, idempotent repost/unrepost; limited to 30 mutations/minute per client. |
| `GET /api/account/live-reposts` | Authenticated current-account timeline only; returns at most 100 currently visible reposts. |
| `GET /api/live-sessions/:id/products/:productId` | Public-safe current details for an approved product attached to the visible show. |
| `PATCH /api/seller/live-sessions/:id/products` | Authenticated seller, scoped to their own show and seller; replaces the current shelf with up to six distinct eligible products. Audited. |
| `GET /live/:id/embed` | Public responsive player/replay wrapper; applies the same show visibility and provider checks. |

Mutating API requests use the application's existing CSRF double-submit protection (`marketplace_csrf` cookie and `x-csrf-token` header) and session authentication where specified. The API's normal rate limiter, request validation, security headers, and audit mechanisms remain in force. Seller shelf updates are transactionally synchronized; historical show-product links are retained rather than deleted when a shelf changes.

## Safety and privacy boundaries

- Live features remain fail-closed unless the deployment and administrator readiness gates are enabled and the configured provider reports healthy. A `LIVE` database status alone does not make a show public.
- Only approved sellers' public live shows and published replays are available for social, embed, and product-detail actions. Deleted, private, unpublished, or otherwise unavailable shows return not found/unavailable.
- Viewer payloads omit provider session references, recording egress/storage identifiers, provider diagnostics, and other internal fields. Playback URLs are accepted only when they are HTTPS and do not contain credentials or point at loopback/private development hosts.
- The product picker validates ownership, approval, uniqueness, and the six-item limit on the server. Product detail is rechecked at view time, and cart/checkout independently revalidates current stock, variants, and order rules.
- Reposts persist until the user removes them or the show is no longer visible; the account timeline is not an endpoint for browsing other users' reposts. Aggregate counts may still be public.
- Sharing links may be sent to external social networks by the viewer. Those networks apply their own privacy and tracking policies. The embed is a public viewer, not an access-control bypass.
- Payment actions use the existing checkout and provider integration. No new provider credential, money movement, payment gate, email, or streaming configuration is enabled by this feature.

## Database and operations

The additive migration is `apps/api/prisma/migrations/20261031100000_live_shopping_social_commerce/migration.sql`. It adds the current shop-shelf metadata and persisted viewer repost relation while preserving existing show-product history. Generate the Prisma client and apply migrations through the repository's reviewed deployment procedure only after the change is accepted; do not run this migration against a production database as part of local testing.

The live seller picker and product dialog are covered by `e2e/live-shopping-social-ui.spec.ts`; social actions, checkout handoff, and account repost behavior are covered by `e2e/live-shopping-social-commerce.spec.ts`. These tests use synthetic provider/payment responses and a disposable database. They verify the unavailable-provider behavior, not a real LiveKit broadcast, real payment, or third-party share delivery. A real-provider smoke test requires separately approved sandbox credentials and a healthy configured LiveKit deployment.

The checkout frame is same-origin and allowed only for the live-shopping checkout route. External payment pages are deliberately opened in a separate tab/window; do not relax the frame policy to embed a payment provider. Keep the read-only `/live/:id/embed` route separate from checkout framing.
