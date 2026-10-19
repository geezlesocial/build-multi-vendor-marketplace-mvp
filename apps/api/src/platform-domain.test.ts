import { describe, expect, it } from 'vitest';
import { decryptPayoutDetails, encryptPayoutDetails, maskIdentifier, payoutStatusTransitionAllowed, reservedStoreSlug, storeThemeSchema } from './platform-domain.js';

describe('platform administration domain rules', () => {
  it('accepts only the allowlisted store theme shape', () => {
    const theme = storeThemeSchema.parse({ primaryColor: '#123456', accentColor: '#abcdef', sections: [{ type: 'featuredProducts', title: 'Featured', productIds: [] }] });
    expect(theme.primaryColor).toBe('#123456');
    expect(() => storeThemeSchema.parse({ primaryColor: 'red', script: '<script>alert(1)</script>' })).toThrow();
  });

  it('round-trips encrypted payout details without exposing them in the masked value', () => {
    const value = { accountHolder: 'Local Seller', accountNumber: '123456789' };
    expect(decryptPayoutDetails(encryptPayoutDetails(value))).toEqual(value);
    expect(maskIdentifier(value.accountNumber)).toContain('6789');
    expect(maskIdentifier(value.accountNumber)).not.toContain(value.accountNumber);
  });

  it('keeps payout transitions explicit and rejects reserved store slugs', () => {
    expect(payoutStatusTransitionAllowed('REQUESTED', 'APPROVED')).toBe(true);
    expect(payoutStatusTransitionAllowed('REQUESTED', 'PAID')).toBe(false);
    expect(reservedStoreSlug('admin')).toBe(true);
    expect(reservedStoreSlug('local-makers')).toBe(false);
  });
});
