import { describe, expect, it } from 'vitest';
import { decryptPayoutDetails, encryptPayoutDetails, maskIdentifier, payoutStatusTransitionAllowed, platformSettingsSchema, reservedStoreSlug, storeSlugFromName, storeThemeSchema } from './platform-domain.js';

describe('platform administration domain rules', () => {
  it('accepts only the allowlisted store theme shape', () => {
    const theme = storeThemeSchema.parse({ primaryColor: '#123456', accentColor: '#abcdef', sections: [{ type: 'featuredProducts', title: 'Featured', productIds: [] }] });
    expect(theme.primaryColor).toBe('#123456');
    expect(theme.faviconMediaId).toBeNull();
    expect(storeThemeSchema.parse({ faviconMediaId: 'approved-store-favicon' }).faviconMediaId).toBe('approved-store-favicon');
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

  it('normalizes store names into public slugs without empty punctuation URLs', () => {
    expect(storeSlugFromName('Tech & Appliances')).toBe('tech-appliances');
    expect(storeSlugFromName('  Café---Tools!  ')).toBe('cafe-tools');
    expect(storeSlugFromName('***')).toBe('');
  });

  it('validates an optional COD ceiling in integer minor units and supports clearing it', () => {
    expect(platformSettingsSchema.parse({ codMaxMinor: 25_000 }).codMaxMinor).toBe(25_000);
    expect(platformSettingsSchema.parse({ codMaxMinor: null }).codMaxMinor).toBeNull();
    expect(() => platformSettingsSchema.parse({ codMaxMinor: -1 })).toThrow();
    expect(() => platformSettingsSchema.parse({ codMaxMinor: 2_000_000_001 })).toThrow();
  });
});
