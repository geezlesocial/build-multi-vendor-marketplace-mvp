import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Growth = { store: { name: string }; enabledForPlan: boolean; available: boolean; sponsoredAvailable: boolean; sponsoredProviders: string[]; currency: string; minorUnitExponent: number | null; minFundingMinor: number; maxFundingMinor: number; pricePerClickMinor: number; monthlySpendMinor: number; adBalance: { availableMinor: number; status: string; ledger: { id: string; type: string; amountMinor: number; balanceAfterMinor: number; currency: string; createdAt: string; campaign: { name: string } | null }[]; fundingIntents: { id: string; amountMinor: number; currency: string; provider: string; status: string; createdAt: string; paidAt: string | null }[] }; campaignLimit: number; campaignCount: number; monthlyBudgetCapMinor: number; campaigns: { id: string; name: string; goal: string; status: string; sponsored: boolean; monthlyBudgetMinor: number; audienceCategoryIds: string[]; products: { product: { name: string; status: string } }[]; metrics: { day: string; impressions: number; clicks: number; spendMinor: number }[] }[]; message: string };
type SellerData = { products: { id: string; name: string; status: string; categoryId?: string | null; inventory?: { quantity: number } | null }[] };
type Affiliate = { included: boolean; enabled: boolean; marketplaceProgramAvailable: boolean; payoutRequestsAvailable: boolean; message: string };
type Email = { enabledForPlan: boolean; deliveryAvailable: boolean; subscriberLimit: number; monthlySendLimit: number; counts: Record<string, number>; subscribers: { id: string; emailMasked: string; status: string; createdAt: string }[]; campaigns: { id: string; name: string; subject: string; status: string; recipientCount: number; sentCount: number; failedCount: number; queuedAt: string | null; sentAt: string | null }[]; message: string };
type Category = { id: string; name: string; status: string };

function majorToMinor(value: string, exponent: number) {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d*)?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) return null;
  const units = BigInt(whole) * (10n ** BigInt(exponent)) + BigInt((fraction || '').padEnd(exponent, '0') || '0');
  return units <= 2_147_483_647n ? Number(units) : null;
}
function minorToMajorInput(value: number, exponent: number) {
  const scale = 10 ** exponent; const whole = Math.floor(value / scale);
  return exponent ? `${whole}.${String(value % scale).padStart(exponent, '0')}` : String(whole);
}

export function SellerStoreGrowth() {
  const [growth, setGrowth] = useState<Growth | null>(null); const [products, setProducts] = useState<SellerData['products']>([]); const [categories, setCategories] = useState<Category[]>([]); const [affiliate, setAffiliate] = useState<Affiliate | null>(null); const [email, setEmail] = useState<Email | null>(null);
  const [name, setName] = useState(''); const [goal, setGoal] = useState('DISCOVERY'); const [productIds, setProductIds] = useState<string[]>([]); const [categoryIds, setCategoryIds] = useState<string[]>([]); const [emailName, setEmailName] = useState(''); const [subject, setSubject] = useState(''); const [content, setContent] = useState('');
  const [sponsored, setSponsored] = useState(false); const [campaignBudget, setCampaignBudget] = useState('50'); const [fundingAmount, setFundingAmount] = useState('25'); const [fundingProvider, setFundingProvider] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => {
    const [nextGrowth, dashboard, nextCategories, nextAffiliate, nextEmail] = await Promise.all([api<Growth>('/api/seller/store-buster'), api<SellerData>('/api/dashboard/seller'), api<Category[]>('/api/categories'), api<Affiliate>('/api/seller/affiliate-program'), api<Email>('/api/seller/email-marketing')]);
    setGrowth(nextGrowth); setProducts(dashboard.products); setCategories(nextCategories.filter(item => item.status === 'ACTIVE')); setAffiliate(nextAffiliate); setEmail(nextEmail);
  };
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, []);
  useEffect(() => {
    if (!growth?.sponsoredProviders.length) return;
    if (!growth.sponsoredProviders.includes(fundingProvider)) setFundingProvider(growth.sponsoredProviders[0]!);
  }, [growth?.sponsoredProviders, fundingProvider]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('adFunding'); const intentId = params.get('intentId'); const providerOrderId = params.get('token');
    if (!result || !intentId) return;
    let active = true;
    const clearReturn = () => { params.delete('adFunding'); params.delete('intentId'); params.delete('token'); const query = params.toString(); window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`); };
    const finish = async () => {
      setBusy(true); setError(''); setMessage('');
      try {
        if (result === 'paypal' && providerOrderId) {
          const settled = await api<{ status: string; message?: string }>(`/api/seller/store-buster/ad-funding/${encodeURIComponent(intentId)}/paypal-capture`, { method: 'POST', body: JSON.stringify({ providerOrderId }) });
          await load(); setMessage(settled.message ?? 'PayPal payment confirmed. Your separate advertising balance has been updated.');
        } else if (result === 'success') {
          let latest: Growth | null = null;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            latest = await api<Growth>('/api/seller/store-buster');
            if (active) setGrowth(latest);
            if (latest.adBalance.fundingIntents.some(item => item.id === intentId && item.status === 'PAID')) break;
            await new Promise(resolve => window.setTimeout(resolve, 1500));
          }
          if (active) setMessage(latest?.adBalance.fundingIntents.some(item => item.id === intentId && item.status === 'PAID') ? 'Payment confirmed. Your advertising balance is ready.' : 'Payment return received. Your balance will update as soon as the signed provider webhook confirms the payment.');
        } else if (active) setMessage('Checkout was cancelled. No advertising credit was added.');
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Ad balance checkout could not be confirmed.'); }
      finally { clearReturn(); if (active) setBusy(false); }
    };
    void finish();
    return () => { active = false; };
  }, []);
  const toggleId = (values: string[], value: string, setter: (values: string[]) => void) => setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  const createCampaign = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try { const exponent = growth?.minorUnitExponent ?? 2; const budgetMinor = sponsored ? majorToMinor(campaignBudget, exponent) : 0; if (sponsored && (budgetMinor == null || budgetMinor < 1)) throw new Error('Enter a valid monthly budget in the platform currency.'); const campaign = await api<{ id: string }>('/api/seller/store-buster/campaigns', { method: 'POST', body: JSON.stringify({ name, goal, productIds, audienceCategoryIds: categoryIds, sponsored, monthlyBudgetMinor: budgetMinor }) }); await api(`/api/seller/store-buster/campaigns/${campaign.id}/submit`, { method: 'POST', body: '{}' }); setName(''); setProductIds([]); setCategoryIds([]); setSponsored(false); await load(); setMessage(sponsored ? 'Sponsored campaign submitted for mandatory admin review. It will serve and charge only after approval.' : 'Organic campaign submitted for review. It does not use advertising credit.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign could not be saved.'); }
    finally { setBusy(false); }
  };
  const fundAdBalance = async (event: React.FormEvent) => {
    event.preventDefault(); if (!growth) return;
    const exponent = growth.minorUnitExponent ?? 2; const amountMinor = majorToMinor(fundingAmount, exponent);
    if (amountMinor == null || amountMinor < growth.minFundingMinor || amountMinor > growth.maxFundingMinor) { setError(`Enter a top-up between ${formatMinor(growth.minFundingMinor, growth.currency)} and ${formatMinor(growth.maxFundingMinor, growth.currency)}.`); return; }
    if (!fundingProvider) { setError('No eligible platform payment provider is available.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const checkout = await api<{ provider: string; checkoutUrl?: string; approvalUrl?: string }>('/api/seller/store-buster/ad-funding', { method: 'POST', body: JSON.stringify({ provider: fundingProvider, amountMinor }) });
      const destination = checkout.checkoutUrl ?? checkout.approvalUrl;
      if (!destination) throw new Error('Payment provider did not return a checkout link.');
      window.location.assign(destination);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Advertising balance checkout could not be started.'); setBusy(false); }
  };
  const createEmailDraft = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { await api('/api/seller/email-campaigns', { method: 'POST', body: JSON.stringify({ name: emailName, subject, content: [{ type: 'paragraph', text: content }] }) }); setEmailName(''); setSubject(''); setContent(''); await load(); setMessage('Email campaign saved as a draft.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Email draft could not be saved.'); }
    finally { setBusy(false); }
  };
  const sendEmailCampaign = async (campaign: Email['campaigns'][number]) => {
    if (!window.confirm(`Queue “${campaign.name}” for up to ${email?.counts.SUBSCRIBED ?? 0} confirmed subscribers? Each recipient will receive a separate message and can unsubscribe.`)) return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await api<{ message: string }>(`/api/seller/email-campaigns/${campaign.id}/send`, { method: 'POST', body: '{}' }); await load(); setMessage(result.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign could not be queued.'); }
    finally { setBusy(false); }
  };
  const cancelEmailCampaign = async (campaign: Email['campaigns'][number]) => {
    if (campaign.status === 'QUEUED' && !window.confirm('Cancel remaining queued messages? Messages already accepted by the email provider cannot be recalled.')) return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await api<{ message: string }>(`/api/seller/email-campaigns/${campaign.id}/cancel`, { method: 'POST', body: '{}' }); await load(); setMessage(result.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign could not be cancelled.'); }
    finally { setBusy(false); }
  };
  const suppressEmailSubscriber = async (subscriber: Email['subscribers'][number]) => {
    const reason = window.prompt(`Reason to suppress ${subscriber.emailMasked} (for example, provider bounce or abuse report):`);
    if (!reason || reason.trim().length < 3) return;
    setBusy(true); setError(''); setMessage('');
    try { await api(`/api/seller/email-subscribers/${subscriber.id}/suppress`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }); await load(); setMessage('Subscriber suppressed and excluded from queued campaign delivery.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Subscriber could not be suppressed.'); }
    finally { setBusy(false); }
  };
  const setAffiliateEnabled = async (enabled: boolean) => { setBusy(true); setError(''); try { await api('/api/seller/affiliate-program', { method: 'PATCH', body: JSON.stringify({ enabled }) }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Affiliate setting could not be saved.'); } finally { setBusy(false); } };

  if (error && !growth) return <section className="page"><h1>Store growth</h1><p className="notice" role="alert">{error}</p></section>;
  if (!growth || !affiliate || !email) return <section className="page"><h1>Store growth</h1><p className="empty" role="status">Loading growth tools…</p></section>;
  const eligibleProducts = products.filter(product => product.status === 'APPROVED' && (product.inventory?.quantity ?? 0) > 0);
  const exponent = growth.minorUnitExponent ?? 2;
  return <section className="page sellerStoreGrowth"><p className="eyebrow">Seller tools</p><h1>Store growth</h1><p className="muted">Growth tools are separately plan-gated. Upgrade options are shown on your <a href="/seller/plan">plan page</a>.</p>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    <section className="card cardBody sellerAdBalance">
      <p className="eyebrow">Sponsored placements</p><h2>Prepaid advertising balance</h2><p className="muted">Spent this month: {formatMinor(growth.monthlySpendMinor, growth.currency)} of your Store-wide cap of {formatMinor(growth.monthlyBudgetCapMinor, growth.currency)}.</p>
      <div className="sellerAdBalanceSummary"><div><span>Available ad credit</span><strong>{formatMinor(growth.adBalance.availableMinor, growth.currency)}</strong><small>{growth.adBalance.status === 'ACTIVE' ? 'Separate from your sales proceeds' : 'Frozen — contact platform support'}</small></div><span className={growth.adBalance.status === 'ACTIVE' ? 'statusPill' : 'notice'}>{growth.adBalance.status}</span></div>
      <p className="muted">Ad credit is collected by the marketplace through its enabled Stripe or PayPal account. It is non-withdrawable, isolated from seller payouts, and is deducted only once per valid, visible product click. Campaigns require approval and stop automatically at their monthly budget or when credit runs low.</p>
      {!growth.sponsoredAvailable && <p className="notice">{growth.message}</p>}
      {growth.sponsoredAvailable && <form onSubmit={fundAdBalance} className="sellerAdFundingForm">
        <label>Top-up amount ({growth.currency})<input required inputMode="decimal" type="number" min={minorToMajorInput(growth.minFundingMinor, exponent)} max={minorToMajorInput(growth.maxFundingMinor, exponent)} step={growth.minorUnitExponent === 0 ? '1' : `0.${'0'.repeat(Math.max(0, (growth.minorUnitExponent ?? 2) - 1))}1`} value={fundingAmount} onChange={event => setFundingAmount(event.target.value)} /></label>
        <label>Platform payment provider<select value={fundingProvider} onChange={event => setFundingProvider(event.target.value)}>{growth.sponsoredProviders.map(provider => <option key={provider} value={provider}>{provider}</option>)}</select></label>
        <button className="primary" disabled={busy || growth.adBalance.status !== 'ACTIVE'}>{busy ? 'Opening secure checkout…' : 'Add prepaid ad credit'}</button>
      </form>}
      {growth.adBalance.fundingIntents.length > 0 && <details><summary>Recent funding activity</summary><div className="table">{growth.adBalance.fundingIntents.map(intent => <article className="row" key={intent.id}><span>{intent.provider} · {formatMinor(intent.amountMinor, intent.currency)} · {intent.status}</span><time>{new Date(intent.createdAt).toLocaleString()}</time></article>)}</div></details>}
    </section>
    <section className="card cardBody"><h2>Store Buster campaigns</h2><p>{!growth.enabledForPlan ? 'Not included in this Store plan.' : !growth.available ? 'Included in your plan, but currently unavailable by platform policy.' : `Included · ${growth.campaignCount} of ${growth.campaignLimit} campaign slots used.`}</p><p className="muted">Organic recommendations use opted-in first-party signals. Paid campaigns have a dedicated dashboard with targeting, creative uploads, currency conversion, and CPC/CPV controls.</p><p><a href="/dashboard?mode=seller&amp;tab=ads">Open Ads dashboard</a></p>
      {growth.available && <form onSubmit={createCampaign}>
        <label>Campaign name<input required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Campaign type<select value="ORGANIC" onChange={() => setSponsored(false)}><option value="ORGANIC">Organic recommendation (no spend)</option></select></label>
        <label>Goal<select value={goal} onChange={event => setGoal(event.target.value)}><option value="DISCOVERY">Store discovery</option><option value="PRODUCT_VIEWS">Product views</option><option value="STORE_VISITS">Store visits</option></select></label>
        {sponsored && <><label>Monthly campaign budget ({growth.currency})<input required inputMode="decimal" type="number" min={growth.minorUnitExponent === 0 ? '1' : minorToMajorInput(1, growth.minorUnitExponent ?? 2)} max={minorToMajorInput(growth.monthlyBudgetCapMinor, growth.minorUnitExponent ?? 2)} step={growth.minorUnitExponent === 0 ? '1' : `0.${'0'.repeat(Math.max(0, (growth.minorUnitExponent ?? 2) - 1))}1`} value={campaignBudget} onChange={event => setCampaignBudget(event.target.value)} /></label><p className="muted">Maximum allowed by the current plan and platform: {formatMinor(growth.monthlyBudgetCapMinor, growth.currency)}. Current click price: {formatMinor(growth.pricePerClickMinor, growth.currency)}. A campaign will not serve until approved by an administrator.</p></>}
        <fieldset><legend>Eligible products (approved and in stock)</legend>{eligibleProducts.length ? eligibleProducts.map(product => <label className="storePlanCheck" key={product.id}><input type="checkbox" checked={productIds.includes(product.id)} onChange={() => toggleId(productIds, product.id, setProductIds)} />{product.name}</label>) : <p className="empty">No approved in-stock products are eligible yet.</p>}</fieldset>
        <fieldset><legend>Optional product categories to target</legend>{categories.map(category => <label className="storePlanCheck" key={category.id}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleId(categoryIds, category.id, setCategoryIds)} />{category.name}</label>)}</fieldset>
        <button className="primary" disabled={busy || productIds.length === 0 || (sponsored && (!growth.sponsoredAvailable || growth.adBalance.status !== 'ACTIVE'))}>{busy ? 'Saving…' : sponsored ? 'Submit sponsored campaign for review' : 'Create organic campaign'}</button>
      </form>}
      {growth.campaigns.length === 0 ? <div className="empty">No Store Buster campaigns yet.</div> : <div className="table">{growth.campaigns.map(campaign => <article className="row" key={campaign.id}><span><strong>{campaign.name}</strong><br />{campaign.goal} · {campaign.status} · {campaign.sponsored ? `Sponsored · ${formatMinor(campaign.monthlyBudgetMinor, growth.currency)} monthly cap` : 'Organic, no spend'}<br />{campaign.metrics.reduce((total, item) => total + item.impressions, 0).toLocaleString()} served · {campaign.metrics.reduce((total, item) => total + item.clicks, 0).toLocaleString()} clicks · {campaign.sponsored ? formatMinor(campaign.metrics.reduce((total, item) => total + item.spendMinor, 0), growth.currency) : 'no spend'}</span><span>{campaign.products.map(item => item.product.name).join(', ')}</span></article>)}</div>}
      {growth.adBalance.ledger.length > 0 && <details><summary>Advertising ledger</summary><div className="table">{growth.adBalance.ledger.map(entry => <article className="row" key={entry.id}><span>{entry.type} · {entry.campaign?.name ?? 'Balance funding'}<br /><small>{formatMinor(entry.amountMinor, entry.currency)} · balance {formatMinor(entry.balanceAfterMinor, entry.currency)}</small></span><time>{new Date(entry.createdAt).toLocaleString()}</time></article>)}</div></details>}
    </section>
    <section className="card cardBody"><h2>Email marketing</h2><p>{!email.enabledForPlan ? 'Not enabled for this plan.' : `Included · ${email.counts.SUBSCRIBED ?? 0} confirmed subscribers of ${email.subscriberLimit} allowed · ${email.monthlySendLimit} messages/month limit.`}</p><p className={email.deliveryAvailable ? 'notice storeEmailReady' : 'notice'}>{email.message}</p>
      {email.enabledForPlan && <form onSubmit={createEmailDraft}><label>Campaign name<input required minLength={2} maxLength={100} value={emailName} onChange={event => setEmailName(event.target.value)} /></label><label>Subject<input required minLength={2} maxLength={160} value={subject} onChange={event => setSubject(event.target.value)} /></label><label>Draft content<textarea required maxLength={2000} value={content} onChange={event => setContent(event.target.value)} /></label><button disabled={busy}>Save campaign draft</button></form>}
      {email.campaigns.length === 0 ? <div className="empty">No email campaigns yet.</div> : <ul className="storeEmailCampaigns">{email.campaigns.map(campaign => <li key={campaign.id}><span><strong>{campaign.name}</strong><br /><span className="muted">{campaign.status} · {campaign.sentCount}/{campaign.recipientCount} sent · {campaign.failedCount} failed</span></span><span className="toolbar">{campaign.status === 'DRAFT' && <button type="button" disabled={busy || !email.deliveryAvailable || !email.enabledForPlan || !(email.counts.SUBSCRIBED ?? 0)} onClick={() => void sendEmailCampaign(campaign)}>Queue campaign</button>}{(campaign.status === 'DRAFT' || campaign.status === 'QUEUED') && <button type="button" disabled={busy} onClick={() => void cancelEmailCampaign(campaign)}>Cancel</button>}</span></li>)}</ul>}
      <h3>Subscriber privacy and suppression</h3><p className="muted">Addresses are masked here. Suppression prevents future campaign sends; it does not expose or delete an address.</p>{email.subscribers.length === 0 ? <div className="empty">No subscriber records.</div> : <ul className="storeEmailCampaigns">{email.subscribers.map(subscriber => <li key={subscriber.id}><span><strong>{subscriber.emailMasked}</strong><br /><span className="muted">{subscriber.status} · added {new Date(subscriber.createdAt).toLocaleDateString()}</span></span>{!['SUPPRESSED', 'BOUNCED', 'UNSUBSCRIBED'].includes(subscriber.status) && <button type="button" disabled={busy} onClick={() => void suppressEmailSubscriber(subscriber)}>Suppress</button>}</li>)}</ul>}
      <p className="muted">Only double-opt-in subscribers are eligible. The provider receives one message per recipient; consent and unsubscribe status are rechecked immediately before each send.</p>
    </section>
    <section className="card cardBody"><h2>Affiliate tools</h2><p>{!affiliate.included ? 'Not enabled for this plan.' : affiliate.marketplaceProgramAvailable ? 'Included and available through the existing platform affiliate program.' : 'Included, but the marketplace affiliate program is currently disabled.'}</p><label className="storePlanCheck"><input type="checkbox" checked={affiliate.enabled} disabled={busy || !affiliate.included || !affiliate.marketplaceProgramAvailable} onChange={event => void setAffiliateEnabled(event.target.checked)} />Allow approved affiliates to promote my Store products</label><p className="muted">Affiliate links remain consent-based and use the existing platform attribution and commission ledger. This Store plan does not create seller commissions or seller payouts; no payout capability is enabled here.</p></section>
  </section>;
}
