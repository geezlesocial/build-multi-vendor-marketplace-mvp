# Payments runbook

## Shared rules

Stripe and PayPal are platform-owner merchant integrations. They do not create seller balances or payouts. No raw card data is stored. The server calculates totals from the persisted cart and current product rows.

## Stripe test mode

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`. The API creates a Checkout Session server-side with an idempotency key derived from the internal order ID. Use Stripe CLI forwarding in a separate PowerShell window, for example:

```powershell
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

Copy the CLI webhook secret into `STRIPE_WEBHOOK_SECRET`. The webhook endpoint verifies the unmodified request body and signature and stores provider event IDs uniquely before treating a payment as paid. Use Stripe test mode only.

## PayPal Sandbox

Create a PayPal Sandbox REST app and set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`, and `PAYPAL_WEBHOOK_ID`. The API creates Orders v2 orders and captures them server-side after buyer approval. Set `PayPal-Request-Id` for safe retries. Configure the webhook endpoint in the PayPal developer dashboard and verify each delivery using PayPal's webhook verification endpoint or the documented certificate-based verification method before enabling staging traffic.

The implementation posts the raw event, headers, webhook ID, and access token to PayPal's `verify-webhook-signature` endpoint before recording the event or changing payment state. A failed or missing verification is rejected. PayPal's simulator mock events use special test behavior; keep those tests separate from real Sandbox app events.

## COD and POS

COD creates an unpaid/pending-collection payment. POS creates a paid cash payment only within the transactional sale operation, scoped to an approved seller. POS is not card-present processing.
