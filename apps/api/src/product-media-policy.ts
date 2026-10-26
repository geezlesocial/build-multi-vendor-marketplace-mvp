export const PRODUCT_MEDIA_LIMITS = {
  IMAGE: 12,
  VIDEO: 1,
  DOCUMENT: 4
} as const;

export type ProductMediaKind = keyof typeof PRODUCT_MEDIA_LIMITS;
export type ProductMediaCounts = Record<ProductMediaKind, number>;

export function productMediaLimitError(kind: ProductMediaKind, counts: ProductMediaCounts) {
  const limit = PRODUCT_MEDIA_LIMITS[kind];
  if (counts[kind] < limit) return null;
  const label = kind === 'IMAGE' ? 'images' : kind === 'VIDEO' ? 'video' : 'documents';
  return Object.assign(new Error(`A product can have up to ${limit} ${label}. Remove one before adding another.`), {
    statusCode: 409,
    code: 'PRODUCT_MEDIA_LIMIT_REACHED',
    kind,
    limit
  });
}
