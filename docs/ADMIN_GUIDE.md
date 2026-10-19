# Admin guide

The admin screen controls multi-vendor mode and independent Stripe, PayPal, COD, and POS switches. A switch affects new sessions/transactions only; historical payments and webhook reconciliation remain addressable in the database.

Live shopping has two controls: deployment environment gate `LIVE_SHOPPING_AVAILABLE` and audited database setting `liveShoppingEnabled`. Both, plus provider readiness, must be true. The current repository has no selected provider, so enabling the admin setting correctly returns a readiness error rather than creating a fake stream. Disabling preserves sessions, reports, carts, and orders.

Turning multi-vendor mode off preserves sellers, products, orders, and history. It blocks new seller applications, seller product creation/sales, and mixed seller checkout while platform-owned products remain available. Re-enable the switch to restore eligible seller flows.

Seller decisions and setting changes are recorded in `AuditLog` with actor, timestamp, old/new values, and reason metadata when supplied. Review the audit endpoint after consequential changes.
