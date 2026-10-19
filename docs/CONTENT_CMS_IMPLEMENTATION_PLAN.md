# Content CMS implementation plan

## Baseline

The repository is an uncommitted independent project on `master`; no prior commit exists to reset. The live-shopping increment is present and is being preserved. The verification run on 2026-10-19 used a new local PostgreSQL 17 cluster on `127.0.0.1:55432`; the existing `postgresql-x64-17` service and its data directory were not started or modified. All four migrations, including `20261019000002_content_cms`, applied successfully and the documented seed completed. HTTP CMS checks and the existing 14 API unit tests passed. No Playwright/browser E2E harness is present in this repository, so browser E2E remains unverified.

## Design decisions

- Reuse the existing `User`, `Role`, `Session`, `AuditLog`, Prisma, Express, and React/Vite architecture.
- Add a `CONTENT_EDITOR` role for drafting and editorial maintenance. Publishing, SEO/index controls, revision restore, navigation changes, and media release remain restricted to `ADMIN`.
- Store editorial content as validated JSON blocks, not trusted arbitrary HTML. Supported blocks are headings, paragraphs, lists, quotes, safe links, images, videos, captions, and downloadable files. Arbitrary script, iframe, HTML, and JSON-LD input are rejected.
- Use a local filesystem storage adapter for development only. Uploaded bytes are never stored in PostgreSQL. Public release requires an owner-configured private object store/CDN and an antivirus scanner hook; no paid storage or scanner is created here.
- Add server-rendered HTML responses for published content, plus API data routes. The Vite dev proxy will forward content paths to the API; production hosting must reverse-proxy the same paths to the API or provide an equivalent SSR/prerender deployment.
- Use UTC for scheduling in the database. Editors provide an IANA timezone for display/context; timezone conversion is not delegated to the browser for publication decisions.
- Content editors can draft and edit content, but only administrators can change indexing flags, navigation placement, publish/unpublish/archive, restore revisions, or delete/release media.
- Public media delivery is fail-closed: an approved asset must be referenced by published content before it is served publicly. Scheduled publication re-checks media approval so quarantined assets cannot become public through a scheduler run.

## Models and migration

The additive migration adds blog posts/categories/tags/revisions, content pages/revisions, media assets, slug redirects, and short-lived preview tokens. Existing payment, order, seller, POS, and live-shopping tables are unchanged. Financial/history data is not deleted by content actions.

## Security and limits

Content mutation routes require `ADMIN` or `CONTENT_EDITOR`; release-sensitive routes require `ADMIN`. Public queries filter strictly to published content whose publication time has arrived. Preview tokens are hashed, expire, are single-use, and emit `noindex,nofollow`. Media uses generated keys, signature checks, MIME/extension allowlists, byte limits, quarantine status, and safe response headers. Path traversal, unsafe protocols, and unapproved media are rejected.

Initial configurable limits: 5 MiB images, 50 MiB video, 10 MiB documents/captions, 200 blocks per document, and 160-character slug/title limits. These are conservative MVP defaults and must be load-tested before staging.

## Verification plan

Unit tests cover block validation, safe URL protocols, slug/redirect loop rules, and metadata escaping. Database-backed tests must cover workflows, revisions, scheduling idempotency, media ownership, and public filtering. HTTP tests must inspect initial HTML, canonical/OG metadata, JSON-LD, sitemap, robots, redirects, and preview noindex behavior. Browser E2E remains separate from API tests. Provider/payment/live-shopping tests must remain unchanged.

## Verification notes and remaining blockers

The initial seed had a defect: demo passwords were hashed without `PASSWORD_PEPPER`, so seeded logins failed. The seed now uses the configured pepper and updates existing local demo users on reseed. Public publication predicates now calculate server time per request; content published after API startup is visible without a restart. Structured content links reject unsafe protocols at the API boundary.

The isolated migration/seed and database-backed HTTP checks passed for role access, draft/scheduled/published/archived visibility, revisions and restore, slug redirects, preview access/single-use/expiry, navigation, sitemap/robots/initial HTML SEO, media signatures/size/quarantine/public delivery, safe PDF attachment disposition, and malicious content rejection. Browser E2E remains blocked by the absence of a browser test harness. Production object storage/CDN, antivirus scanning, canonical site URL, legal page copy, and backup policy require owner configuration and approval.
