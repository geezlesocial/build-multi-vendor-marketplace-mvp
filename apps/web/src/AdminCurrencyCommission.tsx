import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Catalog = { currencies: { code: string; name: string; region: string; active: boolean; displayEnabled: boolean; storePricingEnabled: boolean; checkoutEnabled: boolean; subscriptionEnabled: boolean; minorUnitExponent: number }[]; referenceRefreshEnabled: boolean; baseCurrency: string; subscriptionBillingEnabled: false };
type Policy = { id: string; version: number; status: string; type: string; currency: string; fixedMinor: number | null; basisPoints: number | null; minimumMinor: number | null; capMinor: number | null; reason: string; storeId: string | null; planVersionId: string | null; store?: { name: string }; planVersion?: { plan: { name: string } } };
type Review = { id: string; amountMinor: number; currency: string; provider: string; providerEventId: string; reason: string; parentOrder: { orderNumber: string; sellerOrders: { id: string; sellerId: string | null; seller: { store?: { name: string } } | null; items: { id: string; productName: string; quantity: number; unitPriceMinor: number; currencySnapshotEntry?: { code: string } }[] }[] } };
type Ledger = { totals: { sellerId: string; store: { name: string; slug: string } | null; currency: string; netMinor: number; entries: number }[]; unresolvedReviews: number; fundedOrReconciled: false; note: string };
type SectionProps = { section: 'currencies' | 'commissions' };

export function AdminCurrencyCommission({ section }: SectionProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [manual, setManual] = useState({ baseCurrency: 'USD', quoteCurrency: '', rate: '', effectiveFrom: new Date(Date.now() + 60_000).toISOString().slice(0, 16), reason: '' });
  const [policy, setPolicy] = useState({ scope: 'store', scopeId: '', type: 'ZERO', currency: 'USD', fixedMinor: '', basisPoints: '', minimumMinor: '', capMinor: '', reason: '' });
  const [previewBase, setPreviewBase] = useState('10000');
  const [preview, setPreview] = useState<number | null>(null);
  const [refundAllocations, setRefundAllocations] = useState<Record<string, Record<string, string>>>({});

  const load = async () => {
    const [c, p, r, l] = await Promise.all([
      api<Catalog>('/api/admin/currencies'),
      api<{ policies: Policy[] }>('/api/admin/seller-commission-policies'),
      api<Review[]>('/api/admin/seller-commission-reviews'),
      api<Ledger>('/api/admin/seller-commission-ledger')
    ]);
    setCatalog(c); setPolicies(p.policies); setReviews(r); setLedger(l);
    setManual(value => ({ ...value, baseCurrency: c.baseCurrency, quoteCurrency: c.currencies.find(currency => currency.displayEnabled && currency.code !== c.baseCurrency)?.code ?? '' }));
    setPolicy(value => ({ ...value, currency: c.baseCurrency }));
  };
  useEffect(() => { void load().catch(reason => setError((reason as Error).message)).finally(() => setLoading(false)); }, []);
  const action = async (work: () => Promise<unknown>, success: string) => {
    setSaving(true); setError(''); setMessage('');
    try { await work(); await load(); setMessage(success); }
    catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const updateCapability = (code: string, body: object) => action(() => api(`/api/admin/currencies/${code}`, { method: 'PATCH', body: JSON.stringify({ ...body, reason: 'Reviewed in platform currency controls' }) }), 'Currency capability updated.');
  const createManual = () => action(() => api('/api/admin/fx/manual-rates', { method: 'POST', body: JSON.stringify({ ...manual, effectiveFrom: new Date(manual.effectiveFrom).toISOString() }) }), 'Manual reference rate version saved.');
  const createPolicy = () => action(async () => {
    const body: Record<string, unknown> = { type: policy.type, currency: policy.currency, reason: policy.reason, ...(policy.scope === 'store' ? { storeId: policy.scopeId } : { planVersionId: policy.scopeId }) };
    if (policy.type === 'FIXED_PER_ORDER' || policy.type === 'PERCENTAGE_PLUS_FIXED') body.fixedMinor = Number(policy.fixedMinor);
    if (policy.type === 'PERCENTAGE' || policy.type === 'PERCENTAGE_PLUS_FIXED') body.basisPoints = Number(policy.basisPoints);
    if (policy.minimumMinor !== '') body.minimumMinor = Number(policy.minimumMinor);
    if (policy.capMinor !== '') body.capMinor = Number(policy.capMinor);
    await api('/api/admin/seller-commission-policies', { method: 'POST', body: JSON.stringify(body) });
    setPolicy(current => ({ ...current, scopeId: '', reason: '' })); setPreview(null);
  }, 'Commission draft version created.');
  const resolveReview = (review: Review) => {
    const allocations = Object.entries(refundAllocations[review.id] ?? {}).filter(([, amount]) => amount !== '').map(([orderItemId, amount]) => ({ orderItemId, refundMinor: Number(amount) }));
    const reason = window.prompt('Reason for item-level refund allocation');
    if (!reason || reason.trim().length < 5) return;
    void action(() => api(`/api/admin/seller-commission-reviews/${review.id}/resolve`, { method: 'POST', body: JSON.stringify({ allocations, reason }) }), 'Refund allocation posted as append-only commission reversals.');
  };
  const currency = catalog?.currencies.find(item => item.code === manual.quoteCurrency);
  if (loading) return <div className="empty" role="status">Loading currency and commission controls…</div>;
  if (error && !catalog) return <div className="empty" role="alert">{error}<button onClick={() => { setLoading(true); setError(''); void load().catch(reason => setError((reason as Error).message)).finally(() => setLoading(false)); }}>Retry</button></div>;

  return <section className="adminCurrencyCommission">
    <p><a href="/admin/platform">Back to platform administration</a></p><div className="sectionHeading"><div><p className="eyebrow">Platform controls</p><h2>{section === 'currencies' ? 'Currency catalog and FX' : 'Seller commissions'}</h2></div><nav className="toolbar" aria-label="Currency and commission pages"><a href="/admin/currencies">Currency &amp; FX</a><a href="/admin/commissions">Seller commissions</a></nav></div>
    <p className="muted">Checkout currency is {catalog?.baseCurrency}. Reference rates are estimates only. Subscription billing remains disabled; no settings here enable payment-provider currency support.</p>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    {section === 'currencies' && <>
      <div className="setting"><div><strong>Automatic reference refresh</strong><p>Provider adapter calls are disabled unless the deployment explicitly enables them.</p></div><span>{catalog?.referenceRefreshEnabled ? 'Configured on this deployment' : 'Disabled'}</span>{catalog?.referenceRefreshEnabled && <button disabled={saving} onClick={() => void action(() => api('/api/admin/fx/refresh', { method: 'POST', body: '{}' }), 'Reference-rate refresh completed. Unsupported pairs remain unavailable.')}>Refresh reference rates</button>}</div>
      <h3>Currency capabilities</h3><p className="muted">Display and Store pricing do not imply checkout or subscription support. Payment and subscription capability changes remain server-gated.</p>
      <div className="table">{catalog?.currencies.map(item => <div className="row currencyAdminRow" key={item.code}><strong>{item.code} · {item.name}</strong><span>{item.region} · {item.minorUnitExponent} minor digits</span><label className="checkRow"><input type="checkbox" checked={item.active} onChange={event => void updateCapability(item.code, { active: event.target.checked })} />Active</label><label className="checkRow"><input type="checkbox" checked={item.displayEnabled} onChange={event => void updateCapability(item.code, { displayEnabled: event.target.checked })} />Display</label><label className="checkRow"><input type="checkbox" checked={item.storePricingEnabled} onChange={event => void updateCapability(item.code, { storePricingEnabled: event.target.checked })} />Store pricing</label><span>Checkout: {item.checkoutEnabled ? 'platform base only' : 'not enabled'}</span><span>Subscription: disabled</span></div>)}</div>
      <section className="card cardBody"><h3>Audited manual reference rate</h3><p>Manual values override automatic rates for the selected base/quote pair while effective. Use a documented source and reason; this does not set a payment amount.</p><div className="two"><label>Base currency<select value={manual.baseCurrency} onChange={event => setManual({ ...manual, baseCurrency: event.target.value })}>{catalog?.currencies.filter(item => item.active).map(item => <option key={item.code}>{item.code}</option>)}</select></label><label>Quote currency<select value={manual.quoteCurrency} onChange={event => setManual({ ...manual, quoteCurrency: event.target.value })}><option value="">Choose display currency</option>{catalog?.currencies.filter(item => item.active && item.displayEnabled && item.code !== manual.baseCurrency).map(item => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label></div><label>Rate (1 {manual.baseCurrency} =)<input inputMode="decimal" value={manual.rate} onChange={event => setManual({ ...manual, rate: event.target.value })} /></label><label>Effective from<input type="datetime-local" value={manual.effectiveFrom} onChange={event => setManual({ ...manual, effectiveFrom: event.target.value })} /></label><label>Reason<input value={manual.reason} onChange={event => setManual({ ...manual, reason: event.target.value })} minLength={5} maxLength={500} /></label><button className="primary" disabled={saving || !manual.quoteCurrency || !manual.rate || manual.reason.trim().length < 5} onClick={() => void createManual()}>Add manual rate version</button>{currency && <small>Quote currency precision: {currency.minorUnitExponent} digits.</small>}</section>
    </>}
    {section === 'commissions' && <>
      <section className="card cardBody"><h3>Accrued ledger and reconciliation status</h3><p>{ledger?.note}</p><p><strong>Unresolved partial-refund allocations:</strong> {ledger?.unresolvedReviews ?? 0}</p>{ledger?.totals.length ? <div className="table">{ledger.totals.map(total => <div className="row" key={`${total.sellerId}-${total.currency}`}><strong>{total.store?.name ?? 'Store'} · {total.currency}</strong><span>Net accrued {formatMinor(total.netMinor, total.currency)}</span><span>{total.entries} append-only entries</span><span>Funding/reconciliation: not configured</span></div>)}</div> : <div className="empty">No seller commission ledger activity yet. No payout obligations are represented by a zero ledger.</div>}</section>
      <section className="card cardBody"><h3>New draft policy version</h3><p>Activation is explicit and audited. Existing orders keep their immutable policy snapshot. Zero commission is the default when no active Store or plan policy applies.</p><div className="two"><label>Policy scope<select value={policy.scope} onChange={event => setPolicy({ ...policy, scope: event.target.value })}><option value="store">Store</option><option value="plan">Store Plan version</option></select></label><label>{policy.scope === 'store' ? 'Store ID' : 'Store Plan version ID'}<input value={policy.scopeId} onChange={event => setPolicy({ ...policy, scopeId: event.target.value })} required /></label></div><div className="two"><label>Commission type<select value={policy.type} onChange={event => setPolicy({ ...policy, type: event.target.value })}><option value="ZERO">Zero</option><option value="FIXED_PER_ORDER">Fixed per successful order</option><option value="PERCENTAGE">Percentage</option><option value="PERCENTAGE_PLUS_FIXED">Percentage plus fixed</option></select></label><label>Currency<select value={policy.currency} onChange={event => setPolicy({ ...policy, currency: event.target.value })}>{catalog?.currencies.filter(item => item.active).map(item => <option key={item.code}>{item.code}</option>)}</select></label></div>{['FIXED_PER_ORDER', 'PERCENTAGE_PLUS_FIXED'].includes(policy.type) && <label>Fixed fee in minor units<input type="number" min="0" step="1" value={policy.fixedMinor} onChange={event => setPolicy({ ...policy, fixedMinor: event.target.value })} /></label>}{['PERCENTAGE', 'PERCENTAGE_PLUS_FIXED'].includes(policy.type) && <label>Percentage in basis points<input type="number" min="0" max="10000" step="1" value={policy.basisPoints} onChange={event => setPolicy({ ...policy, basisPoints: event.target.value })} /><small>For example, 250 basis points = 2.5%.</small></label>}<div className="two"><label>Minimum commission (minor units)<input type="number" min="0" step="1" value={policy.minimumMinor} onChange={event => setPolicy({ ...policy, minimumMinor: event.target.value })} /></label><label>Maximum cap (minor units)<input type="number" min="0" step="1" value={policy.capMinor} onChange={event => setPolicy({ ...policy, capMinor: event.target.value })} /></label></div><label>Audit reason<input value={policy.reason} onChange={event => setPolicy({ ...policy, reason: event.target.value })} minLength={5} maxLength={500} /></label><div className="two"><label>Simulator eligible order amount (minor units)<input type="number" min="0" step="1" value={previewBase} onChange={event => setPreviewBase(event.target.value)} /></label><button type="button" disabled={saving} onClick={async () => { try { const body: Record<string, unknown> = { policy: { type: policy.type, currency: policy.currency, fixedMinor: ['FIXED_PER_ORDER', 'PERCENTAGE_PLUS_FIXED'].includes(policy.type) ? Number(policy.fixedMinor) : null, basisPoints: ['PERCENTAGE', 'PERCENTAGE_PLUS_FIXED'].includes(policy.type) ? Number(policy.basisPoints) : null, minimumMinor: policy.minimumMinor === '' ? null : Number(policy.minimumMinor), capMinor: policy.capMinor === '' ? null : Number(policy.capMinor) }, eligibleBaseMinor: Number(previewBase) }; const result = await api<{ commissionMinor: number }>('/api/admin/seller-commission-preview', { method: 'POST', body: JSON.stringify(body) }); setPreview(result.commissionMinor); setError(''); } catch (reason) { setError((reason as Error).message); } }}>Preview</button></div>{preview !== null && <p role="status">Preview: {formatMinor(preview, policy.currency)} per order example.</p>}<button className="primary" disabled={saving || !policy.scopeId || policy.reason.trim().length < 5 || (['FIXED_PER_ORDER', 'PERCENTAGE_PLUS_FIXED'].includes(policy.type) && policy.fixedMinor === '') || (['PERCENTAGE', 'PERCENTAGE_PLUS_FIXED'].includes(policy.type) && policy.basisPoints === '')} onClick={() => void createPolicy()}>Create draft version</button></section>
      <h3>Policy versions</h3>{policies.length ? <div className="table">{policies.map(item => <div className="row" key={item.id}><strong>{item.store?.name ?? item.planVersion?.plan.name ?? item.storeId ?? item.planVersionId} · v{item.version}</strong><span>{item.type.replaceAll('_', ' ')} · {item.status}</span><span>{item.currency} · {item.basisPoints != null ? `${item.basisPoints / 100}%` : ''}{item.fixedMinor != null ? ` + ${formatMinor(item.fixedMinor, item.currency)}` : ''}</span><small>{item.reason}</small>{item.status === 'DRAFT' && <button disabled={saving} onClick={() => { const reason = window.prompt('Reason for activating this commission policy version'); if (reason && reason.trim().length >= 5) void action(() => api(`/api/admin/seller-commission-policies/${item.id}/activate`, { method: 'POST', body: JSON.stringify({ reason }) }), `Policy version ${item.version} activated.`); }}>Activate version</button>}{item.status === 'ACTIVE' && <button disabled={saving} onClick={() => { const reason = window.prompt('Reason for retiring this policy'); if (reason && reason.trim().length >= 5) void action(() => api(`/api/admin/seller-commission-policies/${item.id}/retire`, { method: 'POST', body: JSON.stringify({ reason }) }), 'Policy retired; existing order snapshots remain unchanged.'); }}>Retire</button>}</div>)}</div> : <div className="empty">No commission policy versions. Applicable commission defaults to zero.</div>}
      <section>
        <h3>Verified partial refund allocation reviews</h3>
        <p className="muted">Each entered item refund must be positive integer minor units, belong to the order, and sum exactly to the verified provider refund. Resolution writes append-only commission reversals.</p>
        {reviews.length ? reviews.map(review => <article className="card cardBody commissionReview" key={review.id}>
          <h4>{review.parentOrder.orderNumber} · {review.provider} · {formatMinor(review.amountMinor, review.currency)}</h4>
          <p>{review.reason} · Event {review.providerEventId}</p>
          {review.parentOrder.sellerOrders.filter(order => order.sellerId).flatMap(order => order.items.map(item => (
            <label key={item.id}>{order.seller?.store?.name ?? 'Seller'} · {item.productName} · max {formatMinor(item.unitPriceMinor * item.quantity, review.currency)}
              <input type="number" min="0" step="1" value={refundAllocations[review.id]?.[item.id] ?? ''} onChange={event => setRefundAllocations(current => ({ ...current, [review.id]: { ...(current[review.id] ?? {}), [item.id]: event.target.value } }))} placeholder="Refund amount in minor units" />
            </label>
          )))}
          <button className="primary" disabled={saving} onClick={() => resolveReview(review)}>Post allocated reversals</button>
        </article>) : <div className="empty">No partial refund commission reviews require allocation.</div>}
      </section>
      <div className="notice">No seller payout is initiated. Funding source, settlement policy, and any real-money commission collection remain separate business decisions.</div>
    </>}
  </section>;
}
