# Storefront Themes Studio

## Theme catalog

The storefront theme preset is independent from the existing Header & Footer Builder templates. The public catalog contains six fixed, code-owned designs:

| Tier | Themes                                               |
| ---- | ---------------------------------------------------- |
| Free | Classic, Editorial, Boutique                         |
| Paid | Tech & Electronics, Groceries, Ecommerce Marketplace |

Theme designs consume the Store's approved products and existing catalog data. They do not create or infer stock, specifications, delivery promises, or product claims. Shared commerce actions, account controls, navigation, search, cart, and checkout continue to use the existing marketplace components and APIs.

## Seller workflow and access

An approved Store owner or staff member with the existing branding permission can open **Seller dashboard → Store → Themes**. The studio supports draft editing, responsive desktop/tablet/mobile previews, theme-specific design tokens, selected sections, safe approved Store media, publish, revision history, and restoration. Changes are versioned and writes include the expected revision; stale writes return a conflict so the editor can reload instead of overwriting newer work.

Classic, Editorial, and Boutique are available to eligible approved Stores without paid subscription status. The three premium presets require an active, provider-backed paid Store subscription and a matching active subscription assignment/plan version within its effective dates. A plan label, free/manual assignment, trial, expired or cancelled subscription, or client-supplied theme choice does not grant paid access. The server derives Store scope from the signed-in account and rechecks entitlement for draft, publish, restore, and public rendering.

If premium access ends, the saved draft, published configuration, and revision history remain stored. Public rendering uses Classic until entitlement is active again; reactivation restores access to the preserved selection. Media references must belong to the same Store and be approved by the existing scanning pipeline before publication. No arbitrary HTML, CSS, JavaScript, embed code, or external widgets are accepted.

## Platform administration

Platform administrators can manage the six-theme catalog order, public availability, and validated design tokens in **Platform administration → Storefront themes**. Classic is mandatory and remains the safe fallback. Catalog writes require an audit reason, use optimistic concurrency, and create an audit record. Hiding a theme removes it from public discovery and new selection while previously saved Store configuration remains intact; public tenant output still uses an allowed, entitled design.

Color tokens are validated server-side for a minimum 4.5:1 contrast against their configured surfaces/cards. Keep text and controls readable at narrow widths, preserve reduced-motion preferences, and verify keyboard focus when changing design tokens or sections.

### Managing theme catalog preview images

In **Platform administration → Themes & Templates Management**, an administrator can replace the catalog preview image for any of the six themes. These are reference/gallery images only; changing one does not change a seller's logo, favicon, banner, selected theme, products, or storefront content. The bundled defaults are `classic.webp`, `editorial.webp`, `boutique.webp`, `tech-electronics.webp`, `groceries.webp`, and `ecommerce-marketplace.webp` under `apps/web/public/theme-previews/`.

Choose a PNG, JPEG, WebP, or GIF file up to 5,000,000 bytes (5 MB) and 40 megapixels. The server checks the file content and image decoding rather than trusting the browser's filename or MIME type, then normalizes the image to WebP. The browser shows a device-local candidate preview and upload progress; it is not yet shared or published. Uploads require configured managed storage and malware scanning. A completed image remains private in quarantine until the scanner approves it. If scanning is unavailable or fails, the existing published image stays active; an administrator can retry the scan later. Rejected or quarantined media is not publicly served. Only an approved image can be published.

After approval, the upload-and-publish action selects the image for that theme. The change is audited and protected by an expected-version check, so stale concurrent edits are rejected instead of silently replacing a newer catalog update. To undo a replacement, use **Restore default image** on that theme's card and confirm; this removes the catalog override and makes the bundled default visible again without deleting the uploaded asset.

Open admin and seller theme catalogs refresh the published preview catalog every 15 seconds while the page is visible, and refresh again when a hidden tab becomes visible. This is polling, not push-based real-time delivery; a transient refresh failure leaves the last loaded catalog in place. See [Content media storage](CONTENT_MEDIA_STORAGE.md) for the shared storage and scanner configuration and operational requirements.

## Data and API notes

Migration `20261101100000_storefront_themes_studio` is additive. It adds the three preset values to the existing `StoreThemePreset` enum and a nullable marketplace theme-catalog JSON setting; existing Stores without theme data continue to use Classic. Store drafts, published theme JSON, publication time, and revision rows are maintained against the existing Store tenant.

The implementation exposes a public catalog endpoint, seller revision/restore endpoints, and administrator catalog read/update endpoints under `/api/store-themes`, `/api/seller/store-theme`, and `/api/admin/store-themes`. Seller save/publish operations use the existing Store platform API and server authorization boundary. Public storefront lookup applies approved-seller, entitlement, catalog-visibility, and Store-scope checks before selecting the presentation.

## Verification

`e2e/store-themes.spec.ts` creates disposable synthetic Stores, products, approved/quarantined media, and a provider-backed active paid-subscription fixture. It exercises seller/admin/free-staff authorization, six-theme preview, draft and publication behavior, cross-Store/global isolation, concurrent revision conflicts, revision restoration, hidden catalog behavior, subscription downgrade/reactivation, saved configuration retention, and public fallbacks. It attaches desktop and mobile screenshots for each theme to the Playwright test result.

Run the browser suite only with the guarded `E2E_DATABASE_URL` workflow in `docs/LOCAL_CONTAINER_STAGING.md`; do not point E2E variables at a development or persistent database. Migration validation is performed against disposable PostgreSQL 17. Payment-provider execution, production billing, cloud media storage/scanning, Azure deployment, and production migrations are outside this feature and remain disabled or separately gated.
