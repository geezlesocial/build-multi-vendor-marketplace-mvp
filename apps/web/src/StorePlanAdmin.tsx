import React, { useEffect, useMemo, useState } from 'react';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? (undefined as T) : response.json();
}

type Entitlements = { productLimit: number; storeLimit: number; vendorLimit: number; staffSeatLimit: number; allowedThemes: string[]; customDomainEligible: boolean; paymentConnectors: string[]; mobileTemplates: string[] };
type PlanVersion = Entitlements & { id: string; version: number; status: string; name: string; description: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number; annualDiscountPercent: number | null; defaultInterval: 'MONTHLY' | 'ANNUAL'; termIntervals: number | null; expirationBehavior: string; cancellationPolicy: string; freeTrialDays: number; introPriceMinor: number | null; introDurationDays: number | null; effectiveFrom: string | null; effectiveUntil: string | null; _count: { assignments: number } };
type Plan = { id: string; key: string; name: string; status: string; versions: PlanVersion[] };
type StoreRow = { id: string; name: string; slug: string; seller: { id: string; status: string; user: { name: string; email: string }; _count: { products: number; staff: number } } };
type Assignment = { id: string; status: string; source: string; effectiveFrom: string; effectiveUntil: string | null; reason: string | null; planVersion: { version: number; plan: { name: string; key: string } }; assignedBy: { name: string; email: string } | null };

const blankEntitlements: Entitlements = { productLimit: 25, storeLimit: 1, vendorLimit: 1, staffSeatLimit: 2, allowedThemes: ['CLASSIC'], customDomainEligible: false, paymentConnectors: [], mobileTemplates: ['RESPONSIVE_STANDARD'] };
const themeOptions = ['CLASSIC', 'EDITORIAL', 'BOUTIQUE'];
const connectorOptions = ['STRIPE', 'PAYPAL'];
const mobileOptions = ['RESPONSIVE_STANDARD', 'MOBILE_COMPACT', 'MOBILE_EDITORIAL'];
const reasonDefault = 'Configured through platform plan administration';
type PricingForm = { description: string; currency: string; monthlyPrice: string; annualPriceMode: 'FULL' | 'FIXED' | 'DISCOUNT'; annualPrice: string; annualDiscountPercent: string; defaultInterval: 'MONTHLY' | 'ANNUAL'; termIntervals: string; expirationBehavior: 'DOWNGRADE_TO_LEGACY' | 'SUSPEND_SELLER'; cancellationPolicy: 'CANCEL_ANYTIME' | 'CANCEL_AT_TERM_END'; freeTrialDays: string; introPrice: string; introDurationDays: string; effectiveFrom: string; effectiveUntil: string };
const blankPricing: PricingForm = { description: '', currency: 'USD', monthlyPrice: '0.00', annualPriceMode: 'FULL', annualPrice: '', annualDiscountPercent: '10', defaultInterval: 'MONTHLY', termIntervals: '', expirationBehavior: 'DOWNGRADE_TO_LEGACY', cancellationPolicy: 'CANCEL_ANYTIME', freeTrialDays: '0', introPrice: '', introDurationDays: '30', effectiveFrom: '', effectiveUntil: '' };
const minorToInput = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
const money = (currency: string, minor: number) => `${currency} ${(Math.floor(minor / 100)).toLocaleString()}.${String(minor % 100).padStart(2, '0')}`;
const inputToMinor = (text: string) => { const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim()); if (!match) return null; const value = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0'); return value <= 2_000_000_000n ? Number(value) : null; };

export function StorePlanAdmin() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [entitlements, setEntitlements] = useState<Entitlements>(blankEntitlements);
  const [pricing, setPricing] = useState<PricingForm>(blankPricing);
  const [reason, setReason] = useState(reasonDefault);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [nextPlans, nextStores] = await Promise.all([api<Plan[]>('/api/admin/store-plans'), api<StoreRow[]>('/api/admin/store-plan-stores')]);
    setPlans(nextPlans);
    setStores(nextStores);
    setSelectedStoreId(current => current || nextStores[0]?.id || '');
  };
  useEffect(() => { load().catch(error => setMessage(error.message)).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!selectedStoreId) { setAssignments([]); return; }
    api<Assignment[]>(`/api/admin/store-plan-stores/${encodeURIComponent(selectedStoreId)}/assignments`).then(setAssignments).catch(error => setMessage(error.message));
  }, [selectedStoreId]);

  const selectedPlan = plans.find(plan => plan.id === selectedPlanId) ?? null;
  const activeVersions = useMemo(() => plans.filter(plan => plan.status === 'ACTIVE').flatMap(plan => plan.versions.filter(version => version.status === 'ACTIVE' && version.monthlyPriceMinor === 0 && version.annualPriceMinor === 0 && version.introPriceMinor === null && version.freeTrialDays === 0).map(version => ({ ...version, plan }))), [plans]);
  const updateList = (field: 'allowedThemes' | 'paymentConnectors' | 'mobileTemplates', value: string, checked: boolean) => setEntitlements(current => ({ ...current, [field]: checked ? [...current[field], value] : current[field].filter(item => item !== value) }));
  const editPlan = (plan: Plan) => {
    const source = plan.versions.find(version => version.status === 'DRAFT') ?? plan.versions.find(version => version.status === 'ACTIVE') ?? plan.versions[0];
    if (!source) return;
    setSelectedPlanId(plan.id); setName(source.name); setKey(plan.key);
    setEntitlements({ productLimit: source.productLimit, storeLimit: source.storeLimit, vendorLimit: source.vendorLimit, staffSeatLimit: source.staffSeatLimit, allowedThemes: source.allowedThemes, customDomainEligible: source.customDomainEligible, paymentConnectors: source.paymentConnectors, mobileTemplates: source.mobileTemplates });
    const mode = source.annualDiscountPercent !== null ? 'DISCOUNT' : source.annualPriceMinor === source.monthlyPriceMinor * 12 ? 'FULL' : 'FIXED';
    setPricing({ ...blankPricing, description: source.description, currency: source.currency, monthlyPrice: minorToInput(source.monthlyPriceMinor), annualPriceMode: mode, annualPrice: mode === 'FIXED' ? minorToInput(source.annualPriceMinor) : '', annualDiscountPercent: String(source.annualDiscountPercent ?? 10), defaultInterval: source.defaultInterval, termIntervals: source.termIntervals === null ? '' : String(source.termIntervals), expirationBehavior: source.expirationBehavior as PricingForm['expirationBehavior'], cancellationPolicy: source.cancellationPolicy as PricingForm['cancellationPolicy'], freeTrialDays: String(source.freeTrialDays), introPrice: source.introPriceMinor === null ? '' : minorToInput(source.introPriceMinor), introDurationDays: String(source.introDurationDays ?? 30), effectiveFrom: source.effectiveFrom?.slice(0, 10) ?? '', effectiveUntil: source.effectiveUntil?.slice(0, 10) ?? '' });
  };
  const pricingPayload = () => ({
    description: pricing.description,
    currency: pricing.currency,
    monthlyPrice: pricing.monthlyPrice,
    annualPriceMode: pricing.annualPriceMode,
    ...(pricing.annualPriceMode === 'FIXED' ? { annualPrice: pricing.annualPrice } : {}),
    ...(pricing.annualPriceMode === 'DISCOUNT' ? { annualDiscountPercent: Number(pricing.annualDiscountPercent) } : {}),
    defaultInterval: pricing.defaultInterval,
    termIntervals: pricing.termIntervals ? Number(pricing.termIntervals) : null,
    expirationBehavior: pricing.expirationBehavior,
    cancellationPolicy: pricing.cancellationPolicy,
    freeTrialDays: Number(pricing.freeTrialDays),
    ...(pricing.introPrice ? { introPrice: pricing.introPrice, introDurationDays: Number(pricing.introDurationDays) } : {}),
    ...(pricing.effectiveFrom ? { effectiveFrom: new Date(`${pricing.effectiveFrom}T00:00:00.000Z`).toISOString() } : {}),
    ...(pricing.effectiveUntil ? { effectiveUntil: new Date(`${pricing.effectiveUntil}T00:00:00.000Z`).toISOString() } : {})
  });
  const savePlan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      if (selectedPlanId) await api(`/api/admin/store-plans/${selectedPlanId}`, { method: 'PATCH', body: JSON.stringify({ name, entitlements, pricing: pricingPayload(), reason }) });
      else await api('/api/admin/store-plans', { method: 'POST', body: JSON.stringify({ name, key, entitlements, pricing: pricingPayload(), reason }) });
      await load(); setMessage('Plan saved as a draft version. Activate it before assignment.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  const activate = async (plan: Plan, version: PlanVersion) => {
    if (!window.confirm(`Activate ${plan.name} version ${version.version} for new Store subscriptions and assignments? Existing subscriptions keep their saved price and terms. Activation does not charge anyone.`)) return;
    setSaving(true); setMessage('');
    try { await api(`/api/admin/store-plans/${plan.id}/activate`, { method: 'POST', body: JSON.stringify({ versionId: version.id, reason }) }); await load(); setMessage(`${plan.name} version ${version.version} is active for new assignments.`); }
    catch (error) { setMessage((error as Error).message); } finally { setSaving(false); }
  };
  const retire = async (plan: Plan) => {
    if (!window.confirm(`Retire ${plan.name}? Existing Store assignments stay active; this only blocks new assignments.`)) return;
    setSaving(true); setMessage('');
    try { await api(`/api/admin/store-plans/${plan.id}/retire`, { method: 'POST', body: JSON.stringify({ reason }) }); await load(); setMessage(`${plan.name} retired. Existing Store assignments remain in effect.`); }
    catch (error) { setMessage((error as Error).message); } finally { setSaving(false); }
  };
  const assign = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedStoreId || !versionId) return; setSaving(true); setMessage('');
    try { await api(`/api/admin/store-plan-stores/${selectedStoreId}/assignments`, { method: 'POST', body: JSON.stringify({ versionId, reason }) }); await load(); setAssignments(await api<Assignment[]>(`/api/admin/store-plan-stores/${encodeURIComponent(selectedStoreId)}/assignments`)); setMessage('Plan assignment saved and audited.'); }
    catch (error) { setMessage((error as Error).message); } finally { setSaving(false); }
  };

  const monthlyPreview = inputToMinor(pricing.monthlyPrice);
  const annualBaseMinor = monthlyPreview === null ? null : BigInt(monthlyPreview) * 12n;
  const annualPreview = monthlyPreview === null ? null : pricing.annualPriceMode === 'FIXED'
    ? inputToMinor(pricing.annualPrice)
    : pricing.annualPriceMode === 'DISCOUNT'
      ? (() => { const percent = Number(pricing.annualDiscountPercent); if (!Number.isInteger(percent) || percent < 1 || percent > 90) return null; const amount = (annualBaseMinor! * BigInt(100 - percent) + 50n) / 100n; return amount <= 2_000_000_000n ? Number(amount) : null; })()
      : annualBaseMinor! <= 2_000_000_000n ? Number(annualBaseMinor) : null;
  const annualSavings = annualBaseMinor !== null && annualPreview !== null ? Number(annualBaseMinor - BigInt(annualPreview)) : null;

  if (loading) return <section className="empty" role="status">Loading Store plans…</section>;
  return <section className="storePlanAdmin">
    <h2>Store plans and versions</h2>
    <p className="muted">Versions are immutable after activation. Retiring a plan blocks new assignments but preserves existing Store entitlements. No subscription billing is collected here.</p>
    {message && <p className="notice" role="status">{message}</p>}
    <div className="storePlanAdminGrid">
      <div>
        <h3>Available plans</h3>
        {plans.length === 0 ? <div className="empty">No plans yet. Create a draft plan to begin.</div> : <div className="settings">{plans.map(plan => <article className="card cardBody storePlanAdminCard" key={plan.id}>
          <div className="storePlanCardHead"><div><p className="eyebrow">{plan.key}</p><h3>{plan.name}</h3></div><span>{plan.status}</span></div>
          {plan.versions.map(version => <div className="storePlanVersion" key={version.id}><span>Version {version.version} · {version.status} · {version._count.assignments} assignment(s)</span>{version.status === 'DRAFT' && plan.status !== 'RETIRED' && <button type="button" disabled={saving} onClick={() => void activate(plan, version)}>Activate version</button>}</div>)}
          {plan.versions.map(version => <div className="muted" key={`${version.id}-terms`}>
            <strong>{version.name} · {money(version.currency, version.monthlyPriceMinor)} / month · {money(version.currency, version.annualPriceMinor)} / year</strong>
            {version.annualDiscountPercent ? ` · ${version.annualDiscountPercent}% annual discount` : ''}
            {` · ${version.freeTrialDays ? `${version.freeTrialDays}-day free trial` : 'no free trial'}`}
            {version.introPriceMinor !== null ? ` · paid intro ${money(version.currency, version.introPriceMinor)} for ${version.introDurationDays} days` : ''}
            {` · ${version.termIntervals ? `${version.termIntervals} intervals` : 'ongoing'}`}
            {` · effective ${version.effectiveFrom ? new Date(version.effectiveFrom).toLocaleDateString() : 'on activation'}`}
            {version.effectiveUntil ? ` through ${new Date(version.effectiveUntil).toLocaleDateString()}` : ''}
            {version.description ? <p>{version.description}</p> : null}
          </div>)}
          <div className="toolbar"><button type="button" onClick={() => editPlan(plan)}>Edit / new version</button>{plan.key !== 'legacy-compatible' && plan.status !== 'RETIRED' && <button type="button" disabled={saving} onClick={() => void retire(plan)}>Retire plan</button>}</div>
        </article>)}</div>}
      </div>
      <form className="card cardBody storePlanForm" onSubmit={savePlan}>
        <h3>{selectedPlanId ? 'Create a new version' : 'Create a plan'}</h3>
        <label>Plan name<input required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        {!selectedPlanId && <label>Plan key<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} value={key} onChange={event => setKey(event.target.value)} /></label>}
        <fieldset className="storePlanPricingFields"><legend>Pricing and billing terms</legend>
          <label>Plan description<textarea maxLength={2000} value={pricing.description} onChange={event => setPricing({ ...pricing, description: event.target.value })} /></label>
          <div className="storePlanNumberGrid">
            <label>Currency<select value={pricing.currency} onChange={event => setPricing({ ...pricing, currency: event.target.value })}>{['AUD', 'CAD', 'EUR', 'GBP', 'NZD', 'SGD', 'USD'].map(currency => <option key={currency}>{currency}</option>)}</select></label>
            <label>Monthly price<input inputMode="decimal" required pattern="(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?" value={pricing.monthlyPrice} onChange={event => setPricing({ ...pricing, monthlyPrice: event.target.value })} aria-describedby="plan-price-help" /></label>
            <label>Default billing interval<select value={pricing.defaultInterval} onChange={event => setPricing({ ...pricing, defaultInterval: event.target.value as PricingForm['defaultInterval'] })}><option value="MONTHLY">Monthly</option><option value="ANNUAL">Annual</option></select></label>
          </div>
          <p id="plan-price-help" className="muted">Amounts accept up to two decimal places and are stored as integer minor units. No payment is collected here.</p>
          <label>Annual pricing<select value={pricing.annualPriceMode} onChange={event => setPricing({ ...pricing, annualPriceMode: event.target.value as PricingForm['annualPriceMode'] })}><option value="FULL">12 monthly payments (no discount)</option><option value="FIXED">Fixed annual price</option><option value="DISCOUNT">Annual discount percentage</option></select></label>
          {pricing.annualPriceMode === 'FIXED' && <label>Annual price<input inputMode="decimal" required pattern="(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?" value={pricing.annualPrice} onChange={event => setPricing({ ...pricing, annualPrice: event.target.value })} /></label>}
          {pricing.annualPriceMode === 'DISCOUNT' && <label>Annual discount (%)<input type="number" min="1" max="90" required value={pricing.annualDiscountPercent} onChange={event => setPricing({ ...pricing, annualDiscountPercent: event.target.value })} /></label>}
          <div className="storePlanNumberGrid">
            <label>Term length in billing intervals<input type="number" min="1" max="120" value={pricing.termIntervals} onChange={event => setPricing({ ...pricing, termIntervals: event.target.value })} placeholder="Ongoing" /></label>
            <label>Expiration behavior<select value={pricing.expirationBehavior} onChange={event => setPricing({ ...pricing, expirationBehavior: event.target.value as PricingForm['expirationBehavior'] })}><option value="DOWNGRADE_TO_LEGACY">Downgrade to legacy-compatible</option><option value="SUSPEND_SELLER">Suspend selling</option></select></label>
            <label>Cancellation policy<select value={pricing.cancellationPolicy} onChange={event => setPricing({ ...pricing, cancellationPolicy: event.target.value as PricingForm['cancellationPolicy'] })}><option value="CANCEL_ANYTIME">Cancel anytime</option><option value="CANCEL_AT_TERM_END">Cancel at term end</option></select></label>
          </div>
          <div className="storePlanNumberGrid">
            <label>Free-trial days<input type="number" min="0" max="90" value={pricing.freeTrialDays} onChange={event => setPricing({ ...pricing, freeTrialDays: event.target.value })} /></label>
            <label>Paid introductory price<input inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?" value={pricing.introPrice} onChange={event => setPricing({ ...pricing, introPrice: event.target.value })} placeholder="None" /></label>
            <label>Paid introductory days<input type="number" min="1" max="365" value={pricing.introDurationDays} disabled={!pricing.introPrice} onChange={event => setPricing({ ...pricing, introDurationDays: event.target.value })} /></label>
          </div>
          <p className="muted">A free trial is free. A paid introductory offer is charged separately, then the selected recurring interval price applies.</p>
          <div className="storePlanNumberGrid">
            <label>Effective from<input type="date" value={pricing.effectiveFrom} onChange={event => setPricing({ ...pricing, effectiveFrom: event.target.value })} /></label>
            <label>Effective until<input type="date" value={pricing.effectiveUntil} onChange={event => setPricing({ ...pricing, effectiveUntil: event.target.value })} /></label>
          </div>
          <div className="card cardBody storePlanPricePreview" aria-live="polite">
            <strong>Price preview</strong>
            <p>{monthlyPreview === null ? 'Enter a valid monthly amount.' : `${money(pricing.currency, monthlyPreview)} monthly · ${annualPreview === null ? 'Check the annual price and discount values.' : `${money(pricing.currency, annualPreview)} per year · ${annualSavings === 0 ? 'no annual savings' : annualSavings! > 0 ? `saves ${money(pricing.currency, annualSavings!)} compared with 12 monthly payments` : 'annual price exceeds 12 monthly payments'}`}`}</p>
            {Number(pricing.freeTrialDays) > 0 && <p>{pricing.freeTrialDays}-day free trial before recurring billing.</p>}
            {pricing.introPrice && <p>Paid introductory charge: {inputToMinor(pricing.introPrice) === null ? 'Check the amount.' : `${money(pricing.currency, inputToMinor(pricing.introPrice)!)} for ${pricing.introDurationDays || '…'} days, followed by the selected recurring price.`}</p>}
            <p>{pricing.cancellationPolicy === 'CANCEL_AT_TERM_END' ? 'Cancellation takes effect at the end of the billing term.' : 'Cancellation is allowed at any time; access follows the configured expiration behavior.'}</p>
          </div>
        </fieldset>
        <div className="storePlanNumberGrid">
          <label>Product limit<input type="number" min="1" max="2000000000" value={entitlements.productLimit} onChange={event => setEntitlements({ ...entitlements, productLimit: Number(event.target.value) })} /></label>
          <label>Store limit<input type="number" min="1" max="100000" value={entitlements.storeLimit} onChange={event => setEntitlements({ ...entitlements, storeLimit: Number(event.target.value) })} /></label>
          <label>Vendor limit<input type="number" min="1" max="100000" value={entitlements.vendorLimit} onChange={event => setEntitlements({ ...entitlements, vendorLimit: Number(event.target.value) })} /></label>
          <label>Staff-seat limit<input type="number" min="0" max="100000" value={entitlements.staffSeatLimit} onChange={event => setEntitlements({ ...entitlements, staffSeatLimit: Number(event.target.value) })} /></label>
        </div>
        <fieldset><legend>Allowed themes</legend>{themeOptions.map(option => <label className="storePlanCheck" key={option}><input type="checkbox" checked={entitlements.allowedThemes.includes(option)} onChange={event => updateList('allowedThemes', option, event.target.checked)} />{option}</label>)}</fieldset>
        <fieldset><legend>Eligible payment connectors</legend><p className="muted">Eligibility only; does not connect seller merchant accounts.</p>{connectorOptions.map(option => <label className="storePlanCheck" key={option}><input type="checkbox" checked={entitlements.paymentConnectors.includes(option)} onChange={event => updateList('paymentConnectors', option, event.target.checked)} />{option}</label>)}</fieldset>
        <fieldset><legend>Responsive storefront templates</legend>{mobileOptions.map(option => <label className="storePlanCheck" key={option}><input type="checkbox" checked={entitlements.mobileTemplates.includes(option)} onChange={event => updateList('mobileTemplates', option, event.target.checked)} />{option.replaceAll('_', ' ')}</label>)}</fieldset>
        <label className="storePlanCheck"><input type="checkbox" checked={entitlements.customDomainEligible} onChange={event => setEntitlements({ ...entitlements, customDomainEligible: event.target.checked })} />Custom-domain eligibility (DNS/TLS provisioning is not included)</label>
        <label>Reason for change<input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <button className="primary" disabled={saving}>{saving ? 'Saving…' : selectedPlanId ? 'Save new draft version' : 'Create draft plan'}</button>
        {selectedPlanId && <button type="button" onClick={() => { setSelectedPlanId(''); setName(''); setKey(''); setEntitlements(blankEntitlements); setPricing(blankPricing); }}>Start a new plan</button>}
      </form>
    </div>
    <section className="card cardBody storeAssignmentPanel">
      <h3>Assign a plan version to a Store</h3>
      <p className="muted">Vendor count and staff seats are separate. Current Stores have one seller owner; no additional-vendor or multiple-Store membership workflow is introduced.</p>
      {stores.length === 0 ? <div className="empty">No Stores are available for assignment.</div> : <>
        <label>Store<select value={selectedStoreId} onChange={event => setSelectedStoreId(event.target.value)}>{stores.map(store => <option key={store.id} value={store.id}>{store.name} · {store.seller.user.name} ({store.seller.user.email})</option>)}</select></label>
        <form className="storeAssignmentForm" onSubmit={assign}>
          <label>Active plan version<select required value={versionId} onChange={event => setVersionId(event.target.value)}><option value="">Choose a version</option>{activeVersions.map(version => <option key={version.id} value={version.id}>{version.plan.name} · v{version.version}</option>)}</select></label>
          <label>Reason<input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button className="primary" disabled={saving || !versionId}>Assign plan</button>
        </form>
        <h4>Assignment history</h4>
        {assignments.length === 0 ? <div className="empty">No assignment history found.</div> : <div className="table">{assignments.map(item => <div className="row storeAssignmentRow" key={item.id}><span>{item.planVersion.plan.name} · v{item.planVersion.version}</span><span>{item.status}</span><span>{new Date(item.effectiveFrom).toLocaleString()}</span><span>{item.assignedBy?.name ?? item.source}</span></div>)}</div>}
      </>}
    </section>
    <p className="muted">Store limits currently reflect one Store per Seller and vendor limits reflect the single Seller owner. Staff seats count SellerStaff records only. Existing products and staff remain accessible after a lower-limit assignment; over-limit usage blocks new product creation and is never silently removed.</p>
  </section>;
}
