import { describe, expect, it } from 'vitest';
import { generateUserWalletId, normalizeWalletId, PLATFORM_ADMIN_WALLET_ID } from './wallet-identity.js';

describe('wallet identity', () => {
  it('uses a fixed platform wallet ID and generates stable-width unique candidates', () => {
    expect(PLATFORM_ADMIN_WALLET_ID).toBe('UI314159');
    expect(generateUserWalletId(0)).toBe('UIB000000');
    expect(generateUserWalletId(2345)).toBe('UIB002345');
    expect(generateUserWalletId(999999)).toBe('UIB999999');
  });

  it('rejects entropy outside the six-digit range and normalizes user-entered IDs', () => {
    expect(() => generateUserWalletId(-1)).toThrow();
    expect(() => generateUserWalletId(1_000_000)).toThrow();
    expect(normalizeWalletId('  uib002345 ')).toBe('UIB002345');
  });
});
