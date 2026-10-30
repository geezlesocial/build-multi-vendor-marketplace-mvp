export type WholesaleTerms = {
  wholesaleEnabled: boolean;
  wholesaleMinQuantity: number | null;
  wholesaleMaxQuantity: number | null;
};

export function wholesaleConfigurationError(terms: WholesaleTerms) {
  if (!terms.wholesaleEnabled) return null;
  if (!Number.isInteger(terms.wholesaleMinQuantity) || (terms.wholesaleMinQuantity ?? 0) < 1) {
    return 'A wholesale listing must have a minimum order quantity of at least 1.';
  }
  if (!Number.isInteger(terms.wholesaleMaxQuantity) || (terms.wholesaleMaxQuantity ?? 0) < terms.wholesaleMinQuantity!) {
    return 'A wholesale listing must have a maximum order quantity equal to or greater than its minimum.';
  }
  if (terms.wholesaleMaxQuantity! > 99) return 'The maximum wholesale order is 99 units per listing.';
  return null;
}

export function wholesaleQuantityError(terms: WholesaleTerms, quantity: number, requireMinimum = true) {
  const configurationError = wholesaleConfigurationError(terms);
  if (configurationError) return configurationError;
  if (!terms.wholesaleEnabled) return null;
  if (quantity > terms.wholesaleMaxQuantity!) return `This wholesale listing allows at most ${terms.wholesaleMaxQuantity} units per order.`;
  if (requireMinimum && quantity < terms.wholesaleMinQuantity!) return `This is a wholesale listing. Order at least ${terms.wholesaleMinQuantity} units.`;
  return null;
}
