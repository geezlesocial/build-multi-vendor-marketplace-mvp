import React, { useEffect, useRef, useState } from 'react';
import { useSession } from './session.js';

const CART_SYNC_STORAGE_KEY = 'marketplace:cart-sync';

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

  const dashboardHref = user?.role === 'ADMIN' ? '/admin/platform' : '/dashboard';
  const platformName = publicBranding?.platformName?.trim() || publicBranding?.shortName?.trim() || 'Market Lane';
  const platformShortName = publicBranding?.shortName?.trim() || platformName;
  const platformTagline = publicBranding?.tagline?.trim() || 'independent marketplace';
  const platformLogo = publicBranding?.logoMediaId ?? publicBranding?.alternateLogoMediaId;
  return <div className="app">
    <header className="topbar">
      <a className="brand" href="/">{platformLogo && <img className="platformBrandLogo" src={`/content-media/${encodeURIComponent(platformLogo)}`} alt={`${platformName} logo`} onError={event => { event.currentTarget.hidden = true; }} />}<span className="platformBrandText"><span className="platformBrandName">{platformShortName}</span><small>{platformTagline}</small></span></a>
      <nav className="primaryNav" aria-label="Main navigation">
        <a className="navPill" href="/">Shop</a>
        <a className="navPill cartButton" href="/checkout">Cart <b aria-label={`${cartCount} items in cart`}>{user ? cartCount : 0}</b></a>
        {!user && <><a className="navPill" href="/?auth=login">Sign in</a><a className="navPill primary" href="/?auth=register">Create account</a></>}
        {user && <div className="accountMenu" ref={accountRef}>
          <button className="accountTrigger" type="button" aria-label={`${user.name}, account menu`} aria-haspopup="true" aria-expanded={accountOpen} aria-controls="account-menu" onClick={() => setAccountOpen(open => !open)}>
              <AccountAvatar name={user.name} src={user.avatarUrl ?? (publicBranding?.defaultAvatarMediaId ? `/content-media/${encodeURIComponent(publicBranding.defaultAvatarMediaId)}` : undefined)} />
            <span className="accountName">{user.name}</span><span aria-hidden="true">⌄</span>
          </button>
          <div className="accountMenuPanel" id="account-menu" aria-label="Account destinations" hidden={!accountOpen}>
            <div className="accountMenuIdentity"><strong>{user.name}</strong><small>{user.email}</small></div>
            {user.role === 'ADMIN' ? <a href="/admin/platform" onClick={() => setAccountOpen(false)}>Admin dashboard</a> : <>
              <a href={`${dashboardHref}?mode=buyer`} onClick={() => setAccountOpen(false)}>Buyer dashboard</a>
              {(user.role === 'SELLER' || user.role === 'CASHIER') && <a href="/dashboard?mode=seller" onClick={() => setAccountOpen(false)}>Seller dashboard</a>}
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
    </header>
    {user && !user.emailVerifiedAt && <div className="notice emailVerificationBanner" role="status">Verify <strong>{user.email}</strong> to review products and qualify for account rewards. <a href="/settings#profile">Open account settings</a></div>}
    <main className="shellMain">{children}</main>
    <footer>{platformName} · Platform payments are collected by the owner; automated seller payouts are not included.</footer>
  </div>;
}
