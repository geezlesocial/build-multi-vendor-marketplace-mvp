# Isolated local container verification

This Compose profile is for disposable local integration testing only. It does not deploy Marketplace, contact payment providers, or configure a production email service. Azure deployment remains deferred. The database is isolated on its own Compose network and stored in `tmpfs`; never point this profile, the seed command, or Playwright at a persistent development, staging, or production database.

## Services and security boundaries

- PostgreSQL 17 is reachable from the host only on a selected loopback port; the database data directory is temporary.
- The API and unprivileged Nginx web image communicate over the private Compose network. Only loopback ports are published.
- Nginx serves the production-built React app and proxies API, blog/page, sitemap/robots, and private-media paths to Express. `/api` and server-rendered content paths do not fall through to the SPA.
- The API trusts exactly one proxy hop in this test profile. The smoke test simulates the HTTPS-terminating edge with a forwarded `https` scheme and verifies `Secure`, `HttpOnly` session cookies and CSRF behavior. Local Nginx itself does not terminate TLS.
- Mailpit captures synthetic SMTP messages and has no relay credentials. ClamAV is accessible only on the private Compose network; its unauthenticated, unencrypted TCP protocol must never be exposed publicly.
- ClamAV is configured with a 4 GiB memory ceiling and 1.5 CPU limit. Allow adequate Docker Desktop memory/CPU; a TCP-open check is not readiness. The smoke test requires real clean and EICAR test verdicts and records observed memory use.
- Payment, wallet movement, live shopping, object storage, seller email marketing, and other external-provider gates remain disabled. No cloud credentials are used.

## PowerShell: create, verify, and destroy an isolated run

Run from the repository root in one PowerShell session. Choose unused loopback ports if the defaults conflict.

```powershell
$e2eId = [guid]::NewGuid().ToString('N')
$env:COMPOSE_PROJECT_NAME = "marketplace-local-$e2eId"
$env:STAGING_TEST_DB_NAME = "wallet_funding_e2e_$e2eId"
$env:WALLET_FUNDING_SANDBOX_ID = $e2eId
$env:STAGING_TEST_DB_PORT = '55439'
$env:STAGING_TEST_API_PORT = '4001'
$env:STAGING_TEST_WEB_PORT = '5174'
$env:STAGING_TEST_MAILPIT_API_PORT = '18025'
$env:STAGING_TEST_MAILPIT_PORT = '11025'
$env:STAGING_TEST_CLAMAV_PORT = '13310'
$testDbUrl = "postgresql://marketplace_test:local-only-disposable-password@127.0.0.1:$($env:STAGING_TEST_DB_PORT)/$($env:STAGING_TEST_DB_NAME)?schema=public"
$env:DATABASE_URL = $testDbUrl
$env:E2E_DATABASE_URL = $testDbUrl

npm ci --no-audit --fund=false
npm run db:generate
docker compose -f docker-compose.staging-test.yml --profile session-services up -d postgres mailpit clamav
```

Wait for PostgreSQL, then migrate only the disposable database with the isolated migration image, seed synthetic accounts, and start the app images:

```powershell
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  docker compose -f docker-compose.staging-test.yml exec -T postgres pg_isready -U marketplace_test -d $env:STAGING_TEST_DB_NAME *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }

docker compose -f docker-compose.staging-test.yml --profile migrations run --build --rm migrator
if ($LASTEXITCODE -ne 0) { throw 'Disposable database migration failed.' }
npm run db:seed
if ($LASTEXITCODE -ne 0) { throw 'Disposable database seed failed.' }

docker compose -f docker-compose.staging-test.yml --profile session-services up -d --build api web
```

After `/healthz` and the proxied `/ready` respond successfully, run the integration checks:

```powershell
$env:STAGING_SMOKE_BASE_URL = "http://127.0.0.1:$($env:STAGING_TEST_WEB_PORT)"
$env:STAGING_TEST_CLAMAV_HOST = '127.0.0.1'
$env:STAGING_TEST_MAILPIT_HOST = '127.0.0.1'
$env:STAGING_TEST_MAILPIT_API = "http://127.0.0.1:$($env:STAGING_TEST_MAILPIT_API_PORT)"
node scripts/staging-container-network-smoke.mjs
node scripts/staging-proxy-smoke.mjs
npx playwright install chromium
npx playwright test --config=playwright.container.config.ts
node scripts/staging-services-smoke.mjs
node --import tsx scripts/media-scanning-api.test.mjs
```

The network smoke runs the production ClamAV adapter and synthetic SMTP client from inside the API image. The browser smoke opens the production web image, verifies same-origin JavaScript/CSS and API responses, and ensures unknown API routes return JSON rather than React HTML. The service/media checks additionally exercise persisted quarantine behavior against the unique disposable database.

When finished, confirm the project name is the unique `marketplace-local-<run id>` created above, then remove only that Compose project:

```powershell
docker compose -f docker-compose.staging-test.yml --profile migrations --profile session-services down --volumes --remove-orphans
Remove-Item Env:DATABASE_URL, Env:E2E_DATABASE_URL, Env:WALLET_FUNDING_SANDBOX_ID -ErrorAction SilentlyContinue
```

The `down --volumes` command destroys the disposable Compose project and its temporary data. Do not run it with an unset or unverified `COMPOSE_PROJECT_NAME`. For full browser regressions against the same disposable database, use `npm run e2e` with separate API/web ports or use the manual `Marketplace full E2E stability` workflow, which creates a fresh PostgreSQL database for each of three runs.

## Migration and recovery notes

Use `prisma migrate deploy` only against the new disposable database in this profile. Never run `prisma migrate dev` or reset a persistent database to make a test pass. The LiveKit migration ordering, historical checksum mismatch, fresh-database behavior, and required ledger inspection are documented in [the LiveKit migration-order hotfix](LIVEKIT_MIGRATION_ORDER_HOTFIX.md). A fresh disposable success is not approval to apply rewritten migration history to a valuable database.

This Compose test does not create a backup or prove restore readiness. Before any hosted staging operation, create a provider-native backup, restore it to a separate isolated database, compare schema and representative counts, and record the result. A failed restore or ambiguous migration ledger is a stop condition; rollback is to the verified backup or previous immutable application image, not a destructive schema reset.
