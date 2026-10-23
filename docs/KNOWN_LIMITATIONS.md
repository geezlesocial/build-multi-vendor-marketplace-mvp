# Known limitations

- Automated seller payouts, escrow, Stripe Connect, PayPal Multiparty, and seller money transmission are not included.
- PayPal Sandbox credentials and a registered, verified webhook are required for provider testing.
- The UI is a compact MVP shell; production branding, content, localization, image storage/CDN, and a full accessibility audit remain launch work.
- Product catalog image management remains separate from the CMS media pipeline; CMS uploads use local development storage only until production object storage/CDN is configured.
- Stock is reserved at order creation. A production policy is required for release after payment cancellation/failure.
- No tax engine, dynamic/external shipping rates, carrier APIs/labels/tracking, native apps, live video, bulk catalog migration, terminal hardware, or external inventory sync. Seller-entered shipping services and destination zones are available; they do not contact carriers.
- Live shopping is provider-neutral until the owner approves a managed provider and supplies sandbox credentials. There is no simulated player, recording/replay, chat, advanced moderation, or provider-backed seller publishing in the current slice.
- CMS local media storage is development-only. Production object storage/CDN, malware scanning, image dimensions/video duration inspection, legal copy, and browser E2E remain owner/staging work.
