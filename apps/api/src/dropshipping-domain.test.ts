import { describe, expect, it } from 'vitest';
import { cleanSupplierDescription, decryptDropshippingCredentials, encryptDropshippingCredentials, safeCjImageUrl, supplierProductList, type CjCredentials } from './dropshipping-domain.js';

const credentials: CjCredentials = {
  apiKey: 'CJUserNum@api@synthetic-example-key',
  accessToken: 'synthetic-access-token',
  refreshToken: 'synthetic-refresh-token',
  accessTokenExpiresAt: '2027-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2027-06-01T00:00:00.000Z'
};

describe('dropshipping integration boundaries', () => {
  it('encrypts the supplier key and token bundle and round-trips it', () => {
    const encrypted = encryptDropshippingCredentials(credentials);
    expect(encrypted).not.toContain(credentials.apiKey);
    expect(encrypted).not.toContain(credentials.accessToken);
    expect(decryptDropshippingCredentials(encrypted)).toEqual(credentials);
  });

  it('only accepts HTTPS images from the supplier CDN domains', () => {
    expect(safeCjImageUrl('https://cf.cjdropshipping.com/image.jpg')).toBe('https://cf.cjdropshipping.com/image.jpg');
    expect(safeCjImageUrl('https://assets.aliyuncs.com/image.png')).toBe('https://assets.aliyuncs.com/image.png');
    expect(safeCjImageUrl('http://cf.cjdropshipping.com/image.jpg')).toBeNull();
    expect(safeCjImageUrl('https://cjdropshipping.com.attacker.test/image.jpg')).toBeNull();
    expect(safeCjImageUrl('javascript:alert(1)')).toBeNull();
  });

  it('removes executable markup from supplier descriptions', () => {
    expect(cleanSupplierDescription('<p>Soft cotton</p><script>alert(1)</script> &amp; durable')).toBe('Soft cotton & durable');
  });

  it('extracts only product objects from CJ list response envelopes', () => {
    expect(supplierProductList({ content: [{ productList: [{ id: 'cj-1' }, null, 'bad'] }, { productList: [{ id: 'cj-2' }] }] })).toEqual([{ id: 'cj-1' }, { id: 'cj-2' }]);
    expect(supplierProductList(null)).toEqual([]);
  });
});
