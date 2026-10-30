# Payments runbook

## Shared rules

Stripe, PayPal, PayMongo, and Paystack are platform-owner merchant integrations. They do not create seller balances or payouts. No raw card data is stored. The server calculates totals from the persisted cart and current product rows. Orders, seller commissions, and accounting remain in the platform base currency; only PayMongo's PHP provider charge and Paystack's NGN provider charge use a separately saved, immutable conversion quote.

## Stripe test mode

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`. The API creates a Checkout Session server-side with an idempotency key derived from the internal order ID. Use Stripe CLI forwarding in a separate PowerShell window, for example:

```powershell
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

Copy the CLI webhook secret into `STRIPE_WEBHOOK_SECRET`. The webhook endpoint verifies the unmodified request body and signature and stores provider event IDs uniquely before treating a payment as paid. Use Stripe test mode only.

## PayPal Sandbox

Create a PayPal Sandbox REST app and set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`, and `PAYPAL_WEBHOOK_ID`. The API creates Orders v2 orders and captures them server-side after buyer approval. Set `PayPal-Request-Id` for safe retries. Configure the webhook endpoint in the PayPal developer dashboard and verify each delivery using PayPal's webhook verification endpoint or the documented certificate-based verification method before enabling staging traffic.

The implementation posts the raw event, headers, webhook ID, and access token to PayPal's `verify-webhook-signature` endpoint before recording the event or changing payment state. A failed or missing verification is rejected. PayPal's simulator mock events use special test behavior; keep those tests separate from real Sandbox app events.

## PayMongo hosted checkout (PHP)

Set `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` in the API environment. Use test-mode keys for local/staging work. Configure the PayMongo Dashboard webhook endpoint as `https://<public-api-host>/api/webhooks/paymongo` and subscribe to `checkout_session.payment.paid`, `refund.succeeded`, and `dispute.created`. The endpoint verifies `Paymongo-Signature` against the raw request body and selects the test/live signature using the API-key mode. Checkout sessions are created server-side through PayMongo's v2 Hosted Checkout API with a stable per-order idempotency key; the provider-hosted page handles payment details.

## Paystack hosted checkout (NGN)

Set `PAYSTACK_SECRET_KEY` in the API environment and configure the Paystack Dashboard webhook as `https://<public-api-host>/api/webhooks/paystack`. Subscribe to `charge.success`, `refund.processed`, and `charge.dispute.create`. The endpoint checks `x-paystack-signature` as an HMAC-SHA512 over the exact raw body. The transaction uses a deterministic unique reference tied to the internal order, and the buyer is sent to Paystack's hosted authorization page.

## Enabling the localized checkout methods

1. In platform currency administration, activate PHP and/or NGN for display and payment-rate use. Configure an approved, fresh conversion rate from the platform base currency; checkout fails closed when a current quote is unavailable.
2. In Admin → Integrations & APIs, register the matching provider under Marketplace buyer checkout. Use only references such as `env:PAYMONGO_SECRET_KEY`, `env:PAYMONGO_WEBHOOK_SECRET`, and `env:PAYSTACK_SECRET_KEY`; the application stores references, not secret values. Add the actual values to the API's deployment secret environment.
3. Enable the provider configuration and separately enable the PayMongo or Paystack payment-method switch. The checkout defaults to PayMongo for a Philippine destination and Paystack for a Nigerian destination when the method is available; buyers can choose a different enabled method.
4. Test with provider sandbox credentials and a publicly reachable HTTPS webhook endpoint. Provider dashboards cannot deliver webhooks to a plain localhost URL; use an approved secure tunnel for local webhook testing, then remove it afterward.

The gateway quote and rate snapshot are persisted on the payment attempt. A signed capture is matched to the exact provider currency and amount; the base-currency order and existing seller/affiliate accounting are not rewritten. Refund/dispute evidence retains the raw provider amount and currency and stores a separately normalized base-currency value for order-case and commission workflows. Provider refunds are issued in the provider dashboard; recording a webhook in this application does not issue one.

Live checkout is intentionally blocked by the existing provider-verification safety gate. Configuration presence is not provider verification. Do not turn on live payment settings until a reviewed provider connectivity/ownership verification flow exists and production credentials, public HTTPS webhook delivery, refund operations, and reconciliation have been tested. The implementation has not been validated against real merchant accounts and does not make a claim of PCI or legal compliance.

## COD and POS

COD creates an unpaid/pending-collection payment. POS creates a paid cash payment only within the transactional sale operation, scoped to an approved seller. POS is not card-present processing.
