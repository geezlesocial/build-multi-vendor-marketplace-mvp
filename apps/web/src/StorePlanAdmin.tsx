import React, { useEffect, useMemo, useState } from 'react';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? (undefined as T) : response.json();
}

type Entitlements = { productLimit: number; storeLimit: number; vendorLimit: number; staffSeatLimit: number; allowedThemes: string[]; customDomainEligible: boolean; paymentConnectors: string[]; mobileTemplates: string[] };
type PlanVersion = Entitlements & { id: string; version: number; status: string; _count: { assignments: number } };
type Plan = { id: string; key: string; name: string; status: string; versions: PlanVersion[] };
type StoreRow = { id: string; name: string; slug: string; seller: { id: string; status: string; user: { name: string; email: string }; _count: { products: number; staff: number } } };
type Assignment = { id: string; status: string; source: string; effectiveFrom: string; effectiveUntil: string | null; reason: string | null; planVersion: { version: number; plan: { name: string; key: string } }; assignedBy: { name: string; email: string } | null };

const blankEntitlements: Entitlements = { productLimit: 25, storeLimit: 1, vendorLimit: 1, staffSeatLimit: 2, allowedThemes: ['CLASSIC'], customDomainEligible: false, paymentConnectors: [], mobileTemplates: ['RESPONSIVE_STANDARD'] };
const themeOptions = ['CLASSIC', 'EDITORIAL', 'BOUTIQUE'];
const connectorOptions = ['STRIPE', 'PAYPAL'];
const mobileOptions = ['RESPONSIVE_STANDARD', 'MOBILE_COMPACT', 'MOBILE_EDITORIAL'];
const reasonDefault = 'Configured through platform plan administration';

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
  const activeVersions = useMemo(() => plans.filter(plan => plan.status === 'ACTIVE').flatMap(plan => plan.versions.filter(version => version.status === 'ACTIVE').map(version => ({ ...version, plan }))), [plans]);
  const updateList = (field: 'allowedThemes' | 'paymentConnectors' | 'mobileTemplates', value: string, checked: boolean) => setEntitlements(current => ({ ...current, [field]: checked ? [...current[field], value] : current[field].filter(item => item !== value) }));
  const editPlan = (plan: Plan) => {
    const source = plan.versions.find(version => version.status === 'DRAFT') ?? plan.versions.find(version => version.status === 'ACTIVE') ?? plan.versions[0];
    if (!source) return;
    setSelectedPlanId(plan.id); setName(plan.name); setKey(plan.key);
    setEntitlements({ productLimit: source.productLimit, storeLimit: source.storeLimit, vendorLimit: source.vendorLimit, staffSeatLimit: source.staffSeatLimit, allowedThemes: source.allowedThemes, customDomainEligible: source.customDomainEligible, paymentConnectors: source.paymentConnectors, mobileTemplates: source.mobileTemplates });
  };
  const savePlan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      if (selectedPlanId) await api(`/api/admin/store-plans/${selectedPlanId}`, { method: 'PATCH', body: JSON.stringify({ name, entitlements, reason }) });
      else await api('/api/admin/store-plans', { method: 'POST', body: JSON.stringify({ name, key, entitlements, reason }) });
      await load(); setMessage('Plan saved as a draft version. Activate it before assignment.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  const activate = async (plan: Plan, version: PlanVersion) => {
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
          {plan.versions.map(version => <div className="storePlanVersion" key={version.id}><span>Version {version.version} · {version.status} · {version._count.assignments} assignment(s)</span>{version.status === 'DRAFT' && plan.status !== 'RETIRED' && <button disabled={saving} onClick={() => void activate(plan, version)}>Activate version</button>}</div>)}
          <div className="toolbar"><button type="button" onClick={() => editPlan(plan)}>Edit / new version</button>{plan.key !== 'legacy-compatible' && plan.status !== 'RETIRED' && <button type="button" disabled={saving} onClick={() => void retire(plan)}>Retire plan</button>}</div>
        </article>)}</div>}
      </div>
      <form className="card cardBody storePlanForm" onSubmit={savePlan}>
        <h3>{selectedPlanId ? 'Create a new version' : 'Create a plan'}</h3>
        <label>Plan name<input required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        {!selectedPlanId && <label>Plan key<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} value={key} onChange={event => setKey(event.target.value)} /></label>}
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
        {selectedPlanId && <button type="button" onClick={() => { setSelectedPlanId(''); setName(''); setKey(''); setEntitlements(blankEntitlements); }}>Start a new plan</button>}
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
