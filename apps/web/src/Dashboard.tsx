import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, type SessionUser } from './session.js';
import { SellerShipping } from './SellerShipping.js';
import { AddressMapPicker } from './AddressMapPicker.js';
import { formatMinor } from './money.js';
import { SellerCommissionStatement, SellerStoreCurrency } from './SellerStoreCurrency.js';

type User = { id: string; email: string; name: string; role: string; sellerId?: string; avatarUrl?: string };
type Access = { buyer: boolean; seller: boolean; affiliateEligible: boolean; sellerApplication: { status: string; reason?: string | null; store?: { name: string; slug: string } | null } | null };
type BuyerData = { orders: any[]; cart: { items: any[] }; favorites: any[]; conversations: any[]; notifications: any[]; addresses: any[]; affiliate: any | null };
type SellerData = { store: any; summary: { orderCount: number; grossByCurrency: { currency: string; grossMinor: number }[] }; products: any[]; orders: any[]; conversations: any[]; payoutMethods: any[]; payouts: any[]; live: { effectiveEnabled: boolean; deploymentGate: boolean; reason: string } };
const money = (minor: number, currency = 'USD') => formatMinor(minor, currency);
async function request<T>(path: string, options: RequestInit = {}): Promise<T> { const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1]; const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); } return response.status === 204 ? undefined as T : response.json(); }

type Workspace = 'buyer' | 'seller';
type WorkspaceTabs = { buyer: string; seller: string };
const allowedTabs: Record<Workspace, string[]> = {
  buyer: ['overview', 'orders', 'cart', 'favorites', 'messages', 'notifications', 'profile', 'addresses', 'affiliate'],
  seller: ['overview', 'products', 'orders', 'shipping', 'messages', 'store', 'payouts', 'pos', 'live']
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
  const [user, setUser] = useState<User | null>(sessionUser);
  const [access, setAccess] = useState<Access | null>(null);
  const [buyer, setBuyer] = useState<BuyerData | null>(null);
  const [seller, setSeller] = useState<SellerData | null>(null);
  const [mode, setMode] = useState<Workspace>(() => readDashboardLocation().mode);
  const initialLocation = readDashboardLocation();
  const [tabs, setTabs] = useState<WorkspaceTabs>({ buyer: initialLocation.mode === 'buyer' ? initialLocation.tab : 'overview', seller: initialLocation.mode === 'seller' ? initialLocation.tab : 'overview' });
  const [loading, setLoading] = useState<Record<Workspace, boolean>>({ buyer: true, seller: false });
  const [errors, setErrors] = useState<Record<Workspace, string>>({ buyer: '', seller: '' });
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
      if (!currentAccess.buyer) return;
      if (target === 'seller' && !currentAccess.seller) { setSeller(null); return; }
      if (target === 'seller') setSeller(await request<SellerData>('/api/dashboard/seller'));
      else setBuyer(await request<BuyerData>('/api/dashboard/buyer'));
    } catch (error) {
      if (sequence === requestSequence.current[target]) setErrors(current => ({ ...current, [target]: (error as Error).message || 'Dashboard data could not be loaded.' }));
    } finally {
      if (sequence === requestSequence.current[target]) setLoading(current => ({ ...current, [target]: false }));
    }
  }, []);

  useEffect(() => { if (sessionUser) void load(mode); }, [sessionUser?.id, load]);
  useEffect(() => {
    const onPopState = () => {
      const next = readDashboardLocation();
      setMode(next.mode);
      setTabs(current => ({ ...current, [next.mode]: next.tab }));
      void load(next.mode);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [load]);

  const selectMode = (next: Workspace) => {
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

  if (!sessionUser || sessionUser.role === 'ADMIN') return <section className="page"><p className="eyebrow">Your account</p><h1>Admin dashboard is separate</h1><p className="notice">Use the authorized platform administration controls from the main navigation.</p><a className="primary" href="/admin/platform">Open platform administration</a></section>;
  if (!access && loading.buyer) return <section className="page dashboard" aria-busy="true"><p className="eyebrow">Your account</p><h1>Preparing your dashboard</h1><p className="muted" role="status">Loading your server-verified account access and activity…</p></section>;
  if (!access && errors.buyer) return <section className="page dashboard"><p className="eyebrow">Your account</p><h1>Dashboard unavailable</h1><p className="notice" role="alert">{errors.buyer}</p><button className="primary" onClick={() => void load(mode)}>Try again</button></section>;
  if (!access) return <section className="page dashboard"><h1>Dashboard unavailable</h1><p className="notice" role="alert">Sign in is required to open your dashboard.</p></section>;

  const hasSellerWorkspace = access.seller;
  return <section className="page dashboard"><p className="eyebrow">Your account · {mode === 'buyer' ? 'Buyer workspace' : 'Seller workspace'}</p><h1>{mode === 'buyer' ? 'Buyer dashboard' : 'Seller dashboard'}</h1><p className="muted">Switching workspaces changes the view only; server permissions still determine which tools and Store data you can access.</p>
    {message && <p className="notice" role="status">{message}</p>}
    {hasSellerWorkspace && <div className="dashboardSwitch" role="group" aria-label="Choose dashboard workspace"><button type="button" className={mode === 'buyer' ? 'primary' : ''} aria-pressed={mode === 'buyer'} onClick={() => selectMode('buyer')}>Buyer view</button><button type="button" className={mode === 'seller' ? 'primary' : ''} aria-pressed={mode === 'seller'} onClick={() => selectMode('seller')}>Seller view</button></div>}
    {!hasSellerWorkspace && mode === 'buyer' && <div className="sellerApplicationCard"><div><p className="eyebrow">Seller application</p><strong>{access.sellerApplication?.status ?? 'Not started'}</strong><p>{access.sellerApplication?.reason || 'Apply to sell on the marketplace. Seller tools remain restricted until an administrator approves your application.'}</p></div>{!access.sellerApplication && <button type="button" onClick={() => void applyForSeller()}>Apply to become a seller</button>}</div>}
    {mode === 'seller' && !hasSellerWorkspace ? <section className="dashboardOnboarding"><h2>Seller access is not active yet</h2><p className="muted">Your seller tools stay unavailable until the marketplace approves your application.</p>{access.sellerApplication ? <div className="setting"><div><strong>Application status: {access.sellerApplication.status}</strong><p>{access.sellerApplication.reason || 'We’ll show seller tools here after approval.'}</p></div></div> : <button className="primary" onClick={() => void applyForSeller()}>Apply to become a seller</button>}<a href="/dashboard">Return to buyer workspace</a></section> : <>
      <section className="dashboardWorkspace" aria-label="Buyer workspace" hidden={mode !== 'buyer'}>
        {errors.buyer && <p className="notice" role="alert">Saved dashboard data is shown where available. Refresh failed: {errors.buyer}</p>}
        {!buyer && loading.buyer && <p className="empty" role="status" aria-busy="true">Loading buyer activity…</p>}
        {!buyer && errors.buyer && <button onClick={() => void load('buyer')}>Retry buyer dashboard</button>}
        <BuyerDashboard data={buyer} tab={tabs.buyer} setTab={tab => selectTab('buyer', tab)} user={user ?? sessionUser} onUserUpdated={updated => { setUser(updated); setSessionUser(updated); }} reload={() => load('buyer')} />
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
function BuyerDashboard({ data, tab, setTab, user, onUserUpdated, reload }: { data: BuyerData | null; tab: string; setTab: (value: string) => void; user: User; onUserUpdated: (user: SessionUser) => void; reload: () => void }) {
  if (!data) return <p className="empty">Loading buyer data…</p>;
  const tabs = ['overview', 'orders', 'cart', 'favorites', 'messages', 'notifications', 'profile', 'addresses']; if (data.affiliate) tabs.push('affiliate');
  return <><Tabs items={tabs} active={tab} setActive={setTab} />{tab === 'overview' && <><div className="heroPills"><span>{data.orders.length} recent orders</span><span>{data.cart.items.reduce((sum, item) => sum + item.quantity, 0)} items in cart</span><span>{data.favorites.length} favorites</span></div><OrderList orders={data.orders.slice(0, 5)} /></>}{tab === 'orders' && <OrderList orders={data.orders} />}{tab === 'cart' && <BuyerCart data={data} reload={reload} />}{tab === 'favorites' && <Favorites data={data} reload={reload} />}{tab === 'messages' && <Messages conversations={data.conversations} reload={reload} />}{tab === 'notifications' && <NotificationList notifications={data.notifications} reload={reload} />}{tab === 'profile' && <Profile user={user} onUserUpdated={onUserUpdated} reload={reload} />}{tab === 'addresses' && <Addresses data={data} reload={reload} />}{tab === 'affiliate' && data.affiliate && <section className="setting"><div><h2>Affiliate area</h2><p>Approved affiliate profile: {data.affiliate.referralCode}</p></div><a href="/affiliate">Open affiliate dashboard</a></section>}</>;
}

function NotificationList({ notifications, reload }: { notifications: any[]; reload: () => void }) { return <section><h2>Notifications</h2>{notifications.length === 0 ? <div className="empty">No notifications yet.</div> : <div className="table">{notifications.map(notification => <div className="row" key={notification.id}><div><strong>{notification.title}</strong><p>{notification.body}</p><small>{notification.readAt ? 'Read' : 'Unread'}</small></div>{!notification.readAt && <button onClick={async () => { await request(`/api/notifications/${notification.id}/read`, { method: 'POST', body: '{}' }); reload(); }}>Mark as read</button>}</div>)}</div>}</section>; }
function OrderList({ orders }: { orders: any[] }) { return <section><h2>Orders</h2>{orders.length === 0 ? <div className="empty">No orders yet.</div> : <div className="table">{orders.map(order => <details className="row" key={order.id}><summary><strong>{order.orderNumber}</strong> · {money(order.totalMinor, order.currency)} · {order.status}</summary><p>Payment: {order.payment?.method ?? '—'} / {order.payment?.status ?? '—'}</p>{order.sellerOrders?.map((sellerOrder: any) => <div key={sellerOrder.id}><strong>{sellerOrder.seller?.store?.name ?? 'Platform items'}</strong>{sellerOrder.shippingSnapshotJson && <p>Shipping: {sellerOrder.shippingSnapshotJson.serviceName} · {money(sellerOrder.shippingSnapshotJson.shippingMinor, sellerOrder.shippingSnapshotJson.currency)}</p>}{sellerOrder.items?.map((item: any) => <span key={item.id}>{item.quantity} × {item.productName} · {money(item.unitPriceMinor, order.currency)}<br /></span>)}</div>)}</details>)}</div>}</section>; }
function BuyerCart({ data, reload }: { data: BuyerData; reload: () => void }) { const update = async (productId: string, quantity: number) => { try { await request(`/api/cart/items/${productId}`, { method: 'PATCH', body: JSON.stringify({ quantity }) }); window.dispatchEvent(new Event('marketplace:cart-changed')); reload(); } catch (error) { alert((error as Error).message); } }; return <section><h2>Cart</h2>{data.cart.items.length === 0 ? <div className="empty">Your cart is empty. <a href="/">Continue shopping</a>.</div> : <div className="table">{data.cart.items.map(item => <div className="row" key={item.id}><span>{item.product.name} · {money(item.variant?.priceMinor ?? item.product.priceMinor, item.product.currency)}</span><span><button aria-label={`Decrease ${item.product.name}`} disabled={item.quantity <= 1} onClick={() => void update(item.product.id, item.quantity - 1)}>−</button> {item.quantity} <button aria-label={`Increase ${item.product.name}`} onClick={() => void update(item.product.id, item.quantity + 1)}>+</button></span><button onClick={() => void update(item.product.id, 0)}>Remove</button></div>)}</div>}<p><a className="primary" href="/">Continue shopping</a> <a className="primary" href="/checkout">Proceed to checkout</a></p></section>; }
function Favorites({ data, reload }: { data: BuyerData; reload: () => void }) { return <section><h2>Favorites</h2>{data.favorites.length === 0 ? <div className="empty">No saved favorites.</div> : <div className="grid">{data.favorites.map(item => <article className="card" key={item.id}><div className="cardBody"><h2>{item.product.name}</h2><p>{item.product.seller?.store?.name ?? 'Platform store'}</p><strong>{money(item.product.priceMinor, item.product.currency)}</strong><button onClick={async () => { await request(`/api/favorites/${item.productId}`, { method: 'DELETE' }); reload(); }}>Remove favorite</button></div></article>)}</div>}</section>; }
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
  if (!data) return <p className="empty">Loading seller data…</p>;
  const tabs = ['overview', 'products', 'orders', 'shipping', 'messages', 'store', 'currency', 'commission', 'payouts', 'pos', 'live'];
  return <>
    <Tabs items={tabs} active={tab} setActive={setTab} />
    <p><a href="/seller/plan">View Store plan and usage</a></p>
    <p><a href="/seller/content">Open Store content studio</a></p>
    <p><a href="/seller/growth">Store growth tools</a></p>
    <p><a href="/seller/currency">Manage Store currency</a> · <a href="/seller/commissions">View commission statement</a></p>
    {tab === 'overview' && <><div className="heroPills"><span>{data.products.length} products</span><span>{data.summary.orderCount} orders</span>{data.summary.grossByCurrency.length ? data.summary.grossByCurrency.map(total => <span key={total.currency}>Gross sales ({total.currency}): {money(total.grossMinor, total.currency)}</span>) : <span>No sales yet</span>}</div><SellerOrders orders={data.orders.slice(0, 5)} /></>}
    {tab === 'products' && <SellerProducts data={data} reload={reload} />}
    {tab === 'orders' && <SellerOrders orders={data.orders} sellerMode />}
    {tab === 'shipping' && <SellerShipping />}
    {tab === 'currency' && <SellerStoreCurrency />}
    {tab === 'commission' && <SellerCommissionStatement />}
    {tab === 'messages' && <Messages conversations={data.conversations} reload={reload} />}
    {tab === 'store' && <section className="setting"><div><h2>{data.store.name}</h2><p>Public URL: /store/{data.store.slug}</p></div><a href={`/store/${data.store.slug}`}>View store</a><a href="/seller/platform">Edit store settings</a></section>}
    {tab === 'payouts' && <section><h2>Payouts</h2><p className="muted">Payouts remain separate from buyer checkout. Full account identifiers are never shown.</p><div className="table">{data.payoutMethods.map(method => <div className="row" key={method.id}><span>{method.type} · {method.maskedIdentifier}</span><span>{method.status}</span></div>)}{data.payouts.map(payout => <div className="row" key={payout.id}><span>{money(payout.amountMinor, payout.currency)}</span><span>{payout.status}</span></div>)}</div><a href="/seller/platform">Manage payout methods</a></section>}
    {tab === 'pos' && <section className="setting"><h2>Cash POS</h2><p>POS availability is server-enforced for approved seller/cashier accounts.</p><a href="/pos">Open POS</a></section>}
    {tab === 'live' && <section className="setting"><h2>Live shopping</h2><p>{data.live.effectiveEnabled ? 'Live shopping is enabled for this deployment.' : `Unavailable: ${data.live.reason}`}</p></section>}
  </>;
}
function SellerProducts({ data, reload }: { data: SellerData; reload: () => void }) {
  const [form, setForm] = useState({ name: '', description: '', priceMinor: 1000, stock: 1 });
  const [media, setMedia] = useState<any[]>([]);
  const [imageChoices, setImageChoices] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  useEffect(() => { void request<{ assets: any[] }>('/api/seller/store-media').then(result => setMedia(result.assets)).catch(error => setMessage((error as Error).message)); }, []);
  const attach = async (product: any) => {
    const mediaAssetId = imageChoices[product.id];
    if (!mediaAssetId) return;
    try {
      await request(`/api/products/${encodeURIComponent(product.id)}/images`, { method: 'POST', body: JSON.stringify({ mediaAssetId, alt: product.name }) });
      setImageChoices({ ...imageChoices, [product.id]: '' }); setMessage('Approved image attached to product.'); reload();
    } catch (error) { setMessage((error as Error).message); }
  };
  return <section><h2>Products</h2><form className="setting" onSubmit={async event => { event.preventDefault(); try { await request('/api/products', { method: 'POST', body: JSON.stringify({ ...form, priceMinor: Number(form.priceMinor), stock: Number(form.stock) }) }); setForm({ name: '', description: '', priceMinor: 1000, stock: 1 }); reload(); } catch (error) { setMessage((error as Error).message); } }}><label>Product name<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label>Description<textarea required value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><label>Price in minor units<input type="number" min="1" value={form.priceMinor} onChange={event => setForm({ ...form, priceMinor: Number(event.target.value) })} /></label><label>Stock<input type="number" min="0" value={form.stock} onChange={event => setForm({ ...form, stock: Number(event.target.value) })} /></label><button className="primary">Create listing</button></form>
    {message && <p className="notice" role="status">{message}</p>}
    {data.products.length === 0 ? <div className="empty">No products yet.</div> : <div className="table">{data.products.map(product => <div className="row sellerProductRow" key={product.id}><div><strong>{product.name}</strong><br /><small>{product.status} · {product.inventory?.quantity ?? 0} stock · {product.variants?.length ?? 0} variants</small><div className="sellerProductImages">{product.images?.map((image: any) => <span key={image.id}>{image.alt} <button type="button" aria-label={`Remove image ${image.alt}`} onClick={async () => { await request(`/api/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(image.id)}`, { method: 'DELETE' }); reload(); }}>Remove image</button></span>)}</div><label>Add approved Store image<select aria-label={`Image for ${product.name}`} value={imageChoices[product.id] ?? ''} onChange={event => setImageChoices({ ...imageChoices, [product.id]: event.target.value })}><option value="">Select approved image</option>{media.filter(asset => asset.kind === 'IMAGE' && asset.uploadStatus === 'COMPLETE' && asset.scanStatus === 'APPROVED').map(asset => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></label>{imageChoices[product.id] && <button type="button" onClick={() => void attach(product)}>Attach image</button>}</div>{product.status !== 'ARCHIVED' && <button type="button" onClick={async () => { await request(`/api/seller/products/${product.id}/archive`, { method: 'PATCH', body: '{}' }); reload(); }}>Archive</button>}</div>)}</div>}</section>;
}
function SellerOrders({ orders, sellerMode = false }: { orders: any[]; sellerMode?: boolean }) { return <section><h2>Seller orders</h2>{orders.length === 0 ? <div className="empty">No seller orders yet.</div> : <div className="table">{orders.map(order => { const sellerOrder = order.sellerOrders?.[0]; return <div className="row" key={order.id}><span>{order.orderNumber} · {money(sellerOrder?.totalMinor ?? order.totalMinor, order.currency)}{sellerOrder?.shippingSnapshotJson && <small className="orderShippingLine">Shipping: {sellerOrder.shippingSnapshotJson.serviceName} · {money(sellerOrder.shippingSnapshotJson.shippingMinor, sellerOrder.shippingSnapshotJson.currency)}</small>}</span><span>{sellerOrder?.status ?? order.status}</span>{sellerMode && sellerOrder && <select aria-label={`Fulfillment status for ${order.orderNumber}`} defaultValue={sellerOrder.status} onChange={async event => { await request(`/api/sellers/${sellerOrder.sellerId}/orders/${sellerOrder.id}/status`, { method: 'POST', body: JSON.stringify({ status: event.target.value }) }); }}><option>PENDING</option><option>CONFIRMED</option><option>PROCESSING</option><option>FULFILLED</option><option>CANCELLED</option></select>}</div>; })}</div>}</section>; }
