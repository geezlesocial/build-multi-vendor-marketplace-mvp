import React, { useEffect, useRef, useState } from 'react';
import { useSession } from './session.js';
import { Onboarding } from './Onboarding.js';
import { JimaWidget } from './JimaWidget.js';
import { HeaderActivity } from './HeaderActivity.js';
import { SiteChromeFooter, SiteChromeHeader } from './SiteChrome.js';
import type { SiteChromeBrand, SiteChromeConfiguration } from './site-chrome-types.js';

const CART_SYNC_STORAGE_KEY = 'marketplace:cart-sync';
const SITE_CHROME_SYNC_STORAGE_KEY = 'marketplace:site-chrome-published';

type PublicSiteChrome = { configuration: SiteChromeConfiguration | null; publishedVersion: number | null; footerSuppressed: boolean; scope: 'PLATFORM' | 'STORE'; brand: SiteChromeBrand | null };

async function publicChromeUrl() {
  const path = window.location.pathname;
  const params = new URLSearchParams();
  const storeMatch = path.match(/^\/store\/([^/]+)\/?$/);
  if (storeMatch) {
    params.set('storeSlug', decodeURIComponent(storeMatch[1]!));
    params.set('kind', 'HOME');
  } else if (path === '/') {
    try {
      const domain = await fetch('/api/public/store-domain', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
      if (domain.ok) {
        const value = await domain.json() as { storeSlug?: string };
        if (typeof value.storeSlug === 'string') { params.set('storeSlug', value.storeSlug); params.set('kind', 'HOME'); }
      }
    } catch { /* The normal platform home remains available if host resolution is offline. */ }
    if (!params.has('kind')) params.set('kind', 'HOME');
  } else if (path === '/favorites') params.set('kind', 'FAVORITES');
  else if (path === '/dashboard' || path === '/wallet' || path === '/club-coins') params.set('kind', 'DASHBOARD');
  else if (path === '/blog') params.set('kind', 'BLOG_INDEX');
  else if (path === '/checkout') params.set('kind', 'CHECKOUT');
  else if (/^\/products\/[^/]+\/?$/.test(path)) { params.set('kind', 'PRODUCT'); params.set('slug', decodeURIComponent(path.split('/')[2]!)); }
  else if (/^\/category\/[^/]+\/?$/.test(path)) { params.set('kind', 'CATEGORY'); params.set('slug', decodeURIComponent(path.split('/')[2]!)); }
  else if (path === '/settings' || path === '/ads' || path === '/admin/wallet' || path.startsWith('/admin/') || path.startsWith('/seller/')) params.set('kind', 'DASHBOARD');
  else params.set('kind', 'SHOP');
  return `/api/site-chrome/public?${params.toString()}`;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toLocaleUpperCase() ?? '').join('') || '?';
}

function AccountAvatar({ name, src }: { name: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img className="avatarImage" src={src} alt="" onError={() => setFailed(true)} /> : <span className="avatarFallback" aria-hidden="true">{initials(name)}</span>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, status, error, refreshUser, setUser } = useSession();
  const [accountOpen, setAccountOpen] = useState(false);
  const [cartCount, setCartCount] = useState(0);
  const [publicBranding, setPublicBranding] = useState<{ platformName: string; shortName: string; tagline?: string; logoMediaId: string | null; alternateLogoMediaId: string | null; faviconMediaId: string | null; defaultAvatarMediaId: string | null } | null>(null);
  const [siteChrome, setSiteChrome] = useState<PublicSiteChrome | null>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/platform/branding').then(response => response.ok ? response.json() : null).then(value => {
      if (!active || !value || typeof value.platformName !== 'string') return;
      setPublicBranding(value);
      if (typeof value.faviconMediaId === 'string') {
        let link = document.querySelector<HTMLLinkElement>('link[data-platform-branding-icon]');
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.dataset.platformBrandingIcon = 'true'; document.head.append(link); }
        link.href = `/content-media/${encodeURIComponent(value.faviconMediaId)}`;
      } else document.querySelector('link[data-platform-branding-icon]')?.remove();
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(await publicChromeUrl(), { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const result = await response.json() as PublicSiteChrome;
        if (active && result && (result.scope === 'PLATFORM' || result.scope === 'STORE')) setSiteChrome(result);
      } catch { /* Existing platform chrome remains the resilient fallback. */ }
      finally { inFlight = false; }
    };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const refreshFromAnotherTab = (event: StorageEvent) => { if (event.key === SITE_CHROME_SYNC_STORAGE_KEY) void refresh(); };
    const refreshFromPublication = () => void refresh();
    void refresh();
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('storage', refreshFromAnotherTab);
    window.addEventListener('marketplace:site-chrome-published', refreshFromPublication);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refreshWhenVisible); window.removeEventListener('storage', refreshFromAnotherTab); window.removeEventListener('marketplace:site-chrome-published', refreshFromPublication); document.removeEventListener('visibilitychange', refreshWhenVisible); };
  }, []);

  useEffect(() => {
    if (!user) { setCartCount(0); return undefined; }
    let active = true;
    let latestRequest = 0;
    const refreshCartCount = async () => {
      const requestId = ++latestRequest;
      try {
        const response = await fetch('/api/cart', { credentials: 'include' });
        if (!response.ok) return;
        const cart = await response.json() as { items?: { quantity: number }[] };
        if (active && requestId === latestRequest) setCartCount((cart.items ?? []).reduce((sum, item) => sum + item.quantity, 0));
      } catch { /* The cart page reports its own loading and error state. */ }
    };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void refreshCartCount(); };
    const broadcastCartChange = () => {
      try { localStorage.setItem(CART_SYNC_STORAGE_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`); }
      catch { /* Cross-tab synchronization is best-effort when browser storage is unavailable. */ }
    };
    const refreshFromAnotherTab = (event: StorageEvent) => {
      if (event.key === CART_SYNC_STORAGE_KEY) void refreshCartCount();
    };
    void refreshCartCount();
    window.addEventListener('marketplace:cart-changed', refreshCartCount);
    window.addEventListener('marketplace:cart-changed', broadcastCartChange);
    window.addEventListener('storage', refreshFromAnotherTab);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.removeEventListener('marketplace:cart-changed', refreshCartCount);
      window.removeEventListener('marketplace:cart-changed', broadcastCartChange);
      window.removeEventListener('storage', refreshFromAnotherTab);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!accountOpen) return undefined;
    const closeOutside = (event: PointerEvent) => { if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAccountOpen(false); accountRef.current?.querySelector<HTMLButtonElement>('.accountTrigger')?.focus(); } };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [accountOpen]);

  useEffect(() => {
    if (user?.onboardingCompletedAt && window.location.pathname === '/onboarding') window.location.replace('/');
    if (status === 'ready' && !user && window.location.pathname === '/onboarding') window.location.replace('/?auth=login&returnTo=%2Fonboarding');
    if (user && !user.onboardingCompletedAt && window.location.pathname !== '/onboarding' && window.location.pathname !== '/email/verify') window.location.replace('/onboarding');
  }, [status, user?.id, user?.onboardingCompletedAt]);

  const signOut = async () => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: csrf ? { 'x-csrf-token': csrf } : {} });
    if (!response.ok) return;
    setUser(null);
    setAccountOpen(false);
    window.location.assign('/');
  };

  if (status === 'loading') return <div className="app"><header className="topbar"><a className="brand" href="/">Market Lane<span>independent marketplace</span></a><span className="sessionLoading" role="status">Checking your account…</span></header><main className="shellLoading" aria-busy="true"><p className="eyebrow">Market Lane</p><h1>Preparing your marketplace</h1><p className="muted">Your account and public catalog are loading.</p></main></div>;
  if (status === 'error') return <div className="app"><header className="topbar"><a className="brand" href="/">Market Lane<span>independent marketplace</span></a></header><main className="shellLoading"><h1>Marketplace unavailable</h1><p className="notice" role="alert">{error}</p><button className="primary" onClick={() => void refreshUser()}>Try again</button></main></div>;

  if (user && !user.onboardingCompletedAt && window.location.pathname !== '/email/verify') return <div className="app onboardingAppShell"><main className="onboardingGate"><Onboarding /></main></div>;

  const dashboardHref = user?.role === 'ADMIN' || user?.role === 'PLATFORM_STAFF' ? '/admin/platform' : '/dashboard';
  const platformName = publicBranding?.platformName?.trim() || publicBranding?.shortName?.trim() || 'Market Lane';
  const platformShortName = publicBranding?.shortName?.trim() || platformName;
  const platformTagline = publicBranding?.tagline?.trim() || 'independent marketplace';
  const platformLogo = publicBranding?.logoMediaId ?? publicBranding?.alternateLogoMediaId;
  const chromeBrand: SiteChromeBrand = siteChrome?.brand ?? { title: platformShortName, tagline: platformTagline, logoMediaId: platformLogo, path: '/' };
  return <div className="app">
    {siteChrome?.configuration ? <SiteChromeHeader configuration={siteChrome.configuration} brand={chromeBrand} user={user} cartCount={cartCount} onSignOut={() => void signOut()} /> : <header className="topbar">
      <a className="brand" href="/">{platformLogo && <img className="platformBrandLogo" src={`/content-media/${encodeURIComponent(platformLogo)}`} alt={`${platformName} logo`} onError={event => { event.currentTarget.hidden = true; }} />}<span className="platformBrandText"><span className="platformBrandName">{platformShortName}</span><small>{platformTagline}</small></span></a>
      <nav className="primaryNav" aria-label="Main navigation">
        <a className="navPill" href="/">Shop</a>
        {user && <HeaderActivity userId={user.id} role={user.role} />}
        <a className="navPill cartButton" href="/checkout">Cart <b aria-label={`${cartCount} items in cart`}>{user ? cartCount : 0}</b></a>
        {!user && <><a className="navPill" href="/?auth=login">Sign in</a><a className="navPill primary" href="/?auth=register">Create account</a></>}
        {user && <div className="accountMenu" ref={accountRef}>
          <button className="accountTrigger" type="button" aria-label={`${user.name}, account menu`} aria-haspopup="true" aria-expanded={accountOpen} aria-controls="account-menu" onClick={() => setAccountOpen(open => !open)}>
              <AccountAvatar name={user.name} src={user.avatarUrl ?? (publicBranding?.defaultAvatarMediaId ? `/content-media/${encodeURIComponent(publicBranding.defaultAvatarMediaId)}` : undefined)} />
            <span className="accountName">{user.name}</span><span aria-hidden="true">⌄</span>
          </button>
          <div className="accountMenuPanel" id="account-menu" aria-label="Account destinations" hidden={!accountOpen}>
            <div className="accountMenuIdentity"><strong>{user.name}</strong><small>{user.email}</small></div>
            {user.role === 'ADMIN' || user.role === 'PLATFORM_STAFF' ? <><a href="/admin/platform" onClick={() => setAccountOpen(false)}>{user.role === 'ADMIN' ? 'Admin dashboard' : `${user.platformPositionName ?? user.platformPosition?.replaceAll('_', ' ') ?? 'Team'} workspace`}</a>{(user.role === 'ADMIN' || user.platformPermissions?.includes('GROWTH')) && <a href="/admin/ads" onClick={() => setAccountOpen(false)}>Marketplace ads</a>}{(user.role === 'ADMIN' || user.platformPermissions?.includes('CONTENT_MANAGEMENT')) && <a href="/admin/content" onClick={() => setAccountOpen(false)}>Content workspace</a>}</> : <>
              <a href={`${dashboardHref}?mode=buyer`} onClick={() => setAccountOpen(false)}>Buyer dashboard</a>
              {(user.role === 'SELLER' || user.role === 'CASHIER') && <a href="/dashboard?mode=seller" onClick={() => setAccountOpen(false)}>Seller dashboard</a>}
              {(user.role === 'BUYER' || user.role === 'SELLER') && <a href="/ads" onClick={() => setAccountOpen(false)}>Create and manage ads</a>}
              <a href="/dashboard?tab=orders" onClick={() => setAccountOpen(false)}>Orders</a>
              <a href="/dashboard?tab=messages" onClick={() => setAccountOpen(false)}>Messages</a>
              <a href="/wallet" onClick={() => setAccountOpen(false)}>Wallet</a>
              <a href="/club-coins" onClick={() => setAccountOpen(false)}>Club Coins</a>
              {user.role === 'CONTENT_EDITOR' && <a href="/admin/content" onClick={() => setAccountOpen(false)}>Content workspace</a>}
            </>}
            <a href="/settings#profile" onClick={() => setAccountOpen(false)}>Profile and settings</a>
            <button type="button" className="signOutAction" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>}
      </nav>
    </header>}
    {user && !user.emailVerifiedAt && <div className="notice emailVerificationBanner" role="status">Verify <strong>{user.email}</strong> to review products and qualify for account rewards. <a href="/settings#profile">Open account settings</a></div>}
    <main className="shellMain">{children}</main>
    {siteChrome?.configuration ? <><SiteChromeFooter configuration={siteChrome.configuration} brand={chromeBrand} suppressed={siteChrome.footerSuppressed} /><p className="platformLegalDisclosure">{platformName} · Platform payments are collected by the owner; automated seller payouts are not included.</p></> : <footer>{platformName} · Platform payments are collected by the owner; automated seller payouts are not included.</footer>}
    <JimaWidget userName={user?.name} />
  </div>;
}
