import type { SiteChromeConfiguration } from './site-chrome-domain.js';
import { renderSiteChromeSocialIcon } from './site-chrome-social-icons.js';

export type SiteChromeBrand = {
  title: string;
  tagline?: string;
  description?: string;
  logoMediaId?: string | null;
  path?: string;
};

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const external = (href: string) => /^https:\/\//i.test(href);
const linkAttrs = (href: string) => external(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
/** All interpolated values are strict-schema validated color/size values, never arbitrary CSS. */
export function siteChromeStyles(configuration: SiteChromeConfiguration) {
  const { header, footer } = configuration;
  return `:root{--chrome-header-bg:${header.backgroundColor};--chrome-header-text:${header.textColor};--chrome-header-accent:${header.accentColor};--chrome-footer-bg:${footer.backgroundColor};--chrome-footer-text:${footer.textColor};--chrome-footer-accent:${footer.accentColor};--chrome-footer-logo-width:${footer.logoWidth}px;--chrome-footer-logo-height:${footer.logoHeight}px}
.siteChromeSsrHeader{position:relative;z-index:2;background:var(--chrome-header-bg);color:var(--chrome-header-text);border-bottom:1px solid #dce1d9;font-family:system-ui,sans-serif}.siteChromeSsrHeader.isSticky{position:sticky;top:0}.siteChromeSsrHeader--compact .siteChromeSsrNav{padding-block:.45rem}.siteChromeSsrHeader--spacious .siteChromeSsrNav{padding-block:1.3rem}.siteChromeSsrAnnouncement{padding:.45rem 1rem;text-align:center;background:var(--chrome-header-accent);color:#fff}.siteChromeSsrAnnouncement a{color:inherit}.siteChromeSsrNav{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:.45rem;padding:1rem clamp(1rem,4vw,4rem)}.siteChromeSsrBrand{display:flex;align-items:center;gap:.65rem;margin-right:auto;color:inherit;text-decoration:none;font-weight:800}.siteChromeSsrBrand img{max-width:150px;max-height:48px;object-fit:contain}.siteChromeSsrBrand span{display:grid}.siteChromeSsrBrand small{font-weight:500;letter-spacing:.05em}.siteChromeSsrNav>a:not(.siteChromeSsrBrand){padding:.45rem .75rem;border:1px solid #c6d0c7;border-radius:99px;color:inherit;text-decoration:none}.siteChromeSsrNav .siteChromeSsrPrimary{background:var(--chrome-header-accent);color:#fff!important}.siteChromeSsrNav form{display:flex;gap:.3rem}.siteChromeSsrNav input{min-width:0;padding:.55rem;border:1px solid #c6d0c7;border-radius:.6rem}.siteChromeSsrNav button{padding:.5rem .75rem;border:1px solid var(--chrome-header-accent);border-radius:99px;background:var(--chrome-header-accent);color:#fff}.siteChromeSsrHeader--editorial .siteChromeSsrBrand{justify-content:center;text-align:center}.siteChromeSsrHeader--commerce .siteChromeSsrNav form{flex:1;max-width:28rem}.siteChromeSsrHeader--commerce .siteChromeSsrNav input{flex:1}.siteChromeSsrCategoryMenu{position:relative}.siteChromeSsrCategoryMenu summary{cursor:pointer;padding:.45rem .7rem;border:1px solid #c6d0c7;border-radius:99px}.siteChromeSsrCategoryList{position:absolute;z-index:5;top:100%;left:0;display:grid;min-width:13rem;max-height:60vh;overflow:auto;padding:.4rem;background:#fff;border:1px solid #dce1d9;border-radius:.7rem;box-shadow:0 10px 30px #18211d22}.siteChromeSsrCategoryList a{padding:.45rem;color:#26342c}
.siteChromeSsrFooter{padding:2rem clamp(1rem,4vw,4rem) 1rem;background:var(--chrome-footer-bg);color:var(--chrome-footer-text);font-family:system-ui,sans-serif;border-top:1px solid #dce1d9}.siteChromeSsrFooterMain{display:grid;grid-template-columns:minmax(200px,1.5fr) repeat(auto-fit,minmax(140px,1fr));gap:1.5rem;max-width:1280px;margin:auto}.siteChromeSsrIdentity{display:flex;gap:.75rem;align-items:flex-start}.siteChromeSsrIdentity img{width:auto;max-width:var(--chrome-footer-logo-width);max-height:var(--chrome-footer-logo-height);object-fit:contain}.siteChromeSsrIdentity p{max-width:32rem;color:#68736b}.siteChromeSsrSection{display:grid;align-content:start;gap:.45rem}.siteChromeSsrSection h2{margin:0 0 .2rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em}.siteChromeSsrFooter a{color:var(--chrome-footer-accent);overflow-wrap:anywhere}.siteChromeSsrSocials{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}.siteChromeSsrSocials a{display:inline-flex;gap:.4rem;align-items:center;padding:.45rem .65rem;border:1px solid #cad5cb;border-radius:99px;text-decoration:none}.siteChromeSsrBottom{display:flex;justify-content:space-between;gap:1rem;max-width:1280px;margin:1.25rem auto 0;padding-top:.8rem;border-top:1px solid #cad5cb}.siteChromeSsrDisclosure{padding:1rem;background:#eef3ec;color:#546258;text-align:center;font:.85rem/1.5 system-ui,sans-serif}
.siteChromeSsrHeader.isCentered .siteChromeSsrBrand{margin-left:auto;margin-right:auto}.siteChromeSsrFooter--business .siteChromeSsrFooterMain{grid-template-columns:minmax(200px,1.6fr) repeat(3,minmax(130px,1fr))}.siteChromeSsrFooter--signature{padding-top:clamp(2rem,6vw,4.5rem)}.siteChromeSsrFooter--signature .siteChromeSsrIdentity strong{font-size:1.3rem}.siteChromeSsrFooter.isCentered .siteChromeSsrFooterMain{justify-items:center;text-align:center}.siteChromeSsrFooter.isCentered .siteChromeSsrIdentity{justify-content:center}.siteChromeSsrFooter.isCentered .siteChromeSsrSocials{justify-content:center}
@media(max-width:720px){.siteChromeSsrNav{justify-content:flex-start}.siteChromeSsrBrand{width:100%}.siteChromeSsrNav form{order:2;width:100%}.siteChromeSsrFooterMain{grid-template-columns:repeat(2,minmax(0,1fr))}.siteChromeSsrIdentity{grid-column:1/-1}.siteChromeSsrBottom{flex-direction:column}}@media(max-width:380px){.siteChromeSsrFooterMain{grid-template-columns:minmax(0,1fr)}}`;
}

export function renderSiteChromeHeader(configuration: SiteChromeConfiguration, brand: SiteChromeBrand, categories: { name: string; slug: string }[] = []) {
  const header = configuration.header;
  const title = header.title || brand.title;
  const tagline = header.tagline || brand.tagline || '';
  const logo = header.logoMediaId || brand.logoMediaId || null;
  const root = brand.path || '/';
  const announcement = header.announcementEnabled && header.announcementText
    ? `<div class="siteChromeSsrAnnouncement">${header.announcementHref ? `<a href="${escapeHtml(header.announcementHref)}"${linkAttrs(header.announcementHref)}>${escapeHtml(header.announcementText)}</a>` : escapeHtml(header.announcementText)}</div>` : '';
  const search = header.showSearch || header.template === 'COMMERCE'
    ? `<form role="search" action="${escapeHtml(root)}" method="get"><label hidden for="site-chrome-ssr-search">Search products and stores</label><input id="site-chrome-ssr-search" name="search" maxlength="100" placeholder="Search products and stores"><button type="submit">Search</button></form>` : '';
  const categoryNavigation = header.showCategoryLinks && categories.length ? `<details class="siteChromeSsrCategoryMenu"><summary>Categories</summary><div class="siteChromeSsrCategoryList">${categories.map(category => `<a href="/category/${encodeURIComponent(category.slug)}">${escapeHtml(category.name)}</a>`).join('')}</div></details>` : '';
  const ctaId = header.ctaLinkId;
  const customLinks = header.navigation.filter(link => link.enabled).map(link => `<a${link.id === ctaId ? ' class="siteChromeSsrPrimary"' : ''} href="${escapeHtml(link.href)}"${linkAttrs(link.href)}>${escapeHtml(link.label)}</a>`).join('');
  return `${announcement}<header class="siteChromeSsrHeader siteChromeSsrHeader--${header.template.toLowerCase()} siteChromeSsrHeader--${header.density.toLowerCase()}${header.sticky ? ' isSticky' : ''}${header.alignment === 'CENTER' ? ' isCentered' : ''}"><nav class="siteChromeSsrNav" aria-label="Main navigation"><a class="siteChromeSsrBrand" href="${escapeHtml(root)}">${logo ? `<img src="/content-media/${encodeURIComponent(logo)}" alt="${escapeHtml(title)} logo">` : ''}<span>${escapeHtml(title)}${tagline ? `<small>${escapeHtml(tagline)}</small>` : ''}</span></a>${search}${categoryNavigation}<a href="${escapeHtml(root)}">${root.startsWith('/store/') ? 'Store' : 'Shop'}</a>${customLinks}<a href="/favorites">Favorites</a><a href="/dashboard?tab=messages">Messages</a><a href="/dashboard?tab=notifications">Notifications</a><a href="/checkout">Cart</a><a class="siteChromeSsrPrimary" href="/?auth=login">Sign in</a></nav></header>`;
}

export function renderSiteChromeFooter(configuration: SiteChromeConfiguration, brand: SiteChromeBrand, suppressed: boolean) {
  if (suppressed) return '';
  const footer = configuration.footer;
  const title = footer.title || brand.title;
  const logo = footer.logoMediaId || brand.logoMediaId || null;
  const groups = footer.sections.map(section => {
    const links = section.links.filter(link => link.enabled);
    if (!links.length) return '';
    return `<section class="siteChromeSsrSection"><h2>${escapeHtml(section.title)}</h2>${links.map(link => `<a href="${escapeHtml(link.href)}"${linkAttrs(link.href)}>${escapeHtml(link.label)}</a>`).join('')}</section>`;
  }).join('');
  const contact = footer.contactEmail || footer.contactPhone
    ? `<section class="siteChromeSsrSection"><h2>Contact</h2>${footer.contactEmail ? `<a href="mailto:${escapeHtml(footer.contactEmail)}">${escapeHtml(footer.contactEmail)}</a>` : ''}${footer.contactPhone ? `<a href="tel:${escapeHtml(footer.contactPhone.replace(/[^+\d]/g, ''))}">${escapeHtml(footer.contactPhone)}</a>` : ''}</section>` : '';
  const socials = footer.socials.filter(item => item.enabled).map(item => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.label || item.platform)}">${renderSiteChromeSocialIcon(item.platform)}${item.display === 'ICON_AND_LABEL' ? `<span>${escapeHtml(item.label || item.platform.replaceAll('_', ' '))}</span>` : ''}</a>`).join('');
  return `<footer class="siteChromeSsrFooter siteChromeSsrFooter--${footer.template.toLowerCase()}${footer.alignment === 'CENTER' ? ' isCentered' : ''}"><div class="siteChromeSsrFooterMain"><div class="siteChromeSsrIdentity">${logo ? `<img src="/content-media/${encodeURIComponent(logo)}" alt="${escapeHtml(title)} logo">` : ''}<div><strong>${escapeHtml(title)}</strong>${footer.description ? `<p>${escapeHtml(footer.description)}</p>` : ''}</div></div>${groups}${contact}${socials ? `<section class="siteChromeSsrSocials" aria-label="Social links">${socials}</section>` : ''}</div><div class="siteChromeSsrBottom"><span>${escapeHtml(footer.copyright || `Copyright ${new Date().getFullYear()} ${title}`)}</span>${footer.backToTop ? '<a href="#top">Back to top &#8593;</a>' : ''}</div></footer>`;
}
