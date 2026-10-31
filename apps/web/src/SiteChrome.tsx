import React, { useEffect, useRef, useState } from 'react';
import { HeaderActivity } from './HeaderActivity.js';
import type { SessionUser } from './session.js';
import type { SiteChromeBrand, SiteChromeConfiguration, SiteChromeSocial } from './site-chrome-types.js';
import './SiteChrome.css';

const socialGlyph: Record<SiteChromeSocial['platform'], string> = { FACEBOOK: 'f', INSTAGRAM: '◎', LINKEDIN: 'in', X: '𝕏', YOUTUBE: '▶', TIKTOK: '♪', WHATSAPP: '◔', PINTEREST: '℘', WEBSITE: '↗', OTHER: '↗' };
const external = (href: string) => /^https:\/\//i.test(href);

function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toLocaleUpperCase() ?? '').join('') || '?'; }

function Avatar({ user }: { user: SessionUser }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [user.avatarUrl]);
  return user.avatarUrl && !failed ? <img className="avatarImage" src={user.avatarUrl} alt="" onError={() => setFailed(true)} /> : <span className="avatarFallback" aria-hidden="true">{initials(user.name)}</span>;
}

export function SiteChromeHeader({ configuration, brand, user, cartCount, onSignOut }: { configuration: SiteChromeConfiguration; brand: SiteChromeBrand; user: SessionUser | null; cartCount: number; onSignOut: () => void }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [categories, setCategories] = useState<{ name: string; slug: string }[]>([]);
  const accountRef = useRef<HTMLDivElement>(null);
  const header = configuration.header;
  const showSearch = header.showSearch || header.template === 'COMMERCE';
  const isStore = Boolean(brand.path?.startsWith('/store/'));
  const title = header.title.trim() || brand.title;
  const tagline = header.tagline.trim() || brand.tagline || (isStore ? brand.description : 'independent marketplace') || '';
  const logo = header.logoMediaId || brand.logoMediaId;
  const theme = { '--chrome-header-bg': header.backgroundColor, '--chrome-header-text': header.textColor, '--chrome-header-accent': header.accentColor } as React.CSSProperties;
  const openSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const value = search.trim();
    if (!value) return;
    const storeMatch = window.location.pathname.match(/^\/store\/([^/]+)\/?$/);
    const destination = storeMatch ? `/store/${encodeURIComponent(storeMatch[1])}` : '/';
    const url = new URL(destination, window.location.origin);
    url.searchParams.set('search', value);
    window.location.assign(`${url.pathname}${url.search}`);
  };
  useEffect(() => {
    if (!accountOpen) return undefined;
    const outside = (event: PointerEvent) => { if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setAccountOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [accountOpen]);
  const customLinks = header.navigation.filter(link => link.enabled);
  useEffect(() => {
    if (!header.showCategoryLinks) { setCategories([]); return undefined; }
    let active = true;
    fetch('/api/categories', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(response => response.ok ? response.json() as Promise<{ name: string; slug: string }[]> : []).then(items => { if (active) setCategories(items.slice(0, 12)); }).catch(() => { if (active) setCategories([]); });
    return () => { active = false; };
  }, [header.showCategoryLinks]);
  return <div className={`siteChromeHeader siteChromeHeader--${header.template.toLowerCase()} siteChromeHeader--${header.density.toLowerCase()}${header.sticky ? ' isSticky' : ''}`} style={theme}>
    {header.announcementEnabled && header.announcementText && <div className="siteChromeAnnouncement">{header.announcementHref ? <a href={header.announcementHref} target={external(header.announcementHref) ? '_blank' : undefined} rel={external(header.announcementHref) ? 'noopener noreferrer' : undefined}>{header.announcementText}</a> : header.announcementText}</div>}
    <header className={`topbar siteChromeTopbar${header.alignment === 'CENTER' ? ' isCentered' : ''}`}>
      <a className="brand siteChromeBrand" href={brand.path || '/'}>{logo && <img className="siteChromeLogo" src={`/content-media/${encodeURIComponent(logo)}`} alt={`${title} logo`} onError={event => { event.currentTarget.hidden = true; }} />}<span className="platformBrandText"><span className="platformBrandName">{title}</span>{tagline && <small>{tagline}</small>}</span></a>
      {showSearch && <form className="siteChromeSearch" role="search" onSubmit={openSearch}><label className="visuallyHidden" htmlFor="site-chrome-search">Search products and stores</label><input id="site-chrome-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search products and stores" maxLength={100} /><button type="submit" aria-label="Search">Search</button></form>}
      <button className="siteChromeMobileToggle" type="button" aria-expanded={mobileOpen} aria-controls="site-chrome-navigation" onClick={() => setMobileOpen(value => !value)}>{mobileOpen ? 'Close menu' : 'Menu'}</button>
      <nav id="site-chrome-navigation" className={`primaryNav siteChromeNav${mobileOpen ? ' isOpen' : ''}`} aria-label="Main navigation">
        <a className="navPill" href={brand.path || '/'}>{isStore ? 'Store' : 'Shop'}</a>
        {header.showCategoryLinks && categories.length > 0 && <details className="siteChromeCategoryMenu"><summary>Categories</summary><div className="siteChromeCategoryList">{categories.map(category => <a key={category.slug} href={`/category/${encodeURIComponent(category.slug)}`}>{category.name}</a>)}</div></details>}
        {customLinks.map(link => <a className={`navPill${link.id === header.ctaLinkId ? ' primary' : ''}`} key={link.id} href={link.href} target={external(link.href) ? '_blank' : undefined} rel={external(link.href) ? 'noopener noreferrer' : undefined}>{link.label}</a>)}
        {user && <HeaderActivity userId={user.id} role={user.role} />}
        <a className="navPill cartButton" href="/checkout">Cart <b aria-label={`${cartCount} items in cart`}>{user ? cartCount : 0}</b></a>
        {!user && <><a className="navPill" href="/?auth=login">Sign in</a><a className="navPill primary" href="/?auth=register">Create account</a></>}
        {user && <div className="accountMenu" ref={accountRef}>
          <button className="accountTrigger" type="button" aria-label={`${user.name}, account menu`} aria-haspopup="true" aria-expanded={accountOpen} aria-controls="site-chrome-account-menu" onClick={() => setAccountOpen(value => !value)}><Avatar user={user} /><span className="accountName">{user.name}</span><span aria-hidden="true">⌄</span></button>
          <div className="accountMenuPanel" id="site-chrome-account-menu" aria-label="Account destinations" hidden={!accountOpen}>
            <div className="accountMenuIdentity"><strong>{user.name}</strong><small>{user.email}</small></div>
            {user.role === 'ADMIN' || user.role === 'PLATFORM_STAFF' ? <><a href="/admin/platform">{user.role === 'ADMIN' ? 'Admin dashboard' : `${user.platformPositionName ?? user.platformPosition?.replaceAll('_', ' ') ?? 'Team'} workspace`}</a>{(user.role === 'ADMIN' || user.platformPermissions?.includes('GROWTH')) && <a href="/admin/ads">Marketplace ads</a>}{(user.role === 'ADMIN' || user.platformPermissions?.includes('CONTENT_MANAGEMENT')) && <a href="/admin/content">Content workspace</a>}</> : <>
              <a href="/dashboard?mode=buyer">Buyer dashboard</a>
              {(user.role === 'SELLER' || user.role === 'CASHIER') && <a href="/dashboard?mode=seller">Seller dashboard</a>}
              {(user.role === 'BUYER' || user.role === 'SELLER') && <a href="/ads">Create and manage ads</a>}
              <a href="/dashboard?tab=orders">Orders</a><a href="/dashboard?tab=messages">Messages</a><a href="/wallet">Wallet</a><a href="/club-coins">Club Coins</a>
              {user.role === 'CONTENT_EDITOR' && <a href="/admin/content">Content workspace</a>}
            </>}
            <a href="/settings#profile">Profile and settings</a><button type="button" className="signOutAction" onClick={onSignOut}>Sign out</button>
          </div>
        </div>}
      </nav>
    </header>
  </div>;
}

export function SiteChromeFooter({ configuration, brand, suppressed = false }: { configuration: SiteChromeConfiguration; brand: SiteChromeBrand; suppressed?: boolean }) {
  if (suppressed) return null;
  const footer = configuration.footer;
  const title = footer.title.trim() || brand.title;
  const logo = footer.logoMediaId || brand.logoMediaId;
  const style = { '--chrome-footer-bg': footer.backgroundColor, '--chrome-footer-text': footer.textColor, '--chrome-footer-accent': footer.accentColor } as React.CSSProperties;
  const sections = footer.sections.map(section => ({ ...section, links: section.links.filter(link => link.enabled) })).filter(section => section.links.length);
  const socials = footer.socials.filter(item => item.enabled);
  return <footer className={`siteChromeFooter siteChromeFooter--${footer.template.toLowerCase()}${footer.alignment === 'CENTER' ? ' isCentered' : ''}`} style={style}>
    <div className="siteChromeFooterMain">
      <div className="siteChromeFooterIdentity">{logo && <img src={`/content-media/${encodeURIComponent(logo)}`} alt={`${title} logo`} style={{ maxWidth: footer.logoWidth, maxHeight: footer.logoHeight }} onError={event => { event.currentTarget.hidden = true; }} />}<div><strong>{title}</strong>{footer.description && <p>{footer.description}</p>}</div></div>
      {sections.map(section => <section className="siteChromeFooterSection" key={section.id}><h2>{section.title}</h2>{section.links.map(link => <a key={link.id} href={link.href} target={external(link.href) ? '_blank' : undefined} rel={external(link.href) ? 'noopener noreferrer' : undefined}>{link.label}</a>)}</section>)}
      {(footer.contactEmail || footer.contactPhone) && <section className="siteChromeFooterSection"><h2>Contact</h2>{footer.contactEmail && <a href={`mailto:${footer.contactEmail}`}>{footer.contactEmail}</a>}{footer.contactPhone && <a href={`tel:${footer.contactPhone.replace(/[^+\d]/g, '')}`}>{footer.contactPhone}</a>}</section>}
      {socials.length > 0 && <section className="siteChromeSocials" aria-label="Social media">{socials.map(item => <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" aria-label={item.label || item.platform} title={item.label || item.platform}><span className="siteChromeSocialGlyph" aria-hidden="true">{socialGlyph[item.platform]}</span>{item.display === 'ICON_AND_LABEL' && <span>{item.label || item.platform.replaceAll('_', ' ')}</span>}</a>)}</section>}
    </div>
    <div className="siteChromeFooterBottom"><span>{footer.copyright || `© ${new Date().getFullYear()} ${title}`}</span>{footer.backToTop && <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>Back to top ↑</button>}</div>
  </footer>;
}
