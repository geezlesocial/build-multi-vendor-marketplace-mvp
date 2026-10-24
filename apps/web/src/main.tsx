import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './currency-location.css';
import { ContentAdmin } from './ContentAdmin.js';
import { AffiliateAdmin } from './AffiliateAdmin.js';
import { AffiliateDashboard } from './AffiliateDashboard.js';
import { PlatformAdmin } from './PlatformAdmin.js';
import { SellerPlatform } from './SellerPlatform.js';
import { SellerStorePlan } from './SellerStorePlan.js';
import { SellerStoreContent } from './SellerStoreContent.js';
import { SellerStoreGrowth } from './SellerStoreGrowth.js';
import { SellerCommissionStatement, SellerStoreCurrency } from './SellerStoreCurrency.js';
import { AdminCurrencyCommission } from './AdminCurrencyCommission.js';
import { Storefront } from './Storefront.js';
import { Dashboard } from './Dashboard.js';
import { MarketplaceHome } from './MarketplaceHome.js';
import { ProductPage } from './ProductPage.js';
import { Settings } from './Settings.js';
import { AdminWallet } from './AdminWallet.js';
import { ClubCoins, Wallet } from './Wallet.js';
import { AppShell } from './AppShell.js';
import { SessionProvider, useSession, type SessionUser } from './session.js';
import { formatMinor } from './money.js';

type User = SessionUser;
type Product = { id: string; name: string; description: string; priceMinor: number; currency: string; availableStock: number; seller?: { store?: { name: string } }; category?: { name: string } };
type CartVariant = { id: string; name: string; priceMinor: number; currency: string; stock: number };
type CartItem = { product: Product; quantity: number; variant?: CartVariant | null };
type CartState = { items: CartItem[] };
type CartApiItem = { product: Product & { inventory?: { quantity: number } | null }; quantity: number; variant?: CartVariant | null };
type Settings = { multiVendorEnabled: boolean; paymentMethods: { method: string; enabled: boolean }[]; liveShopping?: { enabled: boolean; deploymentGate: boolean; reason: string } };

const money = (minor: number, currency = 'USD') => formatMinor(minor, currency);
async function api<T>(path: string, options: RequestInit = {}): Promise<T> { const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1]; const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); } return response.status === 204 ? (undefined as T) : response.json(); }
const normalizeCart = (value: { items?: CartApiItem[] }): CartState => ({ items: (value.items ?? []).map(item => ({ ...item, product: { ...item.product, availableStock: item.variant?.stock ?? item.product.inventory?.quantity ?? item.product.availableStock ?? 0 } })) });
const itemPrice = (item: CartItem) => item.variant?.priceMinor ?? item.product.priceMinor;
const itemStock = (item: CartItem) => item.variant?.stock ?? item.product.availableStock;

function App() {
  const { user, setUser } = useSession();
  const [settings, setSettings] = useState<Settings>({ multiVendorEnabled: true, paymentMethods: [], liveShopping: { enabled: false, deploymentGate: false, reason: 'Live shopping is not configured.' } });
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartState>({ items: [] });
  const [view, setView] = useState<'home' | 'checkout' | 'login' | 'dashboard' | 'pos' | 'live' | 'affiliate'>(() => window.location.pathname === '/checkout' ? 'checkout' : window.location.pathname === '/pos' ? 'pos' : new URLSearchParams(window.location.search).has('auth') ? 'login' : 'home');
  const [message, setMessage] = useState('');

  const loadCart = async () => { const next = normalizeCart(await api<{ items: CartApiItem[] }>('/api/cart')); setCart(next); window.dispatchEvent(new Event('marketplace:cart-changed')); };
  const load = async () => { const [publicSettings, catalog] = await Promise.all([api<Settings>('/api/settings/public'), api<{ items: Product[] }>(`/api/products?q=${encodeURIComponent(query)}`)]); setSettings(publicSettings); setProducts(catalog.items); };
  useEffect(() => { load().catch(e => setMessage(e.message)); }, [query]);
  useEffect(() => { if (user) void loadCart().catch(e => setMessage(e.message)); else setCart({ items: [] }); }, [user?.id]);
  const cartTotal = useMemo(() => cart.items.reduce((sum, item) => sum + itemPrice(item) * item.quantity, 0), [cart]);
  const add = async (productId: string) => { if (!user) { setView('login'); setMessage('Sign in to add items to your cart.'); return; } try { await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId, quantity: 1 }) }); setMessage('Added to cart'); await loadCart(); } catch (e) { setMessage((e as Error).message); } };
  const login = async (form: FormData) => { try { const result = await api<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); setUser(result.user); setCart(normalizeCart(await api<{ items: CartApiItem[] }>('/api/cart'))); setView('home'); setMessage(''); } catch (e) { setMessage((e as Error).message); } };
  const register = async (form: FormData) => { try { const result = await api<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); setUser(result.user); setCart({ items: [] }); setView('home'); setMessage(''); } catch (e) { setMessage((e as Error).message); } };

  return <>
    {message && <div className="notice shellNotice" role="status" aria-live="polite">{message}<button aria-label="Dismiss message" onClick={() => setMessage('')}>×</button></div>}
    {view === 'home' && <MarketplaceHome user={user} onAdd={add} onSignIn={() => { setView('login'); setMessage('Sign in to add items to your cart.'); }} />}
    {view === 'login' && <Login onSubmit={login} onRegister={register} />}
    {view === 'checkout' && <Checkout cart={cart} total={cartTotal} settings={settings} user={user} onChange={loadCart} onClearMessage={() => setMessage('')} onAnnounce={setMessage} />}
    {view === 'dashboard' && <Admin />}
    {view === 'pos' && <POS products={products} />}
  </>;
}

function Home({ products, query, setQuery, add, settings }: { products: Product[]; query: string; setQuery: (v: string) => void; add: (id: string) => void; settings: Settings }) { return <section className="page"><div className="hero"><p className="eyebrow">A calmer way to shop local</p><h1>Find good things from independent sellers.</h1><p>Browse approved products, compare stores, and check out securely with the payment methods the marketplace currently supports.</p><div className="heroPills"><span>Server-validated stock</span><span>Clear order status</span><span>COD available when enabled</span></div></div><div className="toolbar"><label className="search"><span>Search</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search products" /></label><span className="muted">{settings.multiVendorEnabled ? 'Multi-vendor mode is on' : 'Platform products only'}</span></div><div className="grid">{products.map(p => <article className="card" key={p.id}><div className="productMark">{p.name.slice(0, 1)}</div><div className="cardBody"><p className="eyebrow">{p.category?.name ?? 'Featured'} · {p.seller?.store?.name ?? 'Platform store'}</p><h2>{p.name}</h2><p>{p.description}</p><div className="cardBottom"><strong>{money(p.priceMinor, p.currency)}</strong><button onClick={() => add(p.id)} disabled={p.availableStock < 1}>Add to cart</button></div><small>{p.availableStock} in stock</small></div></article>)}</div>{products.length === 0 && <div className="empty">No approved products match that search.</div>}</section>; }

function Login({ onSubmit, onRegister }: { onSubmit: (data: FormData) => void; onRegister: (data: FormData) => void }) { const [registerMode, setRegisterMode] = useState(new URLSearchParams(window.location.search).get('auth') === 'register'); return <section className="narrow"><p className="eyebrow">Account access</p><h1>{registerMode ? 'Create account' : 'Sign in'}</h1><form onSubmit={e => { e.preventDefault(); (registerMode ? onRegister : onSubmit)(new FormData(e.currentTarget)); }}>{registerMode && <label>Name<input name="name" autoComplete="name" required minLength={2} maxLength={100} /></label>}<label>Email<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label><label>Password<input name="password" type="password" autoComplete={registerMode ? 'new-password' : 'current-password'} placeholder={registerMode ? 'Choose a password' : 'Enter your password'} required minLength={10} /></label>{registerMode && <p className="muted">New accounts start as buyers. Seller access remains subject to the existing approval flow.</p>}<button className="primary">{registerMode ? 'Create account' : 'Sign in'}</button></form><button type="button" onClick={() => setRegisterMode(value => !value)}>{registerMode ? 'Already have an account? Sign in' : 'Need an account? Create one'}</button>{!registerMode && <p className="muted">Local demo accounts are documented in the README. Change all demo credentials before any staging use.</p>}</section>; }

type ShippingQuote = { currency: string; itemSubtotalMinor: number; shippingTotalMinor: number; totalMinor: number; quoteToken: string | null; shipments: { sellerId: string; storeName: string; options: { serviceId: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number; currency: string; estimatedMinDays: number | null; estimatedMaxDays: number | null; discount: { name: string; type: string; amountMinor: number } | null }[]; selected: { serviceId: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number; currency: string; estimatedMinDays: number | null; estimatedMaxDays: number | null; discount: { name: string; type: string; amountMinor: number } | null } }[] };
type OrderDisplayEstimate = { currency: string; itemTotalMinor: number; shippingTotalMinor: number; totalMinor: number; purpose: 'DISPLAY_ESTIMATE_ONLY'; rateSnapshots: { provider: string; sourceDate: string; fetchedAt: string; rounding: string }[] };
type OrderConfirmation = { orderNumber: string; total: number; itemSubtotal: number; shippingTotal: number; currency: string; method: string; paymentStatus: string; shipments: { storeName: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number }[]; displayEstimate: OrderDisplayEstimate | null };
type SavedOrderConfirmation = { orderNumber: string; totalMinor: number; currency: string; payment: { method: string; status: string } | null; displayEstimate: OrderDisplayEstimate | null; sellerOrders: { shippingSnapshotJson: { serviceName?: unknown; feeMinor?: unknown; discountMinor?: unknown; shippingMinor?: unknown } | null; seller: { store: { name: string } } | null }[] };
type CurrencyOptions = { checkoutCurrency: string; checkoutCompatible: boolean; displayCurrencies: { code: string; name: string; symbol: string; minorUnitExponent: number }[]; error: string | null };
type CartEstimate = { displayCurrency: string; displayMerchandiseMinor: number; displayShippingMinor: number; displayTotalMinor: number; chargeCurrency: string; chargeMerchandiseMinor: number; chargeShippingMinor: number; rates: { provider: string; sourceDate: string; fetchedAt: string; purpose: string }[]; note: string };

function confirmationFromSavedOrder(order: SavedOrderConfirmation): OrderConfirmation {
  const shipments = order.sellerOrders.flatMap(sellerOrder => {
    const snapshot = sellerOrder.shippingSnapshotJson;
    if (!snapshot) return [];
    return [{
      storeName: sellerOrder.seller?.store.name ?? 'Store',
      serviceName: typeof snapshot.serviceName === 'string' ? snapshot.serviceName : 'Delivery',
      feeMinor: typeof snapshot.feeMinor === 'number' ? snapshot.feeMinor : 0,
      discountMinor: typeof snapshot.discountMinor === 'number' ? snapshot.discountMinor : 0,
      shippingMinor: typeof snapshot.shippingMinor === 'number' ? snapshot.shippingMinor : 0
    }];
  });
  const shippingTotal = shipments.reduce((sum, shipment) => sum + shipment.shippingMinor, 0);
  const method = order.payment?.method ?? '';
  const persistedStatus = order.payment?.status ?? 'PENDING';
  const paymentStatus = method !== 'COD' && persistedStatus === 'PENDING' ? 'AWAITING_PROVIDER' : persistedStatus;
  return { orderNumber: order.orderNumber, total: order.totalMinor, itemSubtotal: order.totalMinor - shippingTotal, shippingTotal, currency: order.currency, method, paymentStatus, shipments, displayEstimate: order.displayEstimate };
}

function Checkout({ cart, total, settings, user, onChange, onClearMessage, onAnnounce }: { cart: CartState; total: number; settings: Settings; user: User | null; onChange: () => Promise<void>; onClearMessage: () => void; onAnnounce: (message: string) => void }) {
  const requestedOrderId = new URLSearchParams(window.location.search).get('order');
  const [form, setForm] = useState({ buyerName: user?.name ?? '', buyerEmail: user?.email ?? '', line1: '', city: '', region: '', postalCode: '', country: 'US', method: 'COD' });
  const [result, setResult] = useState('');
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  const [shippingQuote, setShippingQuote] = useState<ShippingQuote | null>(null);
  const [selectedServices, setSelectedServices] = useState<Record<string, string>>({});
  const [quotePending, setQuotePending] = useState(false);
  const [currencyOptions, setCurrencyOptions] = useState<CurrencyOptions | null>(null);
  const [displayCurrency, setDisplayCurrency] = useState('');
  const [displayEstimate, setDisplayEstimate] = useState<CartEstimate | null>(null);
  const [estimateMessage, setEstimateMessage] = useState('');
  const methods = settings.paymentMethods.filter(x => x.enabled && ['STRIPE', 'PAYPAL', 'COD'].includes(x.method));
  const address = { line1: form.line1, city: form.city, region: form.region, postalCode: form.postalCode, country: form.country };
  const requiresShipping = cart.items.some(item => Boolean(item.product.seller));
  const updateAddress = (key: 'line1' | 'city' | 'region' | 'postalCode' | 'country', value: string) => { setForm(current => ({ ...current, [key]: value })); setShippingQuote(null); setSelectedServices({}); };

  const cartKey = cart.items.map(item => `${item.product.id}:${item.variant?.id ?? ''}:${item.quantity}`).sort().join('|');
  useEffect(() => {
    let active = true;
    if (!user) { setCurrencyOptions(null); return; }
    api<CurrencyOptions>('/api/currency/cart-options').then(options => {
      if (!active) return;
      setCurrencyOptions(options);
      setDisplayCurrency(current => options.displayCurrencies.some(currency => currency.code === current) ? current : options.displayCurrencies[0]?.code ?? '');
      setEstimateMessage(options.error ?? '');
    }).catch(error => { if (active) setEstimateMessage((error as Error).message); });
    return () => { active = false; };
  }, [user?.id, cartKey]);

  useEffect(() => {
    if (requestedOrderId) return;
    let active = true;
    setDisplayEstimate(null);
    if (!displayCurrency || !cart.items.length || !currencyOptions?.displayCurrencies.some(currency => currency.code === displayCurrency)) return;
    if (requiresShipping && !shippingQuote) { setEstimateMessage('Calculate delivery first to see the complete display estimate.'); return; }
    setEstimateMessage('');
    api<CartEstimate>('/api/currency/cart-estimate', { method: 'POST', body: JSON.stringify({ displayCurrency, ...(requiresShipping ? { address, shippingQuoteToken: shippingQuote?.quoteToken } : {}) }) })
      .then(estimate => { if (active) setDisplayEstimate(estimate); })
      .catch(error => { if (active) setEstimateMessage((error as Error).message); });
    return () => { active = false; };
  }, [requestedOrderId, displayCurrency, currencyOptions, cartKey, shippingQuote?.quoteToken, form.line1, form.city, form.region, form.postalCode, form.country]);

  useEffect(() => {
    if (!requestedOrderId) return;
    let active = true;
    if (!user?.id) {
      setResult('Sign in to view this saved order confirmation.');
      return () => { active = false; };
    }
    onAnnounce('Loading saved order confirmation…');
    api<SavedOrderConfirmation>(`/api/dashboard/orders/${encodeURIComponent(requestedOrderId)}`)
      .then(order => {
        if (!active) return;
        const savedConfirmation = confirmationFromSavedOrder(order);
        setConfirmation(savedConfirmation);
        if (order.displayEstimate) {
          setDisplayEstimate({
            displayCurrency: order.displayEstimate.currency,
            displayMerchandiseMinor: order.displayEstimate.itemTotalMinor,
            displayShippingMinor: order.displayEstimate.shippingTotalMinor,
            displayTotalMinor: order.displayEstimate.totalMinor,
            chargeCurrency: order.currency,
            chargeMerchandiseMinor: savedConfirmation.itemSubtotal,
            chargeShippingMinor: savedConfirmation.shippingTotal,
            rates: order.displayEstimate.rateSnapshots.map(rate => ({ ...rate, purpose: 'DISPLAY_ESTIMATE_ONLY' })),
            note: `Estimate only, restored from reference-rate snapshots saved with this order. USD order total: ${money(order.totalMinor, order.currency)}; payment status: ${savedConfirmation.paymentStatus}.`
          });
        } else {
          setDisplayEstimate(null);
        }
        setResult('');
        onAnnounce('');
      })
      .catch(error => {
        if (!active) return;
        setResult(`Your order is saved, but its confirmation details could not be loaded. ${(error as Error).message}`);
        onAnnounce('');
      });
    return () => { active = false; };
  }, [requestedOrderId, user?.id, onAnnounce]);

  const calculateShipping = async (selections = selectedServices) => {
    if (!form.line1.trim() || !form.city.trim() || !form.region.trim() || !form.postalCode.trim() || !form.country.trim()) { setResult('Enter your delivery address before calculating shipping.'); return; }
    setQuotePending(true); setShippingQuote(null); setResult('');
    try {
      const quote = await api<ShippingQuote>('/api/shipping/quote', { method: 'POST', body: JSON.stringify({ address, serviceSelections: selections }) });
      const savedSelections = Object.fromEntries(quote.shipments.map(shipment => [shipment.sellerId, shipment.selected.serviceId]));
      setSelectedServices(savedSelections); setShippingQuote(quote);
    } catch (error) { setResult((error as Error).message); }
    finally { setQuotePending(false); }
  };

  const updateQuantity = async (item: CartItem, quantity: number) => {
    if (pendingProductId) return;
    setPendingProductId(item.product.id);
    try {
      await api<void>(`/api/cart/items/${encodeURIComponent(item.product.id)}`, { method: 'PATCH', body: JSON.stringify({ quantity }) });
      await onChange();
      setShippingQuote(null);
      setResult('');
      const itemName = item.variant ? `${item.product.name} - ${item.variant.name}` : item.product.name;
      onAnnounce(quantity === 0 ? `${itemName} removed from your cart.` : 'Cart updated.');
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setPendingProductId(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) { setResult('Sign in before checkout.'); return; }
    try {
      const displayCurrencyAllowed = Boolean(currencyOptions?.displayCurrencies.some(currency => currency.code === displayCurrency));
      const r = await api<{ orderId: string; orderNumber: string; totalMinor: number; shippingTotalMinor: number; currency: string; paymentStatus: string; shippingBreakdown: OrderConfirmation['shipments'] }>('/api/orders/checkout', { method: 'POST', body: JSON.stringify({ buyerName: form.buyerName, buyerEmail: form.buyerEmail, address, method: form.method, ...(displayCurrencyAllowed ? { displayCurrency } : {}), shippingQuoteToken: shippingQuote?.quoteToken ?? undefined }) });
      window.history.replaceState({}, '', `/checkout?order=${encodeURIComponent(r.orderId)}`);
      setConfirmation({ orderNumber: r.orderNumber, total: r.totalMinor, itemSubtotal: r.totalMinor - r.shippingTotalMinor, shippingTotal: r.shippingTotalMinor, currency: r.currency, method: form.method, paymentStatus: r.paymentStatus, shipments: r.shippingBreakdown, displayEstimate: null });
      setDisplayEstimate(null);
      setResult('');
      onClearMessage();
      await onChange();
    } catch (e) { setResult((e as Error).message); }
  };

  const summaryTotal = confirmation?.total ?? shippingQuote?.totalMinor ?? total;
  const summaryCurrency = confirmation?.currency ?? cart.items[0]?.variant?.currency ?? cart.items[0]?.product.currency ?? 'USD';
  return <section className="checkout"><div><p className="eyebrow">Checkout</p><h1>Complete your order</h1>{confirmation && <div className="notice orderConfirmation" role="status" aria-live="polite"><strong>Order confirmed</strong><p>Your order is confirmed and awaiting collection.</p><dl><div><dt>Order reference</dt><dd>{confirmation.orderNumber}</dd></div><div><dt>Total</dt><dd>{money(confirmation.total, confirmation.currency)}</dd></div><div><dt>Payment method</dt><dd>{confirmation.method === 'COD' ? 'COD (Cash on delivery)' : confirmation.method}</dd></div><div><dt>Status</dt><dd>{confirmation.paymentStatus === 'PENDING' ? 'Pending' : confirmation.paymentStatus}</dd></div></dl></div>}{cart.items.length === 0 ? <div className="empty">Your cart is empty.</div> : <form onSubmit={submit}><label>Name<input required value={form.buyerName} onChange={e => setForm({ ...form, buyerName: e.target.value })} /></label><label>Email<input required type="email" value={form.buyerEmail} onChange={e => setForm({ ...form, buyerEmail: e.target.value })} /></label><div className="two"><label>Address<input required value={form.line1} onChange={e => updateAddress('line1', e.target.value)} /></label><label>City<input required value={form.city} onChange={e => updateAddress('city', e.target.value)} /></label></div><div className="two"><label>Region<input required value={form.region} onChange={e => updateAddress('region', e.target.value)} /></label><label>Postal code<input required value={form.postalCode} onChange={e => updateAddress('postalCode', e.target.value)} /></label></div><label>Country code<input required minLength={2} maxLength={2} value={form.country} onChange={e => updateAddress('country', e.target.value.toUpperCase())} /></label>{requiresShipping && <button type="button" onClick={() => void calculateShipping()} disabled={quotePending}>{quotePending ? 'Calculating shipping…' : shippingQuote ? 'Recalculate shipping' : 'Calculate shipping'}</button>}{currencyOptions && <label>Display estimate (not payment currency)<select value={displayCurrency} onChange={event => setDisplayCurrency(event.target.value)}>{currencyOptions.displayCurrencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>}{currencyOptions?.error && <p className="muted" role="status">{currencyOptions.error}</p>}<label>Payment method<select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>{methods.map(m => <option key={m.method} value={m.method}>{m.method}</option>)}</select></label><button className="primary" disabled={quotePending || (requiresShipping && !shippingQuote) || Boolean(currencyOptions && !currencyOptions.checkoutCompatible)}>Place order</button>{requiresShipping && !shippingQuote && <p className="muted">Calculate a covered shipping option for each Store before placing your order.</p>}{result && <p className="notice" role="alert">{result}</p>}</form>}</div><aside className="summary"><h2>Summary</h2>{cart.items.map(item => { const name = item.variant ? `${item.product.name} — ${item.variant.name}` : item.product.name; const available = itemStock(item); const pending = pendingProductId === item.product.id; return <div className="cartLine" key={item.product.id}><div className="cartLineInfo"><span>{name}</span><small>{money(itemPrice(item), item.variant?.currency ?? item.product.currency)} each · {available} available</small></div><div className="cartControls" aria-label={`Quantity controls for ${name}`}><button type="button" aria-label={`Decrease quantity for ${name}`} disabled={pending || item.quantity <= 1} onClick={() => void updateQuantity(item, item.quantity - 1)}>−</button><output aria-live="polite">{pending ? 'Saving…' : item.quantity}</output><button type="button" aria-label={`Increase quantity for ${name}`} disabled={pending || item.quantity >= Math.min(available, 99)} onClick={() => void updateQuantity(item, item.quantity + 1)}>+</button><button type="button" className="removeButton" aria-label={`Remove ${name} from cart`} disabled={pending} onClick={() => void updateQuantity(item, 0)}>Remove</button></div><strong>{money(itemPrice(item) * item.quantity, item.variant?.currency ?? item.product.currency)}</strong></div>; })}<hr /><p>Merchandise subtotal<strong>{money(confirmation?.itemSubtotal ?? total, summaryCurrency)}</strong></p>{confirmation ? confirmation.shipments.map(shipment => <p key={`${shipment.storeName}-${shipment.serviceName}`}>{shipment.storeName} · {shipment.serviceName}<strong>{money(shipment.shippingMinor, confirmation.currency)}</strong></p>) : shippingQuote?.shipments.map(shipment => <div className="shippingSummary" key={shipment.sellerId}><h3>{shipment.storeName}</h3><label>Delivery service<select aria-label={`Delivery service for ${shipment.storeName}`} value={shipment.selected.serviceId} onChange={event => { const next = { ...selectedServices, [shipment.sellerId]: event.target.value }; setSelectedServices(next); void calculateShipping(next); }}>{shipment.options.map(option => <option key={option.serviceId} value={option.serviceId}>{option.serviceName} · {money(option.shippingMinor, option.currency)}{option.estimatedMinDays !== null ? ` · ${option.estimatedMinDays}${option.estimatedMaxDays !== null && option.estimatedMaxDays !== option.estimatedMinDays ? `–${option.estimatedMaxDays}` : ''} days` : ''}</option>)}</select></label><p>Service fee<strong>{money(shipment.selected.feeMinor, shipment.selected.currency)}</strong></p>{shipment.selected.discount && <p>Shipping discount — {shipment.selected.discount.name}<strong>−{money(shipment.selected.discountMinor, shipment.selected.currency)}</strong></p>}<p>Shipment shipping<strong>{money(shipment.selected.shippingMinor, shipment.selected.currency)}</strong></p></div>)}<hr /><p className="total">{requiresShipping && !shippingQuote && !confirmation ? 'Merchandise subtotal' : 'Order total'}<strong>{money(summaryTotal, summaryCurrency)}</strong></p>{displayEstimate && <div className="displayEstimate" aria-live="polite"><strong>Estimated display total: {money(displayEstimate.displayTotalMinor, displayEstimate.displayCurrency)}</strong><small>{displayEstimate.note}</small>{displayEstimate.rates[0] && <small>Rate observed {displayEstimate.rates[0].sourceDate}; fetched {new Date(displayEstimate.rates[0].fetchedAt).toLocaleString()}.</small>}</div>}{estimateMessage && <p className="muted" role="status">{estimateMessage}</p>}{requiresShipping && !shippingQuote && !confirmation ? <small>Final charge total appears after shipping is calculated for every Store.</small> : <small>Actual order charge remains {summaryCurrency}. No hidden tax is added.</small>}{result && !cart.items.length && <p className="notice" role="alert">{result}</p>}</aside></section>;
}

function Admin() { const [settings, setSettings] = useState<{ marketplace: { multiVendorEnabled: boolean } | null; paymentMethods: { method: string; enabled: boolean }[] } | null>(null); const [sellers, setSellers] = useState<{ id: string; status: string; user: { email: string }; store?: { name: string } }[]>([]); const [message, setMessage] = useState(''); const load = async () => { setSettings(await api('/api/admin/settings')); setSellers(await api('/api/admin/sellers')); }; useEffect(() => { load().catch(e => setMessage(e.message)); }, []); const toggle = async (body: object) => { try { await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }); await load(); } catch (e) { setMessage((e as Error).message); } }; return <><section className="page"><p className="eyebrow">Control room</p><h1>Marketplace settings</h1>{message && <p className="notice">{message}</p>}<div className="settings">{settings && <><div className="setting"><div><strong>Multi-vendor mode</strong><p>When off, seller records remain preserved but new seller sales and applications are blocked.</p></div><button onClick={() => toggle({ multiVendorEnabled: !settings.marketplace?.multiVendorEnabled })}>{settings.marketplace?.multiVendorEnabled ? 'Enabled' : 'Disabled'}</button></div>{settings.paymentMethods.map(m => <div className="setting" key={m.method}><div><strong>{m.method}</strong><p>Server-side activation control for new transactions.</p></div><button onClick={() => toggle({ method: m.method, enabled: !m.enabled })}>{m.enabled ? 'Enabled' : 'Disabled'}</button></div>)}</>}</div><h2>Seller review</h2><div className="table">{sellers.map(s => <div className="row" key={s.id}><span>{s.store?.name ?? 'Application'} · {s.user.email}</span><span>{s.status}</span><select value={s.status} onChange={async e => { await api(`/api/admin/sellers/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); await load(); }}><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>SUSPENDED</option></select></div>)}</div></section><AffiliateAdmin /></>; }

function POS({ products }: { products: Product[] }) { const [items, setItems] = useState<Record<string, number>>({}); const [message, setMessage] = useState(''); const sale = async () => { try { const result = await api<{ receiptUrl: string }>('/api/pos/sales', { method: 'POST', body: JSON.stringify({ register: 'browser-1', items: Object.entries(items).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity })) }) }); setMessage(`Sale created. Receipt: ${result.receiptUrl}`); setItems({}); } catch (e) { setMessage((e as Error).message); } }; return <section className="page"><p className="eyebrow">Seller-scoped cash register</p><h1>POS</h1><p className="muted">This is browser cash POS only. It does not process card-present payments or connect to hardware.</p><div className="grid posGrid">{products.map(p => <article className="card compact" key={p.id}><div><h2>{p.name}</h2><p>{money(p.priceMinor)} · {p.availableStock} available</p></div><input aria-label={`Quantity for ${p.name}`} type="number" min="0" max={p.availableStock} value={items[p.id] ?? 0} onChange={e => setItems({ ...items, [p.id]: Number(e.target.value) })} /></article>)}</div><button className="primary" onClick={sale}>Complete cash sale</button>{message && <p className="notice">{message}</p>}</section>; }

function PageRouter() { const storeContentPath = window.location.pathname === '/seller/content'; const storeGrowthPath = window.location.pathname === '/seller/growth'; const storePath = window.location.pathname.match(/^\/store\/([^/]+)\/?$/); const productPath = window.location.pathname.match(/^\/products\/([^/]+)\/?$/); return storeContentPath ? <SellerStoreContent /> : storeGrowthPath ? <SellerStoreGrowth /> : window.location.pathname === '/seller/currency' ? <SellerStoreCurrency /> : window.location.pathname === '/seller/commissions' ? <SellerCommissionStatement /> : window.location.pathname === '/admin/currencies' ? <AdminCurrencyCommission section="currencies" /> : window.location.pathname === '/admin/commissions' ? <AdminCurrencyCommission section="commissions" /> : window.location.pathname === '/dashboard' ? <Dashboard /> : window.location.pathname === '/settings' ? <Settings /> : window.location.pathname === '/wallet' ? <Wallet /> : window.location.pathname === '/club-coins' ? <ClubCoins /> : window.location.pathname === '/admin/wallet' ? <AdminWallet /> : window.location.pathname.startsWith('/admin/content') ? <ContentAdmin /> : window.location.pathname.startsWith('/admin/platform') ? <PlatformAdmin /> : window.location.pathname.startsWith('/seller/plan') ? <SellerStorePlan /> : window.location.pathname.startsWith('/seller/platform') ? <SellerPlatform /> : window.location.pathname.startsWith('/affiliate') ? <AffiliateDashboard /> : storePath ? <Storefront slug={decodeURIComponent(storePath[1])} /> : productPath ? <ProductPage id={decodeURIComponent(productPath[1])} /> : <App />; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><SessionProvider><AppShell><PageRouter /></AppShell></SessionProvider></React.StrictMode>);
