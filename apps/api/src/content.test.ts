import { describe, expect, it } from 'vitest';
import { contentBodySchema, contentSlugSchema, safeExternalUrl } from './content-validation.js';

describe('content safety validation', () => {
  it('accepts structured blocks and rejects HTML/script content', () => {
    expect(contentBodySchema.parse([{ type: 'heading', level: 2, text: 'Welcome' }, { type: 'paragraph', text: 'A useful article.' }])).toHaveLength(2);
    expect(() => contentBodySchema.parse([{ type: 'paragraph', text: '<script>alert(1)</script>' }])).toThrow();
  });

  it('allows safe links but rejects executable protocols', () => {
    expect(safeExternalUrl('https://example.com/help')).toBe('https://example.com/help');
    expect(() => safeExternalUrl('javascript:alert(1)')).toThrow();
    expect(() => safeExternalUrl('data:text/html,unsafe')).toThrow();
  });

  it('enforces normalized slugs', () => {
    expect(contentSlugSchema.parse('shipping-help')).toBe('shipping-help');
    expect(() => contentSlugSchema.parse('Draft Page')).toThrow();
    expect(() => contentSlugSchema.parse('../admin')).toThrow();
  });
});
