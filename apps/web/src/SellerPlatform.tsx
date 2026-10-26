import React, { useEffect, useRef, useState } from 'react';
import { BrandingImageControl } from './BrandingImageControl.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? (undefined as T) : response.json();
}

const slugPreview = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
type Theme = { themePreset: string; mobileTemplate: string; description: string; primaryColor: string; accentColor: string; font: string; sections: { type: 'featuredProducts'; title: string; productIds: string[] }[]; contactLinks: { label: string; url: string }[]; logoMediaId: string | null; faviconMediaId: string | null; bannerMediaId: string | null };
type StorePlanEntitlements = { allowedThemes: string[]; mobileTemplates: string[] };
type StoreNameChanges = { limit: number | null; used: number; remaining: number | null; resetsAt: string | null; unlimited: boolean };
type SellerPayoutMethod = { id: string; type: string; status: string; country: string; currency: string; label: string; maskedIdentifier: string | null; providerConfigured: boolean; providerStatus: string | null; isDefault: boolean; createdAt: string; updatedAt: string };
const emptyTheme: Theme = { themePreset: 'CLASSIC', mobileTemplate: 'RESPONSIVE_STANDARD', description: '', primaryColor: '#1f6f5b', accentColor: '#e7b75a', font: 'system', sections: [], contactLinks: [], logoMediaId: null, faviconMediaId: null, bannerMediaId: null };

export function SellerPlatform() {
  const [storeName, setStoreName] = useState('');
  const [slug, setSlug] = useState('');
  const [theme, setTheme] = useState<Theme>(emptyTheme);
  const [publishedTheme, setPublishedTheme] = useState<Theme | null>(null);
  const [brandingStaff, setBrandingStaff] = useState<{ userId: string; canManageStoreBranding: boolean; canManageShipping: boolean; canManageCurrency: boolean; user: { name: string | null; email: string } }[]>([]);
  const [methods, setMethods] = useState<SellerPayoutMethod[]>([]);
  const [planEntitlements, setPlanEntitlements] = useState<StorePlanEntitlements>({ allowedThemes: ['CLASSIC', 'EDITORIAL', 'BOUTIQUE'], mobileTemplates: ['RESPONSIVE_STANDARD', 'MOBILE_COMPACT', 'MOBILE_EDITORIAL'] });
  const [nameChanges, setNameChanges] = useState<StoreNameChanges>({ limit: 3, used: 0, remaining: 3, resetsAt: null, unlimited: false });
  const [savingAppearance, setSavingAppearance] = useState(false);
  const [savingPayoutMethod, setSavingPayoutMethod] = useState(false);
  const [message, setMessage] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const initialLoadStarted = useRef(false);

  const load = async () => {
    const [current, payoutMethods, plan, staff] = await Promise.all([
      api<{ name: string; slug: string; draft: Theme; published: Theme | null; nameChanges: StoreNameChanges }>('/api/seller/store-theme'),
      api<typeof methods>('/api/seller/payout-methods'),
      api<{ entitlements: StorePlanEntitlements }>('/api/seller/plan'),
      api<typeof brandingStaff>('/api/seller/store-branding/staff').catch(() => [])
    ]);
    setStoreName(current.name);
    setSlug(current.slug);
    setTheme({ ...emptyTheme, ...current.draft });
    setPublishedTheme(current.published ? { ...emptyTheme, ...current.published } : null);
    setMethods(payoutMethods);
    setPlanEntitlements(plan.entitlements);
    setNameChanges(current.nameChanges);
    setBrandingStaff(staff);
  };
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    load().catch(error => setMessage(error.message)).finally(() => setInitialLoading(false));
  }, []);

  const saveTheme = async (publish = false) => {
    setSavingAppearance(true);
    setMessage(publish ? 'Saving and publishing Store appearance…' : 'Saving Store appearance draft…');
    let draftSaved = false;
    let themePublished = false;
    try {
      const saved = await api<{ slug: string }>('/api/seller/store-theme', { method: 'PUT', body: JSON.stringify({ ...theme, name: storeName }) });
      draftSaved = true;
      setSlug(saved.slug);
      if (publish) {
        await api('/api/seller/store-theme/publish', { method: 'POST', body: '{}' });
        themePublished = true;
      }
      const current = await api<{ name: string; slug: string; draft: Theme; published: Theme | null; nameChanges: StoreNameChanges }>('/api/seller/store-theme');
      setStoreName(current.name);
      setSlug(current.slug);
      setTheme({ ...emptyTheme, ...current.draft });
      setPublishedTheme(current.published ? { ...emptyTheme, ...current.published } : null);
      setNameChanges(current.nameChanges);
      setMessage(publish ? 'Store settings and theme published' : 'Store settings draft saved');
    } catch (error) {
      if (draftSaved) {
        try {
          const current = await api<{ name: string; slug: string; draft: Theme; published: Theme | null; nameChanges: StoreNameChanges }>('/api/seller/store-theme');
          setStoreName(current.name);
          setSlug(current.slug);
          setTheme({ ...emptyTheme, ...current.draft });
          setPublishedTheme(current.published ? { ...emptyTheme, ...current.published } : null);
          setNameChanges(current.nameChanges);
        } catch { /* Keep the confirmed server save state message below. */ }
        setMessage(themePublished ? 'Store appearance was published, but the page could not refresh its saved state.' : `Store appearance draft was saved, but ${publish ? 'publishing failed' : 'the page could not refresh'}: ${(error as Error).message}`);
      } else setMessage(`Store appearance was not saved: ${(error as Error).message}`);
    } finally { setSavingAppearance(false); }
  };
  const addMethod = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSavingPayoutMethod(true);
    setMessage('Saving payout method…');
    try {
      const form = new FormData(formElement);
      const saved = await api<SellerPayoutMethod>('/api/seller/payout-methods', { method: 'POST', body: JSON.stringify({ type: form.get('type'), country: form.get('country'), currency: form.get('currency'), label: form.get('label'), identifier: form.get('identifier'), details: { accountHolder: String(form.get('accountHolder') ?? '') } }) });
      setMethods(current => [saved, ...current.filter(method => method.id !== saved.id)]);
      formElement.reset();
      setMessage('Payout method saved; only a masked identifier is shown here.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSavingPayoutMethod(false); }
  };

  const previewSlug = slugPreview(storeName);
  const nameChangeHint = nameChanges.unlimited
    ? 'Administrators can rename the official platform Store without a monthly limit.'
    : nameChanges.remaining === 0
      ? `You have used all ${nameChanges.limit} Store name changes this month. The limit resets ${nameChanges.resetsAt ? new Date(nameChanges.resetsAt).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : 'next month'} (UTC).`
      : `You can rename your Store ${nameChanges.remaining} more ${nameChanges.remaining === 1 ? 'time' : 'times'} this month. The limit resets ${nameChanges.resetsAt ? new Date(nameChanges.resetsAt).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : 'next month'} (UTC).`;
  const themeOptions = [...new Set([...planEntitlements.allowedThemes, theme.themePreset])];
  const mobileTemplateOptions = [...new Set([...planEntitlements.mobileTemplates, theme.mobileTemplate])];
  return <section className="page">
    <p className="eyebrow">Seller tools</p>
    <h1>Store appearance and payout setup</h1>
    {message && <p className="notice" role="status">{message}</p>}
    {initialLoading ? <p className="empty" role="status">Loading store settings and plan limits…</p> : <div className="two">
      <div className="narrow">
        <h2>Store settings</h2>
        <p className="muted">Your store URL is generated from the store name. The server checks reserved names and URL collisions before saving. Sellers can change the Store name up to three times per calendar month. New branding uploads remain private until scanning approves them.</p>
        <p><a href="/seller/plan">View plan and usage</a></p>
        <p><a href="/seller/currency">Manage Store currency and display offers</a> · <a href="/seller/commissions">View commission statement</a></p>
        <label>Store name<input aria-label="Store name" value={storeName} onChange={event => setStoreName(event.target.value)} maxLength={120} required disabled={!nameChanges.unlimited && nameChanges.remaining === 0} /></label>
        <p className="muted" role="status" aria-live="polite">{nameChangeHint}</p>
        <p className="storeUrl" aria-live="polite">Public URL: <code>/store/{previewSlug || 'your-store'}</code></p>
        {slug && <p><a href={`/store/${slug}`}>View store</a></p>}
        <label>Store description<textarea value={theme.description} onChange={event => setTheme({ ...theme, description: event.target.value })} /></label>
        <BrandingImageControl label="Store logo" ratio={3} value={theme.logoMediaId} publishedValue={publishedTheme?.logoMediaId} onChange={logoMediaId => setTheme(current => ({ ...current, logoMediaId }))} listUrl="/api/seller/store-media" uploadUrl="/api/seller/store-media/uploads" previewUrl={id => `/api/seller/store-media/${encodeURIComponent(id)}/preview`} quota />
        <BrandingImageControl label="Store favicon" ratio={1} value={theme.faviconMediaId} publishedValue={publishedTheme?.faviconMediaId} onChange={faviconMediaId => setTheme(current => ({ ...current, faviconMediaId }))} listUrl="/api/seller/store-media" uploadUrl="/api/seller/store-media/uploads" previewUrl={id => `/api/seller/store-media/${encodeURIComponent(id)}/preview`} quota />
        <BrandingImageControl label="Store banner" ratio={2.4} value={theme.bannerMediaId} publishedValue={publishedTheme?.bannerMediaId} onChange={bannerMediaId => setTheme(current => ({ ...current, bannerMediaId }))} listUrl="/api/seller/store-media" uploadUrl="/api/seller/store-media/uploads" previewUrl={id => `/api/seller/store-media/${encodeURIComponent(id)}/preview`} quota />
        <label>Theme preset<select aria-label="Theme preset" value={theme.themePreset} onChange={event => setTheme({ ...theme, themePreset: event.target.value })}>{themeOptions.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ').toLowerCase()}</option>)}</select></label>
        <label>Mobile storefront template<select aria-label="Mobile storefront template" value={theme.mobileTemplate} onChange={event => setTheme({ ...theme, mobileTemplate: event.target.value })}>{mobileTemplateOptions.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ').toLowerCase()}</option>)}</select></label>
        <label>Primary color<input value={theme.primaryColor} onChange={event => setTheme({ ...theme, primaryColor: event.target.value })} /></label>
        <label>Accent color<input value={theme.accentColor} onChange={event => setTheme({ ...theme, accentColor: event.target.value })} /></label>
        <label>Font<select value={theme.font} onChange={event => setTheme({ ...theme, font: event.target.value })}><option value="system">System</option><option value="serif">Serif</option><option value="rounded">Rounded</option></select></label>
        <div className="toolbar"><button className="primary" disabled={savingAppearance} onClick={() => void saveTheme()}>{savingAppearance ? 'Saving…' : 'Save draft'}</button><button disabled={savingAppearance} onClick={() => void saveTheme(true)}>{savingAppearance ? 'Saving…' : 'Publish'}</button></div>
        <section className="storeBrandingStaff"><h3>Staff permissions</h3><p className="muted">Branding, shipping, and currency access are separate permissions. POS access does not automatically grant any of them.</p>{brandingStaff.length ? brandingStaff.map(member => <div className="setting" key={member.userId}><strong>{member.user.name || member.user.email}</strong><label>Manage store branding<input type="checkbox" aria-label={`Allow ${member.user.name || member.user.email} to manage store branding`} checked={member.canManageStoreBranding} onChange={async event => { try { await api(`/api/seller/store-branding/staff/${encodeURIComponent(member.userId)}`, { method: 'PATCH', body: JSON.stringify({ canManageStoreBranding: event.target.checked }) }); await load(); setMessage('Staff branding permission updated.'); } catch (error) { setMessage((error as Error).message); } }} /></label><label>Manage shipping<input type="checkbox" aria-label={`Allow ${member.user.name || member.user.email} to manage shipping`} checked={member.canManageShipping} onChange={async event => { try { await api(`/api/seller/store-branding/staff/${encodeURIComponent(member.userId)}`, { method: 'PATCH', body: JSON.stringify({ canManageShipping: event.target.checked }) }); await load(); setMessage('Staff shipping permission updated.'); } catch (error) { setMessage((error as Error).message); } }} /></label><label>Manage currency settings<input type="checkbox" aria-label={`Allow ${member.user.name || member.user.email} to manage Store currency`} checked={member.canManageCurrency} onChange={async event => { try { await api(`/api/seller/store-branding/staff/${encodeURIComponent(member.userId)}`, { method: 'PATCH', body: JSON.stringify({ canManageCurrency: event.target.checked }) }); await load(); setMessage('Staff currency permission updated.'); } catch (error) { setMessage((error as Error).message); } }} /></label></div>) : <p className="empty">No staff accounts are assigned to this Store.</p>}</section>
      </div>
      <div className="narrow">
        <h2>Manual payout method</h2>
        <p className="muted">The platform owner must enable a method. Account details are encrypted at rest and never returned in full.</p>
        <form onSubmit={addMethod}>
          <label>Type<select name="type"><option value="MANUAL_BANK">Manual bank transfer</option><option value="MANUAL_EWALLET">Manual e-wallet transfer</option></select></label>
          <label>Country<input name="country" defaultValue="US" maxLength={2} required /></label>
          <label>Currency<input name="currency" defaultValue="USD" maxLength={3} required /></label>
          <label>Label<input name="label" placeholder="Primary account" required /></label>
          <label>Account identifier<input name="identifier" required /></label>
          <label>Account holder<input name="accountHolder" required /></label>
          <button className="primary" disabled={savingPayoutMethod}>{savingPayoutMethod ? 'Saving…' : 'Save / update payout method'}</button>
        </form>
        <div className="table">{methods.map(method => <div className="row" key={method.id}><span>{method.type} · {method.maskedIdentifier}</span><span>{method.status}</span></div>)}</div>
      </div>
    </div>}
  </section>;
}
