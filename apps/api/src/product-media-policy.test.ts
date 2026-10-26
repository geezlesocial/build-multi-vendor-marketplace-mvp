import { describe, expect, it } from 'vitest';
import { PRODUCT_MEDIA_LIMITS, productMediaLimitError, type ProductMediaCounts } from './product-media-policy.js';

describe('product media limits', () => {
  it('allows assets while each kind remains within its product limit', () => {
    const counts: ProductMediaCounts = { IMAGE: 11, VIDEO: 0, DOCUMENT: 3 };
    expect(productMediaLimitError('IMAGE', counts)).toBeNull();
    expect(productMediaLimitError('VIDEO', counts)).toBeNull();
    expect(productMediaLimitError('DOCUMENT', counts)).toBeNull();
    expect(PRODUCT_MEDIA_LIMITS).toEqual({ IMAGE: 12, VIDEO: 1, DOCUMENT: 4 });
  });

  it('rejects the next asset once the matching kind is full', () => {
    const counts: ProductMediaCounts = { IMAGE: 12, VIDEO: 1, DOCUMENT: 4 };
    expect(productMediaLimitError('IMAGE', counts)).toMatchObject({ statusCode: 409, code: 'PRODUCT_MEDIA_LIMIT_REACHED', kind: 'IMAGE', limit: 12 });
    expect(productMediaLimitError('VIDEO', counts)).toMatchObject({ statusCode: 409, code: 'PRODUCT_MEDIA_LIMIT_REACHED', kind: 'VIDEO', limit: 1 });
    expect(productMediaLimitError('DOCUMENT', counts)).toMatchObject({ statusCode: 409, code: 'PRODUCT_MEDIA_LIMIT_REACHED', kind: 'DOCUMENT', limit: 4 });
  });
});
