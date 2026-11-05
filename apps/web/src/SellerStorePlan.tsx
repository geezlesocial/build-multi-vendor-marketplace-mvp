import React, { useEffect, useState } from 'react';

type PlanData = {
  adminOverride?: boolean;
  store: { name: string; slug: string };
  plan: { key: string; name: string; status: string; version: number; versionStatus: string };
  assignment: { status: string; source: string; effectiveFrom: string | null; effectiveUntil: string | null };
  pricing: { description: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number; annualDiscountPercent: number | null; defaultInterval: string; termIntervals: number | null; expirationBehavior: string; cancellationPolicy: string; freeTrialDays: number; introPriceMinor: number | null; introDurationDays: number | null; effectiveFrom: string | null; effectiveUntil: string | null };
  entitlements: { productLimit: number; storeLimit: number; vendorLimit: number; staffSeatLimit: number; allowedThemes: string[]; customDomainEligible: boolean; paymentConnectors: string[]; sellerManagedPaymentsEnabled: boolean; sellerManagedCarrierAccountsEnabled: boolean; dropshippingEnabled: boolean; mobileTemplates: string[]; blogPostLimit: number; contentPageLimit: number; mediaStorageLimitBytes: number; scheduledPublishingEnabled: boolean; advancedContentSeoEnabled: boolean; storeBusterEnabled: boolean; storeBusterCampaignLimit: number; storeBusterMonthlyBudgetMinor: number; emailMarketingEnabled: boolean; emailSubscriberLimit: number; emailMonthlySendLimit: number; affiliateToolsEnabled: boolean };
  usage: { products: number; stores: number; vendors: number; staffSeats: number; blogPosts: number; contentPages: number; mediaStorageBytes: number };
  notes: { connectors: string; customDomain: string; mobileTemplates: string };
};
type BillingSubscription = { id: string; status: string; interval: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number | null; introPriceMinor: number | null; introDurationDays: number | null; freeTrialDays: number; termIntervals: number | null; expirationBehavior: string; cancellationPolicy: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; trialEndsAt: string | null; introEndsAt: string | null; nextChargeAt: string | null; expiresAt: string | null; cancelAtPeriodEnd: boolean; cancelledAt: string | null; planVersion: { version: number; name: string; plan: { key: string } }; invoices: { id: string; status: string; amountMinor: number; refundedMinor: number; currency: string; periodStart: string | null; periodEnd: string | null; dueAt: string | null; paidAt: string | null; createdAt: string }[] };
type BillingData = { checkoutAvailable: boolean; cancellationAvailable: boolean; checkoutUnavailableReason: string; current: BillingSubscription | null; subscriptions: BillingSubscription[]; historyAvailable: boolean };
type PlanOptions = { checkoutAvailable: boolean; checkoutUnavailableReason: string; offers: { id: string; plan: { name: string; key: string }; version: number; description: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number; annualDiscountPercent: number | null; defaultInterval: string; termIntervals: number | null; cancellationPolicy: string; freeTrialDays: number; introPriceMinor: number | null; introDurationDays: number | null; checkoutSupported: boolean; checkoutUnavailableReason: string | null }[] };
const money = (currency: string, minor: number) => `${currency} ${(Math.floor(minor / 100)).toLocaleString()}.${String(minor % 100).padStart(2, '0')}`;

export function SellerStorePlan() {
  const [data, setData] = useState<PlanData | null>(null);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [options, setOptions] = useState<PlanOptions | null>(null);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [intervals, setIntervals] = useState<Record<string, 'MONTHLY' | 'ANNUAL'>>({});
  useEffect(() => {
    let active = true;
    const get = async <T,>(path: string) => {
      const response = await fetch(path, { credentials: 'include' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not load Store plan.');
      return body as T;
    };
    Promise.all([get<PlanData>('/api/seller/plan'), get<BillingData>('/api/seller/billing'), get<PlanOptions>('/api/seller/plan-options')])
      .then(([plan, history, offers]) => { if (active) { setData(plan); setBilling(history); setOptions(offers); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load Store plan.'); });
    return () => { active = false; };
  }, []);

  if (error) return <section className="page"><p className="eyebrow">Seller tools</p><h1>Plan &amp; Billing</h1><div className="notice" role="alert">{error}</div></section>;
  if (!data || !billing || !options) return <section className="page"><p className="eyebrow">Seller tools</p><h1>Plan &amp; Billing</h1><p className="empty" role="status">Loading your Store plan…</p></section>;
  const limitText = (usage: number, limit: number) => limit >= 1_000_000_000 ? `${usage.toLocaleString()} used · legacy-compatible limit` : `${usage.toLocaleString()} of ${limit.toLocaleString()} used`;
  const metric = (label: string, usage: number, limit: number, unit = '') => <article className="card cardBody planUsageCard" key={label}><h2>{label}</h2><p><strong>{limitText(usage, limit)}{unit}</strong></p>{limit < 1_000_000_000 && <progress max={Math.max(limit, 1)} value={Math.min(usage, limit)} aria-label={`${label} usage`} />}</article>;
  const csrfToken = () => document.cookie.split('; ').find(cookie => cookie.startsWith('marketplace_csrf='))?.slice('marketplace_csrf='.length) ?? '';
  const beginCheckout = async (offer: PlanOptions['offers'][number]) => {
    const interval = intervals[offer.id] ?? (offer.defaultInterval === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY');
    const amount = interval === 'ANNUAL' ? offer.annualPriceMinor : offer.monthlyPriceMinor;
    const priceText = `${money(offer.currency, amount)} per ${interval.toLowerCase()} interval`;
    const trialEnd = offer.freeTrialDays > 0 ? new Date(Date.now() + offer.freeTrialDays * 86_400_000).toLocaleDateString() : null;
    const firstCharge = trialEnd ? `First charge: ${priceText} on or after ${trialEnd}.` : `First charge: ${priceText} after checkout.`;
    const cancellation = offer.cancellationPolicy === 'CANCEL_AT_TERM_END' ? 'Cancellation takes effect at the end of the billing term.' : 'Cancellation takes effect immediately; no automatic refund is issued.';
    const confirmation = `Stripe test-mode subscription for ${offer.plan.name}, version ${offer.version}.\n${priceText}.${trialEnd ? ` Free trial ends ${trialEnd}.` : ''}\n${firstCharge}\nTaxes are not collected in this sandbox checkout.\n${cancellation}\nContinue to the sandbox checkout?`;
    if (!window.confirm(confirmation)) return;
    setBusyId(offer.id); setActionError(''); setActionMessage('Opening Stripe test-mode checkout…');
    try {
      const response = await fetch('/api/seller/billing/subscribe', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken(), 'Idempotency-Key': globalThis.crypto.randomUUID() },
        body: JSON.stringify({ planVersionId: offer.id, interval })
      });
      const result = await response.json().catch(() => ({})) as { error?: string; checkoutUrl?: string; sandbox?: boolean };
      if (!response.ok || !result.checkoutUrl || result.sandbox !== true) throw new Error(result.error ?? 'Could not start subscription checkout.');
      window.location.assign(result.checkoutUrl);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not start subscription checkout.');
      setActionMessage('');
    } finally { setBusyId(''); }
  };
  const cancelSubscription = async (subscription: BillingSubscription) => {
    const timing = subscription.cancellationPolicy === 'CANCEL_AT_TERM_END' ? 'at the end of this billing period' : 'immediately';
    if (!window.confirm(`Cancel this subscription ${timing}? No automatic refund will be issued.`)) return;
    setBusyId(subscription.id); setActionError(''); setActionMessage('Submitting cancellation to Stripe sandbox…');
    try {
      const response = await fetch(`/api/seller/billing/${encodeURIComponent(subscription.id)}/cancel`, { method: 'POST', credentials: 'include', headers: { 'x-csrf-token': csrfToken() } });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Could not cancel subscription.');
      setActionMessage(subscription.cancellationPolicy === 'CANCEL_AT_TERM_END' ? 'Cancellation is scheduled for the end of the billing period.' : 'Subscription cancelled.');
      const updated = await fetch('/api/seller/billing', { credentials: 'include' });
      const updatedBody = await updated.json() as BillingData;
      if (updated.ok) setBilling(updatedBody);
      const plan = await fetch('/api/seller/plan', { credentials: 'include' });
      if (plan.ok) setData(await plan.json() as PlanData);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not cancel subscription.'); setActionMessage('');
    } finally { setBusyId(''); }
  };

  return <section className="page sellerPlanPage">
    <p className="eyebrow">Seller tools</p>
    <h1>Plan &amp; Billing</h1>
    <p className="muted">{data.adminOverride ? 'The official platform Store receives all premium plan features without a subscription or billing.' : 'Review your Store plan, entitlements, usage, and available plans. Any checkout shown here is a Stripe test-mode sandbox, never live billing.'}</p>
    {data.adminOverride && <p className="notice" role="status">Administrator override active: all supported premium Store entitlements are enabled. External providers still require credentials, onboarding, and platform approval.</p>}
    {actionError && <div className="notice" role="alert">{actionError}</div>}
    {actionMessage && <p className="muted" role="status">{actionMessage}</p>}
    <article className="card cardBody sellerPlanSummary">
      <div><p className="eyebrow">{data.store.name}</p><h2>{data.plan.name}</h2><p>Version {data.plan.version} · {data.plan.status} · Assignment {data.assignment.status.toLowerCase()}</p><p>{money(data.pricing.currency, data.pricing.monthlyPriceMinor)} / month · {money(data.pricing.currency, data.pricing.annualPriceMinor)} / year</p>{data.pricing.description && <p>{data.pricing.description}</p>}</div>
      <a href={`/store/${data.store.slug}`}>View public store</a>
    </article>
    {billing.current && <article className="card cardBody sellerBillingSummary"><h2>Subscription status: {billing.current.status}</h2><p>{billing.current.planVersion.name} · {billing.current.interval.toLowerCase()} billing · Version {billing.current.planVersion.version}</p><p>Agreed price: {money(billing.current.currency, billing.current.interval === 'ANNUAL' ? billing.current.annualPriceMinor ?? 0 : billing.current.monthlyPriceMinor)} per {billing.current.interval.toLowerCase()} interval</p>{billing.current.trialEndsAt && <p>Free trial ends {new Date(billing.current.trialEndsAt).toLocaleDateString()}.</p>}{billing.current.introEndsAt && <p>Paid introductory offer ends {new Date(billing.current.introEndsAt).toLocaleDateString()}; it is not a free trial.</p>}{billing.current.nextChargeAt && <p>Next charge date: {new Date(billing.current.nextChargeAt).toLocaleDateString()}.</p>}{billing.current.expiresAt && <p>Current access expires: {new Date(billing.current.expiresAt).toLocaleDateString()}.</p>}<p>Cancellation: {billing.current.cancellationPolicy === 'CANCEL_AT_TERM_END' ? 'at the end of the billing term' : 'any time'}</p>{billing.current.cancelAtPeriodEnd && <p role="status">Cancellation is scheduled at the end of this billing period.</p>}{billing.cancellationAvailable && !billing.current.cancelAtPeriodEnd && ['ACTIVE', 'TRIALING', 'PAST_DUE', 'UNPAID'].includes(billing.current.status) && <button type="button" disabled={busyId === billing.current.id} onClick={() => void cancelSubscription(billing.current!)}>{busyId === billing.current.id ? 'Cancelling…' : 'Cancel subscription'}</button>}</article>}
    <h2>Usage and limits</h2>
    <div className="grid planUsageGrid">
      {metric('Products', data.usage.products, data.entitlements.productLimit)}
      {metric('Stores', data.usage.stores, data.entitlements.storeLimit)}
      {metric('Vendors', data.usage.vendors, data.entitlements.vendorLimit)}
      {metric('Staff seats', data.usage.staffSeats, data.entitlements.staffSeatLimit)}
      {metric('Blog posts', data.usage.blogPosts, data.entitlements.blogPostLimit)}
      {metric('Pages', data.usage.contentPages, data.entitlements.contentPageLimit)}
      {metric('Media storage', data.usage.mediaStorageBytes, data.entitlements.mediaStorageLimitBytes, ' bytes')}
    </div>
    <section className="card cardBody planCapabilities">
      <h2>Included capabilities</h2>
      <dl>
        <div><dt>Allowed storefront themes</dt><dd>{data.entitlements.allowedThemes.join(', ')}</dd></div>
        <div><dt>Responsive storefront templates</dt><dd>{data.entitlements.mobileTemplates.join(', ')}</dd></div>
        <div><dt>Custom-domain eligibility</dt><dd>{data.entitlements.customDomainEligible ? 'Eligible' : 'Not included'}</dd></div>
        <div><dt>Payment connector eligibility</dt><dd>{data.entitlements.paymentConnectors.length ? data.entitlements.paymentConnectors.join(', ') : 'None'}</dd></div>
        <div><dt>Seller-owned payment accounts</dt><dd>{data.entitlements.sellerManagedPaymentsEnabled ? 'Eligible on this plan; provider onboarding and approval still required' : 'Marketplace-managed payments only'}</dd></div>
        <div><dt>Seller-owned carrier accounts</dt><dd>{data.entitlements.sellerManagedCarrierAccountsEnabled ? 'Eligible on this plan; carrier integration still required' : 'Marketplace-managed shipping only'}</dd></div>
        <div><dt>Dropshipping suppliers</dt><dd>{data.entitlements.dropshippingEnabled ? 'Included; supplier account and API access required' : 'Not enabled for this plan'}</dd></div>
        <div><dt>Blog and page publishing</dt><dd>Included on every plan · {data.entitlements.blogPostLimit} posts · {data.entitlements.contentPageLimit} pages</dd></div>
        <div><dt>Scheduled publishing</dt><dd>{data.entitlements.scheduledPublishingEnabled ? 'Included' : 'Not enabled for this plan'}</dd></div>
        <div><dt>Advanced content SEO</dt><dd>{data.entitlements.advancedContentSeoEnabled ? 'Included' : 'Not enabled for this plan'}</dd></div>
        <div><dt>Store Buster</dt><dd>{data.entitlements.storeBusterEnabled ? `Included · ${data.entitlements.storeBusterCampaignLimit} campaigns` : 'Not enabled for this plan'}</dd></div>
        <div><dt>Email marketing</dt><dd>{data.entitlements.emailMarketingEnabled ? `Included · ${data.entitlements.emailSubscriberLimit} subscribers · ${data.entitlements.emailMonthlySendLimit} sends/month` : 'Not enabled for this plan'}</dd></div>
        <div><dt>Affiliate tools</dt><dd>{data.entitlements.affiliateToolsEnabled ? 'Included (payouts are separately gated)' : 'Not enabled for this plan'}</dd></div>
      </dl>
      <p className="muted">{data.notes.connectors}</p>
      <p className="muted">{data.notes.customDomain}</p>
      <p className="muted">{data.notes.mobileTemplates}</p>
    </section>
    <section className="sellerPlanBillingSection">
      <h2>Billing history</h2>
      {billing.subscriptions.length === 0 ? <div className="empty">No subscription or invoice history yet. Your existing Store assignment remains unchanged.</div> : billing.subscriptions.map(subscription => <article className="card cardBody" key={subscription.id}><h3>{subscription.planVersion.name} · {subscription.status}</h3>{subscription.invoices.length === 0 ? <p className="muted">No invoices recorded.</p> : <ul>{subscription.invoices.map(invoice => <li key={invoice.id}>{invoice.createdAt.slice(0, 10)} · {money(invoice.currency, invoice.amountMinor)} · {invoice.status}{invoice.refundedMinor > 0 ? ` · ${money(invoice.currency, invoice.refundedMinor)} refunded` : ''}</li>)}</ul>}</article>)}
      <h2>Available plans</h2>
      {options.offers.length === 0 ? <div className="empty">No currently active upgrade plans are available.</div> : <div className="grid planOfferGrid">{options.offers.map(offer => {
        const interval = intervals[offer.id] ?? (offer.defaultInterval === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY');
        const unavailable = !options.checkoutAvailable || !offer.checkoutSupported;
        return <article className="card cardBody" key={offer.id}><p className="eyebrow">{offer.plan.key} · version {offer.version}</p><h3>{offer.plan.name}</h3>{offer.description && <p>{offer.description}</p>}<p>{money(offer.currency, offer.monthlyPriceMinor)} monthly · {money(offer.currency, offer.annualPriceMinor)} annually{offer.annualDiscountPercent ? ` · saves ${offer.annualDiscountPercent}% annually` : ''}</p>{offer.freeTrialDays > 0 && <p>{offer.freeTrialDays}-day free trial.</p>}{offer.introPriceMinor !== null && <p>Paid introductory charge: {money(offer.currency, offer.introPriceMinor)} for {offer.introDurationDays} days. This is not free; normal recurring billing follows.</p>}<p>Cancellation: {offer.cancellationPolicy === 'CANCEL_AT_TERM_END' ? 'at term end' : 'any time'}.</p><label>Billing interval<select aria-label={`Billing interval for ${offer.plan.name}`} value={interval} onChange={event => setIntervals(previous => ({ ...previous, [offer.id]: event.target.value as 'MONTHLY' | 'ANNUAL' }))}><option value="MONTHLY">Monthly · {money(offer.currency, offer.monthlyPriceMinor)}</option><option value="ANNUAL">Annual · {money(offer.currency, offer.annualPriceMinor)}</option></select></label>{unavailable ? <><button type="button" disabled title={offer.checkoutUnavailableReason ?? options.checkoutUnavailableReason}>Upgrade unavailable</button><p className="muted">{offer.checkoutUnavailableReason ?? options.checkoutUnavailableReason}</p></> : <button type="button" disabled={busyId === offer.id} onClick={() => void beginCheckout(offer)}>{busyId === offer.id ? 'Preparing checkout…' : 'Continue to sandbox checkout'}</button>}</article>;
      })}</div>}
      {!options.checkoutAvailable && <p className="notice" role="status">{billing.checkoutUnavailableReason}</p>}
      {options.checkoutAvailable && <p className="notice" role="status">Stripe test-mode only. No live billing, tax calculation, seller payouts, or automatic refunds are enabled.</p>}
    </section>
  </section>;
}
