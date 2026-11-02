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

  it('adds the same-origin marketplace ad slot only when an eligible published blog opts in', () => {
    const base = { title: 'A post', description: 'Description', canonical: 'https://localhost/blog/example', body: '<p>Post body</p>', type: 'BlogPosting' as const, updatedAt: new Date('2026-01-01T00:00:00.000Z'), breadcrumb: 'Blog' };
    const blog = renderDocument({ ...base, marketplaceAdPlacement: true });
    expect(blog).toContain('data-marketplace-ad-placement="BLOG_POSTS"');
    expect(blog).toContain('/api/marketplace-ads/blog-placement.js');
    expect(blog).toContain('/api/marketplace-ads/placement.css');
    const page = renderDocument({ ...base, type: 'WebPage' });
    expect(page).not.toContain('data-marketplace-ad-placement');
    expect(page).not.toContain('/api/marketplace-ads/blog-placement.js');
  });

  it('renders a known Store theme and validated token palette on CMS and blog pages without allowing CSS injection', () => {
    const base = { title: 'A post', description: 'Description', canonical: 'https://localhost/store/demo/blog/example', body: '<p>Post body</p>', type: 'BlogPosting' as const, updatedAt: new Date('2026-01-01T00:00:00.000Z'), breadcrumb: 'Demo Store', chromeHeader: '<header>Store navigation</header>', chromeFooter: '<footer>Store footer</footer>' };
    const html = renderDocument({ ...base, storeTheme: 'TECH_ELECTRONICS', storeThemeTokens: { surfaceColor: '#10131d', cardColor: '#191e2c', textColor: '#f5f6fb', mutedColor: '#b4bbcf', accentColor: 'red;url(javascript:alert(1))' } });
    expect(html).toContain('data-store-theme="TECH_ELECTRONICS"');
    expect(html).toContain('--store-surface:#10131d');
    expect(html).toContain('--store-theme-accent:#315d47');
    expect(html).toContain('<header>Store navigation</header>');
    expect(html).toContain('<footer>Store footer</footer>');
    const unknown = renderDocument({ ...base, storeTheme: 'UNTRUSTED' });
    expect(unknown).toContain('data-store-theme="CLASSIC"');
  });
});
