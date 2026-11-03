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
import { JimaAdmin } from './JimaAdmin.js';
import { AdminSocialAuth } from './AdminSocialAuth.js';
import { AdminOnboardingReadiness } from './AdminOnboardingReadiness.js';
import { MarketplaceAds } from './MarketplaceAds.js';
import { useSession } from './session.js';
import { PlatformCollaborators } from './PlatformCollaborators.js';
import { SiteChromeBuilder } from './SiteChromeBuilder.js';
import { StoreThemesAdmin } from './StoreThemesAdmin.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const timeoutSignal = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options, signal });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? (undefined as T) : response.json();
}

type Settings = { sellerShippingEnabled: boolean; sellerApprovalPolicy: string; productApprovalPolicy: string; sellerPayoutsEnabled: boolean; payoutFundingConfigured: boolean; manualBankPayoutsEnabled: boolean; manualEwalletPayoutsEnabled: boolean; stripeConnectPayoutsEnabled: boolean; paypalPayoutsEnabled: boolean; payoutHoldDays: number; payoutMinimumMinor: number };
type ShippingAdmin = { enabled: boolean; services: { id: string; name: string; enabled: boolean; feeMinor: number; currency: string; seller: { store?: { name: string } }; zones: { countryCode: string; regionLabel: string | null; cityLabel: string | null }[] }[] };
type Branding = { platformName: string; shortName: string; description: string; seoDescription: string; tagline: string; logoMediaId: string | null; alternateLogoMediaId: string | null; faviconMediaId: string | null; defaultAvatarMediaId: string | null; socialImageMediaId: string | null; supportEmail: string | null; supportUrl: string | null };
type Availability = { languages: string[]; supportedLanguages: string[]; baseCurrency: string; availableDisplayCurrencies: string[]; fxRatesConfigured: boolean; automaticFxEnabled: boolean; note: string };
type AdminOrder = { id: string; orderNumber: string; status: string; totalMinor: number; currency: string; createdAt: string; payment?: { method: string; status: string } | null; sellerOrders?: { id: string; shippingSnapshotJson?: { serviceName: string; shippingMinor: number; currency: string } | null; seller?: { store?: { name: string } | null } | null }[] };
type AuditEntry = { id: string; action: string; entity: string; entityId: string; createdAt: string; actor: { name: string | null; email: string } | null };
type AdminResource = 'branding' | 'settings' | 'availability' | 'vendors' | 'readiness' | 'payouts' | 'orders' | 'audit' | 'shipping';
type AdminResourceStatus = 'loading' | 'ready' | 'error';

const adminNavigation = [
  { group: 'Overview', items: [{ id: 'overview', label: 'Overview' }] },
  { group: 'Marketplace', items: [{ id: 'orders', label: 'Orders' }, { id: 'taxonomy', label: 'Catalog & categories' }, { id: 'reviews', label: 'Product reviews' }, { id: 'vendors', label: 'Sellers & stores' }, { id: 'platform-store', label: 'Official platform Store' }, { id: 'shipping', label: 'Seller-managed shipping' }, { id: 'live-shopping', label: 'Live shopping' }] },
  { group: 'Plans and billing', items: [{ id: 'plans', label: 'Store plans' }] },
  { group: 'Payments', items: [{ id: 'methods', label: 'Payment methods' }, { id: 'transactions', label: 'Transactions' }, { id: 'commissions', label: 'Seller commissions' }, { id: 'payouts', label: 'Seller payouts' }, { id: 'refunds', label: 'Refunds & disputes' }, { id: 'wallet', label: 'Platform wallet & Club Coins' }] },
  { group: 'Growth', items: [{ id: 'affiliate', label: 'Affiliate program' }, { id: 'store-growth', label: 'Store Buster & email' }, { id: 'promotions', label: 'Promotions & ads' }, { id: 'marketplace-ads', label: 'Wallet-funded marketplace ads' }] },
  { group: 'Members and security', items: [{ id: 'members', label: 'Members & security' }, { id: 'auth', label: 'Sign-in & social login' }, { id: 'onboarding', label: 'Onboarding readiness' }, { id: 'team', label: 'Platform team' }] },
  { group: 'Support and messaging', items: [{ id: 'support', label: 'Support & messaging' }] },
  { group: 'AI operations', items: [{ id: 'jima', label: 'Jima System AI' }] },
  { group: 'Integrations & APIs', items: [{ id: 'providers', label: 'Provider configurations' }, { id: 'webhooks', label: 'Webhooks & API status' }] },
  { group: 'Platform settings', items: [{ id: 'branding', label: 'Branding' }, { id: 'themes', label: 'Themes & templates' }, { id: 'chrome', label: 'Header & footer' }, { id: 'settings', label: 'Policies' }, { id: 'availability', label: 'Availability & localization' }, { id: 'currencies', label: 'Currency catalog & FX' }] },
  { group: 'Governance', items: [{ id: 'audit', label: 'Audit log' }] }
];

const defaultBranding: Branding = { platformName: 'Market Lane', shortName: 'Market Lane', description: '', seoDescription: '', tagline: '', logoMediaId: null, alternateLogoMediaId: null, faviconMediaId: null, defaultAvatarMediaId: null, socialImageMediaId: null, supportEmail: null, supportUrl: null };

const sectionPermission: Record<string, string> = {
  overview: 'OVERVIEW', orders: 'MARKETPLACE', taxonomy: 'MARKETPLACE', reviews: 'MARKETPLACE', vendors: 'MARKETPLACE', 'platform-store': 'MARKETPLACE', shipping: 'MARKETPLACE', 'live-shopping': 'MARKETPLACE',
  plans: 'PLANS_BILLING', methods: 'PAYMENTS', transactions: 'PAYMENTS', commissions: 'PAYMENTS', payouts: 'PAYMENTS', refunds: 'PAYMENTS', wallet: 'WALLET_MANAGEMENT', coins: 'WALLET_MANAGEMENT',
  affiliate: 'GROWTH', 'store-growth': 'GROWTH', promotions: 'GROWTH', 'marketplace-ads': 'GROWTH', members: 'MEMBERS_SECURITY', auth: 'MEMBERS_SECURITY', onboarding: 'MEMBERS_SECURITY', support: 'SUPPORT_MESSAGING', jima: 'AI_OPERATIONS', providers: 'INTEGRATIONS', webhooks: 'INTEGRATIONS', branding: 'PLATFORM_SETTINGS', settings: 'PLATFORM_SETTINGS', availability: 'PLATFORM_SETTINGS', currencies: 'PLATFORM_SETTINGS', audit: 'GOVERNANCE'
};

function permittedSection(id: string, isAdmin: boolean, permissions: string[]) {
  if (id === 'chrome' || id === 'themes') return isAdmin;
  if (id === 'team') return isAdmin;
  if (id === 'settings') return isAdmin || permissions.includes('MARKETPLACE') || permissions.includes('PAYMENTS');
  const permission = sectionPermission[id];
  return isAdmin || Boolean(permission && permissions.includes(permission));
}

export function PlatformAdmin() {
  const { user } = useSession();
  const isAdmin = user?.role === 'ADMIN';
  const permissions = user?.platformPermissions ?? [];
  const visibleNavigation = adminNavigation.map(group => ({ ...group, items: group.items.filter(item => permittedSection(item.id, isAdmin, permissions)) })).filter(group => group.items.length > 0);
  const requestedSection = window.location.pathname === '/admin/themes' ? 'themes' : new URLSearchParams(window.location.search).get('section');
  const supportedSections = ['overview', 'orders', 'taxonomy', 'reviews', 'vendors', 'platform-store', 'shipping', 'live-shopping', 'plans', 'methods', 'transactions', 'commissions', 'payouts', 'refunds', 'affiliate', 'store-growth', 'promotions', 'marketplace-ads', 'wallet', 'coins', 'members', 'auth', 'onboarding', 'team', 'support', 'jima', 'providers', 'webhooks', 'branding', 'themes', 'chrome', 'settings', 'availability', 'currencies', 'audit'];
  const firstAllowedSection = visibleNavigation[0]?.items[0]?.id ?? '';
  const requestedTab = requestedSection === 'integrations' ? 'providers' : requestedSection === 'coins' ? 'wallet' : requestedSection;
  const initialTab = requestedTab && supportedSections.includes(requestedTab) && permittedSection(requestedTab, isAdmin, permissions) ? requestedTab : firstAllowedSection;
  const [tab, setTab] = useState(initialTab);
  const [resourceErrors, setResourceErrors] = useState<Partial<Record<AdminResource, string>>>({});
  const [resourceStatus, setResourceStatus] = useState<Record<AdminResource, AdminResourceStatus>>({ branding: 'loading', settings: 'loading', availability: 'loading', vendors: 'loading', readiness: 'loading', payouts: 'loading', orders: 'loading', audit: 'loading', shipping: 'loading' });
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
  const [provisioningSellerId, setProvisioningSellerId] = useState('');

  function updateBranding<K extends keyof Branding>(key: K, value: Branding[K]) {
    brandingRevision.current += 1;
    setBranding(current => ({ ...current, [key]: value }));
  }

  const load = async (): Promise<AdminResource[]> => {
    const requestId = ++latestLoadRequest.current;
    const draftRevision = brandingRevision.current;
    setResourceStatus(current => Object.fromEntries((Object.keys(current) as AdminResource[]).map(key => [key, current[key] === 'ready' ? 'ready' : 'loading'])) as Record<AdminResource, AdminResourceStatus>);
    const read = async <T,>(key: AdminResource, request: Promise<T>, update: (value: T) => void): Promise<AdminResource | null> => {
      try {
        const value = await request;
        if (requestId !== latestLoadRequest.current) return null;
        update(value);
        setResourceErrors(current => { const next = { ...current }; delete next[key]; return next; });
        setResourceStatus(current => ({ ...current, [key]: 'ready' }));
        return null;
      } catch (error) {
        if (requestId !== latestLoadRequest.current) return null;
        setResourceErrors(current => ({ ...current, [key]: error instanceof Error ? error.message : 'This data source could not be loaded.' }));
        setResourceStatus(current => ({ ...current, [key]: 'error' }));
        return key;
      }
    };
    const tasks: Promise<AdminResource | null>[] = [];
    if (permittedSection('branding', isAdmin, permissions)) {
      tasks.push(read('branding', api<{ draftJson?: Branding; publishedJson?: Branding | null }>('/api/admin/platform/branding'), value => { setBranding(current => brandingRevision.current === draftRevision ? value.draftJson ?? defaultBranding : current); setPublishedBranding(value.publishedJson ?? null); }));
      tasks.push(read('availability', api<Availability>('/api/admin/platform/availability'), setAvailability));
    }
    if (isAdmin || permissions.includes('MARKETPLACE') || permissions.includes('PAYMENTS')) tasks.push(read('settings', api<Settings>('/api/admin/platform/settings'), setSettings));
    if (permittedSection('vendors', isAdmin, permissions)) tasks.push(read('vendors', api<{ items: typeof vendors }>('/api/admin/vendors'), value => setVendors(value.items)));
    if (permittedSection('payouts', isAdmin, permissions)) {
      tasks.push(read('readiness', api<typeof readiness>('/api/admin/payout-readiness'), setReadiness));
      tasks.push(read('payouts', api<typeof payouts>('/api/admin/payouts'), setPayouts));
    }
    if (permittedSection('orders', isAdmin, permissions)) tasks.push(read('orders', api<AdminOrder[]>('/api/admin/orders'), setOrders));
    if (permittedSection('audit', isAdmin, permissions)) tasks.push(read('audit', api<AuditEntry[]>('/api/admin/audit'), setAuditEntries));
    if (permittedSection('shipping', isAdmin, permissions)) tasks.push(read('shipping', api<ShippingAdmin>('/api/admin/shipping'), setShippingAdmin));
    const failed = await Promise.all(tasks);
    return failed.filter((key): key is AdminResource => key !== null);
  };
  const loadInitial = async () => {
    try {
      const failed = await load();
      setMessage(failed.length ? `${failed.length} data source(s) could not be loaded. Other modules remain available; retry the affected section.` : '');
    }
    catch (error) { setMessage((error as Error).message); }
  };
  useEffect(() => { if (initialLoadStarted.current) return; initialLoadStarted.current = true; void loadInitial(); }, []);
  useEffect(() => { if (availability) setLanguageDraft(availability.languages); }, [availability]);
  const action = async (path: string, options: RequestInit = {}) => { try { await api(path, options); const failed = await load(); setMessage(failed.length ? `Saved. ${failed.length} data source(s) could not be refreshed; retry the affected section.` : 'Saved'); } catch (error) { setMessage((error as Error).message); } };
  const provisionSellerStore = async (sellerId: string) => {
    setProvisioningSellerId(sellerId);
    try {
      const result = await api<{ created: boolean }>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/provision-store`, { method: 'POST', body: '{}' });
      const failed = await load();
      setMessage(result.created ? `Store provisioned for the approved seller.${failed.length ? ` ${failed.length} data source(s) could not be refreshed.` : ''}` : 'The seller Store already exists; directory data refreshed.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setProvisioningSellerId(''); }
  };
  const refreshAdminData = async () => { try { const failed = await load(); setMessage(failed.length ? `Refreshed available data. ${failed.length} source(s) still need attention.` : 'Dashboard data refreshed.'); } catch (error) { setMessage((error as Error).message); } };
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
  const selectTab = (next: string) => { if (!permittedSection(next, isAdmin, permissions)) return; setTab(next); const url = new URL(window.location.href); url.searchParams.set('section', next); window.history.replaceState({}, '', url); };
  const navigateToSection = (id: string) => {
    if (id === 'wallet' || id === 'coins') { if (permittedSection('wallet', isAdmin, permissions)) window.location.assign('/admin/wallet'); return; }
    if (id === 'currencies') { window.location.assign('/admin/currencies'); return; }
    if (id === 'commissions') { window.location.assign('/admin/commissions'); return; }
    selectTab(id);
  };
  const pendingSellers = vendors.filter(vendor => vendor.status === 'PENDING').length;
  const requestedPayouts = payouts.filter(payout => payout.status === 'REQUESTED').length;
  const formatMoney = (minor: number, currency: string) => formatMinor(minor, currency);
  const metricValue = (key: AdminResource, value: number) => resourceStatus[key] === 'ready' ? value : resourceStatus[key] === 'loading' ? '…' : '—';
  const resourceFallback = (key: AdminResource, label: string) => resourceStatus[key] === 'loading'
    ? <div className="adminModuleLoading" role="status" aria-busy="true">Loading {label}…</div>
    : resourceErrors[key] ? <AdminDataUnavailable label={label} error={resourceErrors[key]!} onRetry={() => void refreshAdminData()} /> : null;
  useEffect(() => { if (tab && !permittedSection(tab, isAdmin, permissions)) selectTab(firstAllowedSection); }, [tab, isAdmin, user?.id, permissions.join(','), firstAllowedSection]);
  return <section className="page adminControlCenter"><p className="eyebrow">{isAdmin ? 'Platform administration' : `${user?.platformPositionName ?? user?.platformPosition?.replaceAll('_', ' ') ?? 'Team'} workspace`}</p><h1>{isAdmin ? 'Control center' : 'Team workspace'}</h1><p className="muted">{isAdmin ? 'Manage implemented marketplace operations and review areas that are still gated or planned.' : 'You can access only the modules assigned to your platform account. Contact an administrator if you need a different access level.'}</p>{message && <p className="notice" role="status">{message}</p>}
    <div className="adminControlLayout">
      {visibleNavigation.length > 0 && <><div className="adminMobileNav"><label htmlFor="admin-section-jump">Jump to module</label><select id="admin-section-jump" value={tab} onChange={event => navigateToSection(event.target.value)}>{visibleNavigation.map(group => <optgroup label={group.group} key={group.group}>{group.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select><small>Choose a section to open its tools and settings.</small></div>
      <nav className="adminControlNav" aria-label="Platform administration sections">{visibleNavigation.map(group => <div className="adminNavGroup" key={group.group}><h2>{group.group}</h2>{group.items.map(item => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => navigateToSection(item.id)}>{item.label}</button>)}</div>)}</nav></>}
      <main className="adminControlMain" aria-live="polite">
    {!visibleNavigation.length && <div className="empty">No platform modules are assigned to this account. Contact a platform administrator for access.</div>}
    {Object.keys(resourceErrors).length > 0 && <div className="adminPartialLoad notice" role="status"><div><strong>Some administration data is temporarily unavailable.</strong><p>Other modules remain usable. Retry a section below, or refresh all control-center data.</p></div><button type="button" onClick={() => void refreshAdminData()}>Retry unavailable data</button></div>}
    {tab === 'overview' && <div><p className="eyebrow">At a glance</p><h2>Marketplace operations</h2><div className="adminMetricGrid">{permittedSection('orders', isAdmin, permissions) && <article className="card cardBody"><strong>{metricValue('orders', orders.length)}</strong><span>Recent orders{resourceErrors.orders ? ' · Unavailable' : ''}</span></article>}{permittedSection('vendors', isAdmin, permissions) && <><article className="card cardBody"><strong>{metricValue('vendors', vendors.length)}</strong><span>Seller records{resourceErrors.vendors ? ' · Unavailable' : ''}</span></article><article className="card cardBody"><strong>{metricValue('vendors', pendingSellers)}</strong><span>Seller applications pending review</span></article></>}{permittedSection('payouts', isAdmin, permissions) && <article className="card cardBody"><strong>{metricValue('payouts', requestedPayouts)}</strong><span>Payout requests awaiting review{resourceErrors.payouts ? ' · Unavailable' : ''}</span></article>}</div><div className="notice"><strong>Financial boundary:</strong> buyer checkout collects for the platform merchant account; seller payouts remain a separate, manually reviewed workflow. Store-plan checkout is disabled.</div></div>}
    {tab === 'orders' && <section><h2>Marketplace orders</h2><p className="muted">Recent order and payment status from the existing admin order API. Shipping totals are included in each buyer-facing order total.</p>{resourceFallback('orders', 'order data') ?? (orders.length ? <div className="table">{orders.map(order => <div className="row adminOrderRow" key={order.id}><strong>{order.orderNumber}</strong><span>{order.status}</span><span>{order.payment?.method ?? '—'} · {order.payment?.status ?? 'No payment record'}</span><span>{order.sellerOrders?.filter(shipment => shipment.shippingSnapshotJson).map(shipment => `${shipment.seller?.store?.name ?? 'Store'}: ${shipment.shippingSnapshotJson!.serviceName} ${formatMoney(shipment.shippingSnapshotJson!.shippingMinor, shipment.shippingSnapshotJson!.currency)}`).join(' · ') || 'No seller shipping'}</span><strong>{formatMoney(order.totalMinor, order.currency)}</strong></div>)}</div> : <div className="empty">No marketplace orders yet.</div>)}</section>}
    {tab === 'transactions' && <section><h2>Transactions</h2><p className="muted">Transaction visibility is provided through marketplace order records. Use Refunds &amp; disputes for buyer cases and webhook-backed refund settlement evidence.</p>{resourceFallback('orders', 'transaction data') ?? (orders.length ? <div className="table">{orders.map(order => <div className="row adminOrderRow" key={order.id}><strong>{order.orderNumber}</strong><span>{order.payment?.method ?? '—'}</span><span>{order.payment?.status ?? 'No payment record'}</span><strong>{formatMoney(order.totalMinor, order.currency)}</strong></div>)}</div> : <div className="empty">No transaction records yet.</div>)}</section>}
    {tab === 'refunds' && <OrderResolutionAdmin />}
    {tab === 'live-shopping' && <AdminLiveShopping />}
    {tab === 'support' && <SupportDesk mode="admin" />}
    {tab === 'jima' && <JimaAdmin />}
    {tab === 'members' && <AdminMembers />}
    {tab === 'team' && isAdmin && <PlatformCollaborators />}
    {tab === 'auth' && <AdminSocialAuth />}
    {tab === 'onboarding' && <AdminOnboardingReadiness />}
    {tab === 'audit' && <section><h2>Audit log</h2><p className="muted">Recent privileged actions. Sensitive metadata and credential references are intentionally omitted from this view.</p>{resourceFallback('audit', 'audit history') ?? (auditEntries.length ? <div className="table">{auditEntries.map(entry => <div className="row adminAuditRow" key={entry.id}><strong>{entry.action}</strong><span>{entry.entity}</span><span>{entry.actor?.name || entry.actor?.email || 'System'}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></div>)}</div> : <div className="empty">No audit entries yet.</div>)}</section>}
    {tab === 'branding' && (resourceFallback('branding', 'branding settings') ?? <div className="brandingEditor"><h2>Platform branding</h2><p className="muted">Changes are saved as a draft first. Publish makes them public. Uploaded assets stay private until approved by scanning; a pending or rejected image cannot replace the current public identity.</p>
      <div className="two">
        <div className="narrow"><label>Platform name<input value={branding.platformName} onChange={event => updateBranding('platformName', event.target.value)} /></label><label>Short name<input value={branding.shortName} onChange={event => updateBranding('shortName', event.target.value)} /></label><label>Description<textarea value={branding.description} onChange={event => updateBranding('description', event.target.value)} /></label><label>SEO description<textarea value={branding.seoDescription} onChange={event => updateBranding('seoDescription', event.target.value)} /></label><label>Tagline<input value={branding.tagline} onChange={event => updateBranding('tagline', event.target.value)} /></label><label>Support email<input type="email" value={branding.supportEmail ?? ''} onChange={event => updateBranding('supportEmail', event.target.value || null)} /></label><label>Support URL<input type="url" value={branding.supportUrl ?? ''} onChange={event => updateBranding('supportUrl', event.target.value || null)} /></label></div>
        <div className="brandingImageGrid">
          {([['logoMediaId', 'Primary logo', 3], ['alternateLogoMediaId', 'Alternate logo', 3], ['faviconMediaId', 'Favicon', 1], ['defaultAvatarMediaId', 'Default profile avatar', 1], ['socialImageMediaId', 'Social sharing image', 1.91]] as const).map(([key, label, ratio]) => <BrandingImageControl key={key} label={label} ratio={ratio} value={branding[key]} publishedValue={publishedBranding ? publishedBranding[key] : null} onChange={id => updateBranding(key, id)} listUrl="/api/admin/platform/branding-media" uploadUrl="/api/admin/platform/branding-media/uploads" previewUrl={id => `/api/admin/platform/branding-media/${encodeURIComponent(id)}/preview`} />)}
        </div>
      </div>
      <div className="toolbar"><button className="primary" disabled={brandingSaving} onClick={() => void saveBrandingDraft()}>{brandingSaving ? 'Saving…' : 'Save branding draft'}</button><button disabled={brandingSaving} onClick={() => { if (window.confirm('Save these edits and publish this branding version? Only approved images will be made public; pending replacements are rejected and the current branding remains active.')) void publishBranding(); }}>{brandingSaving ? 'Saving…' : 'Save and publish branding'}</button></div>
    </div>)}
    {tab === 'chrome' && isAdmin && <SiteChromeBuilder scope="platform" />}
    {tab === 'themes' && isAdmin && <StoreThemesAdmin />}
    {tab === 'settings' && <AdminPolicySettings settings={settings} isAdmin={isAdmin} permissions={permissions} patch={patchSetting} fallback={resourceFallback('settings', 'platform policies')} />}
    {tab === 'shipping' && (resourceFallback('shipping', 'seller shipping data') ?? (shippingAdmin && <section><AdminCarriers /><h2>Seller-managed shipping</h2><p className="muted">Seller-entered service labels and fees are shown for oversight only. No carrier APIs, labels, or external quotes are connected.</p><div className="setting"><div><strong>Global shipping availability</strong><p>Disabling blocks new seller shipments without rewriting seller settings or historical order snapshots.</p></div><button onClick={() => patchSetting('sellerShippingEnabled', !shippingAdmin.enabled)}>{shippingAdmin.enabled ? 'Enabled' : 'Disabled'}</button></div>{shippingAdmin.services.length ? <div className="table">{shippingAdmin.services.map(service => <div className="row" key={service.id}><span>{service.seller.store?.name ?? 'Store'} · {service.name}</span><span>{new Intl.NumberFormat(undefined, { style: 'currency', currency: service.currency }).format(service.feeMinor / 100)}</span><span>{service.zones.map(zone => [zone.cityLabel, zone.regionLabel, zone.countryCode].filter(Boolean).join(', ')).join(' · ')}</span><strong>{service.enabled ? 'Active' : 'Disabled'}</strong></div>)}</div> : <div className="empty">No Stores have configured shipping services yet.</div>}</section>))}
    {tab === 'availability' && (resourceFallback('availability', 'availability settings') ?? (availability && <div className="settings"><h2>Buyer availability</h2><section className="setting availabilityLanguages"><div><strong>Enabled languages</strong><p>Only bundled interface languages can be enabled here. English stays available as the fallback. This controls language choices; it does not machine-translate untranslated content.</p></div><div className="availabilityLanguageOptions">{availability.supportedLanguages.map(language => <label key={language}><input type="checkbox" checked={languageDraft.includes(language)} disabled={language === 'en'} onChange={event => setLanguageDraft(current => event.target.checked ? [...new Set([...current, language])] : current.filter(value => value !== language))} />{language === 'en' ? 'English' : 'Filipino'}</label>)}</div><button className="primary" disabled={languageDraft.length === availability.languages.length && languageDraft.every(language => availability.languages.includes(language))} onClick={() => action('/api/admin/platform/availability', { method: 'PATCH', body: JSON.stringify({ languages: languageDraft, reason: 'Updated enabled platform languages in administration' }) })}>Save language availability</button></section><div className="setting"><div><strong>Base currency</strong><p>Checkout, payment capture, and settlement remain in this currency.</p></div><span>{availability.baseCurrency}</span></div><div className="setting"><div><strong>Display currencies</strong><p>{availability.note}</p></div><span>{availability.availableDisplayCurrencies.join(', ')}</span></div><div className="setting"><div><strong>Foreign exchange</strong><p>{availability.automaticFxEnabled ? 'Automatic reference-rate fetching is enabled; only fresh rates are selectable.' : 'Automatic fetching is disabled. Administrator-approved manual rates can still enable display estimates.'}</p></div><span>{availability.fxRatesConfigured ? 'Foreign rates available' : 'Base currency only'}</span></div></div>))}
    {tab === 'vendors' && <div><h2>Vendor directory</h2>{resourceFallback('vendors', 'seller and store records') ?? <div className="table">{vendors.map(v => <div className="row" key={v.id}><span>{v.store?.name ?? (v.status === 'APPROVED' ? 'Approved · Store setup incomplete' : 'Application')} · {v.user.email}</span><div className="toolbar">{v.status === 'APPROVED' && !v.store && <button type="button" disabled={Boolean(provisioningSellerId)} onClick={() => void provisionSellerStore(v.id)}>{provisioningSellerId === v.id ? 'Provisioning…' : 'Provision Store'}</button>}<select aria-label={`Seller status for ${v.user.email}`} value={v.status} onChange={event => { const status = event.target.value; const reason = status === 'REJECTED' || status === 'SUSPENDED' ? window.prompt('Reason required') : undefined; if (status === 'REJECTED' || status === 'SUSPENDED') { if (!reason) return; } action(`/api/admin/sellers/${v.id}`, { method: 'PATCH', body: JSON.stringify({ status, reason }) }); }}><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>SUSPENDED</option></select></div></div>)}</div>}</div>}
    {tab === 'taxonomy' && <AdminCatalog />}
    {tab === 'reviews' && <AdminProductReviews />}
    {tab === 'platform-store' && <AdminPlatformStore />}
    {tab === 'payouts' && <div><h2>Payout readiness</h2>{resourceFallback('readiness', 'payout readiness') ?? (readiness && <><p className="notice">{readiness.warning}</p><div className="heroPills"><span>Enabled: {String(readiness.enabled)}</span><span>Funding policy: {String(readiness.fundingConfigured)}</span><span>Manual bank: {String(readiness.methods.manualBank)}</span><span>Connect: {String(readiness.methods.stripeConnect)}</span></div></>)}<h2>Review queue</h2>{resourceFallback('payouts', 'payout requests') ?? <div className="table">{payouts.length ? payouts.map(p => <div className="row" key={p.id}><span>{p.seller.store?.name ?? 'Seller'} · {(p.amountMinor / 100).toFixed(2)} {p.currency}</span><span>{p.status}</span>{p.status === 'REQUESTED' && <button onClick={() => action(`/api/admin/payouts/${p.id}/approve`, { method: 'POST', body: '{}' })}>Approve</button>}</div>) : <div className="empty">No payout requests are waiting for review.</div>}</div>}<p className="muted">Manual payouts require an evidence reference before they can be marked paid. Connect and PayPal Payouts remain unavailable until provider eligibility, credentials, webhooks, and sandbox verification are completed.</p></div>}
    {tab === 'plans' && <StorePlanAdmin />}
    {tab === 'affiliate' && <AffiliateAdmin />}
    {tab === 'store-growth' && <AdminStoreGrowth />}
    {tab === 'promotions' && <AdminPromotions />}
    {tab === 'marketplace-ads' && <MarketplaceAds admin />}
    {tab === 'providers' && <AdminIntegrations section="providers" />}
    {tab === 'methods' && <AdminIntegrations section="methods" />}
    {tab === 'webhooks' && <AdminOperations />}
  </main></div></section>;
}

function AdminPolicySettings({ settings, isAdmin, permissions, patch, fallback }: {
  settings: Settings | null;
  isAdmin: boolean;
  permissions: string[];
  patch: (key: keyof Settings, value: boolean | number | string) => void;
  fallback: React.ReactNode;
}) {
  if (!settings) return <>{fallback ?? <div className="empty">Policy settings are not available yet.</div>}</>;
  const canMarketplace = isAdmin || permissions.includes('MARKETPLACE');
  const canPayments = isAdmin || permissions.includes('PAYMENTS');
  return <section className="settings">
    <h2>Platform policies</h2>
    <p className="muted">Only the policy groups assigned to your account are shown here. Every change is recorded in the platform audit log.</p>
    {canMarketplace && <>
      <div className="setting"><div><strong>Seller-managed shipping</strong><p>Turning this off blocks new seller shipments but preserves configuration and historical order snapshots.</p></div><button onClick={() => patch('sellerShippingEnabled', !settings.sellerShippingEnabled)}>{settings.sellerShippingEnabled ? 'Enabled' : 'Disabled'}</button></div>
      <label>Seller approval policy<select value={settings.sellerApprovalPolicy} onChange={event => patch('sellerApprovalPolicy', event.target.value)}><option>MANUAL</option><option>AUTOMATIC</option></select></label>
      <label>Product approval policy<select value={settings.productApprovalPolicy} onChange={event => patch('productApprovalPolicy', event.target.value)}><option>MANUAL</option><option>AUTOMATIC</option></select></label>
    </>}
    {canPayments && <>
      {([['sellerPayoutsEnabled', 'Seller payout subsystem'], ['payoutFundingConfigured', 'Funding policy configured'], ['manualBankPayoutsEnabled', 'Manual bank transfers'], ['manualEwalletPayoutsEnabled', 'Manual e-wallet transfers'], ['stripeConnectPayoutsEnabled', 'Stripe Connect'], ['paypalPayoutsEnabled', 'PayPal Payouts']] as const).map(([key, label]) => <div className="setting" key={key}><div><strong>{label}</strong><p>Server-side switch; existing records are preserved when disabled.</p></div><button onClick={() => patch(key, !settings[key])}>{settings[key] ? 'Enabled' : 'Disabled'}</button></div>)}
      <label>Payout hold days<input type="number" min="0" max="365" value={settings.payoutHoldDays} onChange={event => patch('payoutHoldDays', Number(event.target.value))} /></label>
    </>}
  </section>;
}

function AdminDataUnavailable({ label, error, onRetry }: { label: string; error: string; onRetry: () => void }) {
  return <div className="adminResourceUnavailable" role="alert"><div><strong>{label} could not be loaded.</strong><p>{error}</p><small>Your existing data has not been changed.</small></div><button type="button" onClick={onRetry}>Retry section</button></div>;
}
