# Security notes

- Passwords use bcrypt with an environment pepper.
- Sessions are random opaque tokens; only SHA-256 token hashes are stored.
- Cookies are httpOnly and use secure production settings.
- Helmet, strict configured CORS, JSON limits, rate limits, Zod validation, and structured generic API errors are enabled.
- Inventory decrement, order creation, payment creation, and POS completion use database transactions or guarded updates.
- Logs do not include credentials or raw payment details.
- Provider webhook signatures must be verified before staging/production use. Stripe signature verification and PayPal postback verification are implemented, but both require correctly configured sandbox secrets/webhook IDs.
- Admin MFA is a deployment requirement before production; this MVP does not claim to implement legal, PCI, tax, or privacy compliance.
- Live-shopping secrets are intentionally absent until a provider is selected. The deployment gate and runtime setting fail closed; future provider webhooks must verify the exact raw body and deduplicate provider event IDs.
- CMS content is stored as validated structured blocks rather than trusted HTML. Uploads use generated storage keys, file-signature checks, size limits, quarantine status, and safe response headers; production release remains blocked until an owner-configured scanner and object store/CDN are verified.
