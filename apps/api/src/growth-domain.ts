import crypto from 'node:crypto';

export function safeInternalPath(value: string) {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('..')) throw new Error('Only a safe internal path is allowed');
  return value;
}

export function referralTokenHash(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function signedReferralToken(secret: string) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

export function verifySignedReferralToken(token: string, secret: string) {
  const [nonce, signature] = token.split('.');
  if (!nonce || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(nonce).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function proportionalCommission(originalCommissionMinor: number, originalBaseMinor: number, adjustedBaseMinor: number) {
  if (![originalCommissionMinor, originalBaseMinor, adjustedBaseMinor].every(Number.isSafeInteger) || originalCommissionMinor < 0 || originalBaseMinor <= 0 || adjustedBaseMinor < 0) throw new Error('Invalid commission adjustment');
  return Math.min(originalCommissionMinor, Math.floor(originalCommissionMinor * Math.min(originalBaseMinor, adjustedBaseMinor) / originalBaseMinor));
}

export function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

export function commissionMinor(itemSubtotalMinor: number, basisPoints?: number | null, fixedMinor?: number | null) {
  if (!Number.isSafeInteger(itemSubtotalMinor) || itemSubtotalMinor < 0) throw new Error('Invalid item subtotal');
  if (basisPoints !== null && basisPoints !== undefined) {
    if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) throw new Error('Invalid commission basis points');
    return Math.floor(itemSubtotalMinor * basisPoints / 10000);
  }
  if (fixedMinor !== null && fixedMinor !== undefined) {
    if (!Number.isInteger(fixedMinor) || fixedMinor < 0) throw new Error('Invalid fixed commission');
    return Math.min(itemSubtotalMinor, fixedMinor);
  }
  throw new Error('A commission rule must define basis points or a fixed amount');
}

export function wholesaleUnitPrice(prices: Array<{ minQuantity: number; unitPriceMinor: number }>, quantity: number, retailMinor: number) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantity must be positive');
  return prices.filter(price => price.minQuantity <= quantity).sort((a, b) => b.minQuantity - a.minQuantity)[0]?.unitPriceMinor ?? retailMinor;
}

export function validWholesaleQuantity(quantity: number, minimum: number | null | undefined, packSize: number | null | undefined) {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (minimum && quantity < minimum) return false;
  if (packSize && (quantity % packSize !== 0)) return false;
  return true;
}

export function generatedReferralCode(seed = crypto.randomBytes(10).toString('hex')) {
  const code = seed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toUpperCase();
  if (code.length < 8) throw new Error('Referral code seed is too short');
  return code;
}
