import React, { useEffect, useRef, useState } from 'react';
import { AdminIntegrations } from './AdminIntegrations.js';
import { AffiliateAdmin } from './AffiliateAdmin.js';
import { StorePlanAdmin } from './StorePlanAdmin.js';
import { AdminStoreGrowth } from './AdminStoreGrowth.js';
import { BrandingImageControl } from './BrandingImageControl.js';
import { formatMinor } from './money.js';
import { AdminCatalog } from './AdminCatalog.js';
import { AdminCarriers } from './AdminCarriers.js';
import { AdminPlatformStore } from './AdminPlatformStore.js';
import { OrderResolutionAdmin } from './OrderResolutionAdmin.js';
import { SupportDesk } from './SupportDesk.js';
import { AdminMembers } from './AdminMembers.js';
import { AdminOperations } from './AdminOperations.js';
import { AdminPromotions } from './AdminPromotions.js';
import { AdminProductReviews } from './AdminProductReviews.js';
import { AdminLiveShopping } from './LiveShopping.js';
import { AdminSocialAuth } from './AdminSocialAuth.js';
import { AdminOnboardingReadiness } from './AdminOnboardingReadiness.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? (undefined as T) : response.json();
}

type Settings = { sellerShippingEnabled: boolean; sellerApprovalPolicy: string; productApprovalPolicy: string; sellerPayoutsEnabled: boolean; payoutFundingConfigured: boolean; manualBankPayoutsEnabled: boolean; manualEwalletPayoutsEnabled: boolean; stripeConnectPayoutsEnabled: boolean; paypalPayoutsEnabled: boolean; payoutHoldDays: number; payoutMinimumMinor: number };
type ShippingAdmin = { enabled: boolean; services: { id: string; name: string; enabled: boolean; feeMinor: number; currency: string; seller: { store?: { name: string } }; zones: { countryCode: string; regionLabel: string | null; cityLabel: string | null }[] }[] };
type Branding = { platformName: string; shortName: string; description: string; seoDescription: string; tagline: string; logoMediaId: string | null; alternateLogoMediaId: string | null; faviconMediaId: string | null; defaultAvatarMediaId: string | null; socialImageMediaId: string | null; supportEmail: string | null; supportUrl: string | null };
type Availability = { languages: string[]; supportedLanguages: string[]; baseCurrency: string; availableDisplayCurrencies: string[]; fxRatesConfigured: boolean; automaticFxEnabled: boolean; note: string };
type AdminOrder = { id: string; orderNumber: string; status: string; totalMinor: number; currency: string; createdAt: string; payment?: { method: string; status: string } | null; sellerOrders?: { id: string; shippingSnapshotJson?: { serviceName: string; shippingMinor: number; currency: string } | null; seller?: { store?: { name: string } | null } | null }[] };
type AuditEntry = { id: string; action: string; entity: string; entityId: string; createdAt: string; actor: { name: string | null; email: string } | null };

const adminNavigation = [
  { group: 'Overview', items: [{ id: 'overview', label: 'Overview' }] },
  { group: 'Marketplace', items: [{ id: 'orders', label: 'Orders' }, { id: 'taxonomy', label: 'Catalog & categories' }, { id: 'reviews', label: 'Product reviews' }, { id: 'vendors', label: 'Sellers & stores' }, { id: 'platform-store', label: 'Official platform Store' }, { id: 'shipping', label: 'Seller-managed shipping' }, { id: 'live-shopping', label: 'Live shopping' }] },
  { group: 'Plans and billing', items: [{ id: 'plans', label: 'Store plans' }] },
  { group: 'Payments', items: [{ id: 'methods', label: 'Payment methods' }, { id: 'transactions', label: 'Transactions' }, { id: 'commissions', label: 'Seller commissions' }, { id: 'payouts', label: 'Seller payouts' }, { id: 'refunds', label: 'Refunds & disputes' }] },
  { group: 'Growth', items: [{ id: 'affiliate', label: 'Affiliate program' }, { id: 'store-growth', label: 'Store Buster & email' }, { id: 'promotions', label: 'Promotions & ads' }, { id: 'coins', label: 'Club Coins' }] },
  { group: 'Members and security', items: [{ id: 'members', label: 'Members & security' }, { id: 'auth', label: 'Sign-in & social login' }, { id: 'onboarding', label: 'Onboarding readiness' }] },
  { group: 'Support and messaging', items: [{ id: 'support', label: 'Support & messaging' }] },
  { group: 'Integrations & APIs', items: [{ id: 'providers', label: 'Provider configurations' }, { id: 'webhooks', label: 'Webhooks & API status' }] },
  { group: 'Platform settings', items: [{ id: 'branding', label: 'Branding' }, { id: 'settings', label: 'Policies' }, { id: 'availability', label: 'Availability & localization' }, { id: 'currencies', label: 'Currency catalog & FX' }] },
  { group: 'Governance', items: [{ id: 'audit', label: 'Audit log' }] }
];

const defaultBranding: Branding = { platformName: 'Market Lane', shortName: 'Market Lane', description: '', seoDescription: '', tagline: '', logoMediaId: null, alternateLogoMediaId: null, faviconMediaId: null, defaultAvatarMediaId: null, socialImageMediaId: null, supportEmail: null, supportUrl: null };

export function PlatformAdmin() {
  const requestedSection = new URLSearchParams(window.location.search).get('section');
  const supportedSections = ['overview', 'orders', 'taxonomy', 'reviews', 'vendors', 'platform-store', 'shipping', 'live-shopping', 'plans', 'methods', 'transactions', 'commissions', 'payouts', 'refunds', 'affiliate', 'store-growth', 'promotions', 'coins', 'members', 'auth', 'onboarding', 'support', 'providers', 'webhooks', 'branding', 'settings', 'availability', 'currencies', 'audit'];
  const [tab, setTab] = useState(requestedSection && supportedSections.includes(requestedSection) ? requestedSection : requestedSection === 'integrations' ? 'providers' : 'overview');
  const [initialLoadState, setInitialLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [branding, setBranding] = useState<Branding>(defaultBranding);
  const brandingRevision = useRef(0);
  const latestLoadRequest = useRef(0);
  const initialLoadStarted = useRef(false);
  const [publishedBranding, setPublishedBranding] = useState<Branding | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shippingAdmin, setShippingAdmin] = useState<ShippingAdmin | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [languageDraft, setLanguageDraft] = useState<string[]>(['en']);
  const [vendors, setVendors] = useState<{ id: string; status: string; user: { email: string }; store?: { name: string; slug: string } }[]>([]);
  const [readiness, setReadiness] = useState<{ enabled: boolean; fundingConfigured: boolean; methods: Record<string, boolean>; warning: string } | null>(null);
  const [payouts, setPayouts] = useState<{ id: string; amountMinor: number; currency: string; status: string; seller: { store?: { name: string } } }[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [message, setMessage] = useState('');
  const [brandingSaving, setBrandingSaving] = useState(false);

  function updateBranding<K extends keyof Branding>(key: K, value: Branding[K]) {
    brandingRevision.current += 1;
    setBranding(current => ({ ...current, [key]: value }));
  }

  const load = async () => {
    const requestId = ++latestLoadRequest.current;
    const draftRevision = brandingRevision.current;
    const [b, s, a, v, r, p, o, log, ship] = await Promise.all([
      api<{ draftJson?: Branding; publishedJson?: Branding | null }>('/api/admin/platform/branding'), api<Settings>('/api/admin/platform/settings'), api<Availability>('/api/admin/platform/availability'), api<{ items: typeof vendors }>('/api/admin/vendors'), api<typeof readiness>('/api/admin/payout-readiness'), api<typeof payouts>('/api/admin/payouts'), api<AdminOrder[]>('/api/admin/orders'), api<AuditEntry[]>('/api/admin/audit'), api<ShippingAdmin>('/api/admin/shipping')
    ]);
    if (requestId !== latestLoadRequest.current) return;
    setBranding(current => brandingRevision.current === draftRevision ? b.draftJson ?? defaultBranding : current); setPublishedBranding(b.publishedJson ?? null); setSettings(s); setShippingAdmin(ship); setAvailability(a); setVendors(v.items); setReadiness(r); setPayouts(p); setOrders(o); setAuditEntries(log);
  };
  const loadInitial = async () => {
    try { await load(); setInitialLoadState('ready'); }
    catch (error) { setMessage((error as Error).message); setInitialLoadState('error'); }
  };
  useEffect(() => { if (initialLoadStarted.current) return; initialLoadStarted.current = true; void loadInitial(); }, []);
  useEffect(() => { if (availability) setLanguageDraft(availability.languages); }, [availability]);
  const retryInitialLoad = () => { setInitialLoadState('loading'); void loadInitial(); };
  const action = async (path: string, options: RequestInit = {}) => { try { await api(path, options); await load(); setMessage('Saved'); } catch (error) { setMessage((error as Error).message); } };
  const refreshBranding = async (revision: number) => {
    const saved = await api<{ draftJson?: Branding; publishedJson?: Branding | null }>('/api/admin/platform/branding');
    setBranding(current => brandingRevision.current === revision ? saved.draftJson ?? defaultBranding : current);
    setPublishedBranding(saved.publishedJson ?? null);
  };
  const saveBrandingDraft = async () => {
    const revision = brandingRevision.current;
    setBrandingSaving(true);
    setMessage('Saving platform branding draft…');
    let persisted = false;
    try {
      await api('/api/admin/platform/branding', { method: 'PUT', body: JSON.stringify(branding) });
      persisted = true;
      await refreshBranding(revision);
      setMessage(brandingRevision.current === revision ? 'Platform branding draft saved and verified from the server.' : 'Platform branding draft saved. Newer edits remain unsaved in the editor.');
    } catch (error) {
      setMessage(persisted ? `Platform branding draft was saved, but refresh failed: ${(error as Error).message}` : `Platform branding draft was not saved: ${(error as Error).message}`);
    } finally { setBrandingSaving(false); }
  };
  const publishBranding = async () => {
    const revision = brandingRevision.current;
    setBrandingSaving(true);
    setMessage('Saving branding draft and publishing…');
    let draftSaved = false;
    let published = false;
    try {
      await api('/api/admin/platform/branding', { method: 'PUT', body: JSON.stringify(branding) });
      draftSaved = true;
      await api('/api/admin/platform/branding/publish', { method: 'POST', body: '{}' });
      published = true;
      await refreshBranding(revision);
      setMessage(brandingRevision.current === revision ? 'Platform branding published and verified from the server.' : 'Platform branding published. Newer edits remain unsaved in the editor.');
    } catch (error) {
      if (draftSaved) {
        try { await refreshBranding(revision); } catch { /* Preserve an accurate save/publish outcome below. */ }
      }
      setMessage(published ? 'Platform branding was published, but its latest state could not be refreshed.' : draftSaved ? `Branding draft was saved, but publishing failed: ${(error as Error).message}` : `Platform branding was not saved: ${(error as Error).message}`);
    } finally { setBrandingSaving(false); }
  };
  const patchSetting = (key: keyof Settings, value: boolean | number | string) => action('/api/admin/platform/settings', { method: 'PATCH', body: JSON.stringify({ [key]: value, reason: 'Updated in platform administration' }) });
  const selectTab = (next: string) => { setTab(next); const url = new URL(window.location.href); url.searchParams.set('section', next); window.history.replaceState({}, '', url); };
  const pendingSellers = vendors.filter(vendor => vendor.status === 'PENDING').length;
  const requestedPayouts = payouts.filter(payout => payout.status === 'REQUESTED').length;
  const formatMoney = (minor: number, currency: string) => formatMinor(minor, currency);
  return <section className="page adminControlCenter"><p className="eyebrow">Platform administration</p><h1>Control center</h1><p className="muted">Manage implemented marketplace operations and review areas that are still gated or planned.</p>{message && <p className="notice" role="status">{message}</p>}<div className="adminControlLayout"><nav className="adminControlNav" aria-label="Platform administration sections">{adminNavigation.map(group => <div className="adminNavGroup" key={group.group}><h2>{group.group}</h2>{group.items.map(item => 'planned' in item && item.planned ? <div className="adminNavPlanned" key={item.id}><span>{item.label}</span><small>Planned</small></div> : <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { if (item.id === 'coins') { window.location.assign('/admin/wallet'); return; } if (item.id === 'currencies') { window.location.assign('/admin/currencies'); return; } if (item.id === 'commissions') { window.location.assign('/admin/commissions'); return; } selectTab(item.id); }}>{item.label}</button>)}</div>)}</nav><main className="adminControlMain" aria-live="polite">
    {initialLoadState === 'loading' && <div className="empty" role="status">Loading platform administration…</div>}
    {initialLoadState === 'error' && <div className="empty" role="alert"><p>Platform administration could not be loaded. Your settings have not been changed.</p><button type="button" onClick={retryInitialLoad}>Retry loading settings</button></div>}
    {initialLoadState === 'ready' && <>
    {tab === 'overview' && <div><p className="eyebrow">At a glance</p><h2>Marketplace operations</h2><div className="adminMetricGrid"><article className="card cardBody"><strong>{orders.length}</strong><span>Recent orders</span></article><article className="card cardBody"><strong>{vendors.length}</strong><span>Seller records</span></article><article className="card cardBody"><strong>{pendingSellers}</strong><span>Seller applications pending review</span></article><article className="card cardBody"><strong>{requestedPayouts}</strong><span>Payout requests awaiting review</span></article></div><div className="notice"><strong>Financial boundary:</strong> buyer checkout collects for the platform merchant account; seller payouts remain a separate, manually reviewed workflow. Store-plan checkout is disabled.</div></div>}
    {tab === 'orders' && <section><h2>Marketplace orders</h2><p className="muted">Recent order and payment status from the existing admin order API. Shipping totals are included in each buyer-facing order total.</p>{orders.length ? <div className="table">{orders.map(order => <div className="row adminOrderRow" key={order.id}><strong>{order.orderNumber}</strong><span>{order.status}</span><span>{order.payment?.method ?? '—'} · {order.payment?.status ?? 'No payment record'}</span><span>{order.sellerOrders?.filter(shipment => shipment.shippingSnapshotJson).map(shipment => `${shipment.seller?.store?.name ?? 'Store'}: ${shipment.shippingSnapshotJson!.serviceName} ${formatMoney(shipment.shippingSnapshotJson!.shippingMinor, shipment.shippingSnapshotJson!.currency)}`).join(' · ') || 'No seller shipping'}</span><strong>{formatMoney(order.totalMinor, order.currency)}</strong></div>)}</div> : <div className="empty">No marketplace orders yet.</div>}</section>}
    {tab === 'transactions' && <section><h2>Transactions</h2><p className="muted">Transaction visibility is provided through marketplace order records. Use Refunds &amp; disputes for buyer cases and webhook-backed refund settlement evidence.</p>{orders.length ? <div className="table">{orders.map(order => <div className="row adminOrderRow" key={order.id}><strong>{order.orderNumber}</strong><span>{order.payment?.method ?? '—'}</span><span>{order.payment?.status ?? 'No payment record'}</span><strong>{formatMoney(order.totalMinor, order.currency)}</strong></div>)}</div> : <div className="empty">No transaction records yet.</div>}</section>}
    {tab === 'refunds' && <OrderResolutionAdmin />}
    {tab === 'live-shopping' && <AdminLiveShopping />}
    {tab === 'support' && <SupportDesk mode="admin" />}
    {tab === 'members' && <AdminMembers />}
    {tab === 'auth' && <AdminSocialAuth />}
    {tab === 'onboarding' && <AdminOnboardingReadiness />}
    {tab === 'audit' && <section><h2>Audit log</h2><p className="muted">Recent privileged actions. Sensitive metadata and credential references are intentionally omitted from this view.</p>{auditEntries.length ? <div className="table">{auditEntries.map(entry => <div className="row adminAuditRow" key={entry.id}><strong>{entry.action}</strong><span>{entry.entity}</span><span>{entry.actor?.name || entry.actor?.email || 'System'}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></div>)}</div> : <div className="empty">No audit entries yet.</div>}</section>}
    {tab === 'branding' && <div className="brandingEditor"><h2>Platform branding</h2><p className="muted">Changes are saved as a draft first. Publish makes them public. Uploaded assets stay private until approved by scanning; a pending or rejected image cannot replace the current public identity.</p>
      <div className="two">
        <div className="narrow"><label>Platform name<input value={branding.platformName} onChange={event => updateBranding('platformName', event.target.value)} /></label><label>Short name<input value={branding.shortName} onChange={event => updateBranding('shortName', event.target.value)} /></label><label>Description<textarea value={branding.description} onChange={event => updateBranding('description', event.target.value)} /></label><label>SEO description<textarea value={branding.seoDescription} onChange={event => updateBranding('seoDescription', event.target.value)} /></label><label>Tagline<input value={branding.tagline} onChange={event => updateBranding('tagline', event.target.value)} /></label><label>Support email<input type="email" value={branding.supportEmail ?? ''} onChange={event => updateBranding('supportEmail', event.target.value || null)} /></label><label>Support URL<input type="url" value={branding.supportUrl ?? ''} onChange={event => updateBranding('supportUrl', event.target.value || null)} /></label></div>
        <div className="brandingImageGrid">
          {([['logoMediaId', 'Primary logo', 3], ['alternateLogoMediaId', 'Alternate logo', 3], ['faviconMediaId', 'Favicon', 1], ['defaultAvatarMediaId', 'Default profile avatar', 1], ['socialImageMediaId', 'Social sharing image', 1.91]] as const).map(([key, label, ratio]) => <BrandingImageControl key={key} label={label} ratio={ratio} value={branding[key]} publishedValue={publishedBranding ? publishedBranding[key] : null} onChange={id => updateBranding(key, id)} listUrl="/api/admin/platform/branding-media" uploadUrl="/api/admin/platform/branding-media/uploads" previewUrl={id => `/api/admin/platform/branding-media/${encodeURIComponent(id)}/preview`} />)}
        </div>
      </div>
      <div className="toolbar"><button className="primary" disabled={brandingSaving} onClick={() => void saveBrandingDraft()}>{brandingSaving ? 'Saving…' : 'Save branding draft'}</button><button disabled={brandingSaving} onClick={() => { if (window.confirm('Save these edits and publish this branding version? Only approved images will be made public; pending replacements are rejected and the current branding remains active.')) void publishBranding(); }}>{brandingSaving ? 'Saving…' : 'Save and publish branding'}</button></div>
    </div>}
    {tab === 'settings' && settings && <div className="settings"><div className="setting"><div><strong>Seller-managed shipping</strong><p>Global server-side availability switch. Turning it off blocks new seller shipments but preserves configuration and order snapshots.</p></div><button onClick={() => patchSetting('sellerShippingEnabled', !settings.sellerShippingEnabled)}>{settings.sellerShippingEnabled ? 'Enabled' : 'Disabled'}</button></div>{([['sellerPayoutsEnabled', 'Seller payout subsystem'], ['payoutFundingConfigured', 'Funding policy configured'], ['manualBankPayoutsEnabled', 'Manual bank transfers'], ['manualEwalletPayoutsEnabled', 'Manual e-wallet transfers'], ['stripeConnectPayoutsEnabled', 'Stripe Connect'], ['paypalPayoutsEnabled', 'PayPal Payouts']] as const).map(([key, label]) => <div className="setting" key={key}><div><strong>{label}</strong><p>Server-side switch; existing records are preserved when disabled.</p></div><button onClick={() => patchSetting(key, !settings[key])}>{settings[key] ? 'Enabled' : 'Disabled'}</button></div>)}<label>Seller approval policy<select value={settings.sellerApprovalPolicy} onChange={event => patchSetting('sellerApprovalPolicy', event.target.value)}><option>MANUAL</option><option>AUTOMATIC</option></select></label><label>Product approval policy<select value={settings.productApprovalPolicy} onChange={event => patchSetting('productApprovalPolicy', event.target.value)}><option>MANUAL</option><option>AUTOMATIC</option></select></label><label>Hold days<input type="number" min="0" max="365" value={settings.payoutHoldDays} onChange={event => patchSetting('payoutHoldDays', Number(event.target.value))} /></label></div>}
    {tab === 'shipping' && shippingAdmin && <section><AdminCarriers /><h2>Seller-managed shipping</h2><p className="muted">Seller-entered service labels and fees are shown for oversight only. No carrier APIs, labels, or external quotes are connected.</p><div className="setting"><div><strong>Global shipping availability</strong><p>Disabling blocks new seller shipments without rewriting seller settings or historical order snapshots.</p></div><button onClick={() => patchSetting('sellerShippingEnabled', !shippingAdmin.enabled)}>{shippingAdmin.enabled ? 'Enabled' : 'Disabled'}</button></div>{shippingAdmin.services.length ? <div className="table">{shippingAdmin.services.map(service => <div className="row" key={service.id}><span>{service.seller.store?.name ?? 'Store'} · {service.name}</span><span>{new Intl.NumberFormat(undefined, { style: 'currency', currency: service.currency }).format(service.feeMinor / 100)}</span><span>{service.zones.map(zone => [zone.cityLabel, zone.regionLabel, zone.countryCode].filter(Boolean).join(', ')).join(' · ')}</span><strong>{service.enabled ? 'Active' : 'Disabled'}</strong></div>)}</div> : <div className="empty">No Stores have configured shipping services yet.</div>}</section>}
    {tab === 'availability' && availability && <div className="settings"><h2>Buyer availability</h2><section className="setting availabilityLanguages"><div><strong>Enabled languages</strong><p>Only bundled interface languages can be enabled here. English stays available as the fallback. This controls language choices; it does not machine-translate untranslated content.</p></div><div className="availabilityLanguageOptions">{availability.supportedLanguages.map(language => <label key={language}><input type="checkbox" checked={languageDraft.includes(language)} disabled={language === 'en'} onChange={event => setLanguageDraft(current => event.target.checked ? [...new Set([...current, language])] : current.filter(value => value !== language))} />{language === 'en' ? 'English' : 'Filipino'}</label>)}</div><button className="primary" disabled={languageDraft.length === availability.languages.length && languageDraft.every(language => availability.languages.includes(language))} onClick={() => action('/api/admin/platform/availability', { method: 'PATCH', body: JSON.stringify({ languages: languageDraft, reason: 'Updated enabled platform languages in administration' }) })}>Save language availability</button></section><div className="setting"><div><strong>Base currency</strong><p>Checkout, payment capture, and settlement remain in this currency.</p></div><span>{availability.baseCurrency}</span></div><div className="setting"><div><strong>Display currencies</strong><p>{availability.note}</p></div><span>{availability.availableDisplayCurrencies.join(', ')}</span></div><div className="setting"><div><strong>Foreign exchange</strong><p>{availability.automaticFxEnabled ? 'Automatic reference-rate fetching is enabled; only fresh rates are selectable.' : 'Automatic fetching is disabled. Administrator-approved manual rates can still enable display estimates.'}</p></div><span>{availability.fxRatesConfigured ? 'Foreign rates available' : 'Base currency only'}</span></div></div>}
    {tab === 'vendors' && <div><h2>Vendor directory</h2><div className="table">{vendors.map(v => <div className="row" key={v.id}><span>{v.store?.name ?? 'Application'} · {v.user.email}</span><select value={v.status} onChange={event => { const status = event.target.value; const reason = status === 'REJECTED' || status === 'SUSPENDED' ? window.prompt('Reason required') : undefined; if (status === 'REJECTED' || status === 'SUSPENDED') { if (!reason) return; } action(`/api/admin/sellers/${v.id}`, { method: 'PATCH', body: JSON.stringify({ status, reason }) }); }}><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>SUSPENDED</option></select></div>)}</div></div>}
    {tab === 'taxonomy' && <AdminCatalog />}
    {tab === 'reviews' && <AdminProductReviews />}
    {tab === 'platform-store' && <AdminPlatformStore />}
    {tab === 'payouts' && <div><h2>Payout readiness</h2><p className="notice">{readiness?.warning}</p><div className="heroPills"><span>Enabled: {String(readiness?.enabled)}</span><span>Funding policy: {String(readiness?.fundingConfigured)}</span><span>Manual bank: {String(readiness?.methods.manualBank)}</span><span>Connect: {String(readiness?.methods.stripeConnect)}</span></div><h2>Review queue</h2><div className="table">{payouts.map(p => <div className="row" key={p.id}><span>{p.seller.store?.name ?? 'Seller'} · {(p.amountMinor / 100).toFixed(2)} {p.currency}</span><span>{p.status}</span>{p.status === 'REQUESTED' && <button onClick={() => action(`/api/admin/payouts/${p.id}/approve`, { method: 'POST', body: '{}' })}>Approve</button>}</div>)}</div><p className="muted">Manual payouts require an evidence reference before they can be marked paid. Connect and PayPal Payouts remain unavailable until provider eligibility, credentials, webhooks, and sandbox verification are completed.</p></div>}
    {tab === 'plans' && <StorePlanAdmin />}
    {tab === 'affiliate' && <AffiliateAdmin />}
    {tab === 'store-growth' && <AdminStoreGrowth />}
    {tab === 'promotions' && <AdminPromotions />}
    {tab === 'providers' && <AdminIntegrations section="providers" />}
    {tab === 'methods' && <AdminIntegrations section="methods" />}
    {tab === 'webhooks' && <AdminOperations />}
    </>}
  </main></div></section>;
}
