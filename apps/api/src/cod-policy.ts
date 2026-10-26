export type CodLineEligibility = { requiresShipping: boolean; sellerId: string | null };
export type CodShipmentEligibility = { supportsCod: boolean };

export function codCheckoutEligibilityFailure(items: CodLineEligibility[], shipments: CodShipmentEligibility[]) {
  if (!items.length || items.some(item => !item.requiresShipping || !item.sellerId)) {
    return 'Cash on delivery is available only for physical items fulfilled by approved sellers.';
  }

  const sellerCount = new Set(items.map(item => item.sellerId)).size;
  if (!shipments.length || shipments.length !== sellerCount) {
    return 'Calculate a delivery service for every seller before using cash on delivery.';
  }
  if (shipments.some(shipment => !shipment.supportsCod)) {
    return 'Every selected delivery service must accept cash on delivery.';
  }
  return null;
}

export function exceedsCodOrderLimit(totalMinor: number, maximumMinor: number | null | undefined) {
  return maximumMinor != null && totalMinor > maximumMinor;
}
