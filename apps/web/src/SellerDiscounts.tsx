import { useEffect, useState } from 'react';
import { formatMinor } from './money.js';
import type { CatalogCategory } from './CatalogFields.js';

type Discount = {
  id: string; name: string; code: string; kind: 'PERCENTAGE' | 'FIXED';
  scope: 'ALL_PRODUCTS' | 'SELECTED_PRODUCTS' | 'SELECTED_CATEGORIES';
  percentBasisPoints: number | null; amountMinor: number | null; currency: string;
  minimumSubtotalMinor: number | null; usageLimit: number | null; usesCount: number;
  startsAt: string | null; endsAt: string | null; enabled: boolean;
  products: { productId: string; product: { id: string; name: string } }[];
  categories: { categoryId: string; category: { id: string; name: string } }[];
};
type Form = {
  name: string; code: string; kind: Discount['kind']; scope: Discount['scope'];
  percentOff: string; amountMinor: string; minimumSubtotalMinor: string;
  usageLimit: string; startsAt: string; endsAt: string; enabled: boolean; productIds: string[]; categoryIds: string[];
};
const blank = (): Form => ({ name: '', code: '', kind: 'PERCENTAGE', scope: 'ALL_PRODUCTS', percentOff: '10', amountMinor: '', minimumSubtotalMinor: '', usageLimit: '', startsAt: '', endsAt: '', enabled: true, productIds: [], categoryIds: [] });
const money = (amount: number, currency: string) => formatMinor(amount, currency);
const dateForInput = (value: string | null) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? undefined as T : response.json();
}

export function SellerDiscounts({ products, categories, currency }: { products: any[]; categories: CatalogCategory[]; currency: string }) {
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [form, setForm] = useState<Form>(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = async () => { try { setDiscounts(await request<Discount[]>('/api/seller/product-discounts')); } catch (error) { setMessage((error as Error).message); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const reset = () => { setForm(blank()); setEditingId(null); };
  const beginEdit = (item: Discount) => {
    setEditingId(item.id);
    setForm({ name: item.name, code: item.code, kind: item.kind, scope: item.scope, percentOff: String((item.percentBasisPoints ?? 0) / 100), amountMinor: item.amountMinor == null ? '' : String(item.amountMinor), minimumSubtotalMinor: item.minimumSubtotalMinor == null ? '' : String(item.minimumSubtotalMinor), usageLimit: item.usageLimit == null ? '' : String(item.usageLimit), startsAt: dateForInput(item.startsAt), endsAt: dateForInput(item.endsAt), enabled: item.enabled, productIds: item.products.map(row => row.productId), categoryIds: item.categories.map(row => row.categoryId) });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setMessage('');
    const payload = {
      name: form.name, code: form.code, kind: form.kind, scope: form.scope,
      ...(form.kind === 'PERCENTAGE' ? { percentOff: Number(form.percentOff) } : { amountMinor: Number(form.amountMinor) }),
      minimumSubtotalMinor: form.minimumSubtotalMinor === '' ? null : Number(form.minimumSubtotalMinor),
      usageLimit: form.usageLimit === '' ? null : Number(form.usageLimit),
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      enabled: form.enabled,
      productIds: form.scope === 'SELECTED_PRODUCTS' ? form.productIds : [],
      categoryIds: form.scope === 'SELECTED_CATEGORIES' ? form.categoryIds : []
    };
    try {
      await request(`/api/seller/product-discounts${editingId ? `/${encodeURIComponent(editingId)}` : ''}`, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      setMessage(editingId ? 'Discount code updated.' : 'Discount code created.'); reset(); await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  const selectedOptions = (event: React.ChangeEvent<HTMLSelectElement>) => Array.from(event.currentTarget.selectedOptions, option => option.value);
  return <section className="sellerDiscounts"><h2>Product discount codes</h2><p className="muted">Create a code for all your products, selected products, or selected categories. Discounts apply to merchandise only and are validated again at checkout. Fixed amounts use {currency} minor units.</p>
    <form className="setting sellerDiscountForm" onSubmit={event => void save(event)}>
      <div className="sellerDiscountGrid">
        <label>Discount name<input required maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label>Code<input required minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value={form.code} onChange={event => setForm({ ...form, code: event.target.value.toUpperCase() })} /></label>
        <label>Discount type<select value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value as Form['kind'] })}><option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed amount</option></select></label>
        {form.kind === 'PERCENTAGE' ? <label>Percent off<input required type="number" min="1" max="99" step="1" value={form.percentOff} onChange={event => setForm({ ...form, percentOff: event.target.value })} /></label> : <label>Amount off ({currency} minor units)<input required type="number" min="1" step="1" value={form.amountMinor} onChange={event => setForm({ ...form, amountMinor: event.target.value })} /></label>}
        <label>Applies to<select value={form.scope} onChange={event => setForm({ ...form, scope: event.target.value as Form['scope'], productIds: [], categoryIds: [] })}><option value="ALL_PRODUCTS">All my products</option><option value="SELECTED_PRODUCTS">Selected products</option><option value="SELECTED_CATEGORIES">Selected categories</option></select></label>
        {form.scope === 'SELECTED_PRODUCTS' && <label>Choose products<select required multiple value={form.productIds} onChange={event => setForm({ ...form, productIds: selectedOptions(event) })}>{products.filter(product => product.status !== 'ARCHIVED').map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>}
        {form.scope === 'SELECTED_CATEGORIES' && <label>Choose categories<select required multiple value={form.categoryIds} onChange={event => setForm({ ...form, categoryIds: selectedOptions(event) })}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
        <label>Minimum eligible subtotal ({currency} minor units)<input type="number" min="0" step="1" value={form.minimumSubtotalMinor} onChange={event => setForm({ ...form, minimumSubtotalMinor: event.target.value })} placeholder="No minimum" /></label>
        <label>Maximum uses<input type="number" min="1" step="1" value={form.usageLimit} onChange={event => setForm({ ...form, usageLimit: event.target.value })} placeholder="Unlimited" /></label>
        <label>Starts at<input type="datetime-local" value={form.startsAt} onChange={event => setForm({ ...form, startsAt: event.target.value })} /></label>
        <label>Ends at<input type="datetime-local" value={form.endsAt} onChange={event => setForm({ ...form, endsAt: event.target.value })} /></label>
      </div>
      <label className="sellerDiscountEnabled"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /> Code is active</label>
      <div className="profileActions"><button className="primary" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save discount code' : 'Create discount code'}</button>{editingId && <button type="button" onClick={reset}>Cancel edit</button>}</div>
    </form>
    {message && <p className="notice" role="status">{message}</p>}
    {loading ? <p className="muted">Loading discount codes…</p> : discounts.length === 0 ? <div className="empty">No discount codes yet.</div> : <div className="table">{discounts.map(item => <div className="row" key={item.id}><div><strong>{item.name} · {item.code}</strong><p>{item.kind === 'PERCENTAGE' ? `${(item.percentBasisPoints ?? 0) / 100}% off` : `${money(item.amountMinor ?? 0, item.currency)} off`} · {item.scope === 'ALL_PRODUCTS' ? 'All products' : item.scope === 'SELECTED_PRODUCTS' ? item.products.map(row => row.product.name).join(', ') : item.categories.map(row => row.category.name).join(', ')}</p><small>{item.usesCount}{item.usageLimit === null ? ' uses' : ` / ${item.usageLimit} uses`} · {item.enabled ? 'Active' : 'Inactive'}</small></div><div className="profileActions"><button type="button" onClick={() => beginEdit(item)}>Edit</button><button type="button" onClick={async () => { try { await request(`/api/seller/product-discounts/${encodeURIComponent(item.id)}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) }); await load(); } catch (error) { setMessage((error as Error).message); } }}>{item.enabled ? 'Deactivate' : 'Activate'}</button><button type="button" onClick={async () => { if (!window.confirm(`Delete discount code ${item.code}?`)) return; try { await request(`/api/seller/product-discounts/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); if (editingId === item.id) reset(); setMessage('Discount code deleted.'); await load(); } catch (error) { setMessage((error as Error).message); } }}>Delete</button></div></div>)}</div>}
  </section>;
}
