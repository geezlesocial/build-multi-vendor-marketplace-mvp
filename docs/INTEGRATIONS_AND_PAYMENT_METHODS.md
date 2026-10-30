# Integrations and payment methods

## Scope and financial boundaries

The admin Integrations & APIs area is a reference-only registry for provider adapters already present in the codebase. It accepts Stripe for marketplace checkout and the separately hard-gated wallet-funding context, and PayPal, PayMongo (PHP), and Paystack (NGN) for marketplace checkout. Unsupported provider/context pairs are rejected. This registry does not accept adapter code, arbitrary URLs, or credential values, and it does not make network requests.

Keep these contexts distinct:

| Context | Current boundary |
| --- | --- |
| Marketplace buyer checkout | Stripe and PayPal adapters plus PayMongo (PHP) and Paystack (NGN) hosted checkout, each gated by the independent `PaymentMethodSettings` switch. Funds are collected to the platform merchant account. Localized checkout stores a fixed-rate quote on the payment attempt; order, seller, and commission ledgers stay in the base currency. |
| Store subscription billing | Disabled; `/api/seller/billing/subscribe` continues to return `503 PLAN_BILLING_DISABLED`. Buyer checkout is not reused. |
| Seller-owned provider accounts | Not managed by the platform registry. A Store Plan connector entitlement is eligibility only, not an account connection. |
| Seller payouts | Separate ledger/manual payout workflow. Stripe Connect and PayPal Payouts are not activated by this module. |
| Wallet funding | Stripe reference inventory only; the existing money-movement and wallet hard-disable gates remain authoritative. |

Enabling a provider configuration does not enable its payment method, connect a seller account, initiate a payment, or prove provider credentials are valid. An enabled record means only that required environment-backed references and locally observed mode values match. The registry itself makes no provider network calls; the separate checkout adapters and signed webhook routes do.

## Secret references and environments

Configuration records contain only fixed-name environment references such as `env:STRIPE_SECRET_KEY` or a provider/key-specific managed-secret reference such as `secret-ref:payments/stripe/webhookSecret`. Locally, the owner supplies values to the API process using its existing environment configuration. Hosted deployments should have their secret manager inject values into the expected process environment; the application does not resolve secret-manager paths itself. The UI returns masked reference identifiers and whether an expected runtime value is present, never the value. Secret fields and reference values are excluded from audit metadata; common secret-shaped values accidentally pasted into an audit reason are redacted.

Only provider/context pairs implemented by this repository are accepted. Provider, context, and environment are immutable after creation. Edit references only while a configuration is disabled. Archive instead of deleting; archived rows and references remain for audit/history. The database also rejects configuration deletion, invalid provider/context combinations, unsupported credential keys, bad reference formats, and environment-variable references that do not match the expected provider field. PayMongo and Paystack use `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, and `PAYSTACK_SECRET_KEY` respectively; their webhook endpoints are `/api/webhooks/paymongo` and `/api/webhooks/paystack`.

Sandbox and live entries are distinct. Live entries default to blocked by `LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE=false`. Even if an operator explicitly permits live registry configuration and the local mode/credential checks match, live payment-method activation and new live-mode buyer checkout remain blocked: this increment performs no provider verification, and local configuration is not proof of provider validity. A later provider-verification implementation must be reviewed before changing that server guard. Do not enable the live configuration gate without owner approval.

## Administration and audit

All configuration and buyer-method mutations require an authenticated administrator and the existing CSRF protection. Each successful mutation and its audit record are committed in the same database transaction. Audit diffs contain field names, credential-key names, provider/context/environment, old/new switch values, actor, time, and a reason; they do not contain saved references or secret values. Configuration lifecycle mutations serialize on the configuration row. Payment-method switches remain independent of provider configuration inventory.

The admin view exposes implemented areas only. Orders/transaction status, seller review, taxonomy, Store Plans, seller payouts, affiliate controls, branding, policies, availability, integrations, and audit history reuse their existing routes. Refund/dispute operations, promotion/ad management, broad member security administration, webhook delivery inspection, and API credential rotation remain explicitly planned/disabled where a complete management workflow does not exist. Club Coins continues to route to its existing admin screen and remains governed by its existing hard-disable setting.

## Verification and later prerequisites

Tests use synthetic values and mocked/pure readiness checks; no provider connectivity is tested. Before a later provider activation increment, the owner must decide the hosted secret-manager integration contract, provider account ownership and eligibility, environment-specific webhook provisioning/verification, live-payment approval, operational rotation/reconciliation, and which payment contexts may be activated. Recurring SaaS billing, seller-owned payment accounts, automated payouts, wallet funding, and Club Coins movement are outside this increment.
