import { describe, expect, it } from 'vitest';
import { shipmentTransitionAllowed } from './shipment-domain.js';

describe('seller shipment progression', () => {
  it('requires shipment to begin at shipped', () => {
    expect(shipmentTransitionAllowed(null, 'SHIPPED')).toBe(true);
    expect(shipmentTransitionAllowed(null, 'DELIVERED')).toBe(false);
    expect(shipmentTransitionAllowed(null, 'EXCEPTION')).toBe(false);
  });

  it('allows normal carrier progress and delivery exceptions', () => {
    expect(shipmentTransitionAllowed('SHIPPED', 'IN_TRANSIT')).toBe(true);
    expect(shipmentTransitionAllowed('IN_TRANSIT', 'OUT_FOR_DELIVERY')).toBe(true);
    expect(shipmentTransitionAllowed('OUT_FOR_DELIVERY', 'IN_TRANSIT')).toBe(true);
    expect(shipmentTransitionAllowed('IN_TRANSIT', 'EXCEPTION')).toBe(true);
    expect(shipmentTransitionAllowed('EXCEPTION', 'DELIVERED')).toBe(true);
  });

  it('does not allow a delivered shipment to move backwards', () => {
    expect(shipmentTransitionAllowed('DELIVERED', 'DELIVERED')).toBe(true);
    expect(shipmentTransitionAllowed('DELIVERED', 'IN_TRANSIT')).toBe(false);
    expect(shipmentTransitionAllowed('DELIVERED', 'EXCEPTION')).toBe(false);
  });
});
