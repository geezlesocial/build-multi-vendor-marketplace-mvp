import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from './session.js';
import { BuyerDashboard } from './DashboardBuyerWorkspace.js';
import { SellerDashboard } from './DashboardSellerWorkspace.js';
import { type Access, type BuyerData, type SellerData, type User, request } from './DashboardShared.js';

type Workspace = 'buyer' | 'seller';
type WorkspaceTabs = { buyer: string; seller: string };
const CART_SYNC_STORAGE_KEY = 'marketplace:cart-sync';
const allowedTabs: Record<Workspace, string[]> = {
  buyer: ['overview', 'orders', 'cart', 'favorites', 'messages', 'notifications', 'profile', 'addresses', 'affiliate', 'live'],
  seller: ['overview', 'products', 'orders', 'shipping', 'dropshipping', 'ads', 'messages', 'store', 'currency', 'commission', 'integrations', 'payouts', 'pos', 'live', 'profile']
};
function readDashboardLocation(): { mode: Workspace; tab: string } {
  const params = new URLSearchParams(window.location.search);
  const mode: Workspace = params.get('mode') === 'seller' ? 'seller' : 'buyer';
  const tab = params.get('tab') ?? 'overview';
  return { mode, tab: allowedTabs[mode].includes(tab) ? tab : 'overview' };
}
function writeDashboardLocation(mode: Workspace, tab: string, replace = false) {
  const url = new URL(window.location.href);
  if (mode === 'buyer') url.searchParams.delete('mode'); else url.searchParams.set('mode', mode);
  if (tab === 'overview') url.searchParams.delete('tab'); else url.searchParams.set('tab', tab);
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

export function Dashboard() {
  const { user: sessionUser, setUser: setSessionUser } = useSession();
  const initialLocation = readDashboardLocation();
  const isPlatformAdmin = sessionUser?.role === 'ADMIN';
  const [user, setUser] = useState<User | null>(sessionUser);
  const [access, setAccess] = useState<Access | null>(null);
  const [buyer, setBuyer] = useState<BuyerData | null>(null);
  const [seller, setSeller] = useState<SellerData | null>(null);
  const [mode, setMode] = useState<Workspace>(() => sessionUser?.role === 'ADMIN' ? 'seller' : initialLocation.mode);
  const [tabs, setTabs] = useState<WorkspaceTabs>({ buyer: initialLocation.mode === 'buyer' ? initialLocation.tab : 'overview', seller: initialLocation.mode === 'seller' ? initialLocation.tab : 'overview' });
  const [loading, setLoading] = useState<Record<Workspace, boolean>>({ buyer: true, seller: sessionUser?.role === 'ADMIN' });
  const [errors, setErrors] = useState<Record<Workspace, string>>({ buyer: '', seller: '' });
  const [cartSyncError, setCartSyncError] = useState('');
  const [message, setMessage] = useState('');
  const requestSequence = useRef<Record<Workspace, number>>({ buyer: 0, seller: 0 });
  const accessSequence = useRef(0);

  useEffect(() => { setUser(sessionUser); }, [sessionUser]);

  const load = useCallback(async (target: Workspace) => {
    const sequence = ++requestSequence.current[target];
    const accessRequest = ++accessSequence.current;
    setLoading(current => ({ ...current, [target]: true }));
    setErrors(current => ({ ...current, [target]: '' }));
    try {
      const currentAccess = await request<Access>('/api/dashboard/access');
      if (accessRequest === accessSequence.current) setAccess(currentAccess);
      if (sequence !== requestSequence.current[target]) return;
      if (target === 'buyer' && !currentAccess.buyer) return;
      if (target === 'seller' && !currentAccess.seller) { setSeller(null); return; }
      if (target === 'seller') setSeller(await request<SellerData>('/api/dashboard/seller'));
      else setBuyer(await request<BuyerData>('/api/dashboard/buyer'));
    } catch (error) {
      if (sequence === requestSequence.current[target]) setErrors(current => ({ ...current, [target]: (error as Error).message || 'Dashboard data could not be loaded.' }));
    } finally {
      if (sequence === requestSequence.current[target]) setLoading(current => ({ ...current, [target]: false }));
    }
  }, []);

  useEffect(() => {
    if (!sessionUser || sessionUser.role === 'ADMIN') return undefined;
    let active = true;
    let inFlight = false;
    let refreshQueued = false;
    const refreshCart = () => {
      if (!active || document.visibilityState !== 'visible') return;
      if (inFlight) { refreshQueued = true; return; }
      inFlight = true;
      void request<BuyerData['cart']>('/api/cart').then(cart => {
        if (!active) return;
        setBuyer(current => current ? { ...current, cart } : current);
        setCartSyncError('');
      }).catch(error => {
        if (active) setCartSyncError((error as Error).message || 'Cart summary could not be refreshed.');
      }).finally(() => {
        inFlight = false;
        if (refreshQueued) { refreshQueued = false; refreshCart(); }
      });
    };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') refreshCart(); };
    const refreshFromAnotherTab = (event: StorageEvent) => {
      if (event.key === CART_SYNC_STORAGE_KEY) refreshCart();
    };
    window.addEventListener('marketplace:cart-changed', refreshCart);
    window.addEventListener('storage', refreshFromAnotherTab);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.removeEventListener('marketplace:cart-changed', refreshCart);
      window.removeEventListener('storage', refreshFromAnotherTab);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [sessionUser?.id, sessionUser?.role]);

  useEffect(() => {
    if (sessionUser?.role !== 'ADMIN') return;
    const location = readDashboardLocation();
    const sellerTab = location.mode === 'seller' ? location.tab : 'overview';
    setMode('seller');
    setTabs(current => ({ ...current, seller: sellerTab }));
    writeDashboardLocation('seller', sellerTab, true);
  }, [sessionUser?.id, sessionUser?.role]);
  useEffect(() => { if (sessionUser) void load(mode); }, [sessionUser?.id, sessionUser?.role, mode, load]);
  useEffect(() => {
    const onPopState = () => {
      const next = readDashboardLocation();
      const target = sessionUser?.role === 'ADMIN' ? 'seller' : next.mode;
      const tab = target === 'seller' && sessionUser?.role === 'ADMIN' && next.mode !== 'seller' ? tabs.seller : next.tab;
      setMode(target);
      setTabs(current => ({ ...current, [target]: tab }));
      if (sessionUser?.role === 'ADMIN' && next.mode !== 'seller') writeDashboardLocation('seller', tab, true);
      void load(target);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [load, sessionUser?.role, tabs.seller]);

  const ordersTabActive = tabs[mode] === 'orders';
  useEffect(() => {
    if (!sessionUser || !ordersTabActive) return;
    let inFlight = false;
    const refreshOrders = () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      void load(mode).finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(refreshOrders, 10_000);
    window.addEventListener('focus', refreshOrders);
    window.addEventListener('marketplace:orders-changed', refreshOrders);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOrders);
      window.removeEventListener('marketplace:orders-changed', refreshOrders);
    };
  }, [sessionUser?.id, ordersTabActive, mode, load]);

  const selectMode = (next: Workspace) => {
    if (sessionUser?.role === 'ADMIN' && next !== 'seller') return;
    if (next === mode) return;
    setMode(next);
    setMessage('');
    writeDashboardLocation(next, tabs[next]);
    if ((next === 'buyer' && !buyer) || (next === 'seller' && !seller)) void load(next);
  };
  const selectTab = (target: Workspace, tab: string) => {
    if (!allowedTabs[target].includes(tab)) return;
    setTabs(current => ({ ...current, [target]: tab }));
    writeDashboardLocation(target, tab);
  };
  const activeTab = tabs[mode];
  const applyForSeller = async () => {
    try {
      await request('/api/sellers/apply', { method: 'POST', body: '{}' });
      setMessage('Seller application submitted. Seller tools remain unavailable until approval.');
      await load('buyer');
    } catch (error) { setMessage((error as Error).message); }
  };

  if (!sessionUser) return <section className="page dashboard"><h1>Dashboard unavailable</h1><p className="notice" role="alert">Sign in is required to open your dashboard.</p></section>;
  if (!access && loading[mode]) return <section className="page dashboard" aria-busy="true"><p className="eyebrow">Your account</p><h1>Preparing your dashboard</h1><p className="muted" role="status">Loading your server-verified account access and activity…</p></section>;
  if (!access && errors[mode]) return <section className="page dashboard"><p className="eyebrow">Your account</p><h1>Dashboard unavailable</h1><p className="notice" role="alert">{errors[mode]}</p><button className="primary" onClick={() => void load(mode)}>Try again</button></section>;
  if (!access) return <section className="page dashboard"><h1>Dashboard unavailable</h1><p className="notice" role="alert">Dashboard access could not be determined. Try reloading.</p><button className="primary" onClick={() => void load(mode)}>Try again</button></section>;

  const hasSellerWorkspace = access.seller;
  return <section className="page dashboard"><header className="dashboardPageHeader"><div><p className="eyebrow">Your account · {mode === 'buyer' ? 'Buyer workspace' : 'Seller workspace'}</p><h1>{mode === 'buyer' ? 'Buyer dashboard' : 'Seller dashboard'}</h1><p className="muted">Switching workspaces changes the view only; server permissions still determine which tools and Store data you can access.</p></div><span className="dashboardWorkspaceBadge">{mode === 'buyer' ? 'Buyer workspace' : 'Seller workspace'}</span></header>
    {message && <p className="notice" role="status">{message}</p>}
    {isPlatformAdmin && <p className="dashboardAdminLinks"><a href="/admin/platform?section=platform-store">Official Store administration</a> · <a href="/admin/platform">Control Center</a></p>}
    {hasSellerWorkspace && !isPlatformAdmin && <div className="dashboardSwitch" role="group" aria-label="Choose dashboard workspace"><button type="button" className={mode === 'buyer' ? 'primary' : ''} aria-pressed={mode === 'buyer'} onClick={() => selectMode('buyer')}>Buyer view</button><button type="button" className={mode === 'seller' ? 'primary' : ''} aria-pressed={mode === 'seller'} onClick={() => selectMode('seller')}>Seller view</button></div>}
    {!hasSellerWorkspace && mode === 'buyer' && <div className="sellerApplicationCard"><div><p className="eyebrow">Seller application</p><strong>{access.sellerApplication?.status ?? 'Not started'}</strong><p>{access.sellerApplication?.status === 'APPROVED' && !access.sellerApplication.store ? 'Your application is approved, but Store setup is incomplete. Ask a marketplace administrator to repair Store provisioning in Control Center → Sellers & stores.' : access.sellerApplication?.reason || 'Apply to sell on the marketplace. Seller tools remain restricted until an administrator approves your application.'}</p></div>{!access.sellerApplication && <button type="button" onClick={() => void applyForSeller()}>Apply to become a seller</button>}</div>}
    {isPlatformAdmin && !hasSellerWorkspace && <section className="dashboardOnboarding"><h2>Set up the official platform Store</h2><p className="muted">Create the single official Store in Control Center to enable its admin-managed seller workspace and premium feature access.</p><a className="primary" href="/admin/platform?section=platform-store">Open official Store setup</a></section>}
    {mode === 'seller' && !hasSellerWorkspace && !isPlatformAdmin ? <section className="dashboardOnboarding"><h2>{access.sellerApplication?.status === 'APPROVED' ? 'Store setup needs attention' : 'Seller access is not active yet'}</h2><p className="muted">{access.sellerApplication?.status === 'APPROVED' ? 'Your seller application is approved, but the Store profile is missing. A marketplace administrator can repair it in Control Center → Sellers & stores; your approval will not be reset.' : 'Your seller tools stay unavailable until the marketplace approves your application.'}</p>{access.sellerApplication && <div className="setting"><div><strong>Application status: {access.sellerApplication.status}</strong><p>{access.sellerApplication.reason || (access.sellerApplication.status === 'APPROVED' ? 'Store provisioning is required before seller tools can open.' : 'We’ll show seller tools here after approval.')}</p></div></div>}{!access.sellerApplication && <button className="primary" onClick={() => void applyForSeller()}>Apply to become a seller</button>}<a href="/dashboard">Return to buyer workspace</a></section> : <>
      <section className="dashboardWorkspace" aria-label="Buyer workspace" hidden={mode !== 'buyer'}>
        {errors.buyer && <p className="notice" role="alert">Saved dashboard data is shown where available. Refresh failed: {errors.buyer}</p>}
        {!buyer && loading.buyer && <p className="empty" role="status" aria-busy="true">Loading buyer activity…</p>}
        {!buyer && errors.buyer && <button onClick={() => void load('buyer')}>Retry buyer dashboard</button>}
        <BuyerDashboard data={buyer} tab={tabs.buyer} setTab={tab => selectTab('buyer', tab)} user={user ?? sessionUser} onUserUpdated={updated => { setUser(updated); setSessionUser(updated); }} cartSyncError={cartSyncError} reload={() => load('buyer')} />
      </section>
      {hasSellerWorkspace && <section className="dashboardWorkspace" aria-label="Seller workspace" hidden={mode !== 'seller'}>
        {errors.seller && <p className="notice" role="alert">Saved dashboard data is shown where available. Refresh failed: {errors.seller}</p>}
        {!seller && loading.seller && <p className="empty" role="status" aria-busy="true">Loading Store activity…</p>}
        {!seller && errors.seller && <button onClick={() => void load('seller')}>Retry seller dashboard</button>}
        <SellerDashboard data={seller} tab={tabs.seller} setTab={tab => selectTab('seller', tab)} reload={() => load('seller')} currentUserId={user?.id ?? sessionUser.id} />
      </section>}
    </>}
  </section>;
}
