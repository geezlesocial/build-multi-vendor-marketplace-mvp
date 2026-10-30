import { describe, expect, it } from 'vitest';
import { wholesaleConfigurationError, wholesaleQuantityError } from './wholesale-domain.js';
import { posSchema } from './validation.js';

describe('wholesale listing limits', () => {
  it('allows ordinary listings without wholesale quantities', () => {
    expect(wholesaleConfigurationError({ wholesaleEnabled: false, wholesaleMinQuantity: null, wholesaleMaxQuantity: null })).toBeNull();
    expect(wholesaleQuantityError({ wholesaleEnabled: false, wholesaleMinQuantity: null, wholesaleMaxQuantity: null }, 1)).toBeNull();
  });

  it('requires a valid minimum and maximum for wholesale listings', () => {
    expect(wholesaleConfigurationError({ wholesaleEnabled: true, wholesaleMinQuantity: null, wholesaleMaxQuantity: 10 })).toMatch(/minimum order quantity/);
    expect(wholesaleConfigurationError({ wholesaleEnabled: true, wholesaleMinQuantity: 10, wholesaleMaxQuantity: 9 })).toMatch(/maximum order quantity/);
    expect(wholesaleConfigurationError({ wholesaleEnabled: true, wholesaleMinQuantity: 1, wholesaleMaxQuantity: 100 })).toMatch(/99 units/);
    expect(wholesaleConfigurationError({ wholesaleEnabled: true, wholesaleMinQuantity: 2, wholesaleMaxQuantity: 10 })).toBeNull();
  });

  it('allows building a cart below minimum but blocks checkout until minimum is met', () => {
    const terms = { wholesaleEnabled: true, wholesaleMinQuantity: 5, wholesaleMaxQuantity: 20 };
    expect(wholesaleQuantityError(terms, 2, false)).toBeNull();
    expect(wholesaleQuantityError(terms, 2)).toMatch(/at least 5/);
    expect(wholesaleQuantityError(terms, 5)).toBeNull();
  });

  it('rejects orders above the seller maximum', () => {
    expect(wholesaleQuantityError({ wholesaleEnabled: true, wholesaleMinQuantity: 5, wholesaleMaxQuantity: 20 }, 21)).toMatch(/at most 20/);
  });

  it('does not allow duplicate POS rows that could evade per-order limits', () => {
    const productId = 'c123456789012345678901234';
    expect(posSchema.safeParse({ items: [{ productId, quantity: 5 }, { productId, quantity: 5 }], register: 'Main' }).success).toBe(false);
  });
});
