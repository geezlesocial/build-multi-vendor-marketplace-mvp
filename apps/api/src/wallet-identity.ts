import { randomInt } from 'node:crypto';

export const PLATFORM_ADMIN_WALLET_ID = 'UI314159';

export function generateUserWalletId(random = randomInt(0, 1_000_000)) {
  if (!Number.isInteger(random) || random < 0 || random > 999_999) throw new Error('Wallet ID entropy must be a six-digit integer');
  return `UIB${String(random).padStart(6, '0')}`;
}

export function normalizeWalletId(value: string) {
  return value.trim().toUpperCase();
}
