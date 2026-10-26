# Live Shopping

Status: LiveKit adapter implemented; provider credentials and a real provider sandbox verification are still deployment prerequisites. This repository does not simulate a live player.

## Current safety behavior

Live shopping is available only when `LIVE_SHOPPING_AVAILABLE=true`, the persisted admin setting `liveShoppingEnabled` is true, and LiveKit reports healthy. Configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` server-side. Historical session records, reports, and linked records are preserved.

The deployment owner must set the gate, configure provider secrets in a secret store, deploy/restart, pass readiness checks, and then enable the admin setting. To deactivate, set the deployment gate to false and redeploy/restart; runtime APIs reject new session creation, publishing, and viewing while preserving history.

## Seller planning and administration

Sellers can create draft shows, schedule or reschedule them, link approved products from their own Store, and cancel planned shows. Planning remains available while streaming is disabled; planned sessions are not exposed publicly until all runtime gates are healthy. Sellers cannot start a broadcast without provider-backed publishing.

Administrators can inspect provider readiness, enable or disable the runtime switch when the deployment/provider gates permit it, review sessions and viewer reports, mark reports reviewed/dismissed, and terminate sessions. Mutations are role-checked and audited. Buyer and seller session status views refresh every 10 seconds while the page is visible; this is polling for platform state, not a websocket video transport.

The seller studio creates a LiveKit room, issues a short-lived host token, publishes browser camera/microphone tracks, verifies the host video track before transitioning to LIVE, and ends the provider room when the show ends. Buyers receive short-lived viewer tokens and connect over LiveKit WebRTC. Attendance heartbeats are accepted only when the authenticated viewer is present in the provider room and a host video track is published. Provider webhook reconciliation, recording/replay, chat, and automated seller payouts remain out of scope.

## Provider decision and owner costs

The owner must approve Cloudflare Stream, Mux, LiveKit Cloud, or another managed provider after confirming current region support, browser/device publishing workflow, webhook signing, retention behavior, and sandbox access. The owner pays all provider streaming, storage, delivery, and hosting fees. Custom streaming infrastructure, recording/replay, in-app chat, advanced moderation, and automated seller payouts are excluded.

## Secret boundary

No provider secret, stream key, publish token, playback token, or private credential belongs in Prisma, browser bundles, logs, screenshots, seed data, or Git. The eventual adapter must issue narrowly scoped short-lived tokens server-side and verify provider callbacks against the exact raw request body.

## LiveKit environment variables

`LIVEKIT_URL` accepts the LiveKit server URL (`https://...` for LiveKit Cloud or `http://localhost:7880` for a local server). The browser automatically derives the corresponding `wss://` or `ws://` URL. `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` remain API-only secrets and are never sent to the browser.

## Current acceptance boundary (2026-10-26)

Seller draft/schedule management, product linking, admin session/report controls, LiveKit host/viewer tokens, browser publishing/playback, provider-verified attendance, and fail-closed lifecycle controls are implemented. Static type, unit, lint, build, database integration, browser E2E, and real provider sandbox checks remain separate verification items. Since no provider credentials are present in this local environment, live streaming remains intentionally disabled until deployment configuration is supplied.
