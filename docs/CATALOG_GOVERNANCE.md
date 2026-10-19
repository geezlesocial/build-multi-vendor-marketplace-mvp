# Catalog governance

Platform administrators can manage categories and brands through `/admin/platform`. Categories support a maximum depth of three, reject cycles, preserve referenced records, and use `ACTIVE`, `INACTIVE`, and `ARCHIVED` states. Referenced categories and brands cannot be deleted until products or child categories are reassigned or archived.

Seller-created products remain `PENDING` under the default manual product approval policy. The automatic policy still requires an approved seller and all existing server validation. Platform products created by administrators remain approved.

Taxonomy changes are audited. Published URL redirects and SEO treatment should be reviewed before changing slugs on public storefront routes.
