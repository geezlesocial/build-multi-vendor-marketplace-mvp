import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, type SessionUser } from './session.js';
import { SellerShipping } from './SellerShipping.js';
import { AddressMapPicker } from './AddressMapPicker.js';
import { formatMinor } from './money.js';
import { SellerCommissionStatement, SellerStoreCurrency } from './SellerStoreCurrency.js';
import { PRODUCT_MEDIA_ACCEPT, PRODUCT_MEDIA_LIMITS, productMediaCounts, productMediaKindForFile, uploadContentType, uploadToSignedPostWithType } from './media-upload.js';
import { CatalogFields, type CatalogBrand, type CatalogCategory, type CatalogProductType } from './CatalogFields.js';
import { SellerDiscounts } from './SellerDiscounts.js';
import { SellerDropshipping } from './SellerDropshipping.js';
import { LiveShopping, SellerLiveStudio } from './LiveShopping.js';
import { OrderResolutionPanel } from './OrderResolutionPanel.js';
import { SupportDesk } from './SupportDesk.js';
import './ProductManagement.css';

type User = { id: string; email: string; name: string; role: string; sellerId?: string; avatarUrl?: string };
type Access = { buyer: boolean; seller: boolean; affiliateEligible: boolean; sellerApplication: { status: string; reason?: string | null; store?: { name: string; slug: string } | null } | null };
type BuyerData = { orders: any[]; cart: { items: any[] }; favorites: any[]; conversations: any[]; notifications: any[]; addresses: any[]; affiliate: any | null };
type SellerData = { store: any; summary: { orderCount: number; grossByCurrency: { currency: string; grossMinor: number }[] }; products: any[]; orders: any[]; conversations: any[]; payoutMethods: any[]; payouts: any[]; live: { effectiveEnabled: boolean; deploymentGate: boolean; reason: string } };
const money = (minor: number, currency = 'USD') => formatMinor(minor, currency);
async function request<T>(path: string, options: RequestInit = {}): Promise<T> { const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1]; const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); } return response.status === 204 ? undefined as T : response.json(); }

type Workspace = 'buyer' | 'seller';
type WorkspaceTabs = { buyer: string; seller: string };
const allowedTabs: Record<Workspace, string[]> = {
  buyer: ['overview', 'orders', 'cart', 'favorites', 'messages', 'notifications', 'profile', 'addresses', 'affiliate', 'live'],
  seller: ['overview', 'products', 'orders', 'shipping', 'dropshipping', 'messages', 'store', 'currency', 'commission', 'payouts', 'pos', 'live']
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
    window.addEventListener('marketplace:cart-changed', refreshCart);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.removeEventListener('marketplace:cart-changed', refreshCart);
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
    {!hasSellerWorkspace && mode === 'buyer' && <div className="sellerApplicationCard"><div><p className="eyebrow">Seller application</p><strong>{access.sellerApplication?.status ?? 'Not started'}</strong><p>{access.sellerApplication?.reason || 'Apply to sell on the marketplace. Seller tools remain restricted until an administrator approves your application.'}</p></div>{!access.sellerApplication && <button type="button" onClick={() => void applyForSeller()}>Apply to become a seller</button>}</div>}
    {isPlatformAdmin && !hasSellerWorkspace && <section className="dashboardOnboarding"><h2>Set up the official platform Store</h2><p className="muted">Create the single official Store in Control Center to enable its admin-managed seller workspace and premium feature access.</p><a className="primary" href="/admin/platform?section=platform-store">Open official Store setup</a></section>}
    {mode === 'seller' && !hasSellerWorkspace && !isPlatformAdmin ? <section className="dashboardOnboarding"><h2>Seller access is not active yet</h2><p className="muted">Your seller tools stay unavailable until the marketplace approves your application.</p>{access.sellerApplication ? <div className="setting"><div><strong>Application status: {access.sellerApplication.status}</strong><p>{access.sellerApplication.reason || 'We’ll show seller tools here after approval.'}</p></div></div> : <button className="primary" onClick={() => void applyForSeller()}>Apply to become a seller</button>}<a href="/dashboard">Return to buyer workspace</a></section> : <>
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
        <SellerDashboard data={seller} tab={tabs.seller} setTab={tab => selectTab('seller', tab)} reload={() => load('seller')} />
      </section>}
    </>}
  </section>;
}

function Tabs({ items, active, setActive }: { items: string[]; active: string; setActive: (value: string) => void }) { return <nav className="dashboardTabs" aria-label="Dashboard sections">{items.map(item => <button type="button" key={item} className={active === item ? 'primary' : ''} aria-current={active === item ? 'page' : undefined} onClick={() => setActive(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>; }
function BuyerDashboard({ data, tab, setTab, user, onUserUpdated, cartSyncError, reload }: { data: BuyerData | null; tab: string; setTab: (value: string) => void; user: User; onUserUpdated: (user: SessionUser) => void; cartSyncError: string; reload: () => void }) {
  if (!data) return null;
  const tabs = ['overview', 'orders', 'cart', 'favorites', 'messages', 'notifications', 'profile', 'addresses', 'live']; if (data.affiliate) tabs.push('affiliate');
  const cartCount = data.cart.items.reduce((sum, item) => sum + item.quantity, 0);
  return <><Tabs items={tabs} active={tab} setActive={setTab} />{cartSyncError && <p className="notice" role="alert">Cart summary refresh failed; showing the last saved count. {cartSyncError} <button type="button" onClick={() => window.dispatchEvent(new Event('marketplace:cart-changed'))}>Retry cart summary</button></p>}{tab === 'live' && <LiveShopping />}{tab === 'overview' && <><div className="heroPills"><span>{data.orders.length} recent orders</span><span aria-live="polite">{cartCount} items in cart</span><span>{data.favorites.length} favorites</span></div><OrderList orders={data.orders.slice(0, 5)} reload={reload} /></>}{tab === 'orders' && <OrderList orders={data.orders} reload={reload} />}{tab === 'cart' && <BuyerCart data={data} />}{tab === 'favorites' && <Favorites data={data} reload={reload} />}{tab === 'messages' && <><Messages conversations={data.conversations} reload={reload} /><SupportDesk mode="buyer" orders={data.orders} /></>}{tab === 'notifications' && <NotificationList notifications={data.notifications} reload={reload} />}{tab === 'profile' && <Profile user={user} onUserUpdated={onUserUpdated} reload={reload} />}{tab === 'addresses' && <Addresses data={data} reload={reload} />}{tab === 'affiliate' && data.affiliate && <section className="setting"><div><h2>Affiliate area</h2><p>Approved affiliate profile: {data.affiliate.referralCode}</p></div><a href="/affiliate">Open affiliate dashboard</a></section>}</>;
}

function NotificationList({ notifications, reload }: { notifications: any[]; reload: () => void }) { return <section><h2>Notifications</h2>{notifications.length === 0 ? <div className="empty">No notifications yet.</div> : <div className="table">{notifications.map(notification => <div className="row" key={notification.id}><div><strong>{notification.title}</strong><p>{notification.body}</p><small>{notification.readAt ? 'Read' : 'Unread'}</small></div>{!notification.readAt && <button onClick={async () => { await request(`/api/notifications/${notification.id}/read`, { method: 'POST', body: '{}' }); reload(); }}>Mark as read</button>}</div>)}</div>}</section>; }
function OrderList({ orders, reload }: { orders: any[]; reload: () => void }) {
  const [receiptTarget, setReceiptTarget] = useState<{ parentOrderId: string; sellerOrderId: string; paymentMethod: string } | null>(null);
  const [receiptSaving, setReceiptSaving] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (receiptTarget && !dialog.open) dialog.showModal();
    else if (!receiptTarget && dialog.open) dialog.close();
  }, [receiptTarget]);
  const confirmReceipt = async () => {
    if (!receiptTarget || receiptSaving) return;
    setReceiptSaving(true); setReceiptError('');
    try {
      await request(`/api/orders/${encodeURIComponent(receiptTarget.parentOrderId)}/shipments/${encodeURIComponent(receiptTarget.sellerOrderId)}/confirm-received`, { method: 'POST', body: '{}' });
      setReceiptTarget(null);
      window.dispatchEvent(new Event('marketplace:orders-changed'));
      await reload();
    } catch (error) { setReceiptError((error as Error).message); }
    finally { setReceiptSaving(false); }
  };
  const readableStatus = (status: string) => status.toLowerCase().replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
  const dateLabel = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return <section className="buyerOrders"><header className="ordersSectionHeading"><div><p className="eyebrow">Your purchases</p><h2>Orders and delivery</h2><p className="muted">Track Store updates and confirm receipt after your item ships.</p></div><span className="ordersLiveBadge"><i aria-hidden="true" />Updates every 10 seconds</span></header>
    {orders.length === 0 ? <div className="empty">No orders yet.</div> : <div className="buyerOrderList">{orders.map(order => <details className="buyerOrderCard" key={order.id} open={orders.length === 1}>
      <summary><span><strong>{order.orderNumber}</strong><small>{dateLabel(order.createdAt)} · {order.payment?.method ?? 'Payment pending'}</small></span><span className="buyerOrderTotal">{money(order.totalMinor, order.currency)}<small>{readableStatus(order.status)}</small></span></summary>
      <div className="buyerOrderBody"><p className="orderPaymentStatus">Payment status: <strong>{readableStatus(order.payment?.status ?? 'PENDING')}</strong></p>
        {order.sellerOrders?.map((sellerOrder: any) => <article className="buyerShipmentCard" key={sellerOrder.id}>
          <header><div><p className="eyebrow">{sellerOrder.seller?.store?.name ?? 'Marketplace Store'}</p><h3>{sellerOrder.shipmentStatus ? readableStatus(sellerOrder.shipmentStatus) : sellerOrder.status === 'CANCELLED' ? 'Cancelled' : 'Preparing your order'}</h3></div>{sellerOrder.receivedAt && <span className="receiptStatusBadge">Receipt confirmed</span>}</header>
          {sellerOrder.shippingCarrier && <p className="trackingDetails"><strong>{sellerOrder.shippingCarrier}</strong>{sellerOrder.trackingNumber && <> · Tracking {sellerOrder.trackingNumber}</>}{sellerOrder.trackingUrl && <> · <a href={sellerOrder.trackingUrl} target="_blank" rel="noopener noreferrer">Track with carrier</a></>}</p>}
          {sellerOrder.shipmentUpdates?.length > 0 && <ol className="shipmentTimeline" aria-label="Shipment progress">{[...sellerOrder.shipmentUpdates].reverse().map((update: any) => <li key={update.id}><span className="shipmentTimelineDot" aria-hidden="true" /><div><strong>{readableStatus(update.status)}</strong>{update.note && <p>{update.note}</p>}<small>{update.carrier ?? sellerOrder.shippingCarrier ?? 'Seller update'} · {dateLabel(update.createdAt)}</small></div></li>)}</ol>}
          {sellerOrder.deliveredAt && <p className="muted">Seller marked delivered {dateLabel(sellerOrder.deliveredAt)}.</p>}
          {sellerOrder.receivedAt ? <p className="receiptConfirmedLine" role="status">You confirmed receipt in good condition on {dateLabel(sellerOrder.receivedAt)}. Online seller proceeds remain subject to the configured payout hold.</p> : sellerOrder.shippedAt && order.payment?.method !== 'POS' && <div className="receiptAction"><p className="muted">Only confirm after the item is in your possession and you have checked its condition.</p><button className="primary" type="button" onClick={() => { setReceiptError(''); setReceiptTarget({ parentOrderId: order.id, sellerOrderId: sellerOrder.id, paymentMethod: order.payment?.method ?? 'UNKNOWN' }); }}>Confirm item received</button></div>}
          {order.payment?.method === 'COD' && <p className="notice shipmentPaymentNotice">Cash on delivery is paid to the seller on delivery; the marketplace does not hold COD funds in its payout ledger.</p>}
          {sellerOrder.items?.map((item: any) => <p className="buyerOrderItem" key={item.id}>{item.quantity} × {item.productName} · {money(item.unitPriceMinor, item.currencySnapshot ?? order.currency)}</p>)}
          <OrderResolutionPanel mode="buyer" parentOrderId={order.id} sellerOrder={sellerOrder} currency={order.currency} reload={reload} />
         </article>)}
      </div>
    </details>)}</div>}
    <dialog ref={dialogRef} className="receiptConfirmDialog" aria-labelledby="receipt-confirm-title" onClose={() => { if (receiptTarget) setReceiptTarget(null); }}>
      <p className="eyebrow">Buyer protection</p><h2 id="receipt-confirm-title">Confirm receipt and condition</h2>
      <p>You are confirming that this item is in your possession and was received in good condition. Do not confirm if anything is missing, damaged, or not as described.</p>
      {receiptTarget?.paymentMethod === 'COD' ? <p className="notice">This was a cash-on-delivery order. The seller collects COD payment on delivery; the marketplace cannot hold those cash funds.</p> : <p className="notice">After confirmation, in-app cancellation, refund, or dispute requests for this item may no longer be available, except where applicable law or your payment provider requires otherwise. This confirmation does not waive statutory rights or payment-provider protections.</p>}
      {receiptError && <p className="notice" role="alert">{receiptError}</p>}
      <div className="receiptDialogActions"><button type="button" autoFocus disabled={receiptSaving} onClick={() => setReceiptTarget(null)}>Go back</button><button className="primary" type="button" disabled={receiptSaving} onClick={() => void confirmReceipt()}>{receiptSaving ? 'Confirming…' : 'Confirm received in good condition'}</button></div>
    </dialog>
  </section>;
}
function BuyerCart({ data }: { data: BuyerData }) { const update = async (productId: string, quantity: number) => { try { await request(`/api/cart/items/${productId}`, { method: 'PATCH', body: JSON.stringify({ quantity }) }); window.dispatchEvent(new Event('marketplace:cart-changed')); } catch (error) { alert((error as Error).message); } }; return <section><h2>Cart</h2>{data.cart.items.length === 0 ? <div className="empty">Your cart is empty. <a href="/">Continue shopping</a>.</div> : <div className="table">{data.cart.items.map(item => <div className="row" key={item.id}><span>{item.product.name} · {money(item.variant?.priceMinor ?? item.product.salePriceMinor ?? item.product.priceMinor, item.product.currency)}</span><span><button aria-label={`Decrease ${item.product.name}`} disabled={item.quantity <= 1} onClick={() => void update(item.product.id, item.quantity - 1)}>−</button> {item.quantity} <button aria-label={`Increase ${item.product.name}`} onClick={() => void update(item.product.id, item.quantity + 1)}>+</button></span><button onClick={() => void update(item.product.id, 0)}>Remove</button></div>)}</div>}<p><a className="primary" href="/">Continue shopping</a> <a className="primary" href="/checkout">Proceed to checkout</a></p></section>; }
function Favorites({ data, reload }: { data: BuyerData; reload: () => void }) { return <section><h2>Favorites</h2>{data.favorites.length === 0 ? <div className="empty">No saved favorites.</div> : <div className="grid">{data.favorites.map(item => <article className="card" key={item.id}><div className="cardBody"><h2>{item.product.name}</h2><p>{item.product.seller?.store?.name ?? 'Platform store'}</p><strong>{money(item.product.salePriceMinor ?? item.product.priceMinor, item.product.currency)}</strong><button onClick={async () => { await request(`/api/favorites/${item.productId}`, { method: 'DELETE' }); reload(); }}>Remove favorite</button></div></article>)}</div>}</section>; }
function Messages({ conversations, reload }: { conversations: any[]; reload: () => void }) { const [selected, setSelected] = useState<any>(null); const [body, setBody] = useState(''); const send = async () => { if (!selected || !body.trim()) return; await request(`/api/conversations/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ body }) }); setBody(''); reload(); }; return <section><h2>Messages</h2>{conversations.length === 0 ? <div className="empty">No conversations yet.</div> : <div className="two"><div className="table">{conversations.map(conversation => <button className="row" key={conversation.id} onClick={() => setSelected(conversation)}>{conversation.product?.name ?? 'Conversation'} · {conversation.messages?.[0]?.body ?? 'No messages'}</button>)}</div>{selected && <div className="card cardBody"><h3>Conversation</h3><p>Only participants can access this thread.</p><textarea value={body} onChange={event => setBody(event.target.value)} placeholder="Write a message" /><button className="primary" onClick={() => void send()}>Send</button></div>}</div>}</section>; }
function Profile({ user, onUserUpdated, reload }: { user: User; onUserUpdated: (user: SessionUser) => void; reload: () => void }) { const [name, setName] = useState(user.name); const [message, setMessage] = useState(''); return <section className="profileSummary"><div className="profileSummaryHeader"><h2>Profile and security</h2>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="avatarFallback" aria-hidden="true">{user.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toLocaleUpperCase() ?? '').join('')}</span>}</div><label>Display name<input value={name} onChange={event => setName(event.target.value)} /></label><p className="muted">Email: {user.email} · Role: {user.role}</p><div className="profileActions"><button className="primary" onClick={async () => { const updated = await request<SessionUser>('/api/account/profile', { method: 'PATCH', body: JSON.stringify({ name }) }); onUserUpdated(updated); setMessage('Profile saved.'); reload(); }}>Save profile</button><a href="/settings#profile">Manage your photo and settings</a></div>{message && <p role="status" className="muted">{message}</p>}</section>; }
function Addresses({ data, reload }: { data: BuyerData; reload: () => void }) {
  const [form, setForm] = useState({ label: 'Home', line1: '', city: '', region: '', postalCode: '', country: 'US' });
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await request('/api/account/addresses', { method: 'POST', body: JSON.stringify({ ...form, ...(coordinates ? coordinates : {}) }) }); setForm({ label: 'Home', line1: '', city: '', region: '', postalCode: '', country: 'US' }); setCoordinates(null); setMessage('Address saved.'); reload(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  return <section><h2>Saved addresses</h2><div className="table">{data.addresses.map(address => <div className="row" key={address.id}><span>{address.label}: {address.line1}, {address.city}{address.latitude != null && address.longitude != null ? ' · Map pin saved' : ''}</span><button onClick={async () => { await request(`/api/account/addresses/${address.id}`, { method: 'DELETE' }); reload(); }}>Remove</button></div>)}</div><form className="narrow addressForm" onSubmit={event => void save(event)}><h3>Add address</h3>{Object.entries(form).map(([key, value]) => <label key={key}>{key === 'line1' ? 'Street address' : key === 'postalCode' ? 'Postal code' : key[0]!.toUpperCase() + key.slice(1)}<input required value={value} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}<AddressMapPicker value={coordinates} onChange={setCoordinates} /><button className="primary" disabled={saving}>{saving ? 'Saving address…' : 'Save address'}</button>{message && <p role="status" className="muted">{message}</p>}</form></section>;
}

function SellerDashboard({ data, tab, setTab, reload }: { data: SellerData | null; tab: string; setTab: (value: string) => void; reload: () => void }) {
  if (!data) return null;
  const tabs = ['overview', 'products', 'orders', 'shipping', 'dropshipping', 'messages', 'store', 'currency', 'commission', 'payouts', 'pos', 'live'];
  return <>
    <Tabs items={tabs} active={tab} setActive={setTab} />
    <nav className="sellerQuickLinks" aria-label="Store tools">
      <a href="/seller/plan"><small>Account</small><strong>Plan and usage</strong></a>
      <a href="/seller/content"><small>Brand experience</small><strong>Content studio</strong></a>
      <a href="/seller/growth"><small>Marketing</small><strong>Store growth</strong></a>
      <a href="/seller/currency"><small>Finance</small><strong>Store currency</strong></a>
    </nav>
    {tab === 'overview' && <><div className="heroPills"><span>{data.products.length} products</span><span>{data.summary.orderCount} orders</span>{data.summary.grossByCurrency.length ? data.summary.grossByCurrency.map(total => <span key={total.currency}>Gross sales ({total.currency}): {money(total.grossMinor, total.currency)}</span>) : <span>No sales yet</span>}</div><SellerOrders orders={data.orders.slice(0, 5)} reload={reload} /></>}
    {tab === 'products' && <div className="sellerProductsWorkspace"><SellerProducts data={data} reload={reload} /></div>}
    {tab === 'orders' && <SellerOrders orders={data.orders} sellerMode reload={reload} />}
    {tab === 'shipping' && <SellerShipping />}
    {tab === 'dropshipping' && <SellerDropshipping />}
    {tab === 'currency' && <SellerStoreCurrency />}
    {tab === 'commission' && <SellerCommissionStatement />}
    {tab === 'messages' && <><Messages conversations={data.conversations} reload={reload} /><SupportDesk mode="seller" /></>}
    {tab === 'store' && <section className="setting"><div><h2>{data.store.name}</h2><p>Public URL: /store/{data.store.slug}</p></div><a href={`/store/${data.store.slug}`}>View store</a><a href="/seller/platform">Edit store settings</a></section>}
    {tab === 'payouts' && <section><h2>Payouts</h2><p className="muted">Payouts remain separate from buyer checkout. Full account identifiers are never shown.</p><div className="table">{data.payoutMethods.map(method => <div className="row" key={method.id}><span>{method.type} · {method.maskedIdentifier}</span><span>{method.status}</span></div>)}{data.payouts.map(payout => <div className="row" key={payout.id}><span>{money(payout.amountMinor, payout.currency)}</span><span>{payout.status}</span></div>)}</div><a href="/seller/platform">Manage payout methods</a></section>}
    {tab === 'pos' && <section className="setting"><h2>Cash POS</h2><p>POS availability is server-enforced for approved seller/cashier accounts.</p><a href="/pos">Open POS</a></section>}
    {tab === 'live' && <SellerLiveStudio products={data.products} />}
  </>;
}
function ProductManagement({ products, media, categories, brands, productTypes, reload, setMessage, onUploadFiles, uploading, uploadProgress }: { products: any[]; media: any[]; categories: CatalogCategory[]; brands: CatalogBrand[]; productTypes: CatalogProductType[]; reload: () => void; setMessage: (value: string) => void; onUploadFiles: (files: File[], product?: any) => void; uploading: boolean; uploadProgress: number | null }) {
  const approvedMedia = media.filter(asset => ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(asset.kind) && asset.uploadStatus === 'COMPLETE' && asset.scanStatus === 'APPROVED');
  return <div className="sellerProductManagement">{products.map(product => <ProductEditor key={product.id} product={product} approvedMedia={approvedMedia} categories={categories} brands={brands} productTypes={productTypes} reload={reload} setMessage={setMessage} onUploadFiles={onUploadFiles} uploading={uploading} uploadProgress={uploadProgress} />)}</div>;
}

function ProductEditor({ product, approvedMedia, categories, brands, productTypes, reload, setMessage, onUploadFiles, uploading, uploadProgress }: { product: any; approvedMedia: any[]; categories: CatalogCategory[]; brands: CatalogBrand[]; productTypes: CatalogProductType[]; reload: () => void; setMessage: (value: string) => void; onUploadFiles: (files: File[], product?: any) => void; uploading: boolean; uploadProgress: number | null }) {
  const [form, setForm] = useState({ name: product.name, description: product.description, priceMinor: String(product.priceMinor), salePriceMinor: product.salePriceMinor == null ? '' : String(product.salePriceMinor), stock: String(product.inventory?.quantity ?? 0), categoryId: product.categoryId ?? null as string | null, brandId: product.brandId ?? null as string | null, productTypeId: product.productTypeId ?? '', color: product.color ?? '', featureIds: (product.featureAssignments ?? []).map((item: any) => item.featureId) as string[] });
  const [selectedMedia, setSelectedMedia] = useState('');
  const [saving, setSaving] = useState(false);
  const actionLock = useRef(false);
  useEffect(() => setForm({ name: product.name, description: product.description, priceMinor: String(product.priceMinor), salePriceMinor: product.salePriceMinor == null ? '' : String(product.salePriceMinor), stock: String(product.inventory?.quantity ?? 0), categoryId: product.categoryId ?? null, brandId: product.brandId ?? null, productTypeId: product.productTypeId ?? '', color: product.color ?? '', featureIds: (product.featureAssignments ?? []).map((item: any) => item.featureId) }), [product]);
  const runProductAction = async (action: () => Promise<unknown>, successMessage: string): Promise<boolean> => {
    if (actionLock.current) return false;
    actionLock.current = true;
    setSaving(true); setMessage('');
    try { await action(); setMessage(successMessage); await reload(); return true; }
    catch (error) { setMessage((error as Error).message); return false; }
    finally { actionLock.current = false; setSaving(false); }
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runProductAction(() => request(`/api/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: JSON.stringify({ name: form.name, description: form.description, priceMinor: Number(form.priceMinor), salePriceMinor: form.salePriceMinor === '' ? null : Number(form.salePriceMinor), stock: Number(form.stock), categoryId: form.categoryId, brandId: form.brandId, productTypeId: form.productTypeId, color: form.color || null, featureIds: form.featureIds }) }), 'Product details saved.');
  };
  const attach = async () => {
    const asset = approvedMedia.find(item => item.id === selectedMedia); if (!asset) return;
    const attached = await runProductAction(() => request(`/api/products/${encodeURIComponent(product.id)}/media`, { method: 'POST', body: JSON.stringify({ mediaAssetId: asset.id, label: asset.originalName.replace(/\.[^.]+$/, '') }) }), 'Approved media attached to the product gallery.');
    if (attached) setSelectedMedia('');
  };
  const counts = productMediaCounts(product);
  return <article className="setting productEditor">
    <div className="productEditorHeading"><div><h3>{product.name}</h3><small>{product.status} · {product.inventory?.quantity ?? 0} in stock · {product.variants?.length ?? 0} variants</small></div>{product.status !== 'ARCHIVED' && <button type="button" disabled={saving} onClick={() => void runProductAction(() => request(`/api/seller/products/${encodeURIComponent(product.id)}/archive`, { method: 'PATCH', body: '{}' }), 'Product archived.')}>Archive</button>}</div>
    <form onSubmit={event => void save(event)}>
      <label>Product name<input required minLength={2} maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>Description<textarea required minLength={2} maxLength={5000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <div className="sellerPriceFields"><label>Regular price (minor units)<input required type="number" min="1" step="1" value={form.priceMinor} onChange={event => setForm({ ...form, priceMinor: event.target.value })} /></label><label>Sale price (optional; must be lower)<input type="number" min="1" step="1" value={form.salePriceMinor} onChange={event => setForm({ ...form, salePriceMinor: event.target.value })} /></label><label>Stock<input type="number" min="0" step="1" value={form.stock} onChange={event => setForm({ ...form, stock: event.target.value })} /></label></div>
      <CatalogFields categories={categories} brands={brands} productTypes={productTypes} categoryId={form.categoryId} brandId={form.brandId} productTypeId={form.productTypeId} color={form.color} featureIds={form.featureIds} onCategoryChange={categoryId => setForm(current => ({ ...current, categoryId }))} onBrandChange={brandId => setForm(current => ({ ...current, brandId }))} onProductTypeChange={productTypeId => setForm(current => ({ ...current, productTypeId }))} onColorChange={color => setForm(current => ({ ...current, color }))} onFeatureIdsChange={featureIds => setForm(current => ({ ...current, featureIds }))} onMessage={setMessage} />
      <button disabled={saving}>{saving ? 'Saving…' : 'Save product'}</button>
    </form>
    <div className="productAttachments"><strong>Gallery and product files</strong>{product.images?.map((image: any) => <div className="productAttachment" key={`legacy-${image.id}`}><span>IMAGE · {image.alt}</span><button type="button" disabled={saving} onClick={() => void runProductAction(() => request(`/api/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(image.id)}`, { method: 'DELETE' }), 'Gallery image removed.')}>Remove</button></div>)}{product.mediaAttachments?.map((attachment: any) => <div className="productAttachment" key={attachment.id}><span>{attachment.mediaAsset.kind} · {attachment.label || attachment.mediaAsset.originalName}</span><button type="button" disabled={saving} onClick={() => void runProductAction(() => request(`/api/products/${encodeURIComponent(product.id)}/media/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' }), 'Product media removed.')}>Remove</button></div>)}{!product.images?.length && !product.mediaAttachments?.length && <small>No product media attached yet.</small>}</div>
    <div className="productMediaUploadControl"><label>Upload to this product from your device<input type="file" multiple accept={PRODUCT_MEDIA_ACCEPT} disabled={saving || uploading} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); if (files.length) onUploadFiles(files, product); event.currentTarget.value = ''; }} /></label><small>Images {counts.IMAGE}/{PRODUCT_MEDIA_LIMITS.IMAGE} · Video {counts.VIDEO}/{PRODUCT_MEDIA_LIMITS.VIDEO} · Documents/PDF {counts.DOCUMENT}/{PRODUCT_MEDIA_LIMITS.DOCUMENT}. Uploads are attached automatically after malware approval.</small>{uploading && uploadProgress !== null && <progress value={uploadProgress} max="100" aria-label={`Upload progress for ${product.name}`} />}</div>
    <div className="productAttachControl"><label>Add approved media from library<select aria-label={`Approved product media for ${product.name}`} value={selectedMedia} onChange={event => setSelectedMedia(event.target.value)}><option value="">Select an approved image, video, or document</option>{approvedMedia.map(asset => <option key={asset.id} value={asset.id}>{asset.kind} · {asset.originalName}</option>)}</select></label><button type="button" disabled={!selectedMedia || saving} onClick={() => void attach()}>Add to gallery</button></div>
  </article>;
}

function SellerProducts({ data, reload }: { data: SellerData; reload: () => void }) {
  const [form, setForm] = useState({ name: '', description: '', priceMinor: 1000, salePriceMinor: '', stock: 1, categoryId: null as string | null, brandId: null as string | null, productTypeId: '', color: '', featureIds: [] as string[] });
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [brands, setBrands] = useState<CatalogBrand[]>([]);
  const [productTypes, setProductTypes] = useState<CatalogProductType[]>([]);
  const [media, setMedia] = useState<any[]>([]);
  const [message, setMessage] = useState('');
  const [resourceErrors, setResourceErrors] = useState({ media: '', taxonomy: '' });
  const [resourceRetry, setResourceRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [taxonomyLoading, setTaxonomyLoading] = useState(true);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const createLock = useRef(false);
  useEffect(() => {
    let active = true;
    setMediaLoading(true); setTaxonomyLoading(true); setResourceErrors({ media: '', taxonomy: '' });
    const loadResources = async () => {
      const [mediaResult, taxonomyResult] = await Promise.allSettled([
        request<{ assets: any[] }>('/api/seller/store-media'),
        request<{ categories: CatalogCategory[]; brands: CatalogBrand[]; productTypes: CatalogProductType[] }>('/api/catalog/taxonomy')
      ]);
      if (!active) return;
      const failures: string[] = [];
      if (mediaResult.status === 'fulfilled') setMedia(mediaResult.value.assets);
      else { const error = (mediaResult.reason as Error).message; failures.push(`Media library: ${error}`); setResourceErrors(current => ({ ...current, media: error })); }
      setMediaLoading(false);
      if (taxonomyResult.status === 'fulfilled') {
        const taxonomy = taxonomyResult.value;
        setCategories(taxonomy.categories); setBrands(taxonomy.brands); setProductTypes(taxonomy.productTypes);
        setForm(current => ({ ...current, productTypeId: current.productTypeId || taxonomy.productTypes[0]?.id || '' }));
      } else { const error = (taxonomyResult.reason as Error).message; failures.push(`Catalog options: ${error}`); setResourceErrors(current => ({ ...current, taxonomy: error })); }
      setTaxonomyLoading(false);
      if (failures.length) setMessage(failures.join(' '));
    };
    void loadResources();
    return () => { active = false; };
  }, [resourceRetry]);
  const uploadFiles = async (files: File[], product?: any) => {
    if (uploadLock.current) return;
    const selected: { file: File; contentType: string }[] = [];
    const skipped: string[] = [];
    const counts = product ? productMediaCounts(product) : null;
    for (const file of files) {
      const contentType = uploadContentType(file);
      const kind = productMediaKindForFile(file.name);
      if (!contentType || !kind) { skipped.push(`${file.name}: unsupported file type.`); continue; }
      if (counts && counts[kind] >= PRODUCT_MEDIA_LIMITS[kind]) { skipped.push(`${file.name}: this product has reached its ${kind.toLowerCase()} limit.`); continue; }
      if (counts) counts[kind] += 1;
      selected.push({ file, contentType });
    }
    if (!selected.length) { setMessage(skipped.join(' ') || 'Choose supported image, video, or document files.'); return; }

    uploadLock.current = true;
    setUploading(true); setUploadProgress(0); setMessage('');
    let attached = 0;
    let readyInLibrary = 0;
    let waitingForScan = 0;
    let attachedAny = false;
    const errors: string[] = [];
    try {
      for (const { file, contentType } of selected) {
        try {
          const reservation = await request<{ id: string; upload: { url: string; fields: Record<string, string> } }>('/api/seller/store-media/uploads', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }) });
          await uploadToSignedPostWithType(reservation.upload.url, reservation.upload.fields, file, setUploadProgress, contentType);
          const finalized = await request<{ scanStatus: string }>(`/api/seller/store-media/${encodeURIComponent(reservation.id)}/finalize`, { method: 'POST', body: '{}' });
          if (finalized.scanStatus === 'APPROVED' && product) {
            await request(`/api/products/${encodeURIComponent(product.id)}/media`, { method: 'POST', body: JSON.stringify({ mediaAssetId: reservation.id, label: file.name.replace(/\.[^.]+$/, '') }) });
            attached += 1;
            attachedAny = true;
          } else if (finalized.scanStatus === 'APPROVED') readyInLibrary += 1;
          else waitingForScan += 1;
        } catch (error) { errors.push(`${file.name}: ${(error as Error).message}`); }
      }
      const result = await request<{ assets: any[] }>('/api/seller/store-media');
      setMedia(result.assets);
      if (attachedAny) reload();
      const summary = product
        ? `${attached} file(s) added to ${product.name}; ${waitingForScan} awaiting malware approval.`
        : `${readyInLibrary} file(s) scanned and ready to attach; ${waitingForScan} awaiting malware approval.`;
      setMessage([summary, ...skipped, ...errors].filter(Boolean).join(' '));
    } catch (error) { setMessage((error as Error).message); }
    finally { uploadLock.current = false; setUploading(false); setUploadProgress(null); }
  };
  const createListing = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createLock.current) return;
    const priceMinor = Number(form.priceMinor);
    const salePriceMinor = form.salePriceMinor === '' ? null : Number(form.salePriceMinor);
    const stock = Number(form.stock);
    if (!Number.isSafeInteger(priceMinor) || priceMinor < 1 || (salePriceMinor !== null && (!Number.isSafeInteger(salePriceMinor) || salePriceMinor < 1 || salePriceMinor >= priceMinor)) || !Number.isSafeInteger(stock) || stock < 0) {
      setMessage('Check the regular price, lower sale price, and available stock.');
      return;
    }
    if (taxonomyLoading || !productTypes.length) { setMessage('Approved product types are still loading or unavailable. Try again shortly.'); return; }
    createLock.current = true;
    setCreating(true); setMessage('');
    try {
      await request('/api/products', { method: 'POST', body: JSON.stringify({ ...form, priceMinor, salePriceMinor, color: form.color || null, stock }) });
      setForm({ name: '', description: '', priceMinor: 1000, salePriceMinor: '', stock: 1, categoryId: null, brandId: null, productTypeId: productTypes[0]?.id ?? '', color: '', featureIds: [] });
      setMessage('Listing created and sent through the configured product review policy.');
      await reload();
    } catch (error) { setMessage((error as Error).message); }
    finally { createLock.current = false; setCreating(false); }
  };
  return <section className="sellerProducts">
    <header className="sellerProductsHeader"><div><p className="eyebrow">Catalog management</p><h2>Products</h2><p className="muted">Create, organize, price, and maintain your Store listings.</p></div><div className="sellerListingMetrics" aria-label="Listing summary"><span><strong>{data.products.length}</strong> listings</span><span><strong>{data.products.filter(product => product.status === 'APPROVED').length}</strong> live</span><span><strong>{data.products.filter(product => product.status === 'PENDING').length}</strong> under review</span></div></header>
    {message && <p className="notice sellerProductNotice" role="status" aria-live="polite">{message}</p>}
    <section className="setting sellerProductModule" aria-labelledby="create-listing-heading"><header className="sellerSectionHeading"><span className="sellerStep">01</span><div><p className="eyebrow">New listing</p><h3 id="create-listing-heading">Create a product</h3><p className="muted">Set the core details, then choose the catalog attributes that fit your item.</p></div></header>
      {taxonomyLoading && <p className="muted" role="status" aria-busy="true">Loading approved catalog options…</p>}
      {resourceErrors.taxonomy && <p className="notice" role="alert">Catalog options could not be loaded: {resourceErrors.taxonomy} <button type="button" onClick={() => setResourceRetry(value => value + 1)}>Retry</button></p>}
      <form className="sellerProductCreate" onSubmit={event => void createListing(event)}>
        <label>Product name<input required minLength={2} maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label>Description<textarea required minLength={2} maxLength={5000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
        <div className="sellerPriceFields"><label>Regular price ({data.store.baseCurrency ?? 'USD'} minor units)<input required type="number" min="1" step="1" value={form.priceMinor} onChange={event => setForm({ ...form, priceMinor: Number(event.target.value) })} /></label><label>Sale price (optional)<input type="number" min="1" max={Math.max(1, Number(form.priceMinor) - 1)} step="1" value={form.salePriceMinor} onChange={event => setForm({ ...form, salePriceMinor: event.target.value })} /></label><label>Available stock<input required type="number" min="0" step="1" value={form.stock} onChange={event => setForm({ ...form, stock: Number(event.target.value) })} /></label></div>
        <CatalogFields categories={categories} brands={brands} productTypes={productTypes} categoryId={form.categoryId} brandId={form.brandId} productTypeId={form.productTypeId} color={form.color} featureIds={form.featureIds} onCategoryChange={categoryId => setForm(current => ({ ...current, categoryId }))} onBrandChange={brandId => setForm(current => ({ ...current, brandId }))} onProductTypeChange={productTypeId => setForm(current => ({ ...current, productTypeId }))} onColorChange={color => setForm(current => ({ ...current, color }))} onFeatureIdsChange={featureIds => setForm(current => ({ ...current, featureIds }))} onMessage={setMessage} />
        <button className="primary" disabled={creating || taxonomyLoading || !productTypes.length}>{creating ? 'Creating listing…' : 'Create listing'}</button>
      </form>
    </section>
    <section className="setting sellerProductModule sellerMediaUpload" aria-labelledby="product-library-heading"><header className="sellerSectionHeading"><span className="sellerStep">02</span><div><p className="eyebrow">Shared media</p><h3 id="product-library-heading">Product media library</h3><p className="muted">Uploads stay private until scanning approves them. Attach approved assets to listings below.</p></div></header><label>Choose images, video, or documents<input type="file" multiple accept={PRODUCT_MEDIA_ACCEPT} disabled={uploading} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); if (files.length) void uploadFiles(files); event.currentTarget.value = ''; }} /></label>{mediaLoading && <small role="status" aria-busy="true">Loading media library…</small>}{resourceErrors.media && <p className="notice" role="alert">Media library could not be loaded: {resourceErrors.media} <button type="button" onClick={() => setResourceRetry(value => value + 1)}>Retry</button></p>}{uploadProgress !== null && <progress value={uploadProgress} max="100" aria-label="Upload progress" />}{!mediaLoading && !resourceErrors.media && <small>{media.length} uploaded asset(s); only completed, scanned assets can be attached.</small>}</section>
    <section className="sellerProductModule sellerListingsModule" aria-labelledby="your-listings-heading"><header className="sellerSectionHeading"><span className="sellerStep">03</span><div><p className="eyebrow">Inventory</p><h3 id="your-listings-heading">Your listings</h3><p className="muted">Update product details, inventory, and approved gallery media.</p></div></header><ProductManagement products={data.products} media={media} categories={categories} brands={brands} productTypes={productTypes} reload={reload} setMessage={setMessage} onUploadFiles={uploadFiles} uploading={uploading} uploadProgress={uploadProgress} />{data.products.length === 0 && <div className="empty">No products yet. Create your first listing above.</div>}</section>
    <SellerDiscounts products={data.products} categories={categories} currency={data.store.baseCurrency ?? 'USD'} />
  </section>;
}
function SellerOrders({ orders, sellerMode = false, reload }: { orders: any[]; sellerMode?: boolean; reload: () => void }) {
  const [filter, setFilter] = useState('all');
  const [collectingCodOrderId, setCollectingCodOrderId] = useState<string | null>(null);
  const [codCollectionMessage, setCodCollectionMessage] = useState('');
  const collectCod = async (orderId: string) => {
    if (!window.confirm('Confirm that you physically received the COD cash from the buyer. This records collection; the marketplace does not hold the cash.')) return;
    setCollectingCodOrderId(orderId); setCodCollectionMessage('');
    try {
      await request(`/api/orders/${encodeURIComponent(orderId)}/cod-collect`, { method: 'POST', body: '{}' });
      setCodCollectionMessage('COD collection recorded.');
      window.dispatchEvent(new Event('marketplace:orders-changed'));
      await reload();
    } catch (error) { setCodCollectionMessage((error as Error).message); }
    finally { setCollectingCodOrderId(null); }
  };
  const orderRows = orders.flatMap(order => {
    const sellerOrder = order.sellerOrders?.[0];
    if (!sellerOrder) return [];
    const key = sellerOrder.receivedAt ? 'completed'
      : sellerOrder.status === 'CANCELLED' ? 'cancelled'
        : sellerOrder.shipmentStatus === 'EXCEPTION' ? 'exceptions'
          : sellerOrder.shipmentStatus === 'DELIVERED' ? 'delivered'
            : ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(sellerOrder.shipmentStatus) ? 'in-transit'
              : 'to-ship';
    return [{ order, sellerOrder, key }];
  });
  const filters = [
    { id: 'all', label: 'All orders' },
    { id: 'to-ship', label: 'Needs shipment' },
    { id: 'in-transit', label: 'In transit' },
    { id: 'delivered', label: 'Delivered' },
    { id: 'exceptions', label: 'Exceptions' },
    { id: 'completed', label: 'Receipt confirmed' },
    { id: 'cancelled', label: 'Cancelled' }
  ];
  const visibleOrders = filter === 'all' ? orderRows : orderRows.filter(row => row.key === filter);
  const countFor = (id: string) => id === 'all' ? orderRows.length : orderRows.filter(row => row.key === id).length;
  return <section className="sellerOrders"><header className="ordersSectionHeading"><div><p className="eyebrow">Fulfillment</p><h2>Seller orders</h2><p className="muted">Add tracking at dispatch and keep buyers informed as delivery progresses.</p></div><span className="sellerOrderCount">{visibleOrders.length} of {orderRows.length} orders</span></header>
    {codCollectionMessage && <p className="notice" role="status">{codCollectionMessage}</p>}
    {orderRows.length === 0 ? <div className="empty">No seller orders yet.</div> : <>
      <nav className="sellerOrderFilters" aria-label="Filter seller orders">{filters.map(item => <button type="button" key={item.id} className={filter === item.id ? 'active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{countFor(item.id)}</span></button>)}</nav>
      {visibleOrders.length === 0 ? <div className="empty sellerOrderEmpty">No orders in this status.</div> : <div className="sellerOrderList">{visibleOrders.map(({ order, sellerOrder }) => {
        const status = sellerOrder.receivedAt ? 'RECEIPT CONFIRMED' : sellerOrder.shipmentStatus?.replaceAll('_', ' ') ?? (sellerOrder.status === 'CANCELLED' ? 'CANCELLED' : 'NEEDS SHIPMENT');
        const itemNames = sellerOrder.items?.map((item: any) => item.productName).join(', ') || 'Order items';
        return <details className="sellerOrderCard" key={order.id}>
          <summary className="sellerOrderSummary"><span className="sellerOrderSummaryMain"><span className="sellerOrderSummaryTop"><span className="eyebrow">{order.orderNumber}</span><span className="sellerOrderStatus">{status}</span></span><strong>{itemNames}</strong><small>{money(sellerOrder.totalMinor ?? order.totalMinor, order.currency)} · {order.payment?.method ?? 'Payment pending'} · {order.payment?.status ?? 'PENDING'}</small></span><span className="sellerOrderSummaryAside"><strong>{money(sellerOrder.totalMinor ?? order.totalMinor, order.currency)}</strong><span className="sellerOrderExpandLabel">View order <i aria-hidden="true" /></span></span></summary>
          <div className="sellerOrderDetails">
            {sellerOrder.receivedAt ? <p className="receiptConfirmedLine">Buyer confirmed receipt on {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sellerOrder.receivedAt))}. Eligible online proceeds remain subject to the configured payout hold.</p> : order.payment?.method === 'COD' ? <p className="notice shipmentPaymentNotice">Cash on delivery is collected by the seller at delivery and is not held by the platform.</p> : <p className="muted">Online seller proceeds are not payout-eligible until the buyer confirms receipt and the configured hold period passes.</p>}
            {sellerMode && order.payment?.method === 'COD' && order.payment?.status === 'PENDING' && sellerOrder.shipmentStatus === 'DELIVERED' && sellerOrder.deliveredAt && order._count?.sellerOrders === 1 && <div className="codCollectionAction"><p className="muted">Only confirm after you have received the cash from the buyer.</p><button type="button" className="primary" disabled={collectingCodOrderId === order.id} onClick={() => void collectCod(order.id)}>{collectingCodOrderId === order.id ? 'Recording COD collection…' : 'Confirm COD collected'}</button></div>}
            {sellerMode && order.payment?.method === 'COD' && sellerOrder.shipmentStatus === 'DELIVERED' && order._count?.sellerOrders > 1 && <p className="muted">This order contains multiple Stores; COD collection requires marketplace administrator review.</p>}
            {sellerMode && sellerOrder.sellerId && <SellerShipmentEditor sellerOrder={sellerOrder} reload={reload} />}
            {sellerMode && <OrderResolutionPanel mode="seller" parentOrderId={order.id} sellerOrder={sellerOrder} currency={order.currency} reload={reload} />}
            {sellerMode && <label className="sellerOrderStatusControl">Order processing status<select aria-label={`Order processing status for ${order.orderNumber}`} defaultValue={sellerOrder.status} onChange={async event => { try { await request(`/api/sellers/${sellerOrder.sellerId}/orders/${sellerOrder.id}/status`, { method: 'POST', body: JSON.stringify({ status: event.target.value }) }); reload(); } catch (error) { window.alert((error as Error).message); } }}><option>PENDING</option><option>CONFIRMED</option><option>PROCESSING</option><option>FULFILLED</option><option>CANCELLED</option></select></label>}
          </div>
        </details>;
      })}</div>}
    </>}
  </section>;
}

function SellerShipmentEditor({ sellerOrder, reload }: { sellerOrder: any; reload: () => void }) {
  const [status, setStatus] = useState(sellerOrder.shipmentStatus ?? 'SHIPPED');
  const [carrier, setCarrier] = useState(sellerOrder.shippingCarrier ?? '');
  const [trackingNumber, setTrackingNumber] = useState(sellerOrder.trackingNumber ?? '');
  const [trackingUrl, setTrackingUrl] = useState(sellerOrder.trackingUrl ?? '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setStatus(sellerOrder.shipmentStatus ?? 'SHIPPED');
    setCarrier(sellerOrder.shippingCarrier ?? '');
    setTrackingNumber(sellerOrder.trackingNumber ?? '');
    setTrackingUrl(sellerOrder.trackingUrl ?? '');
  }, [sellerOrder]);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || sellerOrder.receivedAt) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/sellers/${encodeURIComponent(sellerOrder.sellerId)}/orders/${encodeURIComponent(sellerOrder.id)}/shipping`, { method: 'PATCH', body: JSON.stringify({ status, carrier, trackingNumber, trackingUrl, note }) });
      setMessage('Shipment progress saved and shared with the buyer.'); setNote('');
      window.dispatchEvent(new Event('marketplace:orders-changed'));
      await reload();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  if (sellerOrder.receivedAt) return <p className="muted">Shipping history is locked after buyer receipt confirmation.</p>;
  const nextStatuses = sellerOrder.shipmentStatus === 'DELIVERED'
    ? ['DELIVERED']
    : sellerOrder.shipmentStatus === 'EXCEPTION'
      ? ['EXCEPTION', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']
      : sellerOrder.shipmentStatus === 'OUT_FOR_DELIVERY'
        ? ['OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION']
        : sellerOrder.shipmentStatus === 'IN_TRANSIT'
          ? ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']
          : sellerOrder.shipmentStatus === 'SHIPPED'
            ? ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']
            : ['SHIPPED'];
  return <div className="shipmentEditor"><h4>{sellerOrder.shipmentStatus ? 'Update shipping progress' : 'Add shipment and tracking'}</h4><form onSubmit={event => void save(event)}>
    <label>Delivery status<select value={status} onChange={event => setStatus(event.target.value)}>{nextStatuses.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
    <label>Carrier<input required maxLength={120} value={carrier} onChange={event => setCarrier(event.target.value)} placeholder="e.g. DHL, J&T, local courier" /></label>
    <label>Tracking number<input maxLength={160} value={trackingNumber} onChange={event => setTrackingNumber(event.target.value)} /></label>
    <label>Tracking URL<input type="url" maxLength={2000} value={trackingUrl} onChange={event => setTrackingUrl(event.target.value)} placeholder="https://carrier.example/track/…" /></label>
    <label className="shipmentNoteField">Buyer update (optional)<input maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="Parcel accepted at the sorting facility" /></label>
    <button className="primary" disabled={saving || !carrier.trim() || (!trackingNumber.trim() && !trackingUrl.trim())}>{saving ? 'Saving update…' : 'Save and notify buyer'}</button>
  </form>{message && <p className={message.includes('saved') ? 'receiptConfirmedLine' : 'notice'} role={message.includes('saved') ? 'status' : 'alert'}>{message}</p>}
    {sellerOrder.shipmentUpdates?.length > 0 && <ol className="shipmentTimeline sellerShipmentTimeline" aria-label="Shipment update history">{[...sellerOrder.shipmentUpdates].map((update: any) => <li key={update.id}><span className="shipmentTimelineDot" aria-hidden="true" /><div><strong>{update.status.replaceAll('_', ' ')}</strong>{update.note && <p>{update.note}</p>}<small>{update.carrier ?? 'Carrier'} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(update.createdAt))}</small></div></li>)}</ol>}
  </div>;
}
