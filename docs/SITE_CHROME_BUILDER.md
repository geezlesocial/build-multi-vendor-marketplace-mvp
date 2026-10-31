# Header and footer builder

The site-chrome builder provides three responsive header layouts (Classic Marketplace, Editorial Premium, and Commerce Pro) and three footer layouts (Minimal Classic, Business Columns, and Signature Brand). The built-in Marketplace chrome remains the fallback until an administrator publishes a platform configuration or an eligible paid Store publishes its own configuration.

## Access and publishing

- Platform administrators manage the marketplace-wide appearance at `/admin/platform?section=chrome`.
- An approved seller can manage their own Store appearance at `/seller/site-chrome`. Publishing is gated server-side on an active, provider-backed Store Plan assignment with a positive recurring price. Legacy/free assignments, trialing subscriptions, expired subscriptions, and the official platform Store do not qualify for seller premium chrome.
- Eligibility is rechecked for every seller draft, publish, restore, and public-render request. A subscription that stops qualifying causes the public resolver to fall back to the standard Marketplace presentation; saved content is retained.
- Changes are saved as drafts and do not become public until an administrator or eligible seller explicitly publishes. Draft edits use expected-version checks to reject stale updates. Published revisions and changes are audited; restoring a revision creates a new draft rather than rewriting history.

## Customization and safety

The builder supports brand title/tagline, scanned logo media, safe navigation links, selected CTA, colors, spacing, sticky behavior, an announcement, working search, active marketplace categories, footer description, bounded logo dimensions, up to four ordered link groups, contact details, up to six ordered social profiles, copyright text, and per-page optional-footer suppression. The current message/notification activity, cart, sign-in/account controls, and required platform disclosures remain outside the configurable content.

Configuration is validated by a strict server-side schema. Links are limited to internal paths or HTTPS URLs; URL credentials, protocol-relative paths, arbitrary HTML/CSS/JavaScript, duplicate IDs, duplicate social URLs, unsupported templates, invalid colors, and over-limit collections are rejected. Logos use the existing tenant-owned media and safety-scanning workflow. Only published and approved media can be served publicly. Public HTML is escaped, external links receive `noopener noreferrer`, and dynamic CSS is emitted from validated color/size fields only.

The builder includes live preview breakpoints, revision history, restore-as-draft, accessible ordering controls, a maximum-account indicator, and a confirmation before resetting the working draft. Publication signals open tabs in the current browser and other tabs; active pages also refresh published configuration periodically. Public render endpoints are uncached/no-store so plan revocation and publication changes take effect promptly.

Footer suppression hides only the optional presentation footer. The mandatory Marketplace/payment disclosure remains visible. CMS page and post suppression keys use stable content IDs, so changing a slug does not silently detach the rule.

## API and storage

Admin endpoints: `GET/PUT /api/admin/site-chrome`, `POST /api/admin/site-chrome/publish`, and `POST /api/admin/site-chrome/revisions/:version/restore`.

Seller endpoints use the same verbs under `/api/seller/site-chrome`. Public clients use `GET /api/site-chrome/public` and `GET /api/site-chrome/public.css`. Server-rendered CMS/blog responses use the same validated configuration and retain mandatory disclosures.

The additive Prisma migration `20261031110000_site_chrome_builder` creates platform/store configuration and append-only revision records. Apply migrations through the existing reviewed deployment procedure; do not run them against production as part of local UI validation.

## Validation

`e2e/site-chrome.spec.ts` covers administrator preview/save/publish/render behavior and verifies that a legacy/free seller cannot save or publish. API unit tests cover strict schema validation, plan qualification, HTML escaping, safe links, and validated CSS. Run all browser tests only with the repository's guarded disposable E2E database procedure.

## Visual QA captures

`e2e/site-chrome.spec.ts` also has an opt-in public-page screenshot test. Set `SITE_CHROME_CAPTURE_DIR` while running it against a fresh guarded disposable E2E database to capture the rendered site chrome at 1440px desktop and 390px mobile widths. The captures are checked into `docs/site-chrome/screenshots/`:

| Component | Desktop | Mobile |
| --- | --- | --- |
| Classic Marketplace header | [PNG](site-chrome/screenshots/header-classic-marketplace-desktop.png) | [PNG](site-chrome/screenshots/header-classic-marketplace-mobile.png) |
| Editorial Premium header | [PNG](site-chrome/screenshots/header-editorial-premium-desktop.png) | [PNG](site-chrome/screenshots/header-editorial-premium-mobile.png) |
| Commerce Pro header | [PNG](site-chrome/screenshots/header-commerce-pro-desktop.png) | [PNG](site-chrome/screenshots/header-commerce-pro-mobile.png) |
| Minimal Classic footer | [PNG](site-chrome/screenshots/footer-minimal-classic-desktop.png) | [PNG](site-chrome/screenshots/footer-minimal-classic-mobile.png) |
| Business Columns footer | [PNG](site-chrome/screenshots/footer-business-columns-desktop.png) | [PNG](site-chrome/screenshots/footer-business-columns-mobile.png) |
| Signature Brand footer | [PNG](site-chrome/screenshots/footer-signature-brand-desktop.png) | [PNG](site-chrome/screenshots/footer-signature-brand-mobile.png) |
