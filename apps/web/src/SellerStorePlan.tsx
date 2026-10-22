import React, { useEffect, useState } from 'react';

type PlanData = {
  store: { name: string; slug: string };
  plan: { key: string; name: string; status: string; version: number; versionStatus: string };
  assignment: { status: string; source: string; effectiveFrom: string | null; effectiveUntil: string | null };
  entitlements: { productLimit: number; storeLimit: number; vendorLimit: number; staffSeatLimit: number; allowedThemes: string[]; customDomainEligible: boolean; paymentConnectors: string[]; mobileTemplates: string[] };
  usage: { products: number; stores: number; vendors: number; staffSeats: number };
  notes: { connectors: string; customDomain: string; mobileTemplates: string };
};

export function SellerStorePlan() {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/seller/plan', { credentials: 'include' }).then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not load Store plan.');
      return body as PlanData;
    }).then(value => { if (active) setData(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load Store plan.'); });
    return () => { active = false; };
  }, []);

  if (error) return <section className="page"><p className="eyebrow">Seller tools</p><h1>Store plan</h1><div className="notice" role="alert">{error}</div></section>;
  if (!data) return <section className="page"><p className="eyebrow">Seller tools</p><h1>Store plan</h1><p className="empty" role="status">Loading your Store plan…</p></section>;
  const limitText = (usage: number, limit: number) => limit >= 1_000_000_000 ? `${usage.toLocaleString()} used · legacy-compatible limit` : `${usage.toLocaleString()} of ${limit.toLocaleString()} used`;
  const metric = (label: string, usage: number, limit: number) => <article className="card cardBody planUsageCard" key={label}><h2>{label}</h2><p><strong>{limitText(usage, limit)}</strong></p>{limit < 1_000_000_000 && <progress max={Math.max(limit, 1)} value={Math.min(usage, limit)} aria-label={`${label} usage`} />}</article>;

  return <section className="page sellerPlanPage">
    <p className="eyebrow">Seller tools</p>
    <h1>Store plan</h1>
    <p className="muted">Plan changes are managed by a platform administrator. Subscription billing is not part of this release.</p>
    <article className="card cardBody sellerPlanSummary">
      <div><p className="eyebrow">{data.store.name}</p><h2>{data.plan.name}</h2><p>Version {data.plan.version} · {data.plan.status} · Assignment {data.assignment.status.toLowerCase()}</p></div>
      <a href={`/store/${data.store.slug}`}>View public store</a>
    </article>
    <h2>Usage and limits</h2>
    <div className="grid planUsageGrid">
      {metric('Products', data.usage.products, data.entitlements.productLimit)}
      {metric('Stores', data.usage.stores, data.entitlements.storeLimit)}
      {metric('Vendors', data.usage.vendors, data.entitlements.vendorLimit)}
      {metric('Staff seats', data.usage.staffSeats, data.entitlements.staffSeatLimit)}
    </div>
    <section className="card cardBody planCapabilities">
      <h2>Included capabilities</h2>
      <dl>
        <div><dt>Allowed storefront themes</dt><dd>{data.entitlements.allowedThemes.join(', ')}</dd></div>
        <div><dt>Responsive storefront templates</dt><dd>{data.entitlements.mobileTemplates.join(', ')}</dd></div>
        <div><dt>Custom-domain eligibility</dt><dd>{data.entitlements.customDomainEligible ? 'Eligible' : 'Not included'}</dd></div>
        <div><dt>Payment connector eligibility</dt><dd>{data.entitlements.paymentConnectors.length ? data.entitlements.paymentConnectors.join(', ') : 'None'}</dd></div>
      </dl>
      <p className="muted">{data.notes.connectors}</p>
      <p className="muted">{data.notes.customDomain}</p>
      <p className="muted">{data.notes.mobileTemplates}</p>
    </section>
    <p><a href="/dashboard">Back to seller dashboard</a></p>
  </section>;
}
