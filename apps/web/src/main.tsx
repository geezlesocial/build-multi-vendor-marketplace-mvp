import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './DashboardPolish.css';
import './currency-location.css';
import './store-themes.css';
import './checkout-discount.css';
import { ContentAdmin } from './ContentAdmin.js';
import { AffiliateAdmin } from './AffiliateAdmin.js';
import { AffiliateDashboard } from './AffiliateDashboard.js';
import { SiteChromeBuilder } from './SiteChromeBuilder.js';
import { SellerStorePlan } from './SellerStorePlan.js';
import { SellerStoreContent } from './SellerStoreContent.js';
import { SellerStoreGrowth } from './SellerStoreGrowth.js';
import { SellerCommissionStatement, SellerStoreCurrency } from './SellerStoreCurrency.js';
import { AdminCurrencyCommission } from './AdminCurrencyCommission.js';
import { StoreEmailAction } from './StoreEmailAction.js';
import { EmailVerificationAction } from './EmailVerificationAction.js';
import { Dashboard } from './Dashboard.js';
import { MarketplaceHome } from './MarketplaceHome.js';
import { MarketplaceCategory } from './MarketplaceCategory.js';
import { Favorites } from './Favorites.js';
import { ProductPage } from './ProductPage.js';
import { JimaKnowledgeArticle } from './JimaKnowledgeArticle.js';
import { Settings } from './Settings.js';
import { AdminWallet } from './AdminWallet.js';
import { MarketplaceAds } from './MarketplaceAds.js';
import { ClubCoins, Wallet } from './Wallet.js';
import { AppShell } from './AppShell.js';
import { SessionProvider, useSession, type SessionUser } from './session.js';
import { formatMinor } from './money.js';
import { LiveEmbedPage, LivePublicPage } from './LivePublicPage.js';

const PlatformAdmin = React.lazy(() => import('./PlatformAdmin.js').then(module => ({ default: module.PlatformAdmin })));
const SellerPlatform = React.lazy(() => import('./SellerPlatform.js').then(module => ({ default: module.SellerPlatform })));
const Storefront = React.lazy(() => import('./Storefront.js').then(module => ({ default: module.Storefront })));
const StoreThemeStudio = React.lazy(() => import('./StoreThemeStudio.js').then(module => ({ default: module.StoreThemeStudio })));

type User = SessionUser;
type Product = { id: string; name: string; description: string; priceMinor: number; salePriceMinor?: number | null; currency: string; availableStock: number; wholesaleEnabled?: boolean; wholesaleMinQuantity?: number | null; wholesaleMaxQuantity?: number | null; sellerId?: string | null; seller?: { store?: { name: string } }; category?: { name: string }; productType?: { id: string; name: string; requiresShipping: boolean } };
type CartVariant = { id: string; name: string; priceMinor: number; currency: string; stock: number };
type CartItem = { product: Product; quantity: number; variant?: CartVariant | null };
type CartState = { items: CartItem[] };
type CartApiItem = { product: Product & { inventory?: { quantity: number } | null }; quantity: number; variant?: CartVariant | null };
type Settings = { multiVendorEnabled: boolean; paymentMethods: { method: string; enabled: boolean }[]; liveShopping?: { enabled: boolean; deploymentGate: boolean; reason: string } };

const money = (minor: number, currency = 'USD') => formatMinor(minor, currency);
async function api<T>(path: string, options: RequestInit = {}): Promise<T> { const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1]; const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); } return response.status === 204 ? (undefined as T) : response.json(); }
const isLiveCheckoutEmbed = () => window.location.pathname === '/checkout'
  && new URLSearchParams(window.location.search).get('source') === 'live-shopping'
  && new URLSearchParams(window.location.search).get('embed') === '1';
const normalizeCart = (value: { items?: CartApiItem[] }): CartState => ({ items: (value.items ?? []).map(item => ({ ...item, product: { ...item.product, availableStock: item.variant?.stock ?? item.product.inventory?.quantity ?? item.product.availableStock ?? 0 } })) });
const itemPrice = (item: CartItem) => item.variant?.priceMinor ?? item.product.salePriceMinor ?? item.product.priceMinor;
const itemStock = (item: CartItem) => item.variant?.stock ?? item.product.availableStock;

function App() {
  const { user, setUser } = useSession();
  const [settings, setSettings] = useState<Settings>({ multiVendorEnabled: true, paymentMethods: [], liveShopping: { enabled: false, deploymentGate: false, reason: 'Live shopping is not configured.' } });
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartState>({ items: [] });
  const [view, setView] = useState<'home' | 'checkout' | 'login' | 'dashboard' | 'pos' | 'live' | 'affiliate'>(() => window.location.pathname === '/checkout' ? 'checkout' : window.location.pathname === '/pos' ? 'pos' : new URLSearchParams(window.location.search).has('auth') ? 'login' : 'home');
  const [message, setMessage] = useState('');

  const loadCart = async () => { const next = normalizeCart(await api<{ items: CartApiItem[] }>('/api/cart')); setCart(next); window.dispatchEvent(new Event('marketplace:cart-changed')); };
  useEffect(() => {
    let active = true;
    Promise.all([api<Settings>('/api/settings/public'), api<{ items: Product[] }>('/api/products?q=')])
      .then(([publicSettings, catalog]) => {
        if (!active) return;
        setSettings(publicSettings);
        setProducts(catalog.items);
      })
      .catch(error => { if (active) setMessage((error as Error).message); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (user) void loadCart().catch(e => setMessage(e.message)); else setCart({ items: [] }); }, [user?.id]);
  const cartTotal = useMemo(() => cart.items.reduce((sum, item) => sum + itemPrice(item) * item.quantity, 0), [cart]);
  const add = async (productId: string, quantity = 1) => { if (!user) { setView('login'); setMessage('Sign in to add items to your cart.'); return; } try { await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId, quantity }) }); setMessage('Added to cart'); await loadCart(); } catch (e) { setMessage((e as Error).message); } };
  const login = async (form: FormData) => { try { const result = await api<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); setUser(result.user); if (!result.user.onboardingCompletedAt) { window.location.assign('/onboarding'); return; } setCart(normalizeCart(await api<{ items: CartApiItem[] }>('/api/cart'))); setView('home'); setMessage(''); } catch (e) { setMessage((e as Error).message); } };
  const register = async (form: FormData) => { try { const result = await api<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); setUser(result.user); setCart({ items: [] }); window.location.assign(result.user.onboardingCompletedAt ? '/' : '/onboarding'); } catch (e) { setMessage((e as Error).message); } };

  return <>
    {message && <div className="notice shellNotice" role="status" aria-live="polite">{message}<button aria-label="Dismiss message" onClick={() => setMessage('')}>×</button></div>}
    {view === 'home' && <MarketplaceHome user={user} onAdd={add} onSignIn={() => { setView('login'); setMessage('Sign in to add items to your cart.'); }} />}
    {view === 'login' && <Login onSubmit={login} onRegister={register} />}
    {view === 'checkout' && <Checkout cart={cart} total={cartTotal} settings={settings} user={user} onChange={loadCart} onClearMessage={() => setMessage('')} onAnnounce={setMessage} />}
    {view === 'dashboard' && <Admin />}
    {view === 'pos' && <POS products={products} />}
  </>;
}


type SocialProvider = { id: string; label: string; logoUrl: string | null };
type AuthPresentation = { signInHeading: string; signInText: string; signUpHeading: string; signUpText: string; logoUrl: string | null; layout: 'CENTERED' | 'SPLIT' | 'EDITORIAL'; motion: 'NONE' | 'FADE' | 'SLIDE'; accentColor: string };
const defaultAuthPresentation: AuthPresentation = { signInHeading: 'Sign in', signInText: 'Welcome back. Sign in to continue.', signUpHeading: 'Create account', signUpText: 'Join the marketplace and discover independent stores.', logoUrl: null, layout: 'CENTERED', motion: 'FADE', accentColor: '#315d47' };
const socialProviderGlyph: Record<string, string> = { GOOGLE: 'G', LINKEDIN: 'in', FACEBOOK: 'f', X: '𝕏', SCROLITH: 'S' };
const socialErrorText: Record<string, string> = { provider_disabled: 'That sign-in option is not available right now.', provider_error: 'The identity provider could not complete sign-in. Please try again.', email_required: 'This provider did not return an email address. Enable email access for its app, then try again.', email_conflict: 'An account already uses this email. Sign in with that account first; social account linking is not available yet.', account_unavailable: 'This account is not currently available. Contact platform support.', try_again: 'That sign-in attempt expired or could not be verified. Please start again.' };

function Login({ onSubmit, onRegister }: { onSubmit: (data: FormData) => void; onRegister: (data: FormData) => void }) {
  const [registerMode, setRegisterMode] = useState(new URLSearchParams(window.location.search).get('auth') === 'register');
  const [showPassword, setShowPassword] = useState(false);
  const [providers, setProviders] = useState<SocialProvider[]>([]);
  const [presentation, setPresentation] = useState(defaultAuthPresentation);
  const [socialMessage, setSocialMessage] = useState('');
  useEffect(() => {
    void Promise.all([
      api<{ providers: SocialProvider[] }>('/api/auth/social/providers').then(result => setProviders(result.providers)),
      api<AuthPresentation>('/api/auth/presentation').then(setPresentation)
    ]).catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    if (params.get('social') === 'connected') setSocialMessage('You are signed in with your social account.');
    else if (params.get('social') === 'error') setSocialMessage(socialErrorText[params.get('social_error') ?? ''] ?? socialErrorText.try_again);
  }, []);
  const accent = { '--auth-accent': presentation.accentColor } as React.CSSProperties;
  const heading = registerMode ? presentation.signUpHeading : presentation.signInHeading;
  const description = registerMode ? presentation.signUpText : presentation.signInText;
  return <section className={`authPage authLayout-${presentation.layout.toLowerCase()} authMotion-${presentation.motion.toLowerCase()}`} style={accent}>
    {presentation.layout === 'SPLIT' && <aside className="authVisual" aria-hidden="true"><span className="authVisualOrb" /><p>Independent stores.<br />A marketplace built around you.</p></aside>}
    <div className="authPanel">
      {presentation.logoUrl && <img className="authLogo" src={presentation.logoUrl} alt="Marketplace logo" />}
      <p className="eyebrow">Account access</p><h1>{heading}</h1>{description && <p className="authDescription">{description}</p>}
      {socialMessage && <p className={new URLSearchParams(window.location.search).get('social') === 'error' ? 'notice' : 'authSuccess'} role="status">{socialMessage}</p>}
      <form onSubmit={event => { event.preventDefault(); (registerMode ? onRegister : onSubmit)(new FormData(event.currentTarget)); }}>
        {registerMode && <label>Name<input name="name" autoComplete="name" required minLength={2} maxLength={100} /></label>}
        <label>Email<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>
        <label htmlFor="auth-password">Password</label>
        <div className="authPasswordField">
          <input id="auth-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={registerMode ? 'new-password' : 'current-password'} placeholder={registerMode ? 'Choose a password' : 'Enter your password'} required minLength={registerMode ? 10 : 1} maxLength={128} />
          <button className="authPasswordToggle" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} title={showPassword ? 'Hide password' : 'Show password'}>
            {showPassword ? 'Hide' : 'Show'}
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {showPassword ? <><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 002.8 2.8" /><path d="M9.9 5.2A11.3 11.3 0 0112 5c6.4 0 10 7 10 7a15.6 15.6 0 01-4 4.8" /><path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.6 7 10 7a10.8 10.8 0 003.2-.5" /></> : <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>}
            </svg>
          </button>
        </div>
        {registerMode && <p className="muted">New accounts start as buyers. Seller access remains subject to the existing approval flow.</p>}
        <button className="primary">{registerMode ? 'Create account' : 'Sign in'}</button>
      </form>
      <button className="authModeToggle" type="button" onClick={() => { setRegisterMode(value => { const next = !value; const url = new URL(window.location.href); url.searchParams.set('auth', next ? 'register' : 'login'); window.history.replaceState({}, '', url); return next; }); setShowPassword(false); }}>{registerMode ? 'Already have an account? Sign in' : 'Need an account? Create one'}</button>
      {providers.length > 0 && <div className="authSocial"><div className="authDivider"><span>Or continue with</span></div><div className="authSocialGrid">{providers.map(provider => <a className="authSocialButton" key={provider.id} href={`/api/auth/social/${provider.id.toLowerCase()}/start`}><span className={`authProviderGlyph authProvider-${provider.id.toLowerCase()}`}>{provider.logoUrl ? <img src={provider.logoUrl} alt="" /> : socialProviderGlyph[provider.id] ?? provider.label.slice(0, 1)}</span><span>Continue with {provider.label}</span></a>)}</div></div>}
      {!registerMode && <p className="muted authDemoHint">Local demo accounts are documented in the README. Change all demo credentials before any staging use.</p>}
    </div>
  </section>;
}

type ShippingChoice = { serviceId: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number; currency: string; estimatedMinDays: number | null; estimatedMaxDays: number | null; supportsCod: boolean; discount: { name: string; type: string; amountMinor: number } | null };
type ShippingQuote = { currency: string; itemSubtotalMinor: number; shippingTotalMinor: number; totalMinor: number; quoteToken: string | null; shipments: { sellerId: string; storeName: string; options: ShippingChoice[]; selected: ShippingChoice }[] };
type OrderDisplayEstimate = { currency: string; itemTotalMinor: number; shippingTotalMinor: number; totalMinor: number; purpose: 'DISPLAY_ESTIMATE_ONLY'; rateSnapshots: { provider: string; sourceDate: string; fetchedAt: string; rounding: string }[] };
type OrderConfirmation = { orderNumber: string; total: number; itemSubtotal: number; discountMinor: number; discountCode?: string | null; shippingTotal: number; currency: string; method: string; paymentStatus: string; shipments: { storeName: string; serviceName: string; feeMinor: number; discountMinor: number; shippingMinor: number }[]; displayEstimate: OrderDisplayEstimate | null };
type SavedOrderConfirmation = { orderNumber: string; totalMinor: number; currency: string; payment: { method: string; status: string } | null; displayEstimate: OrderDisplayEstimate | null; sellerOrders: { discountMinor?: number; discountCode?: string | null; shippingSnapshotJson: { serviceName?: unknown; feeMinor?: unknown; discountMinor?: unknown; shippingMinor?: unknown } | null; seller: { store: { name: string } } | null }[] };
type CurrencyOptions = { checkoutCurrency: string; checkoutCompatible: boolean; displayCurrencies: { code: string; name: string; symbol: string; minorUnitExponent: number }[]; paymentCurrencies: { method: string; code: string; name: string; symbol: string; minorUnitExponent: number }[]; error: string | null };
type CartEstimate = { displayCurrency: string; complete: boolean; incompleteReason: string | null; displayMerchandiseMinor: number; displayShippingMinor: number; displayTotalMinor: number; chargeCurrency: string; chargeMerchandiseMinor: number; discountMinor?: number; chargeShippingMinor: number; items: { cartItemId: string; productId: string; quantity: number; sourceUnitAmountMinor: number; sourceAmountMinor: number; sourceCurrency: string; estimatedUnitAmountMinor: number; estimatedAmountMinor: number; targetCurrency: string; rate: string; provider: string; sourceDate: string; fetchedAt: string; purpose: string }[]; rates: { provider: string; sourceDate: string; fetchedAt: string; purpose: string }[]; note: string };

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
  const discountMinor = order.sellerOrders.reduce((sum, sellerOrder) => sum + (sellerOrder.discountMinor ?? 0), 0);
  const discountCode = order.sellerOrders.find(sellerOrder => sellerOrder.discountCode)?.discountCode;
  return { orderNumber: order.orderNumber, total: order.totalMinor, itemSubtotal: order.totalMinor - shippingTotal + discountMinor, discountMinor, discountCode, shippingTotal, currency: order.currency, method, paymentStatus, shipments, displayEstimate: order.displayEstimate };
}

function Checkout({ cart, total, settings, user, onChange, onClearMessage, onAnnounce }: { cart: CartState; total: number; settings: Settings; user: User | null; onChange: () => Promise<void>; onClearMessage: () => void; onAnnounce: (message: string) => void }) {
  const requestedOrderId = new URLSearchParams(window.location.search).get('order');
  const [form, setForm] = useState({ buyerName: user?.name ?? '', buyerEmail: user?.email ?? '', line1: '', city: '', region: '', postalCode: '', country: 'US', method: 'COD' });
  const [paymentMethodManuallySelected, setPaymentMethodManuallySelected] = useState(false);
  const [result, setResult] = useState('');
  const [paymentRedirectUrl, setPaymentRedirectUrl] = useState('');
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  const [shippingQuote, setShippingQuote] = useState<ShippingQuote | null>(null);
  const [selectedServices, setSelectedServices] = useState<Record<string, string>>({});
  const [quotePending, setQuotePending] = useState(false);
  const [currencyOptions, setCurrencyOptions] = useState<CurrencyOptions | null>(null);
  const [displayCurrency, setDisplayCurrency] = useState('');
  const [displayEstimate, setDisplayEstimate] = useState<CartEstimate | null>(null);
  const [providerPaymentEstimate, setProviderPaymentEstimate] = useState<CartEstimate | null>(null);
  const [providerPaymentEstimateMessage, setProviderPaymentEstimateMessage] = useState('');
  const [estimateMessage, setEstimateMessage] = useState('');
  const [discountInput, setDiscountInput] = useState('');
  const [appliedDiscount, setAppliedDiscount] = useState<{ code: string; name: string; currency: string; discountMinor: number; eligibleSubtotalMinor: number } | null>(null);
  const [discountPending, setDiscountPending] = useState(false);
  const nonCodMethods = useMemo(() => settings.paymentMethods.filter(x => x.enabled && ['STRIPE', 'PAYPAL', 'PAYMONGO', 'PAYSTACK'].includes(x.method) && (!['PAYMONGO', 'PAYSTACK'].includes(x.method) || currencyOptions?.paymentCurrencies.some(currency => currency.method === x.method))), [settings.paymentMethods, currencyOptions]);
  const codMethodEnabled = settings.paymentMethods.some(x => x.method === 'COD' && x.enabled);
  const codUnavailableMessage = 'COD is available only for physical seller items after calculating delivery and selecting a COD-enabled courier service.';
  const address = { line1: form.line1, city: form.city, region: form.region, postalCode: form.postalCode, country: form.country };
  const requiresShipping = cart.items.some(item => item.product.productType?.requiresShipping ?? Boolean(item.product.seller));
  const physicalSellerCart = cart.items.length > 0 && cart.items.every(item => item.product.productType?.requiresShipping === true && Boolean(item.product.sellerId));
  const expectedShipmentCount = new Set(cart.items.map(item => item.product.sellerId).filter((sellerId): sellerId is string => Boolean(sellerId))).size;
  const codEligible = physicalSellerCart && Boolean(shippingQuote) && shippingQuote!.shipments.length === expectedShipmentCount && shippingQuote!.shipments.length > 0 && shippingQuote!.shipments.every(shipment => shipment.selected.supportsCod);
  const methods = codEligible && codMethodEnabled ? [...nonCodMethods, { method: 'COD', enabled: true }] : nonCodMethods;
  const updateAddress = (key: 'line1' | 'city' | 'region' | 'postalCode' | 'country', value: string) => { setForm(current => ({ ...current, [key]: value })); setShippingQuote(null); setSelectedServices({}); };

  useEffect(() => {
    if (confirmation || cart.items.length === 0) return;
    if (form.method === 'COD' && (!codMethodEnabled || !codEligible) && nonCodMethods.length) {
      setForm(current => current.method === 'COD' ? { ...current, method: nonCodMethods[0]!.method } : current);
    } else if (form.method === 'COD' && !codEligible && !nonCodMethods.length) {
      setResult(codMethodEnabled ? codUnavailableMessage : 'Cash on delivery is disabled by the marketplace.');
    } else if (codEligible && result === codUnavailableMessage) {
      setResult('');
    }
  }, [confirmation, cart.items.length, form.method, codMethodEnabled, codEligible, nonCodMethods, result, codUnavailableMessage]);

  const cartKey = cart.items.map(item => `${item.product.id}:${item.variant?.id ?? ''}:${item.quantity}`).sort().join('|');
  useEffect(() => { setAppliedDiscount(null); setDiscountInput(''); }, [cartKey]);
  useEffect(() => {
    let active = true;
    if (!user) { setCurrencyOptions(null); return; }
    api<CurrencyOptions>('/api/currency/cart-options').then(options => {
      if (!active) return;
      setCurrencyOptions(options);
      setEstimateMessage(options.error ?? '');
      void api<{ preference: { displayCurrency: string } }>('/api/account/preferences').then(preferences => {
        if (!active) return;
        const available = options.displayCurrencies.map(currency => currency.code);
        setDisplayCurrency(current => available.includes(current) ? current : available.includes(preferences.preference.displayCurrency) ? preferences.preference.displayCurrency : available[0] ?? '');
      }).catch(() => {
        if (active) setDisplayCurrency(current => options.displayCurrencies.some(currency => currency.code === current) ? current : options.displayCurrencies[0]?.code ?? '');
      });
    }).catch(error => { if (active) setEstimateMessage((error as Error).message); });
    return () => { active = false; };
  }, [user?.id, cartKey]);

  useEffect(() => {
    if (requestedOrderId) return;
    let active = true;
    setDisplayEstimate(null);
    if (!displayCurrency || !cart.items.length || !currencyOptions?.displayCurrencies.some(currency => currency.code === displayCurrency)) return;
    setEstimateMessage('Updating your currency estimate…');
    const hasShippingQuote = requiresShipping && Boolean(shippingQuote?.quoteToken);
    api<CartEstimate>('/api/currency/cart-estimate', { method: 'POST', body: JSON.stringify({ displayCurrency, ...(appliedDiscount ? { discountCode: appliedDiscount.code } : {}), ...(hasShippingQuote ? { address, shippingQuoteToken: shippingQuote!.quoteToken } : {}) }) })
      .then(estimate => { if (active) { setDisplayEstimate(estimate); setEstimateMessage(estimate.incompleteReason ?? ''); } })
      .catch(error => { if (active) setEstimateMessage((error as Error).message); });
    return () => { active = false; };
  }, [requestedOrderId, displayCurrency, currencyOptions, cartKey, shippingQuote?.quoteToken, form.line1, form.city, form.region, form.postalCode, form.country, appliedDiscount?.code]);

  const selectedProviderCurrency = currencyOptions?.paymentCurrencies.find(currency => currency.method === form.method);
  useEffect(() => {
    if (requestedOrderId || !selectedProviderCurrency || !cart.items.length) { setProviderPaymentEstimate(null); setProviderPaymentEstimateMessage(''); return; }
    let active = true;
    setProviderPaymentEstimate(null);
    setProviderPaymentEstimateMessage('Refreshing payment conversion…');
    const hasShippingQuote = requiresShipping && Boolean(shippingQuote?.quoteToken);
    api<CartEstimate>('/api/currency/cart-estimate', { method: 'POST', body: JSON.stringify({ displayCurrency: selectedProviderCurrency.code, ...(appliedDiscount ? { discountCode: appliedDiscount.code } : {}), ...(hasShippingQuote ? { address, shippingQuoteToken: shippingQuote!.quoteToken } : {}) }) })
      .then(estimate => { if (active) { setProviderPaymentEstimate(estimate); setProviderPaymentEstimateMessage(estimate.incompleteReason ?? ''); } })
      .catch(error => { if (active) setProviderPaymentEstimateMessage((error as Error).message); });
    return () => { active = false; };
  }, [requestedOrderId, selectedProviderCurrency?.code, form.method, cartKey, shippingQuote?.quoteToken, form.line1, form.city, form.region, form.postalCode, form.country, appliedDiscount?.code]);

  useEffect(() => {
    if (paymentMethodManuallySelected) return;
    const preferred = form.country === 'PH' ? 'PAYMONGO' : form.country === 'NG' ? 'PAYSTACK' : null;
    if (preferred && methods.some(method => method.method === preferred) && form.method !== preferred) setForm(current => ({ ...current, method: preferred }));
  }, [form.country, form.method, methods, paymentMethodManuallySelected]);

  useEffect(() => {
    if (!requestedOrderId) return;
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    if (!user?.id) {
      setResult('Sign in to view this saved order confirmation.');
      return () => { active = false; };
    }
    onAnnounce('Loading saved order confirmation…');
    const loadSavedOrder = async () => {
      try {
        const order = await api<SavedOrderConfirmation>(`/api/dashboard/orders/${encodeURIComponent(requestedOrderId)}`);
        if (!active) return;
        const savedConfirmation = confirmationFromSavedOrder(order);
        setConfirmation(savedConfirmation);
        if (order.displayEstimate) {
          setDisplayEstimate({
            displayCurrency: order.displayEstimate.currency,
            complete: true,
            incompleteReason: null,
            displayMerchandiseMinor: order.displayEstimate.itemTotalMinor,
            displayShippingMinor: order.displayEstimate.shippingTotalMinor,
            displayTotalMinor: order.displayEstimate.totalMinor,
            chargeCurrency: order.currency,
            chargeMerchandiseMinor: savedConfirmation.itemSubtotal,
            chargeShippingMinor: savedConfirmation.shippingTotal,
            discountMinor: savedConfirmation.discountMinor,
            items: [],
            rates: order.displayEstimate.rateSnapshots.map(rate => ({ ...rate, purpose: 'DISPLAY_ESTIMATE_ONLY' })),
            note: `Estimate only, restored from reference-rate snapshots saved with this order. USD order total: ${money(order.totalMinor, order.currency)}; payment status: ${savedConfirmation.paymentStatus}.`
          });
        } else {
          setDisplayEstimate(null);
        }
        setResult('');
        onAnnounce('');
        if (order.payment?.method !== 'COD' && order.payment?.status === 'PENDING') pollTimer = setTimeout(() => void loadSavedOrder(), 5000);
      } catch (error) {
        if (!active) return;
        setResult(`Your order is saved, but its confirmation details could not be loaded. ${(error as Error).message}`);
        onAnnounce('');
      }
    };
    void loadSavedOrder();
    return () => { active = false; if (pollTimer) clearTimeout(pollTimer); };
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

  const applyDiscount = async () => {
    if (!discountInput.trim()) { setResult('Enter a discount code first.'); return; }
    setDiscountPending(true); setResult('');
    try {
      const result = await api<{ code: string; name: string; currency: string; discountMinor: number; eligibleSubtotalMinor: number }>('/api/cart/discount/validate', { method: 'POST', body: JSON.stringify({ code: discountInput.trim() }) });
      if (result.currency !== summaryCurrency) throw new Error(`This code is in ${result.currency}, while your cart is charged in ${summaryCurrency}.`);
      setAppliedDiscount(result); setDiscountInput(result.code);
    } catch (error) { setAppliedDiscount(null); setResult((error as Error).message); }
    finally { setDiscountPending(false); }
  };

  const updateQuantity = async (item: CartItem, quantity: number) => {
    if (pendingProductId) return;
    setPendingProductId(item.product.id);
    try {
      await api<void>(`/api/cart/items/${encodeURIComponent(item.product.id)}`, { method: 'PATCH', body: JSON.stringify({ quantity }) });
      await onChange();
      setShippingQuote(null);
      setAppliedDiscount(null);
      setDiscountInput('');
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
    setPaymentRedirectUrl('');
    if (!user) { setResult('Sign in before checkout.'); return; }
    if (form.method === 'COD' && !codMethodEnabled) { setResult('Cash on delivery is disabled by the marketplace.'); return; }
    if (form.method === 'COD' && !codEligible) { setResult(codUnavailableMessage); return; }
    try {
      const displayCurrencyAllowed = Boolean(currencyOptions?.displayCurrencies.some(currency => currency.code === displayCurrency));
      const r = await api<{ orderId: string; orderNumber: string; totalMinor: number; shippingTotalMinor: number; discountMinor: number; discountCode?: string | null; currency: string; paymentStatus: string; shippingBreakdown: OrderConfirmation['shipments']; payment?: { checkoutUrl?: string; approvalUrl?: string } | null }>('/api/orders/checkout', { method: 'POST', body: JSON.stringify({ buyerName: form.buyerName, buyerEmail: form.buyerEmail, address, method: form.method, ...(displayCurrencyAllowed ? { displayCurrency } : {}), ...(appliedDiscount ? { discountCode: appliedDiscount.code } : {}), shippingQuoteToken: shippingQuote?.quoteToken ?? undefined }) });
      const redirectUrl = r.payment?.checkoutUrl ?? r.payment?.approvalUrl;
      if (redirectUrl) {
        const paymentUrl = new URL(redirectUrl);
        if (paymentUrl.protocol !== 'https:') throw new Error('The payment provider did not return a secure checkout link. Your order state has been preserved; contact support before retrying.');
        if (isLiveCheckoutEmbed()) {
          setPaymentRedirectUrl(paymentUrl.toString());
          setResult('Your order is ready. Continue to the secure payment provider in a new tab; this live show will remain open.');
          return;
        }
        window.location.assign(paymentUrl.toString());
        return;
      }
      const checkoutReturn = new URL('/checkout', window.location.origin);
      checkoutReturn.searchParams.set('order', r.orderId);
      if (isLiveCheckoutEmbed()) { checkoutReturn.searchParams.set('source', 'live-shopping'); checkoutReturn.searchParams.set('embed', '1'); }
      window.history.replaceState({}, '', `${checkoutReturn.pathname}${checkoutReturn.search}`);
      setConfirmation({ orderNumber: r.orderNumber, total: r.totalMinor, itemSubtotal: r.totalMinor - r.shippingTotalMinor + r.discountMinor, discountMinor: r.discountMinor, discountCode: r.discountCode, shippingTotal: r.shippingTotalMinor, currency: r.currency, method: form.method, paymentStatus: r.paymentStatus, shipments: r.shippingBreakdown, displayEstimate: null });
      setDisplayEstimate(null);
      setResult('');
      onClearMessage();
      await onChange();
    } catch (e) { setResult((e as Error).message); }
  };

  const currentDiscountMinor = appliedDiscount?.discountMinor ?? 0;
  const summaryTotal = confirmation?.total ?? (shippingQuote ? shippingQuote.totalMinor - currentDiscountMinor : total - currentDiscountMinor);
  const summaryCurrency = confirmation?.currency ?? cart.items[0]?.variant?.currency ?? cart.items[0]?.product.currency ?? 'USD';
  const estimatedLine = (productId: string) => displayEstimate?.items.find(item => item.productId === productId);
  const estimatedSummaryTotal = displayEstimate ? (displayEstimate.complete ? displayEstimate.displayTotalMinor : displayEstimate.displayMerchandiseMinor) : null;
  if (cart.items.length > 0 || Boolean(confirmation)) return <section className="checkout">
    <div><p className="eyebrow">Checkout</p><h1>Complete your order</h1>
      {confirmation && <div className="notice orderConfirmation" role="status" aria-live="polite"><strong>{confirmation.paymentStatus === 'PAID' ? 'Payment received' : confirmation.method === 'COD' ? 'Order received' : 'Order received · waiting for payment confirmation'}</strong><p>{confirmation.paymentStatus === 'AWAITING_PROVIDER' ? 'Your order is saved and the payment provider is confirming the transaction. This page refreshes the status automatically; do not place the order again.' : confirmation.paymentStatus === 'PAID' ? 'Your payment has been confirmed.' : confirmation.method === 'COD' ? 'The seller will collect payment on delivery.' : 'The latest payment status is shown below.'}</p><dl><div><dt>Order reference</dt><dd>{confirmation.orderNumber}</dd></div><div><dt>Total</dt><dd>{money(confirmation.total, confirmation.currency)}</dd></div><div><dt>Payment method</dt><dd>{confirmation.method === 'COD' ? 'COD (Cash on delivery)' : confirmation.method}</dd></div><div><dt>Status</dt><dd>{confirmation.paymentStatus === 'PENDING' ? 'Pending' : confirmation.paymentStatus}</dd></div></dl></div>}
      {!confirmation && <form onSubmit={submit}>
        <label>Name<input required value={form.buyerName} onChange={event => setForm({ ...form, buyerName: event.target.value })} /></label>
        <label>Email<input required type="email" value={form.buyerEmail} onChange={event => setForm({ ...form, buyerEmail: event.target.value })} /></label>
        <div className="two"><label>Address<input required value={form.line1} onChange={event => updateAddress('line1', event.target.value)} /></label><label>City<input required value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} /></label></div>
        <div className="two"><label>Region<input required value={form.region} onChange={event => setForm({ ...form, region: event.target.value })} /></label><label>Postal code<input required value={form.postalCode} onChange={event => setForm({ ...form, postalCode: event.target.value })} /></label></div>
        <label>Country code<input required minLength={2} maxLength={2} value={form.country} onChange={event => updateAddress('country', event.target.value.toUpperCase())} /></label>
        <div className="discountEntry"><label>Discount code<input value={discountInput} onChange={event => { setDiscountInput(event.target.value.toUpperCase()); setAppliedDiscount(null); }} placeholder="Enter a seller's code" /></label><button type="button" disabled={discountPending || !discountInput.trim()} onClick={() => void applyDiscount()}>{discountPending ? 'Checking…' : 'Apply code'}</button></div>
        {appliedDiscount && <p className="muted" role="status">{appliedDiscount.name} applied — saving {money(appliedDiscount.discountMinor, appliedDiscount.currency)}.</p>}
        {requiresShipping && <button type="button" onClick={() => void calculateShipping()} disabled={quotePending}>{quotePending ? 'Calculating shipping…' : shippingQuote ? 'Recalculate shipping' : 'Calculate shipping'}</button>}
        {currencyOptions && <label>Display estimate (not payment currency)<select value={displayCurrency} onChange={event => setDisplayCurrency(event.target.value)}>{currencyOptions.displayCurrencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>}
        {currencyOptions?.error && <p className="muted" role="status">{currencyOptions.error}</p>}
        <label>Payment method<select value={form.method} onChange={event => { setPaymentMethodManuallySelected(true); setPaymentRedirectUrl(''); setForm({ ...form, method: event.target.value }); }}>{methods.map(method => <option key={method.method} value={method.method}>{method.method === 'PAYMONGO' ? 'PayMongo · PHP' : method.method === 'PAYSTACK' ? 'Paystack · NGN' : method.method === 'COD' ? 'Cash on delivery' : method.method}</option>)}</select></label>
        {selectedProviderCurrency && <p className="muted" role="status">Your actual order and seller accounting stay in {currencyOptions?.checkoutCurrency}. The provider charge will be collected in {selectedProviderCurrency.code}; the current conversion estimate is shown in the summary and will be recalculated securely when you place the order.</p>}
        <button className="primary" disabled={discountPending || quotePending || (requiresShipping && !shippingQuote) || Boolean(currencyOptions && !currencyOptions.checkoutCompatible)}>Place order</button>
        {paymentRedirectUrl && <a className="checkoutProviderRedirect" href={paymentRedirectUrl} target="_blank" rel="noopener noreferrer">Continue to secure payment</a>}
        {requiresShipping && !shippingQuote && <p className="muted">Calculate a covered shipping option for each Store before placing your order.</p>}{result && <p className="notice" role="alert">{result}</p>}
      </form>}
    </div>
    <aside className="summary"><h2>Summary</h2>
      {selectedProviderCurrency && !confirmation && <div className="displayEstimate" aria-live="polite"><strong>{providerPaymentEstimate?.complete ? 'Estimated payment charge' : `Estimated merchandise in ${selectedProviderCurrency.code}`}: {providerPaymentEstimate ? money(providerPaymentEstimate.complete ? providerPaymentEstimate.displayTotalMinor : providerPaymentEstimate.displayMerchandiseMinor, selectedProviderCurrency.code) : 'Calculating…'}</strong><small>{providerPaymentEstimateMessage || `Reference-rate estimate only. Final ${selectedProviderCurrency.code} charge is recalculated and saved with the order at submission.`}</small></div>}
      {displayEstimate && !confirmation && <div className="displayEstimate" aria-live="polite"><strong>{displayEstimate.complete ? 'Estimated order total' : 'Estimated merchandise subtotal (shipping not included)'}: {money(estimatedSummaryTotal!, displayEstimate.displayCurrency)}</strong><small>{displayEstimate.note}</small>{displayEstimate.rates[0] && <small>Rate observed {displayEstimate.rates[0].sourceDate}; fetched {new Date(displayEstimate.rates[0].fetchedAt).toLocaleString()}.</small>}</div>}
      {cart.items.map(item => {
        const name = item.variant ? `${item.product.name} — ${item.variant.name}` : item.product.name;
        const available = itemStock(item);
        const minimum = item.product.wholesaleEnabled ? item.product.wholesaleMinQuantity ?? 1 : 1;
        const maximum = item.product.wholesaleEnabled ? Math.min(item.product.wholesaleMaxQuantity ?? 99, available, 99) : Math.min(available, 99);
        const pending = pendingProductId === item.product.id;
        const sourceCurrency = item.variant?.currency ?? item.product.currency;
        const estimate = !confirmation ? estimatedLine(item.product.id) : undefined;
        return <div className="cartLine" key={item.product.id}>
          <div className="cartLineInfo">
            <span>{name}</span>
            <small>{estimate ? `≈ ${money(estimate.estimatedUnitAmountMinor, displayEstimate!.displayCurrency)} each (estimate) · ${money(itemPrice(item), sourceCurrency)} listed price · ${available} available` : `${money(itemPrice(item), sourceCurrency)} each · ${available} available`}</small>
            {item.product.wholesaleEnabled && <small>Wholesale · {minimum}–{item.product.wholesaleMaxQuantity ?? 99} units per order</small>}
            {item.product.wholesaleEnabled && item.quantity < minimum && <small role="status">Add {minimum - item.quantity} more unit{minimum - item.quantity === 1 ? '' : 's'} to meet the minimum.</small>}
          </div>
          <div className="cartControls" aria-label={`Quantity controls for ${name}`}>
            <button type="button" aria-label={`Decrease quantity for ${name}`} disabled={pending || item.quantity <= minimum} onClick={() => void updateQuantity(item, item.quantity - 1)}>−</button>
            <output aria-live="polite">{pending ? 'Saving…' : item.quantity}</output>
            <button type="button" aria-label={`Increase quantity for ${name}`} disabled={pending || item.quantity >= maximum} onClick={() => void updateQuantity(item, item.quantity + 1)}>+</button>
            <button type="button" className="removeButton" aria-label={`Remove ${name} from cart`} disabled={pending} onClick={() => void updateQuantity(item, 0)}>Remove</button>
          </div>
          <strong>{estimate ? `≈ ${money(estimate.estimatedAmountMinor, displayEstimate!.displayCurrency)}` : money(itemPrice(item) * item.quantity, sourceCurrency)}</strong>
        </div>;
      })}
      <hr /><p>{selectedProviderCurrency && !confirmation ? `Merchandise subtotal (${summaryCurrency} platform currency)` : displayEstimate && !confirmation ? `Merchandise subtotal (${summaryCurrency} charge)` : 'Merchandise subtotal'}<strong>{money(confirmation?.itemSubtotal ?? total, summaryCurrency)}</strong></p>
      {(confirmation?.discountMinor ?? currentDiscountMinor) > 0 && <p>Product discount{(confirmation?.discountCode ?? appliedDiscount?.code) ? ` · ${confirmation?.discountCode ?? appliedDiscount?.code}` : ''}<strong>−{money(confirmation?.discountMinor ?? currentDiscountMinor, summaryCurrency)}</strong></p>}
      {confirmation ? confirmation.shipments.map(shipment => <p key={`${shipment.storeName}-${shipment.serviceName}`}>{shipment.storeName} · {shipment.serviceName}<strong>{money(shipment.shippingMinor, confirmation.currency)}</strong></p>) : shippingQuote?.shipments.map(shipment => <div className="shippingSummary" key={shipment.sellerId}><h3>{shipment.storeName}</h3><label>Delivery service<select aria-label={`Delivery service for ${shipment.storeName}`} value={shipment.selected.serviceId} onChange={event => { const next = { ...selectedServices, [shipment.sellerId]: event.target.value }; setSelectedServices(next); void calculateShipping(next); }}>{shipment.options.map(option => <option key={option.serviceId} value={option.serviceId}>{option.serviceName} · {money(option.shippingMinor, option.currency)}{option.estimatedMinDays !== null ? ` · ${option.estimatedMinDays}${option.estimatedMaxDays !== null && option.estimatedMaxDays !== option.estimatedMinDays ? `–${option.estimatedMaxDays}` : ''} days` : ''}</option>)}</select></label><p>Service fee<strong>{money(shipment.selected.feeMinor, shipment.selected.currency)}</strong></p>{shipment.selected.discount && <p>Shipping discount — {shipment.selected.discount.name}<strong>−{money(shipment.selected.discountMinor, shipment.selected.currency)}</strong></p>}<p>Shipment shipping<strong>{money(shipment.selected.shippingMinor, shipment.selected.currency)}</strong></p></div>)}
      <hr /><p className="total">{selectedProviderCurrency && !confirmation ? `Platform order total (${summaryCurrency})` : displayEstimate && !confirmation ? `Actual order charge (${summaryCurrency})` : requiresShipping && !shippingQuote && !confirmation ? 'Merchandise subtotal' : 'Order total'}<strong>{money(summaryTotal, summaryCurrency)}</strong></p>
      {displayEstimate && confirmation && <div className="displayEstimate" aria-live="polite"><strong>Estimated display total: {money(displayEstimate.displayTotalMinor, displayEstimate.displayCurrency)}</strong><small>{displayEstimate.note}</small>{displayEstimate.rates[0] && <small>Rate observed {displayEstimate.rates[0].sourceDate}; fetched {new Date(displayEstimate.rates[0].fetchedAt).toLocaleString()}.</small>}</div>}
      {estimateMessage && !displayEstimate && <p className="muted" role="status">{estimateMessage}</p>}{selectedProviderCurrency && !confirmation ? <small>Platform order and seller accounting remain in {summaryCurrency}; estimated payment is in {selectedProviderCurrency.code}. The provider determines the final charge at checkout.</small> : displayEstimate && !confirmation ? <small>{displayEstimate.complete ? `The estimate is informational only. Actual order charge remains ${money(summaryTotal, summaryCurrency)}.` : `Shipping is excluded. Merchandise charge is ${money(summaryTotal, summaryCurrency)}; actual payment remains in ${summaryCurrency}.`}</small> : <small>Actual order charge remains {summaryCurrency}. No hidden tax is added.</small>}{result && !cart.items.length && <p className="notice" role="alert">{result}</p>}
    </aside>
  </section>;
  return <section className="checkout"><div><p className="eyebrow">Checkout</p><h1>Complete your order</h1>{confirmation && <div className="notice orderConfirmation" role="status" aria-live="polite"><strong>Order confirmed</strong><p>Your order is confirmed and awaiting collection.</p><dl><div><dt>Order reference</dt><dd>{confirmation.orderNumber}</dd></div><div><dt>Total</dt><dd>{money(confirmation.total, confirmation.currency)}</dd></div><div><dt>Payment method</dt><dd>{confirmation.method === 'COD' ? 'COD (Cash on delivery)' : confirmation.method}</dd></div><div><dt>Status</dt><dd>{confirmation.paymentStatus === 'PENDING' ? 'Pending' : confirmation.paymentStatus}</dd></div></dl></div>}{cart.items.length === 0 ? <div className="empty">Your cart is empty.</div> : <form onSubmit={submit}><label>Name<input required value={form.buyerName} onChange={e => setForm({ ...form, buyerName: e.target.value })} /></label><label>Email<input required type="email" value={form.buyerEmail} onChange={e => setForm({ ...form, buyerEmail: e.target.value })} /></label><div className="two"><label>Address<input required value={form.line1} onChange={e => updateAddress('line1', e.target.value)} /></label><label>City<input required value={form.city} onChange={e => updateAddress('city', e.target.value)} /></label></div><div className="two"><label>Region<input required value={form.region} onChange={e => updateAddress('region', e.target.value)} /></label><label>Postal code<input required value={form.postalCode} onChange={e => updateAddress('postalCode', e.target.value)} /></label></div><label>Country code<input required minLength={2} maxLength={2} value={form.country} onChange={e => updateAddress('country', e.target.value.toUpperCase())} /></label>{requiresShipping && <button type="button" onClick={() => void calculateShipping()} disabled={quotePending}>{quotePending ? 'Calculating shipping…' : shippingQuote ? 'Recalculate shipping' : 'Calculate shipping'}</button>}{currencyOptions && <label>Display estimate (not payment currency)<select value={displayCurrency} onChange={event => setDisplayCurrency(event.target.value)}>{currencyOptions.displayCurrencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>}{currencyOptions?.error && <p className="muted" role="status">{currencyOptions.error}</p>}<label>Payment method<select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>{methods.map(m => <option key={m.method} value={m.method}>{m.method}</option>)}</select></label><button className="primary" disabled={quotePending || (requiresShipping && !shippingQuote) || Boolean(currencyOptions && !currencyOptions.checkoutCompatible)}>Place order</button>{requiresShipping && !shippingQuote && <p className="muted">Calculate a covered shipping option for each Store before placing your order.</p>}{result && <p className="notice" role="alert">{result}</p>}</form>}</div><aside className="summary"><h2>Summary</h2>{cart.items.map(item => { const name = item.variant ? `${item.product.name} — ${item.variant.name}` : item.product.name; const available = itemStock(item); const pending = pendingProductId === item.product.id; return <div className="cartLine" key={item.product.id}><div className="cartLineInfo"><span>{name}</span><small>{money(itemPrice(item), item.variant?.currency ?? item.product.currency)} each · {available} available</small></div><div className="cartControls" aria-label={`Quantity controls for ${name}`}><button type="button" aria-label={`Decrease quantity for ${name}`} disabled={pending || item.quantity <= 1} onClick={() => void updateQuantity(item, item.quantity - 1)}>−</button><output aria-live="polite">{pending ? 'Saving…' : item.quantity}</output><button type="button" aria-label={`Increase quantity for ${name}`} disabled={pending || item.quantity >= Math.min(available, 99)} onClick={() => void updateQuantity(item, item.quantity + 1)}>+</button><button type="button" className="removeButton" aria-label={`Remove ${name} from cart`} disabled={pending} onClick={() => void updateQuantity(item, 0)}>Remove</button></div><strong>{money(itemPrice(item) * item.quantity, item.variant?.currency ?? item.product.currency)}</strong></div>; })}<hr /><p>Merchandise subtotal<strong>{money(confirmation?.itemSubtotal ?? total, summaryCurrency)}</strong></p>{confirmation ? confirmation.shipments.map(shipment => <p key={`${shipment.storeName}-${shipment.serviceName}`}>{shipment.storeName} · {shipment.serviceName}<strong>{money(shipment.shippingMinor, confirmation.currency)}</strong></p>) : shippingQuote?.shipments.map(shipment => <div className="shippingSummary" key={shipment.sellerId}><h3>{shipment.storeName}</h3><label>Delivery service<select aria-label={`Delivery service for ${shipment.storeName}`} value={shipment.selected.serviceId} onChange={event => { const next = { ...selectedServices, [shipment.sellerId]: event.target.value }; setSelectedServices(next); void calculateShipping(next); }}>{shipment.options.map(option => <option key={option.serviceId} value={option.serviceId}>{option.serviceName} · {money(option.shippingMinor, option.currency)}{option.estimatedMinDays !== null ? ` · ${option.estimatedMinDays}${option.estimatedMaxDays !== null && option.estimatedMaxDays !== option.estimatedMinDays ? `–${option.estimatedMaxDays}` : ''} days` : ''}</option>)}</select></label><p>Service fee<strong>{money(shipment.selected.feeMinor, shipment.selected.currency)}</strong></p>{shipment.selected.discount && <p>Shipping discount — {shipment.selected.discount.name}<strong>−{money(shipment.selected.discountMinor, shipment.selected.currency)}</strong></p>}<p>Shipment shipping<strong>{money(shipment.selected.shippingMinor, shipment.selected.currency)}</strong></p></div>)}<hr /><p className="total">{requiresShipping && !shippingQuote && !confirmation ? 'Merchandise subtotal' : 'Order total'}<strong>{money(summaryTotal, summaryCurrency)}</strong></p>{displayEstimate && <div className="displayEstimate" aria-live="polite"><strong>Estimated display total: {money(displayEstimate.displayTotalMinor, displayEstimate.displayCurrency)}</strong><small>{displayEstimate.note}</small>{displayEstimate.rates[0] && <small>Rate observed {displayEstimate.rates[0].sourceDate}; fetched {new Date(displayEstimate.rates[0].fetchedAt).toLocaleString()}.</small>}</div>}{estimateMessage && <p className="muted" role="status">{estimateMessage}</p>}{requiresShipping && !shippingQuote && !confirmation ? <small>Final charge total appears after shipping is calculated for every Store.</small> : <small>Actual order charge remains {summaryCurrency}. No hidden tax is added.</small>}{result && !cart.items.length && <p className="notice" role="alert">{result}</p>}</aside></section>;
}

function Admin() { const [settings, setSettings] = useState<{ marketplace: { multiVendorEnabled: boolean } | null; paymentMethods: { method: string; enabled: boolean }[] } | null>(null); const [sellers, setSellers] = useState<{ id: string; status: string; user: { email: string }; store?: { name: string } }[]>([]); const [message, setMessage] = useState(''); const load = async () => { setSettings(await api('/api/admin/settings')); setSellers(await api('/api/admin/sellers')); }; useEffect(() => { load().catch(e => setMessage(e.message)); }, []); const toggle = async (body: object) => { try { await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }); await load(); } catch (e) { setMessage((e as Error).message); } }; return <><section className="page"><p className="eyebrow">Control room</p><h1>Marketplace settings</h1>{message && <p className="notice">{message}</p>}<div className="settings">{settings && <><div className="setting"><div><strong>Multi-vendor mode</strong><p>When off, seller records remain preserved but new seller sales and applications are blocked.</p></div><button onClick={() => toggle({ multiVendorEnabled: !settings.marketplace?.multiVendorEnabled })}>{settings.marketplace?.multiVendorEnabled ? 'Enabled' : 'Disabled'}</button></div>{settings.paymentMethods.map(m => <div className="setting" key={m.method}><div><strong>{m.method}</strong><p>Server-side activation control for new transactions.</p></div><button onClick={() => toggle({ method: m.method, enabled: !m.enabled })}>{m.enabled ? 'Enabled' : 'Disabled'}</button></div>)}</>}</div><h2>Seller review</h2><div className="table">{sellers.map(s => <div className="row" key={s.id}><span>{s.store?.name ?? 'Application'} · {s.user.email}</span><span>{s.status}</span><select value={s.status} onChange={async e => { await api(`/api/admin/sellers/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); await load(); }}><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>SUSPENDED</option></select></div>)}</div></section><AffiliateAdmin /></>; }

function POS({ products }: { products: Product[] }) { const [items, setItems] = useState<Record<string, number>>({}); const [message, setMessage] = useState(''); const sale = async () => { try { const result = await api<{ receiptUrl: string }>('/api/pos/sales', { method: 'POST', body: JSON.stringify({ register: 'browser-1', items: Object.entries(items).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity })) }) }); setMessage(`Sale created. Receipt: ${result.receiptUrl}`); setItems({}); } catch (e) { setMessage((e as Error).message); } }; return <section className="page"><p className="eyebrow">Seller-scoped cash register</p><h1>POS</h1><p className="muted">This is browser cash POS only. It does not process card-present payments or connect to hardware.</p><div className="grid posGrid">{products.map(p => <article className="card compact" key={p.id}><div><h2>{p.name}</h2><p>{money(p.salePriceMinor ?? p.priceMinor)} · {p.availableStock} available</p></div><input aria-label={`Quantity for ${p.name}`} type="number" min="0" max={p.availableStock} value={items[p.id] ?? 0} onChange={e => setItems({ ...items, [p.id]: Number(e.target.value) })} /></article>)}</div><button className="primary" onClick={sale}>Complete cash sale</button>{message && <p className="notice">{message}</p>}</section>; }

function DomainRootRoute() {
  const [storeSlug, setStoreSlug] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    let active = true;
    fetch('/api/public/store-domain', { credentials: 'omit' })
      .then(async response => response.ok ? await response.json() as { storeSlug?: string } : null)
      .then(result => { if (active) { setStoreSlug(typeof result?.storeSlug === 'string' ? result.storeSlug : null); setResolved(true); } })
      .catch(() => { if (active) setResolved(true); });
    return () => { active = false; };
  }, []);
  if (!resolved) return <main className="shellLoading" role="status"><p className="eyebrow">Marketplace</p><h1>Opening Store…</h1></main>;
  return storeSlug ? <Storefront slug={storeSlug} /> : <App />;
}

function PageRouter() {
  const path = window.location.pathname;
  const storeContentPath = path === '/seller/content';
  const storeGrowthPath = path === '/seller/growth';
  const storePath = path.match(/^\/store\/([^/]+)\/?$/);
  const categoryPath = path.match(/^\/category\/([^/]+)\/?$/);
  const productPath = path.match(/^\/products\/([^/]+)\/?$/);
  const jimaHelpPath = path.match(/^\/help\/jima\/([^/]+)\/?$/);
  return storeContentPath ? <SellerStoreContent /> : storeGrowthPath ? <SellerStoreGrowth /> : path === '/email/confirm' ? <StoreEmailAction kind="confirm" /> : path === '/email/unsubscribe' ? <StoreEmailAction kind="unsubscribe" /> : path === '/seller/currency' ? <SellerStoreCurrency /> : path === '/seller/commissions' ? <SellerCommissionStatement /> : path === '/seller/themes' ? <StoreThemeStudio /> : path === '/seller/site-chrome' ? <SiteChromeBuilder scope="store" /> : path === '/admin/themes' ? <PlatformAdmin /> : path === '/admin/currencies' ? <AdminCurrencyCommission section="currencies" /> : path === '/admin/commissions' ? <AdminCurrencyCommission section="commissions" /> : path === '/dashboard' ? <Dashboard /> : path === '/ads' ? <MarketplaceAds /> : path === '/admin/ads' ? <MarketplaceAds admin /> : path === '/favorites' ? <Favorites /> : path === '/settings' ? <Settings /> : path === '/wallet' ? <Wallet /> : path === '/club-coins' ? <ClubCoins /> : path === '/admin/wallet' ? <AdminWallet /> : path.startsWith('/admin/content') ? <ContentAdmin /> : path.startsWith('/admin/platform') ? <PlatformAdmin /> : path.startsWith('/seller/plan') ? <SellerStorePlan /> : path.startsWith('/seller/platform') ? <SellerPlatform /> : path.startsWith('/affiliate') ? <AffiliateDashboard /> : jimaHelpPath ? <JimaKnowledgeArticle id={decodeURIComponent(jimaHelpPath[1])} /> : categoryPath ? <MarketplaceCategory slug={decodeURIComponent(categoryPath[1])} /> : storePath ? <Storefront slug={decodeURIComponent(storePath[1])} /> : productPath ? <ProductPage id={decodeURIComponent(productPath[1])} /> : path === '/' ? <DomainRootRoute /> : <App />;
}
function RoutedPage() {
  const liveRoute = window.location.pathname.match(/^\/live\/([^/]+)\/?$/);
  if (liveRoute) return <LivePublicPage sessionId={safePathSegment(liveRoute[1]!)} />;
  return window.location.pathname === '/email/verify' ? <EmailVerificationAction /> : <PageRouter />;
}
function RouteLoading() { return <main className="shellLoading" role="status"><p className="eyebrow">Marketplace</p><h1>Opening your page…</h1></main>; }
function RoutedPageBoundary() { return <React.Suspense fallback={<RouteLoading />}><RoutedPage /></React.Suspense>; }
function safePathSegment(value: string) { try { return decodeURIComponent(value); } catch { return ''; } }
const liveEmbedRoute = window.location.pathname.match(/^\/live\/([^/]+)\/embed\/?$/);
const liveCheckoutEmbedRoute = window.location.pathname === '/checkout'
  && new URLSearchParams(window.location.search).get('source') === 'live-shopping'
  && new URLSearchParams(window.location.search).get('embed') === '1';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{liveEmbedRoute
  ? <LiveEmbedPage sessionId={safePathSegment(liveEmbedRoute[1]!)} />
  : <SessionProvider>{liveCheckoutEmbedRoute ? <RoutedPageBoundary /> : <AppShell><RoutedPageBoundary /></AppShell>}</SessionProvider>}</React.StrictMode>);
