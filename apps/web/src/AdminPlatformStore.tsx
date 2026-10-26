import React, { useEffect, useState } from 'react';
import { SellerDropshipping } from './SellerDropshipping.js';
import './AdminPlatformStore.css';

type PlatformStoreData = {
  store: { id: string; name: string; slug: string; description: string | null; baseCurrency: string; productCount?: number; sellerStatus?: string; createdAt?: string } | null;
  access: { kind: string; name: string; requiresSubscription: boolean; unlimited: boolean; entitlements: Record<string, unknown> };
};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Platform Store request failed.'); }
  return response.status === 204 ? undefined as T : response.json();
}

export function AdminPlatformStore() {
  const [data, setData] = useState<PlatformStoreData | null>(null);
  const [name, setName] = useState('Official Platform Store');
  const [slug, setSlug] = useState('official-store');
  const [description, setDescription] = useState('The official store representing the marketplace platform.');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setError('');
    try { setData(await api<PlatformStoreData>('/api/admin/platform-store')); }
    catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      await api('/api/admin/platform-store', { method: 'POST', body: JSON.stringify({ name, slug, description, baseCurrency }) });
      setMessage('Official platform Store created. It is live at its public URL; product listings still follow marketplace approval rules.');
      await load();
    } catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  };

  if (loading) return <section className="adminPlatformStore"><div className="empty" role="status">Loading official Store…</div></section>;

  return <section className="adminPlatformStore">
    <header><div><p className="eyebrow">Platform identity</p><h2>Official platform Store</h2><p className="muted">A public Store owned by a locked system seller account and managed by administrators from Control Center.</p></div></header>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    <article className="card cardBody adminPlatformAccess"><div><p className="eyebrow">Plan and billing override</p><h3>{data?.access.name}</h3><p className="muted">No paid subscription or checkout is required for administrators. Premium entitlements are enabled for the official platform Store with the maximum supported plan quotas. This does not change seller entitlements or bypass provider account approval, security, or compliance requirements.</p></div><span className="dropshippingCurrency">Unlimited admin access</span></article>
    {data?.store ? <>
      <article className="card cardBody adminPlatformStoreDetails"><div><p className="eyebrow">Public storefront</p><h3>{data.store.name}</h3><p className="muted">{data.store.description || 'No Store description'} · {data.store.baseCurrency} · {data.store.productCount ?? 0} products · {data.store.sellerStatus}</p></div><a className="primary" href={`/store/${encodeURIComponent(data.store.slug)}`} target="_blank" rel="noreferrer">Open official Store</a></article>
      <article className="card cardBody adminPlatformStoreWorkspace"><div><p className="eyebrow">Store operations</p><h3>Manage the official Store</h3><p className="muted">Open its seller workspace to manage products, content, themes, shipping, and other enabled Store features.</p></div><a className="primary" href="/dashboard?mode=seller">Open Store workspace</a></article>
      <SellerDropshipping />
    </> : <form className="card cardBody adminPlatformStoreCreate" onSubmit={event => void create(event)}>
      <h3>Create the official Store</h3>
      <p className="muted">Only one official platform Store can exist. Its internal owner account has a randomly generated inaccessible password; admin access is provided by role-checked platform routes.</p>
      <label>Store name<input required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Public URL slug<input required minLength={2} maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} /><small>Public path: /store/{slug || 'your-store'}</small></label>
      <label>Description<textarea maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>Base currency<input required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" value={baseCurrency} onChange={event => setBaseCurrency(event.target.value.toUpperCase())} /></label>
      <button className="primary" disabled={saving}>{saving ? 'Creating Store…' : 'Create official platform Store'}</button>
    </form>}
  </section>;
}
