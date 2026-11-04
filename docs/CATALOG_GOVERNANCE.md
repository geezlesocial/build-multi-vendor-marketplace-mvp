# Catalog governance

Platform administrators can manage categories and brands through `/admin/platform?section=taxonomy`. Categories support a maximum depth of three, reject cycles and moves that would deepen descendants, preserve referenced records, and use `ACTIVE`, `INACTIVE`, and `ARCHIVED` states. Referenced categories and brands cannot be deleted until products or child categories are reassigned or archived. A category slug change creates a permanent same-site redirect; category images and brand images can only reference complete, malware-approved images from the existing platform media flow.

`npm run db:seed` adds the curated starting taxonomy, four canonical product types, optional type/category features, and the documented starter brands in [CATALOG_DEFAULTS.md](./CATALOG_DEFAULTS.md). Defaults are additive and stable-ID based: subsequent seeds do not overwrite administrator edits. Removing a seeded default records a suppression marker so a later seed does not recreate it. Existing unmatched or conflicting records are retained and reported instead of being overwritten. Restricted health-device and fresh/chilled food branches start inactive; administrators remain responsible for local law, product eligibility, and catalog suitability before activation.

Brands are marketplace-wide and are not scoped to one category. A product may remain unbranded (`brandId: null`). Starter brand names are examples for catalog setup only; they do not imply endorsement, availability, or ownership. No logos are bundled or scraped. Catalog entries show generated initials unless an administrator selects an image through the approved media flow.

Seller-created products remain `PENDING` under the default manual product approval policy. The automatic policy still requires an approved seller and all existing server validation. Platform products created by administrators remain approved.

Taxonomy changes are audited. Review the permanent redirect and SEO treatment before changing a category slug on a public route.
