import { describe, expect, it } from 'vitest';
import {
  calculateShippingDiscount, matchShippingZone, normalizeCountryCode, normalizeShippingLocation,
  quoteShippingService, signShippingQuote, verifyShippingQuote, type ShippingDiscount,
  type ShippingService, type ShippingZone
} from './shipping-domain.js';

const now = new Date('2026-10-23T00:00:00.000Z');
const zones: ShippingZone[] = [
  { id: 'country', countryCode: 'US', regionKey: '', regionLabel: null, cityKey: '', cityLabel: null },
  { id: 'state', countryCode: 'US', regionKey: 'california', regionLabel: 'California', cityKey: '', cityLabel: null },
  { id: 'city', countryCode: 'US', regionKey: 'california', regionLabel: 'California', cityKey: 'san francisco', cityLabel: 'San Francisco' }
];
const service = (discounts: ShippingDiscount[] = [], shippingZones = zones): ShippingService => ({
  id: 'svc-1', sellerId: 'seller-1', name: 'Local courier', feeMinor: 1000, currency: 'USD',
  estimatedMinDays: 2, estimatedMaxDays: 5, enabled: true, zones: shippingZones, discounts
});
const item = (productId = 'product-1', quantity = 2, unitPriceMinor = 2500) => ({ productId, sellerId: 'seller-1', quantity, unitPriceMinor });
function discount(input: Partial<ShippingDiscount> & Pick<ShippingDiscount, 'id' | 'type'>): ShippingDiscount {
  return { id: input.id, name: input.name ?? input.id, type: input.type, amountMinor: input.amountMinor ?? null,
    basisPoints: input.basisPoints ?? null, priority: input.priority ?? 0, startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null, minimumQuantity: input.minimumQuantity ?? null,
    minimumSubtotalMinor: input.minimumSubtotalMinor ?? null, enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? now, products: input.products ?? [{ productId: 'product-1' }] };
}

describe('seller shipping rules', () => {
  it('normalizes countries and locations and selects the most specific matching zone', () => {
    expect(normalizeCountryCode(' us ')).toBe('US');
    expect(normalizeShippingLocation('  San   Francisco ')).toBe('san francisco');
    expect(matchShippingZone(zones, { country: 'us', region: ' CALIFORNIA ', city: ' San Francisco ', line1: '1 Main', postalCode: '1' })?.id).toBe('city');
    expect(matchShippingZone(zones, { country: 'US', region: 'California', city: 'Oakland', line1: '1 Main', postalCode: '1' })?.id).toBe('state');
    expect(matchShippingZone(zones, { country: 'US', region: 'Nevada', city: 'Reno', line1: '1 Main', postalCode: '1' })?.id).toBe('country');
  });

  it('returns no zone for an uncovered country and rejects equally specific ambiguous matches', () => {
    expect(matchShippingZone(zones, { country: 'CA', region: 'Ontario', city: 'Toronto', line1: '1 Main', postalCode: '1' })).toBeNull();
    expect(() => matchShippingZone([...zones, { ...zones[2]!, id: 'duplicate-city' }], { country: 'US', region: 'California', city: 'San Francisco', line1: '1 Main', postalCode: '1' })).toThrow(/ambiguous/i);
  });

  it('supports free, fixed, and percentage discounts with integer minor units and caps', () => {
    const free = calculateShippingDiscount(service([discount({ id: 'free', type: 'FREE' })]), [item()], now);
    const fixed = calculateShippingDiscount(service([discount({ id: 'fixed', type: 'FIXED', amountMinor: 250 })]), [item()], now);
    const percent = calculateShippingDiscount(service([discount({ id: 'percent', type: 'PERCENTAGE', basisPoints: 1250 })]), [item()], now);
    const capped = calculateShippingDiscount(service([discount({ id: 'cap', type: 'FIXED', amountMinor: 50_000 })]), [item()], now);
    expect(free?.amountMinor).toBe(1000);
    expect(fixed?.amountMinor).toBe(250);
    expect(percent?.amountMinor).toBe(125);
    expect(capped?.amountMinor).toBe(1000);
    expect(quoteShippingService(service([discount({ id: 'free', type: 'FREE' })]), [item()], { country: 'US', region: 'California', city: 'Oakland', line1: '1 Main', postalCode: '1' }, 'USD', now)?.shippingMinor).toBe(0);
  });

  it('requires an eligible selected product and honors date, quantity, subtotal, and deterministic priority', () => {
    const notSelected = discount({ id: 'not-selected', type: 'FREE', products: [{ productId: 'other' }], priority: 100 });
    const future = discount({ id: 'future', type: 'FREE', startsAt: new Date('2026-10-24T00:00:00Z'), priority: 200 });
    const insufficient = discount({ id: 'quantity', type: 'FREE', minimumQuantity: 3, priority: 300 });
    const oldest = discount({ id: 'oldest', type: 'FIXED', amountMinor: 200, priority: 5, createdAt: new Date('2026-01-01') });
    const tied = discount({ id: 'newer', type: 'FREE', priority: 5, createdAt: new Date('2026-02-01') });
    const subtotalGate = discount({ id: 'subtotal', type: 'FREE', minimumSubtotalMinor: 5001, priority: 400 });
    expect(calculateShippingDiscount(service([notSelected, future, insufficient, oldest, tied, subtotalGate]), [item()], now)?.id).toBe('oldest');
    expect(calculateShippingDiscount(service([oldest]), [item('another')], now)).toBeNull();
  });

  it('produces signed quotes that reject tampering and preserves service fee, discount, and final shipping separately', () => {
    const quoted = quoteShippingService(service([discount({ id: 'fixed', type: 'FIXED', amountMinor: 300 })]), [item()], { country: 'US', region: 'California', city: 'Oakland', line1: '1 Main', postalCode: '1' }, 'USD', now)!;
    expect(quoted).toMatchObject({ feeMinor: 1000, discountMinor: 300, shippingMinor: 700, currency: 'USD', zoneId: 'state' });
    const payload = { version: 1 as const, userId: 'buyer-1', expiresAt: now.getTime() + 60_000, cartHash: 'cart', addressHash: 'address', selections: [{ ...quoted, sellerId: 'seller-1' }] };
    const token = signShippingQuote(payload, 'test-only-secret');
    expect(verifyShippingQuote(token, 'test-only-secret')).toEqual(payload);
    expect(verifyShippingQuote(`${token.slice(0, -1)}x`, 'test-only-secret')).toBeNull();
    expect(verifyShippingQuote(token, 'different-secret')).toBeNull();
  });
});
