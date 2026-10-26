import { describe, expect, it } from 'vitest';
import { carrierTrackingUrl, isSafeTrackingUrlTemplate } from './carrier-domain.js';

describe('carrier tracking URLs', () => {
  it('accepts HTTPS tracking pages and templates with a tracking placeholder', () => {
    expect(isSafeTrackingUrlTemplate('https://carrier.example/track')).toBe(true);
    expect(isSafeTrackingUrlTemplate('https://carrier.example/track/{trackingNumber}')).toBe(true);
  });

  it('rejects unsafe protocols, credentials, and unsupported placeholders', () => {
    expect(isSafeTrackingUrlTemplate('http://carrier.example/track')).toBe(false);
    expect(isSafeTrackingUrlTemplate('javascript:alert(1)')).toBe(false);
    expect(isSafeTrackingUrlTemplate('https://user:pass@carrier.example/track')).toBe(false);
    expect(isSafeTrackingUrlTemplate('https://carrier.example/{orderId}')).toBe(false);
  });

  it('URL-encodes tracking numbers and leaves general tracking pages usable', () => {
    expect(carrierTrackingUrl('https://carrier.example/track/{trackingNumber}', 'ABC 123/4'))
      .toBe('https://carrier.example/track/ABC%20123%2F4');
    expect(carrierTrackingUrl('https://carrier.example/track', 'ABC123'))
      .toBe('https://carrier.example/track');
    expect(carrierTrackingUrl(null, 'ABC123')).toBeNull();
  });
});
