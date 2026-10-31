# Marketplace staging operations runbook

This runbook is for a future, explicitly approved deployment. It does not authorize a deployment, spending, DNS updates, secret access, or a database migration. Current decision: **NO-GO at USD 25/month**; the documented baseline exceeds the ceiling before private networking and runtime costs.

## Approval prerequisites

Obtain written approval for each item before acting:

1. A Marketplace-owned Azure subscription and dedicated `rg-marketplace-staging`; never substitute a Scrolith subscription or resource group.
2. Region, PostgreSQL 17/SKU availability, quota, policy, and a revised monthly spend ceiling supported by the subscription's actual rate sheet. Budget alerts are not spending caps.
3. The staging hostname, owner-controlled DNS zone, certificate/custom-domain process, and who may publish DNS records.
4. Test mailbox ownership, synthetic test-account policy, and any separately approved provider sandbox accounts.
5. GitHub OIDC federated identity, exact least-privilege scopes, protected `marketplace-staging` and `marketplace-staging-migrations` environments, required reviewers, and branch restrictions.
6. A migration window, tested restore procedure, retention decision, and named rollback operator.

Do not run the workflow until these prerequisites are approved and configured. Do not deploy while the USD 25 ceiling remains in force.

## Dedicated infrastructure deployment

1. Confirm the selected Azure subscription and `rg-marketplace-staging` name in a read-only review with the owner. Check no target name resolves to Scrolith or production resources. Do not select or reuse any existing resource IDs.
2. Review `infra/azure/main.bicep`, region SKU availability, quotas, private DNS, egress, and the latest subscription-specific cost estimate. Have a second operator review all parameters and scopes.
3. Build the resource group and main template locally with Bicep. Only after separate approval, create the dedicated group and deploy `main.bicep` with `deployApplications=false`, `deployBootstrapJob=false`, and `deploySessionServices=false`. Keep the bootstrap IP empty except during a separately approved secret-seeding window.
4. Create fresh, staging-only random secrets in the approved secure channel. Never put secret values in Bicep parameter files, command-line arguments, shell history, logs, CI variables visible to jobs, or Git. Seed only the required named Key Vault entries using a private, approved management path.
5. Remove any temporary Key Vault public-IP exception immediately after secret seeding. Verify the private DNS answers and access paths from the isolated Container Apps environment. Confirm database public access is disabled and that the database name is exactly `marketplace_staging`.
6. Build images from an approved commit. Scan them, push immutable commit references to the dedicated registry, and record their digests. Do not use `latest` or a mutable tag for deployment.
7. Redeploy the main template with the immutable API, web, and migrator image references and `deployApplications=true`. Keep `deployBootstrapJob=false` and `deploySessionServices=false` unless separately approved.
8. Confirm web is the only public application; API ingress, PostgreSQL, Key Vault, and Blob remain private. Use the ACA-generated HTTPS hostname initially. A friendly domain requires the domain owner's approval, validation records, DNS changes, and an approved certificate binding.

The template creates two isolated Key Vaults. The runtime identity can read only the runtime vault. The one-time bootstrap identity can read only the bootstrap vault. Do not broaden either identity to subscription-wide access. The GitHub deployment identity needs only the dedicated ACR push role and deployment/job-start rights on the dedicated staging resource group; it does not need Owner or subscription Contributor.

## Database backup, migration, and bootstrap

1. Verify the database server FQDN, private DNS resolution, PostgreSQL 17 version, database name, TLS, and the restricted deployment identity before any ledger query.
2. Take an approved backup/restore point. Restore it to a **new isolated server** and validate connectivity and application smoke tests there. Never restore over the source. Record restore duration and cost.
3. Run the manually triggered migration preflight job and inspect `prisma migrate status`, `_prisma_migrations` names/checksums, and actual schema. A pending migration is not automatic approval to apply it.
4. Review `docs/LIVEKIT_MIGRATION_ORDER_HOTFIX.md` before any migration. In particular, `20261026173141` may predate `20261026210000_livekit_admin_configuration`; the guarded repair tolerates an absent table and `20261027140000_livekit_configuration_id_default` adds the default. Historical applied SQL may have a checksum different from the current tree. Stop on an unexplained ledger/checksum mismatch; never edit the ledger or run `migrate dev` to suppress it.
5. Only after migration and restore approvals, use the separately protected migration environment to start the one-shot `prisma migrate deploy` job against the verified staging database. Confirm success and inspect the migration ledger before updating the API/web revisions.
6. Bootstrap the first admin only through the single-use bootstrap job, with separately generated credentials held in the bootstrap vault. The job refuses to run unless the database hostname begins `mpstg-pg-`, the database is `marketplace_staging`, and no admin exists. Verify sign-in, then delete bootstrap secrets and disable/remove the bootstrap job and its role assignment through an approved change.

If a release fails, roll back API/web image digests only when the schema change is backward-compatible. For an incompatible schema, restore to a new isolated server, validate it, update only the staging database URL through the approved secret procedure, and keep the previous server until sign-off. Do not automatically delete the old server or restore point. Test data written after a restore point will be lost on rollback.

## Email, payment, and feature gates

- During an approved email test window, start internal-only Mailpit explicitly, wait for its HTTP readiness endpoint, route only the staging platform mailer to it, and use controlled synthetic addresses. Verify signup, verification, and password-reset flows; inspect captured links; then remove the temporary route and scale Mailpit to zero.
- TCP/SMTP traffic does not reliably wake a zero-replica Container App. The Mailpit and ClamAV template apps default to zero. Explicitly set replicas to one before the test and verify readiness before sending traffic; set them back to zero after the checks.
- ClamAV is provisioned at 2 vCPU/4 GiB because its official container guidance calls for 3–4 GiB. Wait for its signature database to load and readiness to pass. If it is unavailable, media upload must remain fail-closed; do not lower scanner memory to fit a budget.
- Payment testing, if later authorized, uses only provider-issued sandbox credentials and signed sandbox webhooks directed to the approved staging HTTPS hostname. Keep real transfers, wallet funding, payouts, subscription collection, seller marketing, live streaming/replay, and object-media upload disabled. A returned browser payment URL is not proof of settlement.
- Do not connect Mailpit to a real mailbox or use real customer details. Do not publish its UI.

## Shutdown and spend review

At the end of every test window:

1. Stop test traffic and confirm no migration/bootstrap job is running.
2. Set Mailpit and ClamAV replicas to zero; verify their executions are stopped.
3. Scale API and web to zero if the environment is not actively used.
4. Stop PostgreSQL after checking no approved test or restore is in progress. PostgreSQL may automatically restart after seven days; check daily and stop again if still required.
5. Record cost, forecast, storage/backup retention, ACR usage, private endpoint charges, logs, and egress. Keep budget alerts enabled; they cannot prevent charges.
6. Leave the registry, private endpoints, storage, backups, and monitoring only if their residual monthly cost has explicit approval. Full resource-group deletion is destructive and requires separate owner approval plus a verified export/retention decision.

No cron-based start/stop automation is included: scheduling does not make a service free, can auto-start PostgreSQL unexpectedly, and would require an identity with resource-write permissions.

For a provisioned app only, the shape of the explicit scale-up commands is `az containerapp update --resource-group rg-marketplace-staging --name mpstg-mailpit --min-replicas 1 --max-replicas 1` and the same for `mpstg-clamav`. After their HTTP/ClamAV readiness checks, scale them back with `--min-replicas 0 --max-replicas 1`. These commands are documentation examples and have **not** been executed. Verify actual app names and current replica settings after approval; do not assume TCP traffic wakes a zero-replica app.
