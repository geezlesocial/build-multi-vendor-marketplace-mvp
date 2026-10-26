import React, { useEffect, useState } from 'react';
import './SellerDropshipping.css';

type SupplierProduct = { id: string; name: string; sku: string; costUsdMinor: number | null; availableStockSnapshot: number | null; imageUrl: string | null; imported: boolean };
type DropshippingData = {
  store: { id: string; name: string; baseCurrency: string };
  entitlement: { enabled: boolean; plan: string };
  providers: { code: string; name: string; status: string; apiReady: boolean; docsUrl: string; note: string }[];
  connection: { id: string; provider: string; status: string; connected: boolean; connectedAt: string; lastCheckedAt: string | null } | null;
  imports: { id: string; provider: string; externalProductId: string; externalSku: string | null; supplierCostUsdMinor: number | null; importedAt: string; product: { id: string; name: string; status: string; priceMinor: number; currency: string; inventory: { quantity: number } | null } }[];
};

function csrfToken() { return document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1] ?? ''; }
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrfToken() ? { 'x-csrf-token': csrfToken() } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Supplier request failed.'); }
  return response.status === 204 ? undefined as T : response.json();
}
const usd = (minor: number | null) => minor === null ? 'Supplier cost unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(minor / 100);

export function SellerDropshipping() {
  const [data, setData] = useState<DropshippingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [products, setProducts] = useState<SupplierProduct[]>([]);
  const [priceMinor, setPriceMinor] = useState<Record<string, string>>({});
  const [stock, setStock] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState('');

  const load = async () => {
    setError('');
    try { setData(await api<DropshippingData>('/api/seller/dropshipping')); }
    catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const connect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setConnecting(true); setError(''); setNotice('');
    try {
      await api('/api/seller/dropshipping/connections/cj', { method: 'POST', body: JSON.stringify({ apiKey }) });
      setApiKey(''); setNotice('CJdropshipping account connected. Supplier credentials are encrypted and never shown again.'); setProducts([]); await load();
    } catch (reason) { setError((reason as Error).message); }
    finally { setConnecting(false); }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect CJdropshipping? Existing imported products remain in your Store.')) return;
    setError(''); setNotice('');
    try { await api('/api/seller/dropshipping/connections/cj', { method: 'DELETE' }); setProducts([]); setNotice('CJdropshipping disconnected. Imported listings were not deleted.'); await load(); }
    catch (reason) { setError((reason as Error).message); }
  };

  const search = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSearching(true); setError(''); setNotice('');
    try {
      const result = await api<{ products: SupplierProduct[] }>(`/api/seller/dropshipping/products?q=${encodeURIComponent(query.trim())}`);
      setProducts(result.products);
      setPriceMinor(current => Object.fromEntries(result.products.map(product => [product.id, current[product.id] ?? ''])));
      setStock(current => Object.fromEntries(result.products.map(product => [product.id, current[product.id] ?? '0'])));
      if (!result.products.length) setNotice('No available supplier products matched that search.');
    } catch (reason) { setError((reason as Error).message); }
    finally { setSearching(false); }
  };

  const importProduct = async (product: SupplierProduct) => {
    const price = Number(priceMinor[product.id]);
    const quantity = Number(stock[product.id] ?? '0');
    if (!Number.isSafeInteger(price) || price < 1) { setError(`Enter a retail price in ${data?.store.baseCurrency ?? 'your Store currency'} minor units for “${product.name}”.`); return; }
    if (!Number.isSafeInteger(quantity) || quantity < 0) { setError('Stock must be a whole number greater than or equal to zero.'); return; }
    setImporting(product.id); setError(''); setNotice('');
    try {
      const result = await api<{ message: string }>('/api/seller/dropshipping/imports', { method: 'POST', body: JSON.stringify({ productId: product.id, priceMinor: price, stock: quantity }) });
      setNotice(result.message); setProducts(current => current.map(item => item.id === product.id ? { ...item, imported: true } : item)); await load();
    } catch (reason) { setError((reason as Error).message); }
    finally { setImporting(''); }
  };

  if (loading) return <section className="sellerDropshipping"><div className="empty" role="status">Loading supplier integrations…</div></section>;
  if (error.includes('only on an active paid Store plan')) return <section className="sellerDropshipping"><p className="eyebrow">Supplier integrations</p><h2>Dropshipping</h2><div className="notice" role="alert">{error}</div><p className="muted">Dropshipping is available only when an administrator includes it in an active paid Store plan. Your existing listings are not affected.</p><a className="primary" href="/seller/plan">Review Store plan</a></section>;

  return <section className="sellerDropshipping">
    <header className="sellerDropshippingHeader"><div><p className="eyebrow">Store operations</p><h2>Dropshipping suppliers</h2><p className="muted">Connect supplier accounts, search their catalog, and import selected items into {data?.store.name ?? 'your Store'}.</p></div><span className="dropshippingCurrency">Store currency · {data?.store.baseCurrency ?? '—'}</span></header>
    {error && <p className="notice" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <div className="supplierProviderGrid">
      {data?.providers.map(provider => <article className={`supplierProvider ${provider.apiReady ? 'supplierProviderReady' : ''}`} key={provider.code}>
        <div className="supplierProviderTop"><div><p className="eyebrow">{provider.apiReady ? 'API available' : 'Partner access'}</p><h3>{provider.name}</h3></div><span className={`supplierBadge ${provider.apiReady ? 'supplierBadgeReady' : ''}`}>{provider.apiReady ? (data.connection?.connected ? 'Connected' : 'Ready to connect') : 'Approval required'}</span></div>
        <p>{provider.note}</p><a href={provider.docsUrl} target="_blank" rel="noreferrer">Official developer information ↗</a>
      </article>)}
    </div>

    {data?.connection?.connected ? <article className="supplierConnectionCard">
      <div><p className="eyebrow">Connected account</p><h3>CJdropshipping</h3><p className="muted">Connected {new Date(data.connection.connectedAt).toLocaleDateString()} · credentials are encrypted at rest.</p></div>
      <button type="button" onClick={() => void disconnect()}>Disconnect</button>
    </article> : <form className="supplierConnectCard" onSubmit={event => void connect(event)}>
      <div><p className="eyebrow">Connect a supplier</p><h3>CJdropshipping API key</h3><p className="muted">Create an API key in your CJ account, then connect it here. The key is sent directly to this platform over your session and is encrypted before storage.</p></div>
      <label>API key<input required type="password" autoComplete="new-password" minLength={24} maxLength={200} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Paste your CJ API key" /></label>
      <button className="primary" disabled={connecting || apiKey.length < 24}>{connecting ? 'Verifying account…' : 'Connect CJdropshipping'}</button>
    </form>}

    {data?.connection?.connected && <>
      <section className="supplierSearchSection"><div><p className="eyebrow">Product sourcing</p><h3>Find products to import</h3><p className="muted">Supplier costs are shown in USD for reference. Set your own Store price and starting stock. Imports are pending review; inventory and supplier cost do not sync automatically.</p></div>
        <form className="supplierSearchForm" onSubmit={event => void search(event)}><label htmlFor="dropship-search">Search supplier catalog</label><div><input id="dropship-search" minLength={2} maxLength={100} required value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by product name or SKU" /><button className="primary" disabled={searching}>{searching ? 'Searching…' : 'Search products'}</button></div></form>
      </section>
      {products.length > 0 && <div className="supplierSearchResults" aria-live="polite">{products.map(product => <article className="supplierProductCard" key={product.id}>
        {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="supplierProductPlaceholder" aria-hidden="true">CJ</div>}
        <div className="supplierProductDetails"><span className="supplierBadge">Supplier listing · pending your review</span><h4>{product.name}</h4><p className="muted">SKU {product.sku || 'not supplied'} · Cost {usd(product.costUsdMinor)} · Supplier stock snapshot {product.availableStockSnapshot ?? 'unavailable'}</p>
          {product.imported ? <p className="supplierImportedState">Already imported into your Store</p> : <div className="supplierImportFields"><label>Retail price · {data.store.baseCurrency} minor units<input type="number" min="1" max="2000000000" step="1" required value={priceMinor[product.id] ?? ''} onChange={event => setPriceMinor(current => ({ ...current, [product.id]: event.target.value }))} placeholder="Enter your selling price" /></label><label>Starting stock<input type="number" min="0" max="2000000000" step="1" value={stock[product.id] ?? '0'} onChange={event => setStock(current => ({ ...current, [product.id]: event.target.value }))} /></label><button className="primary" type="button" disabled={importing === product.id} onClick={() => void importProduct(product)}>{importing === product.id ? 'Importing…' : 'Import as pending listing'}</button></div>}
        </div>
      </article>)}</div>}
      <section className="supplierImportHistory"><div className="supplierSectionHeading"><div><p className="eyebrow">Imported into this Store</p><h3>Recent supplier imports</h3></div><span>{data.imports.length} imported</span></div>
        {data.imports.length ? <div className="supplierImportList">{data.imports.map(item => <article key={item.id}><div><strong>{item.product.name}</strong><small>{item.provider === 'CJ_DROPSHIPPING' ? 'CJdropshipping' : item.provider} · {item.externalSku ?? item.externalProductId} · {new Date(item.importedAt).toLocaleDateString()}</small></div><span>{item.product.status}</span><a href={`/dashboard?mode=seller&tab=products`}>Edit listing</a></article>)}</div> : <div className="empty">No products imported yet.</div>}
      </section>
    </>}
    <p className="supplierSafetyNote"><strong>Important:</strong> supplier inventory, pricing, order placement, and fulfillment are not synchronized by this catalog importer. Confirm supplier availability and shipping terms, and keep your Store listing accurate. AliExpress and Alibaba.com require separate approval-based adapters before they can be connected here.</p>
  </section>;
}
