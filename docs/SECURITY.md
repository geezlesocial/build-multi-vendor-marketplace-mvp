# Security notes

- Passwords use bcrypt with an environment pepper.
- Sessions are random opaque tokens; only SHA-256 token hashes are stored.
- Cookies are httpOnly and use secure production settings.
- Helmet, strict configured CORS, JSON limits, rate limits, Zod validation, and structured generic API errors are enabled.
- Inventory decrement, order creation, payment creation, and POS completion use database transactions or guarded updates.
- Logs do not include credentials or raw payment details.
- Provider webhook signatures must be verified before staging/production use. Stripe signature verification and PayPal postback verification are implemented, but both require correctly configured sandbox secrets/webhook IDs.
- Admin MFA is a deployment requirement before production; this MVP does not claim to implement legal, PCI, tax, or privacy compliance.
- Live-shopping secrets are intentionally absent until a provider is selected. The deployment gate and runtime setting fail closed; future provider webhooks must verify the exact raw body and deduplicate provider event IDs.
- CMS content is stored as validated structured blocks rather than trusted HTML. Uploads use generated storage keys, file-signature checks, size limits, quarantine status, and safe response headers; production release remains blocked until an owner-configured scanner and object store/CDN are verified.
- The non-deploying container-security workflow audits production and full dependency graphs, builds and scans the API, migration, and web images, rejects HIGH/CRITICAL vulnerabilities and secrets, and retains CycloneDX SBOMs. Production dependency audit must remain clean. The reviewed full-development graph currently includes seven MODERATE transitive `minimatch` findings (GHSA-g3hv-75wg-m249) through ESLint/TypeScript lint tooling; these are development-only and are excluded from production images. Do not use a forced major ESLint upgrade: track a compatible upstream fix, rerun lint/typecheck and the full suite, and keep the production audit/image scan gates blocking.
- Container deployment uses a separate one-shot Prisma migrator; the API runtime never migrates on startup. Prisma 7 uses the PostgreSQL driver adapter and schema-scoped connection `search_path`. The migration-order and applied-checksum warning for the historical LiveKit fix remains a manual database-owner review gate; see `docs/LIVEKIT_MIGRATION_ORDER_HOTFIX.md`.
- Local integration documentation and tests use unique disposable databases, synthetic email identities, Mailpit, and a private ClamAV test service. They do not certify hosted provider configurations or enable payment, email marketing, object-storage, or live-streaming gates. See `docs/LOCAL_CONTAINER_STAGING.md`.
