export type ProductPrice = { priceMinor: number; salePriceMinor?: number | null };
export type UnitPriceRecord = { product: ProductPrice; variant?: { priceMinor: number } | null };

export function effectiveProductPriceMinor(product: ProductPrice): number {
  return product.salePriceMinor ?? product.priceMinor;
}

export function effectiveUnitPriceMinor(item: UnitPriceRecord): number {
  return item.variant?.priceMinor ?? effectiveProductPriceMinor(item.product);
}

export function isValidSalePrice(priceMinor: number, salePriceMinor: number | null | undefined): boolean {
  return salePriceMinor == null || (Number.isSafeInteger(salePriceMinor) && salePriceMinor > 0 && salePriceMinor < priceMinor);
}
