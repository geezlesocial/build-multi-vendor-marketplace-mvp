# Production launch checklist

- [ ] Choose a staging host and budget; do not use live credentials in local development.
- [ ] Set up HTTPS, secure secret management, database encryption/backups, restore drills, monitoring, alerts, and log retention.
- [ ] Replace local demo accounts and require strong passwords plus admin MFA.
- [ ] Confirm Stripe/PayPal merchant eligibility and business details with the providers.
- [ ] Configure and verify provider webhooks; test duplicate, delayed, failed, cancelled, and successful events.
- [ ] Decide stock reservation release behavior and refund/cancellation workflows.
- [ ] Confirm consumer terms, privacy policy, refund policy, taxes, shipping, address handling, and data retention with qualified advisers.
- [ ] Define seller agreement, moderation policy, payout policy, and support escalation. Seller payouts are not in this MVP.
- [ ] Run install, migration, seed, lint, typecheck, unit, integration, browser, secret scan, and restore tests from a clean environment.
- [ ] Confirm domain, CORS origin, rate-limit thresholds, incident response, and operational ownership.
