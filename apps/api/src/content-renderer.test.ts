import { describe, expect, it } from 'vitest';
import { renderBlocks, renderDocument } from './content-renderer.js';

describe('crawlable CMS rendering', () => {
  it('escapes structured content and emits initial-response metadata', () => {
    const body = renderBlocks([{ type: 'paragraph', text: 'Safe content', linkUrl: 'https://example.com' }]);
    const html = renderDocument({ title: 'A <title>', description: 'Description', canonical: 'https://localhost/pages/example', body, type: 'WebPage', updatedAt: new Date('2026-01-01T00:00:00.000Z'), breadcrumb: 'Pages' });
    expect(html).toContain('<title>A &lt;title&gt;</title>');
    expect(html).toContain('<link rel="canonical" href="https://localhost/pages/example">');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('<p>Safe content');
    expect(html).not.toContain('javascript:');
  });
});
