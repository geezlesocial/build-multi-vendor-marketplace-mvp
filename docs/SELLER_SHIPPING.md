# Seller-managed shipping

Seller shipping is scoped to the existing `Seller` and `Store` boundary. No carrier API, external rate quote, shipping label, tracking integration, tax engine, or seller payment account is connected.

## Configuration and authorization

Approved Store owners can manage service labels, integer-minor-unit fees in the platform's configured currency, optional delivery-day estimates, and country/state/city zones from Seller dashboard → Shipping. Seller staff need the separate `canManageShipping` permission; cashier/POS or branding access does not imply shipping access. Admins can inspect all services and use the audited `sellerShippingEnabled` platform switch. Disabling that switch blocks new quotes and seller shipments but does not remove settings or alter orders.

Country codes are trimmed and uppercased. State/province and city matching is trimmed, Unicode-normalized, whitespace-collapsed, and case-insensitive. A zone with no state or city is country-wide. A city zone requires a state/province. When zones overlap, the most-specific matching zone (city, then state/province, then country) wins; duplicate equal-specificity scopes are rejected and the API fails closed if legacy/direct database writes produce an ambiguous match. Multiple eligible services are options for the buyer, not an ambiguity.

## Checkout, discounts, and order history

The buyer chooses one service for each seller shipment. Platform-owned products do not create a seller shipment. The authenticated quote API calculates item subtotal, each seller service fee, one eligible shipping discount, and final total. A short-lived signed quote binds the buyer, address, cart quantities/variants/prices, selected service, discount result, and expiry. Checkout re-reads the cart and shipping rules in a serializable transaction, checks the signed quote, decrements stock, and creates the parent/seller orders atomically. A changed cart, price, service, zone, discount, or expired quote requires recalculation. Uncovered seller destinations and disabled global shipping block checkout; no implicit zero-fee fallback is used.

Shipping remains separate from `SellerOrder.totalMinor`, which continues to represent merchandise only for seller summaries and payout-ledger calculations. `ParentOrder.totalMinor` includes merchandise plus each seller shipment's final shipping amount. Each seller order stores the service, destination, currency, fee, discount, and final shipping amount in `shippingSnapshotJson`. A PostgreSQL trigger prevents later changes to a non-null snapshot. Existing order totals and null snapshots are not rewritten. COD limits compare the final server-calculated order total.

Product-specific discount rules are attached to approved products owned by the seller. A rule is eligible only when at least one selected product is in that seller's shipment; minimum quantity/subtotal apply to those eligible products. Optional effective dates are checked at quote and checkout. Rules never stack: the highest configured integer priority wins; ties use the oldest creation time and then stable ID. Fixed, percentage (basis points), and free-shipping reductions are integer minor-unit calculations and are capped at the service fee.

Seller changes, staff permission changes, and admin global-switch changes are audited. Admin order, seller order, and buyer order views display the stored shipping snapshot where applicable. No buyer-supplied fee, discount, currency, or total is authoritative.

## Migration and operational boundaries

Migration `20261023000027_seller_managed_shipping` is additive. Existing services are not fabricated or backfilled. Therefore existing seller Stores must configure at least one active service/zone before new seller-product checkouts can proceed. The local-only seed creates one clearly labeled US country-wide demo service for the seeded demo Store; it does not configure a real courier. Owners should review local seed behavior before running it against any persistent non-test database.

The platform base currency is fixed for a service; conversion is unsupported. Shipping plans/entitlements are not inferred or added. Country/address accuracy, shipping policy, delivery promises, and any legal/consumer terms remain owner responsibilities. No payment provider, carrier network, remote label service, or live transaction is used by this feature.
