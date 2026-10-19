# Seller store customization

Approved sellers can edit a store draft at `/seller/platform`. The theme is a typed JSON document containing description, approved colors, one of three font choices, contact links, and allowlisted sections. Arbitrary HTML, CSS, JavaScript, external widgets, and scripts are rejected.

Only the seller’s own store is queried or mutated. A seller cannot publish another store by changing a URL or request identifier. Public theme delivery is available only for an approved seller with a published theme.

Store logos and banners use the existing media quarantine/scanning pipeline. A quarantined asset can be saved in a draft but cannot be published. Local disk storage remains development-only; configure the documented object storage/CDN and scanning controls before staging.
