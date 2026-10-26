import type { ShipmentStatus } from '@prisma/client';

const allowedTransitions: Record<ShipmentStatus, ReadonlySet<ShipmentStatus>> = {
  SHIPPED: new Set(['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']),
  IN_TRANSIT: new Set(['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']),
  OUT_FOR_DELIVERY: new Set(['OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION']),
  DELIVERED: new Set(['DELIVERED']),
  EXCEPTION: new Set(['EXCEPTION', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'])
};

export function shipmentTransitionAllowed(current: ShipmentStatus | null, next: ShipmentStatus) {
  return current === null ? next === 'SHIPPED' : allowedTransitions[current].has(next);
}
