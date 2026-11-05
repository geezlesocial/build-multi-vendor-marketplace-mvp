# Market Lane — Multi-Vendor Marketplace MVP

Market Lane is a full-stack multi-vendor marketplace MVP built with React/Vite, Express, Prisma, and PostgreSQL. It includes buyer, seller, cashier/POS, and administrator workflows. Permissions, seller approval, Store-plan entitlements, and external-service configuration determine which capabilities are available.

## Architecture

The request path is browser → React/Vite web app → Express API → Prisma → PostgreSQL. The API owns authentication, authorization, validation, and business rules; the browser does not connect directly to the database. The repository uses npm workspaces for apps/web, apps/api, and packages/migrator. Prisma schema and migrations live with the API; the separate migrator workspace keeps the Prisma CLI in a dedicated one-shot container image. Normal API startup does not apply migrations.

The web container serves the Vite build through unprivileged Nginx and proxies API requests to the Node/Express container. The root Compose file provides local PostgreSQL and ClamAV services; docker-compose.staging-test.yml describes an isolated integration stack, not a production deployment. See [Architecture](docs/ARCHITECTURE.md) and [Local container testing](docs/LOCAL_CONTAINER_STAGING.md).

## Product map

- Buyers can browse the approved marketplace catalog, manage a cart and account, check out, follow Stores, and use order, messaging, and onboarding workflows.
- Sellers manage listings and Store presentation, orders and shipping, and available growth tools. Selling requires seller approval; plan-gated seller features are checked against server-side Store entitlements.
- Administrators manage seller and catalog governance, onboarding, Store plans and platform settings, audits, and content. CMS drafting is available to ADMIN and CONTENT_EDITOR; publishing and other privileged content controls are administrator-only.
- SEO-FY is an optional paid-plan feature for approved seller Stores and approved products. It provides deterministic checks and, when the optional local Jima runtime is configured, drafts only search titles and descriptions. Sellers must explicitly approve drafts; SEO-FY does not guarantee rankings or sales. Jima is disabled by default, accepts loopback runtime configuration only, and is not required for commerce. See [Jima and SEO-FY](docs/JIMA_AI.md).

Availability is narrower than the feature list: paid tools require their plan and permission gates, and external services require separate configuration and operational verification. Live shopping session management does not create a broadcast. SMTP delivery, object storage, scanning, and live-provider behavior are not assumed to be available just because their settings or adapters exist.

## Scope and financial boundary

The MVP supports Stripe and PayPal sandbox checkout, PayMongo hosted checkout for PHP, Paystack hosted checkout for NGN, COD, seller-scoped browser cash POS, and an order-case workflow connecting buyers, sellers, and administrators. Localized gateway adapters require administrator-enabled currencies, a current conversion quote, server-side credentials, and signed webhooks. Online payments go to the platform owner's merchant accounts. Seller payout administration is a separate, disabled-by-default subsystem; no automatic seller settlement, Stripe Connect transfer, PayPal Payout, escrow, or money transmission is active. Provider refunds are processed through the provider and reconciled from verified webhooks; COD refunds are off-platform. Live payment activation remains fail-closed pending provider verification. See `docs/PAYMENTS.md`, `docs/INTEGRATIONS_AND_PAYMENT_METHODS.md`, `docs/PLATFORM_ADMIN_PAYOUTS.md`, and `docs/KNOWN_LIMITATIONS.md`.

The POS is cash-only browser checkout. It does not integrate card readers, Stripe Terminal, printers, or third-party inventory systems. This project is not a claim of PCI, tax, privacy-law, or other legal compliance.

Live shopping supports session planning and administration but does not create a live broadcast. Provider publishing, playback, recording, and moderation capabilities remain unavailable or owner-dependent; see [live-shopping limits](docs/LIVE_SHOPPING.md) and [known limitations](docs/KNOWN_LIMITATIONS.md).

## Local Windows PowerShell setup

Use the repository's Node.js 22.23.4 runtime (the version pinned by CI and the API image).

```powershell
Set-Location 'C:\Build Multi-Vendor Marketplace MVP'
npm ci
npm run dev:setup
npm run dev:db:setup
npm run dev
```

`npm run dev:setup` creates `.env` only when it does not already exist. It generates fresh, cryptographically random local secrets without printing them; it never overwrites an existing `.env` and has no force option. On Windows the file inherits the current account's filesystem permissions.

`npm run dev:db:setup` starts only the local Compose PostgreSQL service, generates the Prisma client, applies migrations, and seeds local demo accounts. Before doing so it verifies that the target is exactly the loopback `marketplace` development database on port 5432 and that payment, wallet, live-provider, storage, scanning, sponsored-placement, and email-delivery gates remain disabled. It refuses remote, staging, production, and E2E database targets or unsafe shell overrides. The local Compose database uses a persistent Docker volume; migrations and demo seed data are for local development only.

Open `http://localhost:5173`. The API is at `http://localhost:4000`. API and Prisma commands load the repository `.env` automatically (and fall back to a workspace-local `.env` if the root file is absent), while preserving variables already explicitly set in the process environment.

### Local setup on macOS/Linux

```sh
cd /path/to/build-multi-vendor-marketplace-mvp
npm ci
npm run dev:setup
npm run dev:db:setup
npm run dev
```

The same no-overwrite and loopback-only database safeguards apply. If `.env` already exists, inspect and retain it; the bootstrap command will not replace it.

Local-only demo accounts seeded by `npm run db:seed`:

- `admin.local@example.test`
- `editor.local@example.test`
- `buyer.local@example.test`
- `seller.local@example.test`

The test-only password is defined in [the local seed](apps/api/prisma/seed.ts); never reuse these accounts outside local development. They are not a production credential mechanism.

## Verification commands

```powershell
npm run typecheck
npm test
npm run build
npm run lint
npm run format:check
npm run env:example:check
```

### Playwright browser tests

The Playwright configuration requires `E2E_DATABASE_URL`. Its guard accepts only a PostgreSQL URL on loopback (`localhost`, `127.0.0.1`, or `::1`) whose database name contains `e2e` or `test`. Create a fresh disposable database for each run; never use the persistent local `marketplace` database, staging, or production. The local development database bootstrap does not create or prepare E2E databases.

The suite starts its own API and Vite servers and runs every configured Playwright project/spec, including the extended site-chrome project. The CI workflow step retains its existing name, “Run CMS browser tests,” but runs `npm run e2e` and is not CMS-only. CI creates a fresh PostgreSQL database, migrates and seeds it, then runs the configured suite without live payment or live-shopping providers.

Browser/API integration tests use a separate database from local development. The following example uses PostgreSQL client tools and the repository-generated local `.env`; run it in a dedicated PowerShell session and use a fresh database name:

```powershell
npm run e2e:install
$testDb = "marketplace_e2e_$([guid]::NewGuid().ToString('N'))"
createdb --host=127.0.0.1 --port=5432 --username=marketplace $testDb

# Load only the generated local .env connection, then change its database path.
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
$env:E2E_DATABASE_URL = node --env-file=.env -e "const u = new URL(process.env.DATABASE_URL); if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.port !== '5432' || u.pathname !== '/marketplace') throw new Error('Expected the generated loopback marketplace .env target'); u.pathname = '/' + process.argv[1]; process.stdout.write(u.href)" $testDb
if ($LASTEXITCODE -ne 0) { throw 'Could not build the disposable E2E database URL.' }
$env:DATABASE_URL = $env:E2E_DATABASE_URL

npm run db:generate
npm run db:deploy
npm run db:seed
npm run e2e
```

Create the database on an already-running local PostgreSQL service; do not start a second database just to follow the example. The command above uses PostgreSQL client tools. If the repository Compose PostgreSQL service is already running in this same Compose project, replace that command with docker compose exec -T postgres createdb -U marketplace $testDb. Set both E2E_DATABASE_URL and DATABASE_URL to the same disposable URL before migration and seeding. Adjust the local database role if it differs from the repository Compose default.

Provider sandbox integrations require their own credentials and webhook setup; the browser suite does not contact payment or live-shopping providers. Live payment activation remains blocked pending provider verification. Never commit `.env` or real credentials.

## Environment configuration

The table lists selected examples only; it is not a complete variable inventory. The checked-in [.env.example](.env.example) and [environment example checker](scripts/check-env-example.mjs) are the maintained sources of truth. The checker compares API and Prisma configuration, required example entries, and fail-closed sample gates. Do not commit .env files or real credentials.

| Area                           | Selected variable names                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| API and database               | NODE_ENV, API_PORT, WEB_ORIGIN, DATABASE_URL, SESSION_TTL_DAYS                                                                         |
| Authentication and proxy       | PASSWORD_PEPPER, TRUST_PROXY_HOPS, SOCIAL_LOGIN_ENCRYPTION_KEY                                                                         |
| Media and scanning             | CONTENT_SCAN_REQUIRED, CONTENT_SCANNER_AVAILABLE, CONTENT_SCANNER_HOST, CONTENT_STORAGE_DIR, CONTENT_OBJECT_STORAGE_AVAILABLE          |
| Payments and external services | STRIPE_SECRET_KEY, PAYPAL_CLIENT_ID, PAYMONGO_SECRET_KEY, PAYSTACK_SECRET_KEY, LIVE_SHOPPING_AVAILABLE, STORE_EMAIL_DELIVERY_AVAILABLE |

## Further product and operations guides

For detailed behavior and limits, see [payments and provider boundaries](docs/PAYMENTS.md), [known limitations](docs/KNOWN_LIMITATIONS.md), [production readiness](docs/PRODUCTION_LAUNCH_CHECKLIST.md), [live shopping](docs/LIVE_SHOPPING.md), [seller shipping](docs/SELLER_SHIPPING.md), [dropshipping](docs/DROPSHIPPING.md), [social login](docs/SOCIAL_LOGIN_SETUP.md), [member onboarding](docs/MEMBER_ONBOARDING.md), [Store plans](docs/SAAS_STORE_PLANS.md), [affiliate program](docs/AFFILIATE_PROGRAM.md), [wholesale](docs/WHOLESALE.md), and [email and notifications](docs/EMAIL_AND_NOTIFICATIONS.md).

Email delivery requires separately supplied SMTP configuration and runtime verification. No paid email, hosted AI, push provider, or native Android app is provisioned by this repository. See [Jima AI](docs/JIMA_AI.md) for the local-only runtime and privacy boundaries.

## Scanned media

CONTENT_SCAN_REQUIRED=true keeps malware scanning mandatory. The checked-in environment example also leaves scanner and managed object-storage availability disabled until configured. If required storage or a scanner is unavailable, protected media uploads cannot complete or assets remain private/quarantined; no clean result is invented and scanning is not bypassed. The adapter speaks ClamAV clamd, which must stay on a private trusted network. See [content media storage and scanning](docs/CONTENT_MEDIA_STORAGE.md).

## Content CMS

The CMS supports structured blog posts and public informational pages, revisions, scheduling, server-rendered metadata, sitemap/robots responses, and previews. ADMIN and CONTENT_EDITOR can draft; only ADMIN can publish, restore revisions, change indexing/navigation controls, or delete media. New media requires configured private storage and a clean scan before approval; local defaults do not silently fall back to unscanned disk storage. Published HTML is rendered by the API, so hosting must route CMS page paths to the API or an equivalent server-rendering layer. See the [CMS guide](docs/CONTENT_CMS_ADMIN_GUIDE.md) and [media-storage guide](docs/CONTENT_MEDIA_STORAGE.md).
