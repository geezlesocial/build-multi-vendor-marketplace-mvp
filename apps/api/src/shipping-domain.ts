import crypto from 'node:crypto';

export type ShippingAddress = { line1: string; line2?: string; city: string; region: string; postalCode: string; country: string };
export type ShippingCartItem = { productId: string; variantId?: string | null; sellerId: string | null; quantity: number; unitPriceMinor: number; productName?: string };
export type ShippingZone = { id: string; countryCode: string; regionKey: string; regionLabel: string | null; cityKey: string; cityLabel: string | null };
export type ShippingDiscount = {
  id: string; name: string; type: 'FREE' | 'FIXED' | 'PERCENTAGE'; amountMinor: number | null; basisPoints: number | null;
  priority: number; startsAt: Date | null; endsAt: Date | null; minimumQuantity: number | null; minimumSubtotalMinor: number | null;
  enabled: boolean; createdAt: Date; products: { productId: string }[];
};
export type ShippingService = {
  id: string; sellerId: string; name: string; feeMinor: number; currency: string; estimatedMinDays: number | null;
  estimatedMaxDays: number | null; enabled: boolean; supportsCod: boolean; zones: ShippingZone[]; discounts: ShippingDiscount[];
  carrierProvider?: { id: string; name: string; trackingUrlTemplate: string | null } | null;
};

export function normalizeShippingLocation(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function normalizeCountryCode(value: string) {
  return value.trim().toUpperCase();
}

export function matchShippingZone(zones: ShippingZone[], address: ShippingAddress) {
  const country = normalizeCountryCode(address.country);
  const region = normalizeShippingLocation(address.region);
  const city = normalizeShippingLocation(address.city);
  const matches = zones.filter(zone => zone.countryCode === country &&
    (!zone.regionKey || zone.regionKey === region) && (!zone.cityKey || zone.cityKey === city));
  if (!matches.length) return null;
  const specificity = (zone: ShippingZone) => Number(Boolean(zone.regionKey)) + Number(Boolean(zone.cityKey));
  const best = Math.max(...matches.map(specificity));
  const winners = matches.filter(zone => specificity(zone) === best);
  if (winners.length !== 1) throw new Error('Shipping zones overlap ambiguously for this destination');
  return winners[0];
}

export type ShippingDiscountResult = { id: string; name: string; type: ShippingDiscount['type']; amountMinor: number } | null;
export function calculateShippingDiscount(service: ShippingService, items: ShippingCartItem[], now = new Date()): ShippingDiscountResult {
  const candidates = service.discounts.filter(discount => {
    if (!discount.enabled || !discount.products.length) return false;
    if (discount.startsAt && now < discount.startsAt) return false;
    if (discount.endsAt && now >= discount.endsAt) return false;
    const products = new Set(discount.products.map(product => product.productId));
    const eligible = items.filter(item => products.has(item.productId));
    if (!eligible.length) return false;
    const quantity = eligible.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = eligible.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
    return (discount.minimumQuantity === null || quantity >= discount.minimumQuantity) &&
      (discount.minimumSubtotalMinor === null || subtotal >= discount.minimumSubtotalMinor);
  }).sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const chosen = candidates[0];
  if (!chosen) return null;
  const raw = chosen.type === 'FREE' ? service.feeMinor
    : chosen.type === 'FIXED' ? (chosen.amountMinor ?? 0)
      : Math.floor(service.feeMinor * (chosen.basisPoints ?? 0) / 10_000);
  return { id: chosen.id, name: chosen.name, type: chosen.type, amountMinor: Math.min(service.feeMinor, Math.max(0, raw)) };
}

export function quoteShippingService(service: ShippingService, items: ShippingCartItem[], address: ShippingAddress, currency: string, now = new Date()) {
  if (!service.enabled || service.currency !== currency) return null;
  const zone = matchShippingZone(service.zones, address);
  if (!zone) return null;
  const discount = calculateShippingDiscount(service, items, now);
  const discountMinor = discount?.amountMinor ?? 0;
  return {
    serviceId: service.id, serviceName: service.carrierProvider ? `${service.carrierProvider.name} · ${service.name}` : service.name, zoneId: zone.id,
    ...(service.carrierProvider ? { carrierProviderId: service.carrierProvider.id, carrierName: service.carrierProvider.name, trackingUrlTemplate: service.carrierProvider.trackingUrlTemplate } : {}),
    feeMinor: service.feeMinor, discountMinor, shippingMinor: service.feeMinor - discountMinor, currency,
    estimatedMinDays: service.estimatedMinDays, estimatedMaxDays: service.estimatedMaxDays, supportsCod: service.supportsCod,
    discount: discount ? { id: discount.id, name: discount.name, type: discount.type, amountMinor: discount.amountMinor } : null
  };
}

export type ShippingQuoteSelection = NonNullable<ReturnType<typeof quoteShippingService>> & { sellerId: string };
export type SignedShippingQuote = {
  version: 1; userId: string; expiresAt: number; cartHash: string; addressHash: string;
  selections: ShippingQuoteSelection[];
};

function digest(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

export function shippingCartHash(items: ShippingCartItem[]) {
  return digest(items.map(item => ({ productId: item.productId, variantId: item.variantId ?? null, sellerId: item.sellerId, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor })).sort((a, b) => a.productId.localeCompare(b.productId)));
}

export function shippingAddressHash(address: ShippingAddress) {
  return digest({ line1: address.line1.trim(), line2: address.line2?.trim() ?? '', city: normalizeShippingLocation(address.city), region: normalizeShippingLocation(address.region), postalCode: address.postalCode.trim(), country: normalizeCountryCode(address.country) });
}

export function signShippingQuote(payload: SignedShippingQuote, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyShippingQuote(token: string, secret: string): SignedShippingQuote | null {
  const [encoded, signature, ...extra] = token.split('.');
  if (!encoded || !signature || extra.length) return null;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedShippingQuote;
    if (value.version !== 1 || typeof value.userId !== 'string' || !Number.isInteger(value.expiresAt) ||
      typeof value.cartHash !== 'string' || typeof value.addressHash !== 'string' || !Array.isArray(value.selections)) return null;
    return value;
  } catch { return null; }
}
