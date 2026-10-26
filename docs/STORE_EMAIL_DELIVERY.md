# Store email delivery

Store marketing email is a provider-neutral SMTP integration. It supports public double-opt-in signup, a one-use confirmation token that expires after 48 hours, store-scoped consent records, signed unsubscribe links, RFC one-click unsubscribe, manual seller suppression, seller-created text-only campaigns, and a database-backed queue with bounded batches and retries.

## Enablement

1. Configure the sender domain and its SPF, DKIM, and DMARC records with the chosen mail provider. Obtain its SMTP endpoint and credentials through the provider's secure channel.
2. Either save provider SMTP settings in Admin > Growth > Store Buster & email, or set the legacy `STORE_EMAIL_SMTP_HOST`, `STORE_EMAIL_SMTP_PORT`, `STORE_EMAIL_SMTP_SECURE`, `STORE_EMAIL_SMTP_REQUIRE_TLS`, optional paired `STORE_EMAIL_SMTP_USER`/`STORE_EMAIL_SMTP_PASSWORD`, `STORE_EMAIL_FROM`, and optional `STORE_EMAIL_REPLY_TO` deployment variables. Dashboard credentials are encrypted at rest and are not returned to the browser. Set a fresh `STORE_EMAIL_TOKEN_SECRET` (at least 32 characters) in the API deployment secret manager for unsubscribe links. Ensure `WEB_ORIGIN` and `SITE_URL` are externally reachable HTTPS origins.
3. Keep `STORE_EMAIL_DELIVERY_AVAILABLE=false` while deploying and validating. Apply migrations and generate Prisma Client while the API process is stopped on Windows.
4. After reviewing provider policy, sender authentication, consent language, privacy notice, and local email laws, set `STORE_EMAIL_DELIVERY_AVAILABLE=true` and restart the API. This gate applies only to Store marketing; account verification and transactional order/support alerts use the same verified SMTP connection without this gate.
5. In the admin dashboard, select and save a provider, test its SMTP connection, then activate it. The test sends no email and validates connection/authentication only; it does not verify sender-domain alignment, inbox placement, or consent/privacy compliance. Verification expires after 24 hours. A dashboard-configured verification is stored with its provider record; legacy deployment SMTP verification is process-local.

Provider credentials saved through the dashboard are stored as encrypted ciphertext; plaintext is used only by the API process for SMTP and never returned in status responses. The legacy deployment-secret option remains available. Do not put provider credentials in browser code or commit them.

## Runtime behavior and operational limits

- A public subscriber must check the explicit consent box and confirm by email. Addresses are normalized and never returned to sellers; the seller list displays masked addresses only.
- Confirmation tokens are random, stored as SHA-256 hashes, single-use, expire after 48 hours, and confirmation resends are throttled to once per minute per pending subscription.
- Campaigns can be queued only when the Store plan permits email marketing and there are confirmed subscribers. Monthly sends and subscriber counts are reserved/checked transactionally. Each message is sent separately and consent/unsubscribe status is rechecked immediately before delivery.
- The worker claims a small batch, retries transient failures up to three attempts with backoff, and recovers stale claims. SMTP does not provide exactly-once delivery: a provider may accept a message immediately before a network/process failure, so a retry can result in a duplicate. Message-ID is stable per queued delivery, but provider deduplication is not guaranteed.
- Cancelling stops messages that remain queued. An in-flight SMTP operation may still complete.
- SMTP acceptance is not proof of inbox delivery. This increment does not include bounce/complaint webhooks, suppression synchronization with a provider, campaign analytics, advanced template building, or automatic domain authentication checks. Admins/sellers must act on provider-reported bounces/complaints using the existing manual suppression controls until those integrations are implemented.
- Test with an explicitly owned mailbox and a low-volume paid plan before any campaign. Never use the demo subscriber data or launch a bulk campaign without owner approval.
