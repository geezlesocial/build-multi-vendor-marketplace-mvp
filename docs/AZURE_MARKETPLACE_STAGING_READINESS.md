# Marketplace Azure staging readiness

**Status: NO-GO for the requested USD 25/month ceiling.** This change set prepares isolated staging packaging and IaC only. It does not create or change Azure resources, inspect Key Vault values, change DNS, or run a persistent migration. The applicable Azure subscription and its negotiated price sheet have not been identified; the currently selected subscription is Scrolith-labelled and is not treated as Marketplace infrastructure.

## Validation and readiness findings

Local validation completed in the isolated preparation worktree: `npm ci`, Prisma client generation, lint, typecheck, unit tests (282 passed), production builds, and the full existing Playwright suite (86 passed) against a disposable per-run PostgreSQL container. The final local same-origin proxy smoke test passed for health/readiness, API routing without SPA fallback, signup, CSRF/session-cookie authentication and logout, CMS/content paths, sitemap/robots, and frontend routing. The API and web containers were exercised with read-only application filesystems. The Compose configuration and both Bicep templates compile locally. The Bicep templates were **not** submitted to Azure for What-If or deployment validation. No Azure resource was created or modified.

One scanner limitation remains: Mailpit and ClamAV were not started in the local test due to host resource limits. The Azure session-service template allocates ClamAV 2 vCPU/4 GiB and requires an explicit start and readiness check; the application keeps uploads fail-closed until a separately reviewed scanner integration passes clean and infected-file tests. The media-upload path therefore has not been certified end-to-end.

The production dependency audit (`npm audit --omit=dev`) reported three high-severity findings associated with `deepmerge-ts` through Prisma configuration/CLI dependencies. A forced fix would upgrade Prisma across a major version; no forced upgrade or audit suppression was applied. The manual workflow fails closed on HIGH/CRITICAL image findings with Trivy. **Do not publish or deploy images until the affected dependency chain is resolved or security-reviewed and an explicit, time-bounded exception is approved.** Docker image rebuilds were attempted, but registry/Prisma-engine network timeouts prevented a final fresh API image rebuild during this run; local app, proxy, E2E, and source validations did complete. CI must rebuild, scan, and attest the exact commit before any future image publication.

The workflow file was structurally parsed and confirmed to expose only `workflow_dispatch`; it was not executed. `actionlint` was unavailable. The local test bridge exposes only the disposable database port on loopback for Playwright; it is not an Azure network simulation. No production, Scrolith, Key Vault, or persistent-database operation was performed.

## Proposed architecture

Use a dedicated `rg-marketplace-staging` in a Marketplace-approved subscription. Do not reuse `rg-scrolith-staging`, its network, database, storage, registry, secrets, identities, or domain bindings. The template creates a dedicated VNet with separate delegated Container Apps and PostgreSQL subnets, a private-endpoint subnet, PostgreSQL private DNS, and a private-only PostgreSQL Flexible Server 17 database named `marketplace_staging`.

The React app is built as static assets and served by unprivileged Nginx in an external Azure Container App. Nginx proxies `/api`, health/readiness, CMS routes, content media/preview, `sitemap.xml`, and `robots.txt` to an internal-only Express Container App. SPA fallback applies only to frontend paths. API and static images are separate, digest-pinned multi-stage builds; the API image has a dedicated one-shot Prisma migration target and never migrates during normal startup.

The API uses a dedicated managed identity for application secrets. A pull-only identity accesses ACR. A separate one-time bootstrap vault and identity keep the initial administrator credentials out of the normal API identity. PostgreSQL and Blob Storage have public network access disabled; Key Vaults have private endpoints and default-deny network ACLs, with an optional, temporary, explicitly allow-listed `/32` bootstrap exception that must be removed immediately after secret seeding. Blob Storage is not granted to the API and is not wired to the application's current S3-compatible media adapter; it remains unused until an Azure-compatible adapter is separately reviewed. ACR Basic is authenticated and registry-admin credentials are disabled. Mailpit and ClamAV are optional, internal-only session services, absent by default. ClamAV is sized at 2 vCPU/4 GiB; do not reduce that based on a 2-GiB assumption.

No data or identity is shared with production or Scrolith. Payments, wallet funding/money movement, seller marketing mail, live streaming/replay, and object-media uploads are configured fail-closed. `CONTENT_SCAN_REQUIRED=true` remains in force while the scanner is unavailable. The runtime does not seed demo accounts or enable a provider. The Azure Blob account is intentionally not wired to the application's S3-compatible media adapter; object storage remains disabled until an Azure-compatible adapter is separately reviewed and tested.

Initial URL: use the Azure Container Apps default HTTPS hostname. Proposed eventual friendly name: `marketplace-staging.<owner-confirmed-domain>`. The domain must be controlled by the Marketplace owner. DNS validation records and an HTTPS certificate/custom-domain binding require explicit approval and are not part of this preparation.

## Reuse and ownership assessment

Read-only Azure context showed the selected account is labelled for Scrolith; no Marketplace-specific subscription or isolated Marketplace staging resource group was verified. That is insufficient evidence to reuse any existing service. The safe decision is a dedicated Marketplace resource group and fresh PostgreSQL database, subject to the owner identifying the correct subscription. `rg-scrolith-staging` is not a fallback target.

Before approval, the subscription owner should confirm subscription ownership, billing agreement, Southeast Asia SKU availability for PostgreSQL 17/B1ms, quota, policy, private endpoint support, and the authorized budget contact. No resource health or secrets were inspected. The Bicep files have been locally compiled, but no Azure what-if or provider deployment validation was run.

## Cost worksheet (USD, Southeast Asia public retail reference)

The figures below are planning inputs from Microsoft's public Retail Prices API, not subscription-specific quotes. Actual agreement discounts, local tax, currency conversion, free-grant consumption, and SKU availability are not known. Do not treat a budget alert or free allowance as a spend cap. Check the current [Azure PostgreSQL Flexible Server](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/), [Container Registry](https://azure.microsoft.com/en-us/pricing/details/container-registry/), [Private Link](https://azure.microsoft.com/en-us/pricing/details/private-link/), [Key Vault](https://azure.microsoft.com/en-us/pricing/details/key-vault/), [Container Apps](https://azure.microsoft.com/en-us/pricing/details/container-apps/), and [Azure Monitor](https://azure.microsoft.com/en-us/pricing/details/monitor/) prices and the owner subscription's negotiated rate card before authorization.

| Component | Reference assumption | Monthly estimate |
| --- | --- | ---: |
| PostgreSQL Flexible Server B1ms compute | $0.026/hour × 730 hours | $18.98 |
| PostgreSQL provisioned storage | 32 GiB × $0.138/GiB-month | $4.42 |
| ACR Basic | $0.1666/day × 30.44 days; up to 10 GB included storage | $5.07 |
| **Known baseline subtotal** | PostgreSQL and registry only; before networking, monitoring and app use | **$28.47** |
| Private endpoints | Three endpoint resources: runtime Key Vault, bootstrap Key Vault, Blob. Hourly endpoint and processed-data charges apply; exact applicable subscription price is not verified here. | **Not included; not zero** |
| Container Apps | Web/API scale to zero; manual migration/bootstrap jobs. Consumption grant may offset usage only if the subscription-shared grant is available. | Variable |
| Log Analytics / Azure Monitor | First 5 GB/month Analytics Logs grant may be shared at billing-account level; additional ingest/retention/alerts may charge. No available grant is assumed. | Variable |
| Blob storage, Key Vault, DNS, image overage, network/egress | Operations, stored data, endpoint processing, DNS queries, image data over ACR included storage, external FX requests and tax | Variable |
| Restore test / session ClamAV | Temporary extra PostgreSQL server and active scanner/container hours | Variable, event-based |

The known first-month lower bound is at least **$28.47** for a full-month PostgreSQL server, provisioned storage, and ACR Basic, before the first private endpoint, Container Apps, log ingestion, Key Vault operations, DNS, Blob capacity/transactions, network/egress, restore work, and tax. Actual deployment dates could prorate some resources, but there is no defensible first-month ceiling from current data.

The baseline already exceeds USD 25 while omitting private endpoints and other variable services. Therefore this architecture is **not feasible under the stated $25/month ceiling**. A working-hours PostgreSQL schedule reduces compute but not its provisioned storage, ACR, private endpoints, logs, or other recurring costs. A one-day restore test creates temporary additional PostgreSQL compute/storage charges. A stopped Flexible Server automatically restarts after seven days; storage and backup charges continue while stopped. See Microsoft's [Flexible Server stop/start behavior](https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-stop-start-server).

There is no single flat deployment fee in this estimate; charges begin when resources are created and accrue by each service's meter. At the reference rates, one day of an additional B1ms restore server plus 32 GiB provisioned storage adds roughly **$0.77** before backup storage, private networking, logs, tax, and data transfer. The first month also accrues the base server/storage/registry amounts above plus every active endpoint and usage meter. Exact partial-month billing and any credits require the approved subscription's rate card. The only defensible configuration within the current $25 ceiling is the local disposable Compose environment; it supports application, database, proxy, and browser smoke testing but not Azure DNS, external provider webhooks, or Azure network behavior.

Container Apps' published consumption grant is 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests per month per subscription; it is shared and does not make this system free or capped. ClamAV needs a 4-GiB test allocation and its image/signature startup traffic is additional; follow [ClamAV's container guidance](https://docs.clamav.net/manual/Installing/Docker.html). Container Apps scale-to-zero behavior is described in [Microsoft's scaling documentation](https://learn.microsoft.com/azure/container-apps/scale-app). The template's $25 Cost Management budget only sends alerts; Azure budgets do not stop resources or cap charges.

**Recommendation:** keep this release at NO-GO until the owner either approves a different hosting design/ceiling and receives a quote from the correct Marketplace subscription, or chooses local-only staging. The only currently approved planning ceiling remains $25 and no Azure spend is authorized. A $75 alert is not recommended as a ceiling: it is neither a cap nor a verified adequate budget. No Azure resource operation is authorized by this report.

The Basic registry has a TLS-protected public endpoint for authenticated CI pushes and image pulls; anonymous access and registry-admin credentials are disabled, and ACA pulls use a dedicated managed identity. ACR Basic does not provide the private registry endpoint isolation of higher tiers, so this remains a documented network exposure and must be reviewed against the owner's threat model. The three private endpoints and their data processing are not included in the $28.47 subtotal. Subscription-specific calculator/quote review is required before any approval.

## Test-email and payment-sandbox plan

- Use Mailpit only during a controlled test window with synthetic addresses/accounts. Its SMTP and web interface are internal to the Container Apps environment by default; do not forward production mail or expose the UI publicly. Configure a test-only platform SMTP route, send a verification/reset sample, verify capture and links, then remove that route and stop Mailpit.
- Create separate Stripe, PayPal, Paystack, and PayMongo sandbox projects only if checkout verification is later authorized. Use provider-issued test keys and signed sandbox webhook secrets from a secure channel, never production keys. Point webhook callbacks only at the approved staging HTTPS hostname and verify signatures, replay handling, amount/currency identity, idempotency and negative cases. Do not enable wallet funding, real transfers, payouts, subscription billing, or production callbacks.
- The default app deployment omits payment credentials and hard-disables money movement. No sandbox provider configuration is included in this branch.
- The template deliberately leaves `CONTENT_SCANNER_AVAILABLE=false` even when it creates the optional ClamAV app. This is fail-closed by design: a separate reviewed staging revision must point at the internal scanner hostname, enable the scanner, and pass clean-file/infected-test-file checks before uploads are considered available. Otherwise media remains quarantined or unavailable.

## Database, migration and recovery safety

Use only a fresh `marketplace_staging` database. Before an approved migration, verify the server/database identity, TLS, current PostgreSQL version, `prisma migrate status`, and `_prisma_migrations` rows/checksums. The status command is a read-only preflight; the only migration writer is the manually approved Container Apps migration job. Do not run `migrate dev`, reset, seed, resolve, or deploy against a developer, Scrolith, or production database.

Before the first migration, create a PostgreSQL backup/PITR restore point and validate a restore to a **new isolated server**. Run smoke tests on the restored clone; never restore over the source. Keep seven-day backup retention as a short staging window, recognizing point-in-time restore creates a billable server.

Review `docs/LIVEKIT_MIGRATION_ORDER_HOTFIX.md` before any migration. It documents the historical ordering problem: migration `20261026173141` can precede the LiveKit table-creation migration `20261026210000_livekit_admin_configuration`; the guarded repair handles an absent table, and `20261027140000_livekit_configuration_id_default` supplies the default. Databases that applied the old SQL can retain a checksum differing from the working tree. Compare ledger/checksum and actual schema; do not rewrite a ledger or use `migrate dev` to silence a mismatch. A clean disposable migration test does not authorize a persistent deploy.

For rollback, first roll back the API/web image only when the migration is backward compatible. For an incompatible schema change, restore to a new database server, validate it, change only the staging database URL secret, restart the staging API, and retain the prior server until signoff. Never drop the original backup/server as an automatic rollback step. Staging is synthetic, but restoration may discard test writes made after the restore point.

## Security and release gates

`npm audit --omit=dev` reported three HIGH vulnerabilities in the production dependency graph, with `deepmerge-ts` pulled through Prisma configuration/CLI dependencies. The advisory is [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). The reported automated fix requires a breaking Prisma major upgrade; this branch does not force that upgrade, suppress the finding, or claim the image is clean. The workflow's Trivy HIGH/CRITICAL gate is intentionally fail-closed. **Do not publish or deploy images until this dependency chain is resolved with a compatible reviewed upgrade or an explicit, time-bounded security exception.**

No fresh final API image rebuild completed in this run because external npm/Prisma-engine downloads timed out. A previous local build and runtime proxy checks completed, but CI must successfully rebuild and scan the exact reviewed commit; cached local layers are not evidence that the final branch image was freshly reproducible. The optional Mailpit/ClamAV full lifecycle, Azure live What-If, OIDC permissions, real outbound email, external sandbox webhooks, DNS/TLS binding, and Azure restore were not exercised. `actionlint` was unavailable; workflow YAML was parsed and its manual-only trigger checked. These are explicit remaining blockers, not assumed successes.

## Credential safety and staged rotation

No secret value was read from disk or Key Vault by this task. The project uses credential classes including password pepper, payout/dropshipping/social-login encryption keys, affiliate signing secret, database credentials, SMTP/provider credentials, webhook secrets, and LiveKit/object-storage credentials. The repository's environment files are excluded from container context; verify ignore rules and secret scanning before any image push.

Some local environment values were pasted into the earlier IDE conversation. Treat those pasted values as exposed: do not copy them into staging or Azure, and have the owner arrange rotation after identifying consumers. No key was rotated here.

For staging, generate fresh random keys and a unique database password; never reuse local, Scrolith, or production values. For any existing non-staging data, preserve encrypted data by introducing versioned/dual-key decrypt-and-reencrypt support, backing up, re-encrypting in a reviewed migration, validating reads, then retiring the old key. Do not replace payout, dropshipping, or social-login encryption keys in place. Password-pepper rotation is separate: preserve existing password verification using a versioned pepper/rehash-on-success transition (or an explicitly approved reset plan); do not overwrite the pepper while old hashes depend on it. Rotate external provider credentials independently, then validate signed webhooks and revoke old credentials only after cutover.

## Spend and shutdown controls

Safe test sequence: scale Mailpit and ClamAV to one replica explicitly, wait for readiness, run the approved checks, then set both to zero; TCP/SMTP/ClamAV connections do not reliably wake a zero-replica service. Scale API/web to zero after tests, stop PostgreSQL, and verify job executions are idle. PostgreSQL can auto-start after seven days, so check it daily and stop it again if still required. This pauses compute, not fixed resources: ACR, private endpoints, provisioned storage/backups, and variable monitoring/network costs remain.

To end recurring charges completely, an owner must approve teardown of the dedicated resource group after a verified export/backup and retention decision. Teardown is destructive and may remove the restore target; it is not part of the workflow. Before any session, record current cost, budget alerts, spend forecast, and required residual resources. Do not claim that the $25 budget is an enforcement control.

## Approval gates and later deployment procedure

The owner must approve in writing: (1) Marketplace subscription and dedicated RG; (2) Southeast Asia or another region; (3) the revised spend ceiling and acceptance that alerts are not caps; (4) domain/hostname and any DNS/certificate changes; (5) test-mailbox ownership; (6) migration and restore window; and (7) staging-only OIDC identity, role scopes, and protected GitHub environment reviewers.

After those approvals, the separate runbook in `docs/azure-marketplace-staging/OPERATIONS.md` lists the ordered deployment, smoke-test, migration, rollback, and shutdown steps. The manual GitHub workflow never creates infrastructure or deploys on push/PR. PR #33 and issue #32 must remain open until separately authorized.
