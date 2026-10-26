# Live Shopping Implementation Plan

## Baseline evidence

The repository was inspected before edits. It is an independent uncommitted repository on branch `master`; there are no prior commits to reset. Existing baseline commands passed before live-shopping changes:

- `npm run test`: 4 unit tests passed.
- `npm run typecheck`: API and web passed.
- `npm run lint`: API and web passed.
- `npm run build`: API and web passed.
- `docker info --format '{{.ServerVersion}}'` and `docker compose ps` did not respond in the available session and were interrupted. No PostgreSQL migration, seed, database-backed integration, browser E2E, or provider sandbox result is claimed.

## Provider decision

LiveKit is the selected provider adapter for this phase. The code remains fail-closed until the owner supplies LiveKit credentials and enables the deployment gate. No fake stream sessions are created.

| Option | Relevant official capability | Cost/account consideration | Main risk for this brief |
|---|---|---|---|
| Cloudflare Stream | Managed live inputs, RTMPS/SRT ingest, HLS/DASH playback, signed playback tokens, live webhooks | Usage-based storage and delivery; owner account and API token required | Live inputs are automatically recorded, which conflicts with this MVP's no recording/replay boundary unless the owner accepts that provider behavior and product policy.
| Mux | Managed RTMP live streams, playback IDs, signed playback policies, API webhooks | Usage-based video input, storage, and delivery; owner account and API credentials required | The documented baseline is RTMP publishing; a separate browser publisher workflow may be needed for direct seller camera publishing.
| LiveKit Cloud | Managed WebRTC rooms, browser SDK ecosystem, RTMP/WHIP/SRT ingress, signed JWT webhooks | Usage-based participant time, bandwidth, and ingress/egress; owner account and project credentials required | Requires a precise livestream room/ingress design and provider-specific operational limits; pricing must be confirmed for the owner's region and expected audience.

References: [Cloudflare live streaming](https://developers.cloudflare.com/stream/stream-live/), [Cloudflare pricing](https://developers.cloudflare.com/stream/pricing/), [Cloudflare webhooks](https://developers.cloudflare.com/stream/stream-live/webhooks/), [Mux live streaming](https://www.mux.com/docs/guides/start-live-streaming), [Mux pricing](https://www.mux.com/docs/pricing/video), [Mux webhooks](https://www.mux.com/docs/core/manage-webhooks), [LiveKit Cloud](https://docs.livekit.io/intro/cloud/), [LiveKit ingress](https://docs.livekit.io/reference/other/ingress/api/), and [LiveKit webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/).

Owner decision required: supply the LiveKit Cloud or self-hosted deployment URL and credentials, confirm account/region, budget, retention policy, and complete a provider sandbox test. No paid resource was created by this repository.

## Implemented provider-neutral slice

- Added `LIVE_SHOPPING_AVAILABLE`, default false, as a deployment hard gate.
- Added audited `MarketplaceSettings.liveShoppingEnabled`, default false.
- Added additive Prisma models for sessions, product links, reports, and verified provider events.
- Added a LiveKit adapter with a fail-closed unavailable fallback, server-side room creation, short-lived host/viewer tokens, room health checks, host publishing verification, viewer playback verification, and room cleanup.
- Added explicit lifecycle and effective-gate logic.
- Added seller-scoped, admin-scoped, public status, report, and moderation API boundaries.
- Added unit coverage for the gate, lifecycle, and fail-closed provider behavior.

## Seller planning and admin operations increment (2026-10-26)

- Sellers can prepare drafts and future schedules without pretending a stream is online, edit show metadata/timing, attach only approved products in their own Store, and cancel planned sessions. Draft/scheduled records remain private while the runtime provider gate is off.
- Buyer, seller, and admin live views refresh platform session state every 10 seconds while visible. Buyer pages link show products to their product detail pages.
- Added a seller Live Studio and an admin Control Center section for readiness, runtime enablement, session review/termination, and report moderation.
- Added idempotent seller transition responses, schedule-in-the-future validation, safe un-scheduling, conditional admin termination/report updates, and audit entries for seller creation/edit/status actions.
- Session serialization omits provider session references, playback references, and provider error details.

LiveKit real-time video transport, seller browser publishing, provider-issued viewer/host tokens, host-track verification, and provider-verified attendance are implemented. Signed provider webhooks/reconciliation, recording/replay, chat, and real provider sandbox testing remain required before production launch. No synthetic stream has been added.

## Affected files and migration

The main affected files are `apps/api/src/config.ts`, `validation.ts`, `live-provider.ts`, `live-state.ts`, `live-domain.ts`, `index.ts`, `prisma/schema.prisma`, `prisma/seed.ts`, `.env.example`, and the additive migration `apps/api/prisma/migrations/20261019000001_live_shopping/migration.sql`.

Apply with `npm run db:deploy` after PostgreSQL is available. The migration only adds a setting column, enums, live-shopping tables, indexes, and foreign keys. Rollback must be planned as a reviewed migration by the owner; do not drop live history while sessions, reports, or support records are needed.

## Remaining work before production launch

Configure LiveKit, run the browser publishing/viewer sandbox test, add signed webhook reconciliation if provider callbacks are required, and complete PostgreSQL integration and browser E2E coverage. Keep payment, POS, seller isolation, and checkout semantics unchanged.

## Risks and test matrix

Mock/unit tests can prove lifecycle and gate rules. PostgreSQL-backed tests are needed to prove migration constraints, seller scoping, transactions, and idempotency. Browser E2E is needed for responsive buyer/seller/admin journeys. A real provider sandbox test is required before calling provider integration complete. These are separate evidence classes and must not be conflated.
