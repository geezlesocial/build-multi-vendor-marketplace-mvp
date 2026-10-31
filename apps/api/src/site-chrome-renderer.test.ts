import { describe, expect, it } from 'vitest';
import { defaultSiteChrome } from './site-chrome-domain.js';
import { renderSiteChromeFooter, renderSiteChromeHeader, siteChromeStyles } from './site-chrome-renderer.js';

describe('server-rendered site chrome', () => {
  const brand = { title: 'A <Market>', tagline: 'Independent stores', path: '/' };

  it('escapes user text, marks external links safely, and keeps platform controls in the header', () => {
    const base = defaultSiteChrome();
    const configuration = {
      ...base,
      header: { ...base.header, title: '<script>alert(1)</script>', navigation: [{ id: 'docs', label: 'Docs & help', href: 'https://docs.example.test/guide', enabled: true }] }
    };
    const html = renderSiteChromeHeader(configuration, brand);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="/checkout">Cart</a>');
    expect(html).toContain('href="/dashboard?tab=messages"');
  });

  it('renders up to six configured socials and always keeps the caller-controlled disclosure outside the footer', () => {
    const base = defaultSiteChrome();
    const configuration = {
      ...base,
      footer: {
        ...base.footer,
        title: 'Studio & Co',
        description: 'Thoughtful goods',
        socials: [{ id: 'site', platform: 'WEBSITE' as const, url: 'https://example.test', label: 'Website', enabled: true, display: 'ICON_AND_LABEL' as const }]
      }
    };
    expect(renderSiteChromeFooter(configuration, brand, false)).toContain('Studio &amp; Co');
    expect(renderSiteChromeFooter(configuration, brand, false)).toContain('aria-label="Social links"');
    expect(renderSiteChromeFooter(configuration, brand, true)).toBe('');
    expect(renderSiteChromeHeader(defaultSiteChrome(), brand)).toContain('A &lt;Market&gt;');
  });

  it('emits only validated theme tokens into the stylesheet', () => {
    const base = defaultSiteChrome();
    const css = siteChromeStyles({ ...base, header: { ...base.header, backgroundColor: '#123456' }, footer: { ...base.footer, logoWidth: 120 } });
    expect(css).toContain('--chrome-header-bg:#123456');
    expect(css).toContain('--chrome-footer-logo-width:120px');
    expect(css).not.toContain('<script');
  });
});
