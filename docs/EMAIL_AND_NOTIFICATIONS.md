# Email and notifications

The growth schema provides durable in-app notifications, channel/category preferences, push-subscription registration, and an idempotent email outbox. Notifications persist before any realtime or push delivery enhancement. Notification reads, push subscriptions, and conversations are authenticated and owner-scoped.

No email API, SMTP credential, FCM project, or VAPID secret is committed or created. Local/test operation must remain non-delivering. The `ANDROID_PUSH` channel is only a provider-neutral registration state: there is no native Android application in this repository, so native Android delivery is blocked until a mobile client and owner-approved FCM setup exist. Compatible browser/PWA Web Push can be added with an owner-configured VAPID key and consent flow.

Before launch, choose one provider, configure a verified sender domain, suppression/bounce handling, retry/dead-letter monitoring, unsubscribe rules for marketing, and a secret store. Do not use marketing sends for transactional events and do not claim delivery merely because an outbox row was accepted.

