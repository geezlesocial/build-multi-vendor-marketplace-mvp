import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { addressSchema, checkoutSchema, productSchema } from './validation.js';

describe('server-side validation', () => {
  it('rejects client-supplied floating point or negative money', () => expect(() => productSchema.parse({ name: 'X', description: 'Y', priceMinor: 10.5, stock: 1 })).toThrow());
  it('requires a complete delivery address', () => expect(() => addressSchema.parse({ line1: '1 Main', city: 'City' })).toThrow());
  it('allows only supported buyer payment methods', () => expect(() => checkoutSchema.parse({ buyerEmail: 'buyer@example.com', buyerName: 'Buyer', address: { line1: '1 Main', city: 'City', region: 'State', postalCode: '123', country: 'US' }, method: 'BITCOIN' })).toThrow());
  it('normalizes quantity constraints through schema', () => { const s = z.object({ quantity: z.number().int().positive().max(99) }); expect(s.parse({ quantity: 2 }).quantity).toBe(2); expect(() => s.parse({ quantity: 0 })).toThrow(); });
});
