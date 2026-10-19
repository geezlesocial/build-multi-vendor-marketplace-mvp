# Live Shopping

Status: provider approval and credentials are pending. This repository intentionally does not simulate a live player or claim a real provider integration.

## Current safety behavior

Live shopping is available only when `LIVE_SHOPPING_AVAILABLE=true`, the persisted admin setting `liveShoppingEnabled` is true, and a configured provider adapter reports healthy. The current adapter always reports unavailable, so the feature remains off. Historical session records, reports, and linked records are preserved.

The deployment owner must set the gate, configure provider secrets in a secret store, deploy/restart, pass readiness checks, and then enable the admin setting. To deactivate, set the deployment gate to false and redeploy/restart; runtime APIs reject new session creation, publishing, and viewing while preserving history.

## Provider decision and owner costs

The owner must approve Cloudflare Stream, Mux, LiveKit Cloud, or another managed provider after confirming current region support, browser/device publishing workflow, webhook signing, retention behavior, and sandbox access. The owner pays all provider streaming, storage, delivery, and hosting fees. Custom streaming infrastructure, recording/replay, in-app chat, advanced moderation, and automated seller payouts are excluded.

## Secret boundary

No provider secret, stream key, publish token, playback token, or private credential belongs in Prisma, browser bundles, logs, screenshots, seed data, or Git. The eventual adapter must issue narrowly scoped short-lived tokens server-side and verify provider callbacks against the exact raw request body.

## Required future environment-variable names

Only `LIVE_SHOPPING_AVAILABLE` is present until a provider is approved. Provider-specific names must be added as placeholders to `.env.example` after that decision; this document intentionally does not invent credential names for an unselected provider.
