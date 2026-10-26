import React, { useEffect, useState } from 'react';
import './AdminCarriers.css';

type Carrier = { id: string; code: string; name: string; countries: string[]; trackingUrlTemplate: string | null; enabled: boolean; _count?: { services: number } };

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

function CarrierRow({ carrier, reason, saving, save, toggle }: { carrier: Carrier; reason: string; saving: boolean; save: (carrier: Carrier, changes: Pick<Carrier, 'name' | 'countries' | 'trackingUrlTemplate'>) => void; toggle: (carrier: Carrier) => void }) {
  const [name, setName] = useState(carrier.name);
  const [countries, setCountries] = useState(carrier.countries.join(', '));
  const [trackingUrlTemplate, setTrackingUrlTemplate] = useState(carrier.trackingUrlTemplate ?? '');
  useEffect(() => { setName(carrier.name); setCountries(carrier.countries.join(', ')); setTrackingUrlTemplate(carrier.trackingUrlTemplate ?? ''); }, [carrier]);
  return <article className="card cardBody adminCarrierCard">
    <header><div><p className="eyebrow">{carrier.code}</p><h4>{carrier.name}</h4></div><span className={carrier.enabled ? 'carrierEnabled' : 'carrierDisabled'}>{carrier.enabled ? 'Available' : 'Disabled'}</span></header>
    <p className="muted">Manual tracking directory only · {carrier._count?.services ?? 0} seller service{carrier._count?.services === 1 ? '' : 's'} linked. No labels, live rates, or carrier API calls are enabled.</p>
    <form className="adminCarrierForm" onSubmit={event => { event.preventDefault(); save(carrier, { name, countries: countries.split(',').map(code => code.trim().toUpperCase()).filter(Boolean), trackingUrlTemplate: trackingUrlTemplate.trim() || null }); }}>
      <label>Carrier name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Countries (ISO codes, comma-separated)<input value={countries} placeholder="PH, SG" onChange={event => setCountries(event.target.value)} /></label>
      <label>HTTPS tracking page or template<input type="url" maxLength={500} value={trackingUrlTemplate} placeholder="https://carrier.example/track/{trackingNumber}" onChange={event => setTrackingUrlTemplate(event.target.value)} /><small>Use {`{trackingNumber}`} only if the carrier accepts it in the URL; otherwise enter the general tracking page.</small></label>
      <div className="adminCarrierActions"><button disabled={saving || !reason.trim()}>Save changes</button><button type="button" disabled={saving || !reason.trim()} onClick={() => toggle(carrier)}>{carrier.enabled ? 'Disable carrier' : 'Enable carrier'}</button></div>
    </form>
  </article>;
}

export function AdminCarriers() {
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [form, setForm] = useState({ code: '', name: '', countries: 'PH', trackingUrlTemplate: '' });
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = async () => setCarriers(await api<Carrier[]>('/api/admin/shipping/carriers'));
  useEffect(() => { load().catch(error => setMessage((error as Error).message)).finally(() => setLoading(false)); }, []);
  const perform = async (work: () => Promise<unknown>, success: string) => {
    setSaving(true); setMessage('');
    try { await work(); await load(); setMessage(success); }
    catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  const create = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reason.trim()) { setMessage('Enter a reason for this change.'); return; }
    void perform(() => api('/api/admin/shipping/carriers', { method: 'POST', body: JSON.stringify({ ...form, countries: form.countries.split(',').map(code => code.trim().toUpperCase()).filter(Boolean), trackingUrlTemplate: form.trackingUrlTemplate.trim() || null, enabled: true, reason }) }), 'Carrier added to the manual tracking directory.');
    setForm({ code: '', name: '', countries: 'PH', trackingUrlTemplate: '' });
  };
  const save = (carrier: Carrier, changes: Pick<Carrier, 'name' | 'countries' | 'trackingUrlTemplate'>) => {
    if (!reason.trim()) { setMessage('Enter a reason for this change.'); return; }
    void perform(() => api(`/api/admin/shipping/carriers/${encodeURIComponent(carrier.id)}`, { method: 'PATCH', body: JSON.stringify({ ...changes, reason }) }), 'Carrier settings saved.');
  };
  const toggle = (carrier: Carrier) => {
    if (!reason.trim()) { setMessage('Enter a reason for this change.'); return; }
    void perform(() => api(`/api/admin/shipping/carriers/${encodeURIComponent(carrier.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !carrier.enabled, reason }) }), `Carrier ${carrier.enabled ? 'disabled' : 'enabled'}.`);
  };

  return <section className="adminCarriers" aria-labelledby="carrier-directory-title">
    <header className="adminCarrierHeading"><div><p className="eyebrow">Shipping integrations</p><h2 id="carrier-directory-title">Carrier directory</h2><p className="muted">Manage the carrier names and official tracking pages sellers can attach to manual shipping services.</p></div></header>
    {message && <p className="notice" role="status" aria-live="polite">{message}</p>}
    <label className="integrationReason">Reason for administrative changes<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
    <div className="notice" role="note">This directory does not connect carrier APIs. Sellers still enter shipping fees and coverage, book shipments with their courier, and enter tracking details manually. Provider API keys are not collected or stored here.</div>
    <form className="card cardBody adminCarrierCreate" onSubmit={create}>
      <h3>Add a carrier</h3>
      <label>Code<input required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.code} placeholder="regional-courier" onChange={event => setForm({ ...form, code: event.target.value.toLowerCase() })} /></label>
      <label>Display name<input required maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>Countries (ISO codes)<input value={form.countries} placeholder="PH, SG" onChange={event => setForm({ ...form, countries: event.target.value })} /></label>
      <label>HTTPS tracking page or template<input type="url" maxLength={500} value={form.trackingUrlTemplate} placeholder="https://carrier.example/track/{trackingNumber}" onChange={event => setForm({ ...form, trackingUrlTemplate: event.target.value })} /><small>Use {`{trackingNumber}`} only if supported by the carrier.</small></label>
      <button className="primary" disabled={saving || !reason.trim()}>Add carrier</button>
    </form>
    <div className="adminCarrierList"><h3>Configured carriers</h3>{loading ? <p className="empty" role="status">Loading carriers…</p> : carriers.length ? carriers.map(carrier => <CarrierRow key={carrier.id} carrier={carrier} reason={reason} saving={saving} save={save} toggle={toggle} />) : <div className="empty">No carriers configured yet.</div>}</div>
  </section>;
}
