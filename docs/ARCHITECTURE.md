# Architecture

Content CMS is an additive API module. Structured blog/page JSON is validated at the boundary, persisted with immutable revisions, and rendered as escaped server HTML for published routes. Media bytes use the local development adapter only; production storage/CDN and scanning are deployment concerns. See `docs/CONTENT_CMS_IMPLEMENTATION_PLAN.md`.

## Request flow

Browser → Vite React UI → Express API → Prisma transaction → PostgreSQL.

Payment providers are called from the API only. The API creates an internal order from the persisted cart, recalculates prices and stock, decrements inventory transactionally, and creates a pending payment. Provider webhooks/API responses are the source of truth for online payment success.

## Isolation rules

- Seller product, inventory, order, and POS queries include the authenticated seller ID.
- Admin-only mutations use role middleware.
- A seller must be `APPROVED` to create products, sell, or use POS.
- Multi-vendor mode is checked on seller application, product creation, and buyer checkout.
- Provider secrets are never returned by API settings endpoints.

## Data model

The Prisma schema includes users, revocable sessions, sellers/stores/staff, categories/products/images/inventory, carts, parent and seller orders, payments/attempts, processed webhooks, marketplace/payment settings, POS sessions, and audit logs. Financial history uses restrictive deletion relations where appropriate.
