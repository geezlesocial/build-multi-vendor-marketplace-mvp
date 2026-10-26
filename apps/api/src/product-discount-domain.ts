export type DiscountCartLine = {
  cartItemId: string;
  productId: string;
  categoryId: string | null;
  categoryIds?: string[];
  sellerId: string | null;
  quantity: number;
  unitPriceMinor: number;
};

export type DiscountDefinition = {
  id: string;
  sellerId: string;
  code: string;
  kind: 'PERCENTAGE' | 'FIXED';
  scope: 'ALL_PRODUCTS' | 'SELECTED_PRODUCTS' | 'SELECTED_CATEGORIES';
  percentBasisPoints: number | null;
  amountMinor: number | null;
  currency: string;
  minimumSubtotalMinor: number | null;
  usageLimit: number | null;
  usesCount: number;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  productIds: string[];
  categoryIds: string[];
};

export type DiscountQuote = {
  discountMinor: number;
  eligibleSubtotalMinor: number;
  allocations: Array<{ cartItemId: string; discountMinor: number }>;
};

export function quoteProductDiscount(definition: DiscountDefinition, lines: DiscountCartLine[], now = new Date()): DiscountQuote {
  if (!definition.enabled) throw new Error('This discount code is inactive.');
  if (definition.startsAt && definition.startsAt > now) throw new Error('This discount code is not active yet.');
  if (definition.endsAt && definition.endsAt <= now) throw new Error('This discount code has expired.');
  if (definition.usageLimit !== null && definition.usesCount >= definition.usageLimit) throw new Error('This discount code has reached its usage limit.');

  const sellerLines = lines.filter(line => line.sellerId === definition.sellerId);
  if (!sellerLines.length) throw new Error('This discount code does not match a Store in your cart.');
  const productIds = new Set(definition.productIds);
  const categoryIds = new Set(definition.categoryIds);
  const eligible = sellerLines.filter(line => definition.scope === 'ALL_PRODUCTS'
    || (definition.scope === 'SELECTED_PRODUCTS' && productIds.has(line.productId))
    || (definition.scope === 'SELECTED_CATEGORIES' && (line.categoryIds ?? (line.categoryId ? [line.categoryId] : [])).some(id => categoryIds.has(id))));
  if (!eligible.length) throw new Error('This discount code does not apply to any item in your cart.');

  const eligibleSubtotalMinor = eligible.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
  if (!Number.isSafeInteger(eligibleSubtotalMinor) || eligibleSubtotalMinor < 1) throw new Error('Eligible items have an invalid subtotal.');
  if (definition.minimumSubtotalMinor !== null && eligibleSubtotalMinor < definition.minimumSubtotalMinor) throw new Error('The eligible items do not meet this code’s minimum subtotal.');

  const rawDiscount = definition.kind === 'PERCENTAGE'
    ? Number((BigInt(eligibleSubtotalMinor) * BigInt(definition.percentBasisPoints ?? 0)) / 10000n)
    : Math.min(eligibleSubtotalMinor - 1, definition.amountMinor ?? 0);
  if (!Number.isSafeInteger(rawDiscount) || rawDiscount < 1) throw new Error('This discount does not reduce the eligible subtotal.');
  if (rawDiscount >= eligibleSubtotalMinor) throw new Error('A discount must leave a positive balance on eligible items.');

  const weighted = eligible.map(line => {
    const lineSubtotal = line.unitPriceMinor * line.quantity;
    const numerator = BigInt(rawDiscount) * BigInt(lineSubtotal);
    const denominator = BigInt(eligibleSubtotalMinor);
    return { cartItemId: line.cartItemId, base: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let unallocated = rawDiscount - weighted.reduce((sum, line) => sum + line.base, 0);
  weighted.sort((a, b) => a.remainder === b.remainder ? a.cartItemId.localeCompare(b.cartItemId) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; unallocated > 0; index = (index + 1) % weighted.length) {
    weighted[index]!.base += 1;
    unallocated -= 1;
  }
  return {
    discountMinor: rawDiscount,
    eligibleSubtotalMinor,
    allocations: weighted.filter(line => line.base > 0).map(line => ({ cartItemId: line.cartItemId, discountMinor: line.base }))
  };
}
