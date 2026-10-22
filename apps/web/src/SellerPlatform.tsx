import React, { useEffect, useState } from 'react';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? (undefined as T) : response.json();
}

const slugPreview = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
type Theme = { themePreset: string; mobileTemplate: string; description: string; primaryColor: string; accentColor: string; font: string; sections: { type: 'featuredProducts'; title: string; productIds: string[] }[]; contactLinks: { label: string; url: string }[]; logoMediaId: string | null; bannerMediaId: string | null };
type StorePlanEntitlements = { allowedThemes: string[]; mobileTemplates: string[] };
const emptyTheme: Theme = { themePreset: 'CLASSIC', mobileTemplate: 'RESPONSIVE_STANDARD', description: '', primaryColor: '#1f6f5b', accentColor: '#e7b75a', font: 'system', sections: [], contactLinks: [], logoMediaId: null, bannerMediaId: null };

export function SellerPlatform() {
  const [storeName, setStoreName] = useState('');
  const [slug, setSlug] = useState('');
  const [theme, setTheme] = useState<Theme>(emptyTheme);
  const [methods, setMethods] = useState<{ id: string; type: string; status: string; maskedIdentifier: string | null }[]>([]);
  const [planEntitlements, setPlanEntitlements] = useState<StorePlanEntitlements>({ allowedThemes: ['CLASSIC', 'EDITORIAL', 'BOUTIQUE'], mobileTemplates: ['RESPONSIVE_STANDARD', 'MOBILE_COMPACT', 'MOBILE_EDITORIAL'] });
  const [message, setMessage] = useState('');

  const load = async () => {
    const [current, payoutMethods, plan] = await Promise.all([
      api<{ name: string; slug: string; draft: Theme }>('/api/seller/store-theme'),
      api<typeof methods>('/api/seller/payout-methods'),
      api<{ entitlements: StorePlanEntitlements }>('/api/seller/plan')
    ]);
    setStoreName(current.name);
    setSlug(current.slug);
    setTheme({ ...emptyTheme, ...current.draft });
    setMethods(payoutMethods);
    setPlanEntitlements(plan.entitlements);
  };
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);

  const saveTheme = async (publish = false) => {
    try {
      const saved = await api<{ slug: string }>('/api/seller/store-theme', { method: 'PUT', body: JSON.stringify({ ...theme, name: storeName }) });
      setSlug(saved.slug);
      if (publish) await api('/api/seller/store-theme/publish', { method: 'POST', body: '{}' });
      await load();
      setMessage(publish ? 'Store settings and theme published' : 'Store settings draft saved');
    } catch (error) { setMessage((error as Error).message); }
  };
  const addMethod = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      await api('/api/seller/payout-methods', { method: 'POST', body: JSON.stringify({ type: form.get('type'), country: form.get('country'), currency: form.get('currency'), label: form.get('label'), identifier: form.get('identifier'), details: { accountHolder: String(form.get('accountHolder') ?? '') } }) });
      event.currentTarget.reset();
      await load();
      setMessage('Payout method saved; only a masked identifier is shown here.');
    } catch (error) { setMessage((error as Error).message); }
  };

  const previewSlug = slugPreview(storeName);
  const themeOptions = [...new Set([...planEntitlements.allowedThemes, theme.themePreset])];
  const mobileTemplateOptions = [...new Set([...planEntitlements.mobileTemplates, theme.mobileTemplate])];
  return <section className="page">
    <p className="eyebrow">Seller tools</p>
    <h1>Store appearance and payout setup</h1>
    {message && <p className="notice" role="status">{message}</p>}
    <div className="two">
      <div className="narrow">
        <h2>Store settings</h2>
        <p className="muted">Your store URL is generated from the store name. The server checks reserved names and URL collisions before saving.</p>
        <p><a href="/seller/plan">View plan and usage</a></p>
        <label>Store name<input aria-label="Store name" value={storeName} onChange={event => setStoreName(event.target.value)} maxLength={120} required /></label>
        <p className="storeUrl" aria-live="polite">Public URL: <code>/store/{previewSlug || 'your-store'}</code></p>
        {slug && <p><a href={`/store/${slug}`}>View store</a></p>}
        <label>Store description<textarea value={theme.description} onChange={event => setTheme({ ...theme, description: event.target.value })} /></label>
        <label>Theme preset<select aria-label="Theme preset" value={theme.themePreset} onChange={event => setTheme({ ...theme, themePreset: event.target.value })}>{themeOptions.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ').toLowerCase()}</option>)}</select></label>
        <label>Mobile storefront template<select aria-label="Mobile storefront template" value={theme.mobileTemplate} onChange={event => setTheme({ ...theme, mobileTemplate: event.target.value })}>{mobileTemplateOptions.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ').toLowerCase()}</option>)}</select></label>
        <label>Primary color<input value={theme.primaryColor} onChange={event => setTheme({ ...theme, primaryColor: event.target.value })} /></label>
        <label>Accent color<input value={theme.accentColor} onChange={event => setTheme({ ...theme, accentColor: event.target.value })} /></label>
        <label>Font<select value={theme.font} onChange={event => setTheme({ ...theme, font: event.target.value })}><option value="system">System</option><option value="serif">Serif</option><option value="rounded">Rounded</option></select></label>
        <div className="toolbar"><button className="primary" onClick={() => void saveTheme()}>Save draft</button><button onClick={() => void saveTheme(true)}>Publish</button></div>
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
          <button className="primary">Save payout method</button>
        </form>
        <div className="table">{methods.map(method => <div className="row" key={method.id}><span>{method.type} · {method.maskedIdentifier}</span><span>{method.status}</span></div>)}</div>
      </div>
    </div>
  </section>;
}
