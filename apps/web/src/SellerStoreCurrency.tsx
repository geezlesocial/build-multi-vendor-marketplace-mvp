import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type CurrencySettings = {
  store: { id: string; name: string; baseCurrency: string };
  offers: { currency: string; displayEnabled: boolean; checkoutEnabled: boolean }[];
  catalog: { code: string; name: string; region: string; active: boolean; displayEnabled: boolean; storePricingEnabled: boolean; minorUnitExponent: number }[];
  manualRates: { id: string; baseCurrency: string; quoteCurrency: string; rate: string; version: number; effectiveFrom: string; effectiveUntil: string | null; reason: string }[];
  rates: { baseCurrency: string; quoteCurrency: string; rate: { rate: string; provider: string; sourceDate: string; fetchedAt: string; freshness: string } | null }[];
  canChangeBaseCurrency: boolean;
  checkoutCurrency: string;
};

export function SellerStoreCurrency() {
  const [data, setData] = useState<CurrencySettings | null>(null);
  const [base, setBase] = useState('USD');
  const [offers, setOffers] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [quote, setQuote] = useState('');
  const [rate, setRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date(Date.now() + 60_000).toISOString().slice(0, 16));
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    const current = await api<CurrencySettings>('/api/seller/store/currency-settings');
    setData(current); setBase(current.store.baseCurrency);
    setOffers([...new Set([current.store.baseCurrency, ...current.offers.filter(offer => offer.displayEnabled && (offer.currency === current.store.baseCurrency || current.rates.some(rate => rate.quoteCurrency === offer.currency && rate.rate && rate.rate.freshness !== 'stale'))).map(offer => offer.currency)])]);
  };
  useEffect(() => { void load().catch(error => setMessage((error as Error).message)).finally(() => setLoading(false)); }, []);
  const save = async () => {
    setSaving(true); setMessage('');
    try { await api('/api/seller/store/currency-settings', { method: 'PATCH', body: JSON.stringify({ baseCurrency: base, displayCurrencies: [...new Set([base, ...offers])], reason }) }); await load(); setReason(''); setMessage('Store currency settings saved and audited.'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  const saveRate = async () => {
    setSaving(true); setMessage('');
    try { await api('/api/seller/store/fx-overrides', { method: 'POST', body: JSON.stringify({ baseCurrency: base, quoteCurrency: quote, rate, effectiveFrom: new Date(effectiveFrom).toISOString(), reason }) }); await load(); setRate(''); setReason(''); setMessage('Manual display reference rate version saved and audited.'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  if (loading) return <section className="page"><p role="status">Loading Store currency settings…</p></section>;
  if (!data) return <section className="page"><h1>Store currency settings</h1><div className="empty" role="alert">{message || 'Store currency settings are unavailable.'}</div><button onClick={() => { setLoading(true); void load().catch(error => setMessage((error as Error).message)).finally(() => setLoading(false)); }}>Retry</button></section>;
  const pricingCurrencies = data.catalog.filter(currency => currency.active && currency.storePricingEnabled);
  const displayCurrencies = data.catalog.filter(currency => currency.active && currency.displayEnabled && (currency.code === base || data.rates.some(rate => rate.quoteCurrency === currency.code && rate.rate && rate.rate.freshness !== 'stale')));
  return <section className="page sellerCurrencyPage">
    <p className="eyebrow">Store setup</p><h1>Currency and display</h1>
    <p className="muted">Configure listing currency and which display estimates your Store offers. These settings do not connect a seller payment provider. Buyer checkout remains limited to {data.checkoutCurrency}; reference rates never set a payment amount.</p>
    {message && <p role="status" className="notice">{message}</p>}
    <section className="setting"><div><h2>Listing currency</h2><p>All new Store listings use this base currency. Historical prices and orders are not rewritten.</p></div><label>Store base currency<select aria-label="Store base currency" value={base} disabled={!data.canChangeBaseCurrency} onChange={event => setBase(event.target.value)}>{pricingCurrencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>{!data.canChangeBaseCurrency && <small>Base currency cannot change after products or order history exist.</small>}</section>
    <fieldset className="currencyOfferList"><legend>Display currencies offered</legend><p className="muted">Currencies without a current manual or automatic reference rate cannot be selected for display. Checkout currency support is controlled separately by platform configuration.</p>{data.catalog.filter(currency => currency.active && currency.displayEnabled).map(currency => { const rate = data.rates.find(item => item.quoteCurrency === currency.code)?.rate; const canOffer = currency.code === base || Boolean(rate && rate.freshness !== 'stale'); return <label className="checkRow" key={currency.code}><input type="checkbox" checked={offers.includes(currency.code)} disabled={currency.code === base || !canOffer} onChange={event => setOffers(current => event.target.checked ? [...new Set([...current, currency.code])] : current.filter(code => code !== currency.code))} />{currency.code} · {currency.name} <small>{currency.code === base ? 'Listing currency' : canOffer && rate ? `${rate.provider === 'MANUAL' ? 'Manual' : 'Reference'} estimate · ${rate.sourceDate}` : 'No current pair available'}</small></label>; })}</fieldset>
    <label>Reason for settings change<input value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={500} /></label>
    <button className="primary" disabled={saving || reason.trim().length < 5} onClick={() => void save()}>{saving ? 'Saving…' : 'Save currency settings'}</button>
    <section className="card cardBody"><h2>Manual display-rate version</h2><p>Manual rates override automatic reference rates for this Store while effective. They are estimates, not executable conversion or settlement terms.</p><div className="two"><label>Quote currency<select value={quote} onChange={event => setQuote(event.target.value)}><option value="">Choose currency</option>{displayCurrencies.filter(currency => currency.code !== base).map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label><label>Rate (1 {base} =)<input inputMode="decimal" value={rate} onChange={event => setRate(event.target.value)} placeholder="0.000000" /></label></div><label>Effective from<input type="datetime-local" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label><label>Audit reason<input value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={500} /></label><button disabled={saving || !quote || !rate || reason.trim().length < 5} onClick={() => void saveRate()}>{saving ? 'Saving…' : 'Add rate version'}</button></section>
    <section><h2>Rate history</h2>{data.manualRates.length ? <div className="table">{data.manualRates.map(item => <div className="row" key={item.id}><strong>{item.baseCurrency}/{item.quoteCurrency} · {item.rate}</strong><span>v{item.version} · effective {new Date(item.effectiveFrom).toLocaleString()}</span><span>{item.effectiveUntil ? `Ended ${new Date(item.effectiveUntil).toLocaleString()}` : 'Current manual rate'}</span><small>{item.reason}</small></div>)}</div> : <div className="empty">No Store-specific manual rates. A fresh platform reference rate may be available.</div>}</section>
  </section>;
}

type CommissionResponse = { currentPolicy: { type: string; currency: string; fixedMinor: number | null; basisPoints: number | null; minimumMinor: number | null; capMinor: number | null; version: number; status: string; reason: string } | null; policySource: string; entries: { id: string; entryType: 'ACCRUAL' | 'REVERSAL' | 'ADJUSTMENT'; amountMinor: number; currency: string; createdAt: string; reason: string | null }[]; page?: { limit: number; offset: number; hasMore: boolean }; totals: { currency: string; amountMinor: number }[]; payoutAvailable: false; note: string };

function commissionEntryState(entryType: CommissionResponse['entries'][number]['entryType']) {
  // The immutable ledger models the kind of posting, not a mutable status column.
  if (entryType === 'ACCRUAL') return 'Accrued';
  if (entryType === 'REVERSAL') return 'Reversed';
  return 'Adjusted';
}

export function SellerCommissionStatement() {
  const [data, setData] = useState<CommissionResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () => api<CommissionResponse>('/api/seller/commissions').then(setData).catch(reason => setError((reason as Error).message)).finally(() => setLoading(false));
  useEffect(() => { void load(); }, []);
  return <section className="page sellerCommissionPage"><p className="eyebrow">Seller statement</p><h1>Commission and adjustments</h1><p className="muted">Ledger amounts follow the policy snapshotted on each order. They are not a funded balance or payout promise.</p>{loading ? <p role="status">Loading commission statement…</p> : error ? <div className="empty" role="alert">{error}<button onClick={() => { setLoading(true); setError(''); void load(); }}>Retry</button></div> : <>
    <section className="setting"><div><h2>Current policy</h2><p>{data?.policySource === 'DEFAULT_ZERO' ? 'No configured Store or plan policy; default is zero commission.' : `${data?.policySource === 'STORE' ? 'Store-specific' : 'Store Plan'} policy · ${data?.currentPolicy?.status}`}</p></div>{data?.currentPolicy && <strong>{data.currentPolicy.type.replaceAll('_', ' ')} · {data.currentPolicy.currency}{data.currentPolicy.basisPoints != null ? ` · ${data.currentPolicy.basisPoints / 100}%` : ''}{data.currentPolicy.fixedMinor != null ? ` + ${formatMinor(data.currentPolicy.fixedMinor, data.currentPolicy.currency)}` : ''}</strong>}</section>
    <div className="adminMetricGrid">{data?.totals.map(total => <article className="card cardBody" key={total.currency}><span>Net ledger activity · {total.currency}</span><strong>{formatMinor(total.amountMinor, total.currency)}</strong></article>)}</div>
    <h2>Commission ledger</h2>{data?.entries.length ? <div className="table">{data.entries.map(entry => <div className="row" key={entry.id}><strong>{entry.entryType}</strong><span>{formatMinor(entry.amountMinor, entry.currency)}</span><span>{commissionEntryState(entry.entryType)}</span><time>{new Date(entry.createdAt).toLocaleString()}</time><small>{entry.reason}</small></div>)}</div> : <div className="empty">No commission accruals or adjustments yet.</div>}
    <p className="notice">{data?.note} Payouts are not initiated here.</p>
  </>}</section>;
}
