import { describe, expect, it } from 'vitest';
import { defaultSiteChrome } from './site-chrome-domain.js';
import { renderSiteChromeFooter, renderSiteChromeHeader, siteChromeStyles } from './site-chrome-renderer.js';
import { renderSiteChromeSocialIcon } from './site-chrome-social-icons.js';

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
        socials: [{ id: 'site', platform: 'WEBSITE' as const, url: 'https://example.test', label: 'Website', iconMediaId: null, enabled: true, display: 'ICON_AND_LABEL' as const }]
      }
    };
    expect(renderSiteChromeFooter(configuration, brand, false)).toContain('Studio &amp; Co');
    expect(renderSiteChromeFooter(configuration, brand, false)).toContain('aria-label="Social links"');
    expect(renderSiteChromeFooter(configuration, brand, false)).toContain('<svg class="siteChromeSocialIcon" data-platform="WEBSITE"');
    expect(renderSiteChromeFooter(configuration, brand, false)).toContain('focusable="false"');
    expect(renderSiteChromeFooter(configuration, brand, false)).not.toContain('<span aria-hidden="true">↗</span>');
    expect(renderSiteChromeFooter(configuration, brand, true)).toBe('');
    expect(renderSiteChromeHeader(defaultSiteChrome(), brand)).toContain('A &lt;Market&gt;');
  });

  it('renders a curated safe SVG mark for every supported social platform', () => {
    const platforms = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'PINTEREST', 'WEBSITE', 'OTHER'];
    for (const platform of platforms) {
      const icon = renderSiteChromeSocialIcon(platform);
      expect(icon).toContain(`data-platform="${platform}"`);
      expect(icon).toContain('<svg');
      expect(icon).toContain('width="20" height="20"');
      expect(icon).not.toContain('<script');
      expect(icon).toContain('aria-hidden="true"');
    }
    expect(renderSiteChromeSocialIcon('OTHER" onload="alert(1)')).toContain('data-platform="OTHER"');
    expect(renderSiteChromeSocialIcon('OTHER" onload="alert(1)')).not.toContain('onload');
  });

  it('does not force Commerce search on when the published search setting is off', () => {
    const base = defaultSiteChrome();
    const html = renderSiteChromeHeader({ ...base, header: { ...base.header, template: 'COMMERCE', showSearch: false } }, brand);
    expect(html).not.toContain('role="search"');
    expect(html).not.toContain('/site-chrome-search.js');
  });

  it('renders search and announcement only when enabled, and safely includes the suggestion assets', () => {
    const base = defaultSiteChrome();
    const enabled = renderSiteChromeHeader({ ...base, header: { ...base.header, template: 'COMMERCE', showSearch: true, announcementEnabled: true, announcementText: 'A <safe> announcement', announcementHref: '/shop' } }, brand);
    expect(enabled).toContain('role="search"');
    expect(enabled).toContain('src="/site-chrome-search.js"');
    expect(enabled).toContain('A &lt;safe&gt; announcement');
    const disabled = renderSiteChromeHeader({ ...base, header: { ...base.header, announcementEnabled: false, announcementText: 'Do not render' } }, brand);
    expect(disabled).not.toContain('Do not render');
  });

  it('renders footer groups, contact actions, copyright, and approved custom social images', () => {
    const base = defaultSiteChrome();
    const html = renderSiteChromeFooter({ ...base, footer: {
      ...base.footer,
      title: 'Studio footer',
      description: 'A short brand story',
      contactEmail: 'hello@example.test',
      contactPhone: '+1 (555) 123-4567',
      copyright: 'Copyright by Studio',
      backToTop: true,
      sections: [{ id: 'help', title: 'Help', links: [{ id: 'faq', label: 'FAQs', href: '/pages/faq', enabled: true }] }],
      socials: [{ id: 'instagram', platform: 'INSTAGRAM', url: 'https://instagram.com/studio', label: 'Studio on Instagram', iconMediaId: 'approved-social-icon', enabled: true, display: 'ICON_AND_LABEL' }]
    } }, brand, false);
    expect(html).toContain('A short brand story');
    expect(html).toContain('href="mailto:hello@example.test"');
    expect(html).toContain('href="tel:+15551234567"');
    expect(html).toContain('href="/pages/faq"');
    expect(html).toContain('Copyright by Studio');
    expect(html).toContain('href="#top">Back to top');
    expect(html).toContain('src="/content-media/approved-social-icon"');
    expect(html).not.toContain('data-platform="INSTAGRAM"');
  });

  it('emits only validated theme tokens into the stylesheet', () => {
    const base = defaultSiteChrome();
    const css = siteChromeStyles({ ...base, header: { ...base.header, backgroundColor: '#123456' }, footer: { ...base.footer, logoWidth: 120 } });
    expect(css).toContain('--chrome-header-bg:#123456');
    expect(css).toContain('--chrome-footer-logo-width:120px');
    expect(css).toContain('.siteChromeSsrSearchResults[hidden]{display:none}');
    expect(css).not.toContain('<script');
  });
});
