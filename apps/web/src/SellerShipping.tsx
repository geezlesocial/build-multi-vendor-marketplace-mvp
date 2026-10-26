import React, { useEffect, useState } from 'react';
import './SellerShipping.css';
import { formatMinor } from './money.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? undefined as T : response.json();
}

type Zone = { id?: string; countryCode: string; regionKey?: string; regionLabel?: string | null; cityKey?: string; cityLabel?: string | null };
type Discount = { id: string; name: string; type: string; amountMinor: number | null; basisPoints: number | null; priority: number; enabled: boolean; minimumQuantity: number | null; minimumSubtotalMinor: number | null; products: { product: { id: string; name: string } }[] };
type CarrierProvider = { id: string; code: string; name: string; countries: string[]; trackingUrlTemplate: string | null };
type Service = { id: string; name: string; enabled: boolean; supportsCod: boolean; carrierProviderId: string | null; carrierProvider: CarrierProvider | null; feeMinor: number; currency: string; estimatedMinDays: number | null; estimatedMaxDays: number | null; zones: Zone[]; discounts: Discount[] };
type Listing = { id: string; name: string; status: string };
type ShippingData = { currency: string; services: Service[]; carrierProviders: CarrierProvider[] };
type ZoneForm = { countryCode: string; region: string; city: string };
const blankZone = (): ZoneForm => ({ countryCode: 'US', region: '', city: '' });
const money = (minor: number, currency: string) => formatMinor(minor, currency);

export function SellerShipping() {
  const [data, setData] = useState<ShippingData | null>(null);
  const [products, setProducts] = useState<Listing[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [carrierProviderId, setCarrierProviderId] = useState('');
  const [fee, setFee] = useState(500);
  const [supportsCod, setSupportsCod] = useState(false);
  const [minDays, setMinDays] = useState('');
  const [maxDays, setMaxDays] = useState('');
  const [zones, setZones] = useState<ZoneForm[]>([blankZone()]);
  const [discountServiceId, setDiscountServiceId] = useState('');
  const [discountName, setDiscountName] = useState('');
  const [discountType, setDiscountType] = useState<'FREE' | 'FIXED' | 'PERCENTAGE'>('FREE');
  const [discountValue, setDiscountValue] = useState(0);
  const [discountPriority, setDiscountPriority] = useState(0);
  const [discountStartsAt, setDiscountStartsAt] = useState('');
  const [discountEndsAt, setDiscountEndsAt] = useState('');
  const [discountProducts, setDiscountProducts] = useState<string[]>([]);
  const [minQuantity, setMinQuantity] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');

  const load = async () => {
    const [shipping, listings] = await Promise.all([
      api<ShippingData>('/api/seller/shipping'), api<Listing[]>('/api/seller/products')
    ]);
    setData(shipping); setProducts(listings); setDiscountServiceId(current => current || shipping.services[0]?.id || '');
  };
  useEffect(() => { void load().catch(error => setMessage((error as Error).message)).finally(() => setLoading(false)); }, []);
  const addService = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api('/api/seller/shipping/services', { method: 'POST', body: JSON.stringify({ name, carrierProviderId: carrierProviderId || null, feeMinor: Number(fee), supportsCod, estimatedMinDays: minDays === '' ? null : Number(minDays), estimatedMaxDays: maxDays === '' ? null : Number(maxDays), zones }) });
      setName(''); setCarrierProviderId(''); setSupportsCod(false); setZones([blankZone()]); await load(); setMessage('Shipping service saved.');
    } catch (error) { setMessage((error as Error).message); }
  };
  const addDiscount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const body = {
        serviceId: discountServiceId, name: discountName, type: discountType,
        ...(discountType === 'FIXED' ? { amountMinor: Number(discountValue) } : {}),
        ...(discountType === 'PERCENTAGE' ? { basisPoints: Number(discountValue) } : {}),
        priority: Number(discountPriority), productIds: discountProducts,
        startsAt: discountStartsAt ? new Date(discountStartsAt).toISOString() : null,
        endsAt: discountEndsAt ? new Date(discountEndsAt).toISOString() : null,
        minimumQuantity: minQuantity === '' ? null : Number(minQuantity),
        minimumSubtotalMinor: minSubtotal === '' ? null : Number(minSubtotal)
      };
      await api('/api/seller/shipping/discounts', { method: 'POST', body: JSON.stringify(body) });
      setDiscountName(''); setDiscountProducts([]); setDiscountValue(0); await load(); setMessage('Product shipping discount saved.');
    } catch (error) { setMessage((error as Error).message); }
  };
  const toggleDiscount = async (discount: Discount) => {
    try { await api(`/api/seller/shipping/discounts/${encodeURIComponent(discount.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !discount.enabled }) }); await load(); setMessage('Discount status updated.'); }
    catch (error) { setMessage((error as Error).message); }
  };
  const updateZones = (index: number, changes: Partial<ZoneForm>) => setZones(current => current.map((zone, zoneIndex) => zoneIndex === index ? { ...zone, ...changes } : zone));

  return <section className="sellerShipping">
    <h2>Shipping settings</h2>
    <p className="muted">Configure delivery fees and coverage. Carrier selections use the marketplace tracking directory only; you still book shipments and enter tracking details manually. No carrier API labels or live quotes are created. Currency follows the platform base currency ({data?.currency ?? '…'}).</p>
    {message && <p className="notice" role="status">{message}</p>}
    {loading ? <div className="empty" role="status">Loading shipping settings…</div> : !data ? <div className="empty" role="alert">Shipping settings could not be loaded. Refresh to retry.</div> : <>
      <form className="card cardBody shippingForm" onSubmit={addService}>
        <h3>Add a delivery service</h3>
        <label>Courier from marketplace directory<select value={carrierProviderId} onChange={event => setCarrierProviderId(event.target.value)}><option value="">Manual / custom courier</option>{data.carrierProviders.map(carrier => <option key={carrier.id} value={carrier.id}>{carrier.name}{carrier.countries.length ? ` · ${carrier.countries.join(', ')}` : ''}</option>)}</select></label>
        <label>Courier or service name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Standard delivery" /></label>
        <label>Shipping fee in minor units ({data.currency})<input type="number" min="0" max="2000000000" step="1" required value={fee} onChange={event => setFee(Number(event.target.value))} /></label>
        <label className="codOptIn"><input type="checkbox" checked={supportsCod} onChange={event => setSupportsCod(event.target.checked)} />This courier/service accepts cash on delivery (COD)</label>
        <div className="two"><label>Minimum delivery days (optional)<input type="number" min="0" max="365" value={minDays} onChange={event => setMinDays(event.target.value)} /></label><label>Maximum delivery days (optional)<input type="number" min="0" max="365" value={maxDays} onChange={event => setMaxDays(event.target.value)} /></label></div>
        <div><h4>Coverage zones</h4><p className="muted">Leave state/province and city empty for country-wide coverage. More-specific zones take priority.</p>{zones.map((zone, index) => <fieldset className="shippingZoneForm" key={index}><legend>Zone {index + 1}</legend><label>Country code<input required minLength={2} maxLength={2} value={zone.countryCode} onChange={event => updateZones(index, { countryCode: event.target.value.toUpperCase() })} /></label><label>State or province (optional)<input maxLength={100} value={zone.region} onChange={event => updateZones(index, { region: event.target.value })} /></label><label>City (optional; requires state/province)<input maxLength={100} value={zone.city} onChange={event => updateZones(index, { city: event.target.value })} /></label>{zones.length > 1 && <button type="button" onClick={() => setZones(current => current.filter((_, i) => i !== index))}>Remove zone</button>}</fieldset>)}<button type="button" onClick={() => setZones(current => [...current, blankZone()])}>Add coverage zone</button></div>
        <button className="primary">Save shipping service</button>
      </form>

      <div className="settings"><h3>Your services</h3>{data.services.length === 0 ? <div className="empty">No delivery service yet. Add a service before buyers can check out your products.</div> : data.services.map(service => <ShippingServiceEditor key={service.id} service={service} currency={data.currency} onSaved={async () => { await load(); setMessage('Shipping service updated.'); }} onError={error => setMessage(error)} />)}</div>
      <CarrierAssignment services={data.services} carriers={data.carrierProviders} onSaved={async () => { await load(); setMessage('Carrier association saved.'); }} onError={error => setMessage(error)} />

      <form className="card cardBody shippingForm" onSubmit={addDiscount}>
        <h3>Add a product shipping discount</h3>
        <p className="muted">A discount applies only when the shipment contains at least one selected eligible product. Only one eligible rule applies: highest priority first, then the oldest rule; discount is capped at the shipping fee.</p>
        <label>Service<select required value={discountServiceId} onChange={event => setDiscountServiceId(event.target.value)}><option value="">Select a service</option>{data.services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
        <label>Discount name<input required value={discountName} onChange={event => setDiscountName(event.target.value)} maxLength={120} /></label>
        <label>Discount type<select value={discountType} onChange={event => setDiscountType(event.target.value as typeof discountType)}><option value="FREE">Free shipping</option><option value="FIXED">Fixed amount (minor units)</option><option value="PERCENTAGE">Percentage (basis points; 100 = 1%)</option></select></label>
        {discountType !== 'FREE' && <label>{discountType === 'FIXED' ? `Amount (${data.currency} minor units)` : 'Percentage in basis points'}<input type="number" min="0" max={discountType === 'FIXED' ? 2000000000 : 10000} step="1" required value={discountValue} onChange={event => setDiscountValue(Number(event.target.value))} /></label>}
        <div className="two"><label>Priority (higher applies first)<input type="number" min="-100000" max="100000" value={discountPriority} onChange={event => setDiscountPriority(Number(event.target.value))} /></label><label>Minimum eligible quantity (optional)<input type="number" min="1" value={minQuantity} onChange={event => setMinQuantity(event.target.value)} /></label></div>
        <div className="two"><label>Starts at (optional)<input type="datetime-local" value={discountStartsAt} onChange={event => setDiscountStartsAt(event.target.value)} /></label><label>Ends at (optional)<input type="datetime-local" value={discountEndsAt} onChange={event => setDiscountEndsAt(event.target.value)} /></label></div>
        <label>Minimum eligible product subtotal in minor units (optional)<input type="number" min="0" value={minSubtotal} onChange={event => setMinSubtotal(event.target.value)} /></label>
        <label>Eligible approved products<select multiple size={Math.min(6, Math.max(2, products.filter(product => product.status === 'APPROVED').length))} value={discountProducts} onChange={event => setDiscountProducts(Array.from(event.target.selectedOptions, option => option.value))}>{products.filter(product => product.status === 'APPROVED').map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
        <button className="primary" disabled={!discountServiceId || discountProducts.length === 0}>Save discount</button>
      </form>
      <section><h3>Configured discounts</h3>{data.services.flatMap(service => service.discounts.map(discount => <article className="setting" key={discount.id}><div><strong>{service.name} · {discount.name}</strong><p>{discount.type.replaceAll('_', ' ')} · priority {discount.priority} · {discount.products.map(item => item.product.name).join(', ') || 'No products'}</p></div><button type="button" onClick={() => void toggleDiscount(discount)}>{discount.enabled ? 'Disable discount' : 'Enable discount'}</button></article>))}{data.services.every(service => service.discounts.length === 0) && <div className="empty">No product shipping discounts configured.</div>}</section>
    </>}
  </section>;
}

function CarrierAssignment({ services, carriers, onSaved, onError }: { services: Service[]; carriers: CarrierProvider[]; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [carrierProviderId, setCarrierProviderId] = useState('');
  const [supportsCod, setSupportsCod] = useState(false);
  useEffect(() => {
    if (!services.some(service => service.id === serviceId)) setServiceId(services[0]?.id ?? '');
    const current = services.find(service => service.id === serviceId);
    setCarrierProviderId(current?.carrierProviderId ?? '');
    setSupportsCod(current?.supportsCod ?? false);
  }, [services, serviceId]);
  const selected = services.find(service => service.id === serviceId);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    try {
      await api(`/api/seller/shipping/services/${encodeURIComponent(selected.id)}`, { method: 'PATCH', body: JSON.stringify({
        name: selected.name, carrierProviderId: carrierProviderId || null, feeMinor: selected.feeMinor, enabled: selected.enabled, supportsCod,
        estimatedMinDays: selected.estimatedMinDays, estimatedMaxDays: selected.estimatedMaxDays,
        zones: selected.zones.map(zone => ({ countryCode: zone.countryCode, region: zone.regionLabel ?? zone.regionKey ?? '', city: zone.cityLabel ?? zone.cityKey ?? '' }))
      }) });
      await onSaved();
    } catch (error) { onError((error as Error).message); }
  };
  if (!services.length) return null;
  return <form className="card cardBody shippingForm" onSubmit={save}>
    <h3>Choose a carrier for an existing service</h3>
    <p className="muted">The carrier link is used for buyer tracking after you provide a tracking number. Rates and shipment booking remain manual.</p>
    <label>Shipping service<select value={serviceId} onChange={event => setServiceId(event.target.value)}>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
    <label>Carrier<select value={carrierProviderId} onChange={event => setCarrierProviderId(event.target.value)}><option value="">Manual / custom courier</option>{carriers.map(carrier => <option key={carrier.id} value={carrier.id}>{carrier.name}{carrier.countries.length ? ` · ${carrier.countries.join(', ')}` : ''}</option>)}</select></label>
    <label className="codOptIn"><input type="checkbox" checked={supportsCod} onChange={event => setSupportsCod(event.target.checked)} />This delivery service accepts cash on delivery (COD)</label>
    <button className="primary" disabled={!selected}>Save carrier association</button>
  </form>;
}

function ShippingServiceEditor({ service, currency, onSaved, onError }: { service: Service; currency: string; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(service.name); const [fee, setFee] = useState(service.feeMinor);
  const [supportsCod, setSupportsCod] = useState(service.supportsCod);
  const [carrierProviderId, setCarrierProviderId] = useState(service.carrierProviderId ?? '');
  const [minDays, setMinDays] = useState(service.estimatedMinDays?.toString() ?? ''); const [maxDays, setMaxDays] = useState(service.estimatedMaxDays?.toString() ?? '');
  const [zones, setZones] = useState<ZoneForm[]>(service.zones.map(zone => ({ countryCode: zone.countryCode, region: zone.regionLabel ?? zone.regionKey ?? '', city: zone.cityLabel ?? zone.cityKey ?? '' })));
  useEffect(() => { setName(service.name); setFee(service.feeMinor); setSupportsCod(service.supportsCod); setCarrierProviderId(service.carrierProviderId ?? ''); setZones(service.zones.map(zone => ({ countryCode: zone.countryCode, region: zone.regionLabel ?? zone.regionKey ?? '', city: zone.cityLabel ?? zone.cityKey ?? '' }))); }, [service]);
  const save = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); try { await api(`/api/seller/shipping/services/${encodeURIComponent(service.id)}`, { method: 'PATCH', body: JSON.stringify({ name, carrierProviderId: carrierProviderId || null, feeMinor: Number(fee), supportsCod, enabled: service.enabled, estimatedMinDays: minDays === '' ? null : Number(minDays), estimatedMaxDays: maxDays === '' ? null : Number(maxDays), zones }) }); await onSaved(); } catch (error) { onError((error as Error).message); } };
  const toggle = async () => { try { await api(`/api/seller/shipping/services/${encodeURIComponent(service.id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: !service.enabled }) }); await onSaved(); } catch (error) { onError((error as Error).message); } };
  return <article className="card cardBody shippingService"><form className="shippingForm" onSubmit={save}><div className="setting"><div><h4>{service.name}</h4><p>{money(service.feeMinor, currency)} · {service.enabled ? 'Active' : 'Disabled'}</p></div><button type="button" onClick={() => void toggle()}>{service.enabled ? 'Disable service' : 'Enable service'}</button></div><label>Service name<input required value={name} onChange={event => setName(event.target.value)} /></label><label>Fee in minor units<input type="number" min="0" max="2000000000" value={fee} onChange={event => setFee(Number(event.target.value))} /></label><div className="two"><label>Minimum delivery days<input type="number" min="0" max="365" value={minDays} onChange={event => setMinDays(event.target.value)} /></label><label>Maximum delivery days<input type="number" min="0" max="365" value={maxDays} onChange={event => setMaxDays(event.target.value)} /></label></div><h5>Coverage</h5>{zones.map((zone, index) => <div className="two shippingZoneRow" key={index}><label>Country<input value={zone.countryCode} maxLength={2} onChange={event => setZones(current => current.map((item, i) => i === index ? { ...item, countryCode: event.target.value.toUpperCase() } : item))} /></label><label>State/province<input value={zone.region} onChange={event => setZones(current => current.map((item, i) => i === index ? { ...item, region: event.target.value } : item))} /></label><label>City<input value={zone.city} onChange={event => setZones(current => current.map((item, i) => i === index ? { ...item, city: event.target.value } : item))} /></label><button type="button" onClick={() => setZones(current => current.filter((_, i) => i !== index))} disabled={zones.length <= 1}>Remove zone</button></div>)}<button type="button" onClick={() => setZones(current => [...current, blankZone()])}>Add zone</button><button className="primary">Save service changes</button></form></article>;
}
