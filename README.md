# Market Lane — Multi-Vendor Marketplace MVP

An independent React + Express + Prisma marketplace MVP with buyer, seller, cashier, and admin flows. This repository is intentionally separate from every other project.

## Scope and financial boundary

The MVP supports Stripe and PayPal sandbox checkout, COD, seller-scoped browser cash POS, and an order-case workflow connecting buyers, sellers, and administrators. Online payments go to the platform owner's merchant accounts. Seller payout administration is a separate, disabled-by-default subsystem; no automatic seller settlement, Stripe Connect transfer, PayPal Payout, escrow, or money transmission is active. Provider refunds are processed outside the app and must be matched to a verified webhook; COD refunds are off-platform. See `docs/PLATFORM_ADMIN_PAYOUTS.md` and `docs/KNOWN_LIMITATIONS.md`.

The POS is cash-only browser checkout. It does not integrate card readers, Stripe Terminal, printers, or third-party inventory systems. This project is not a claim of PCI, tax, privacy-law, or other legal compliance.

Live shopping uses a fail-closed LiveKit adapter. It remains unavailable until the owner configures `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in a deployment secret store, sets `LIVE_SHOPPING_AVAILABLE=true`, deploys/restarts, passes readiness checks, and enables the audited admin setting. See `docs/LIVE_SHOPPING_IMPLEMENTATION_PLAN.md` and `docs/LIVE_SHOPPING.md`.

## Local Windows PowerShell setup

```powershell
Set-Location 'C:\Build Multi-Vendor Marketplace MVP'
Copy-Item .env.example .env
# Edit .env and replace PASSWORD_PEPPER with a long random value.
npm install
docker compose up -d postgres
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

Open `http://localhost:5173`. The API is at `http://localhost:4000`.

Local-only demo accounts seeded by `npm run db:seed`:

- `admin.local@example.test`
- `editor.local@example.test`
- `buyer.local@example.test`
- `seller.local@example.test`
- Password: `LocalDemoOnly-ChangeMe-123!`

Change or remove these accounts before any staging use. The seed is not a production credential mechanism.

## Verification commands

```powershell
npm run typecheck
npm test
npm run build
npm run lint
```

### CMS browser E2E

The minimal Playwright suite uses only seeded local accounts and a disposable PostgreSQL database. Install the browser once, set test-only `DATABASE_URL`, `PASSWORD_PEPPER`, and `CONTENT_SCAN_REQUIRED=true`, then run:

```powershell
npm run e2e:install
npm run e2e
```

The suite starts the API and Vite web server itself, and covers admin publishing/metadata, editor permissions, CSRF-aware mutations, and quarantined media delivery. CI provisions a disposable PostgreSQL 17 service, applies migrations, seeds local test accounts, installs the Chromium headless shell, and runs the same suite. It does not deploy or use payment/live-shopping providers.

Provider sandbox tests require the corresponding environment variables in `.env`. Live-provider sandbox tests remain blocked pending provider approval and credentials. Never commit `.env` or real credentials.

## Environment variable names

`NODE_ENV`, `API_PORT`, `WEB_ORIGIN`, `DATABASE_URL`, `SESSION_COOKIE_NAME`, `SESSION_TTL_DAYS`, `PASSWORD_PEPPER`, `PAYOUT_ENCRYPTION_KEY`, `DROPSHIPPING_ENCRYPTION_KEY`, `CURRENCY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL`, `PAYPAL_WEBHOOK_ID`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `UPLOAD_DIR`, `LIVE_SHOPPING_AVAILABLE`, `SITE_URL`, `CONTENT_STORAGE_DIR`, `CONTENT_SCAN_REQUIRED`, `CONTENT_MAX_IMAGE_BYTES`, `CONTENT_MAX_VIDEO_BYTES`, `CONTENT_MAX_DOCUMENT_BYTES`, `AFFILIATE_DEFAULT_BASIS_POINTS`, `AFFILIATE_SIGNING_SECRET`, `STORE_EMAIL_DELIVERY_AVAILABLE`, `STORE_EMAIL_SMTP_HOST`, `STORE_EMAIL_SMTP_PORT`, `STORE_EMAIL_SMTP_SECURE`, `STORE_EMAIL_SMTP_REQUIRE_TLS`, `STORE_EMAIL_SMTP_USER`, `STORE_EMAIL_SMTP_PASSWORD`, `STORE_EMAIL_FROM`, `STORE_EMAIL_REPLY_TO`, `STORE_EMAIL_TOKEN_SECRET`.

## Key routes

- `GET /api/products`, `GET /api/products/:id`, `GET /api/categories`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/cart`, `POST /api/cart/items`, `PATCH /api/cart/items/:productId`
- `POST /api/orders/checkout`, `POST /api/orders/:id/paypal-capture`, `GET /api/orders`
- `GET/POST/PATCH /api/seller/shipping/services`, `POST /api/seller/shipping/discounts`, `POST /api/shipping/quote`, `GET /api/admin/shipping`
- `GET /api/seller/dropshipping`, `POST/DELETE /api/seller/dropshipping/connections/cj`, `GET /api/seller/dropshipping/products`, `POST /api/seller/dropshipping/imports`
- `POST /api/pos/sales`, `GET /api/pos/receipts/:id`
- `GET/PATCH /api/admin/settings`, `GET/PATCH /api/admin/sellers`, `GET /api/admin/orders`, `GET /api/admin/audit`
- `GET/PUT /api/admin/platform/branding`, `POST /api/admin/platform/branding/publish`, `GET/PATCH /api/admin/platform/settings`
- `GET /api/admin/vendors`, `GET/POST/PATCH/DELETE /api/admin/categories`, `GET/POST/PATCH/DELETE /api/admin/brands`
- `GET/POST /api/seller/payout-methods`, `GET/POST /api/seller/payouts`, `GET /api/admin/payout-readiness`, `GET /api/admin/payouts`
- `GET /api/live-shopping/status`, `GET /api/live-sessions`, `GET /api/seller/live-sessions`
- `GET/POST /api/admin/live-sessions`, `GET/PATCH /api/admin/live-reports`
- `POST /api/webhooks/stripe`, `POST /api/webhooks/paypal`

See `docs/PAYMENTS.md` before connecting a provider. See `docs/PRODUCTION_LAUNCH_CHECKLIST.md` before any staging or launch decision.
See `docs/LIVE_SHOPPING.md` before enabling live shopping.
See `docs/SELLER_SHIPPING.md` for zone matching, discount precedence, immutable order snapshots, and carrier-integration limits.
See `docs/DROPSHIPPING.md` for supplier onboarding, plan gating, encrypted credentials, and importer limitations.

## Growth modules

The additive growth foundation includes variants, owner-scoped favorites, wholesale applications/tier reads, server-recorded affiliate attribution and append-only commission ledger, manual payout requests, durable in-app notifications, web-push subscription registration, participant-scoped buyer/seller messaging, typed campaign records, and provider-neutral email/AI boundaries. See `docs/MONETIZATION_AND_GROWTH_IMPLEMENTATION_PLAN.md`, `docs/AFFILIATE_PROGRAM.md`, `docs/WHOLESALE.md`, `docs/EMAIL_AND_NOTIFICATIONS.md`, `docs/AI_FEATURES.md`, and `docs/MARKETING_AND_CONTENT.md`.

No paid email/AI/push provider is configured, no affiliate payout is issued, and no native Android app exists in this repository. SMTP delivery requires owner-supplied deployment secrets and runtime verification; no credentials or external provider account are provisioned here.

Store email marketing supports double-opt-in subscriptions, signed unsubscribe links, seller draft/queue/cancel controls, consent rechecks, plan quotas, and an SMTP worker. Account verification and transactional order/support/account notifications use the platform SMTP transport with a durable email outbox, verified-recipient/preference rechecks, bounded retries, queue health, and audited failed-job requeue. Configure server-only `STORE_EMAIL_SMTP_*` and `STORE_EMAIL_FROM`; Store marketing additionally requires `STORE_EMAIL_TOKEN_SECRET` and `STORE_EMAIL_DELIVERY_AVAILABLE=true`. Verify SMTP in Admin > Store Buster & email. Sending remains paused until an admin verifies the connection in each running API process; verification expires after 24 hours and resets on restart. The admin screen never displays or accepts secrets. SMTP delivery is at-least-once if a provider accepts a message but the process loses its connection before recording success; SMTP cannot guarantee exactly-once delivery. See `docs/EMAIL_AND_NOTIFICATIONS.md` and `docs/STORE_EMAIL_DELIVERY.md`.

## Content CMS

The CMS supports structured blog posts and public informational pages, revisions, scheduling, server-rendered metadata, sitemap/robots responses, previews, and quarantined local media uploads. `ADMIN` and `CONTENT_EDITOR` can draft; only `ADMIN` can publish, restore revisions, change indexing/navigation controls, or delete media. Local disk is development-only. Configure scanning and production object storage/CDN before staging; see `docs/CONTENT_CMS_ADMIN_GUIDE.md` and `docs/CONTENT_MEDIA_STORAGE.md`.

CMS routes include `GET /api/content/blog`, `GET /api/content/blog/:slug`, `GET /api/content/pages/:slug`, `GET /api/content/navigation`, `/blog/:slug`, `/pages/:slug`, `/sitemap.xml`, and `/robots.txt`. Admin routes are under `/api/admin/content`. Published HTML is rendered by the API; production hosting must route these paths to the API or an equivalent server-rendering layer.
