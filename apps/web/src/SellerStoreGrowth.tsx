import React, { useEffect, useState } from 'react';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Growth = { store: { name: string }; enabledForPlan: boolean; available: boolean; sponsoredAvailable: boolean; campaignLimit: number; campaignCount: number; monthlyBudgetCapMinor: number; campaigns: { id: string; name: string; goal: string; status: string; sponsored: boolean; audienceCategoryIds: string[]; products: { product: { name: string; status: string } }[]; metrics: { day: string; impressions: number; clicks: number }[] }[]; message: string };
type SellerData = { products: { id: string; name: string; status: string; categoryId?: string | null; inventory?: { quantity: number } | null }[] };
type Affiliate = { included: boolean; enabled: boolean; marketplaceProgramAvailable: boolean; payoutRequestsAvailable: boolean; message: string };
type Email = { enabledForPlan: boolean; deliveryAvailable: boolean; subscriberLimit: number; monthlySendLimit: number; counts: Record<string, number>; campaigns: { id: string; name: string; subject: string; status: string }[]; message: string };
type Category = { id: string; name: string; status: string };

export function SellerStoreGrowth() {
  const [growth, setGrowth] = useState<Growth | null>(null); const [products, setProducts] = useState<SellerData['products']>([]); const [categories, setCategories] = useState<Category[]>([]); const [affiliate, setAffiliate] = useState<Affiliate | null>(null); const [email, setEmail] = useState<Email | null>(null);
  const [name, setName] = useState(''); const [goal, setGoal] = useState('DISCOVERY'); const [productIds, setProductIds] = useState<string[]>([]); const [categoryIds, setCategoryIds] = useState<string[]>([]); const [emailName, setEmailName] = useState(''); const [subject, setSubject] = useState(''); const [content, setContent] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => {
    const [nextGrowth, dashboard, nextCategories, nextAffiliate, nextEmail] = await Promise.all([api<Growth>('/api/seller/store-buster'), api<SellerData>('/api/dashboard/seller'), api<Category[]>('/api/categories'), api<Affiliate>('/api/seller/affiliate-program'), api<Email>('/api/seller/email-marketing')]);
    setGrowth(nextGrowth); setProducts(dashboard.products); setCategories(nextCategories.filter(item => item.status === 'ACTIVE')); setAffiliate(nextAffiliate); setEmail(nextEmail);
  };
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, []);
  const toggleId = (values: string[], value: string, setter: (values: string[]) => void) => setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  const createCampaign = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try { const campaign = await api<{ id: string }>('/api/seller/store-buster/campaigns', { method: 'POST', body: JSON.stringify({ name, goal, productIds, audienceCategoryIds: categoryIds }) }); await api(`/api/seller/store-buster/campaigns/${campaign.id}/submit`, { method: 'POST', body: '{}' }); setName(''); setProductIds([]); setCategoryIds([]); await load(); setMessage('Campaign submitted for review. It is organic; no advertising spend has been authorized.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign could not be saved.'); }
    finally { setBusy(false); }
  };
  const createEmailDraft = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { await api('/api/seller/email-campaigns', { method: 'POST', body: JSON.stringify({ name: emailName, subject, content: [{ type: 'paragraph', text: content }] }) }); setEmailName(''); setSubject(''); setContent(''); await load(); setMessage('Email campaign saved as a draft. Sending is unavailable until provider and compliance gates are configured.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Email draft could not be saved.'); }
    finally { setBusy(false); }
  };
  const setAffiliateEnabled = async (enabled: boolean) => { setBusy(true); setError(''); try { await api('/api/seller/affiliate-program', { method: 'PATCH', body: JSON.stringify({ enabled }) }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Affiliate setting could not be saved.'); } finally { setBusy(false); } };

  if (error && !growth) return <section className="page"><h1>Store growth</h1><p className="notice" role="alert">{error}</p></section>;
  if (!growth || !affiliate || !email) return <section className="page"><h1>Store growth</h1><p className="empty" role="status">Loading growth tools…</p></section>;
  const eligibleProducts = products.filter(product => product.status === 'APPROVED' && (product.inventory?.quantity ?? 0) > 0);
  return <section className="page sellerStoreGrowth"><p className="eyebrow">Seller tools</p><h1>Store growth</h1><p className="muted">Growth tools are separately plan-gated. Upgrade options are shown on your <a href="/seller/plan">plan page</a>.</p>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    <section className="card cardBody"><h2>Store Buster</h2><p>{!growth.enabledForPlan ? 'Not enabled for this plan.' : !growth.available ? 'Included in your plan, but currently unavailable by platform policy.' : `Included · ${growth.campaignCount} of ${growth.campaignLimit} campaign slots used.`}</p><p className="muted">Personalized recommendations require each buyer’s explicit opt-in. Stores receive aggregate performance only, not user-level search, view, or saved-item history. Sponsored placements: {growth.sponsoredAvailable ? 'separately gated' : 'disabled'}.</p>
      {growth.available && <form onSubmit={createCampaign}>
        <label>Campaign name<input required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Goal<select value={goal} onChange={event => setGoal(event.target.value)}><option value="DISCOVERY">Store discovery</option><option value="PRODUCT_VIEWS">Product views</option><option value="STORE_VISITS">Store visits</option></select></label>
        <fieldset><legend>Eligible products (approved and in stock)</legend>{eligibleProducts.length ? eligibleProducts.map(product => <label className="storePlanCheck" key={product.id}><input type="checkbox" checked={productIds.includes(product.id)} onChange={() => toggleId(productIds, product.id, setProductIds)} />{product.name}</label>) : <p className="empty">No approved in-stock products are eligible yet.</p>}</fieldset>
        <fieldset><legend>Approved audience interests</legend>{categories.map(category => <label className="storePlanCheck" key={category.id}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleId(categoryIds, category.id, setCategoryIds)} />{category.name}</label>)}</fieldset>
        <button className="primary" disabled={busy || productIds.length === 0}>Create organic campaign</button>
      </form>}
      {growth.campaigns.length === 0 ? <div className="empty">No Store Buster campaigns yet.</div> : <div className="table">{growth.campaigns.map(campaign => <article className="row" key={campaign.id}><span><strong>{campaign.name}</strong><br />{campaign.goal} · {campaign.status} · {campaign.sponsored ? 'Sponsored' : 'Organic'}</span><span>{campaign.products.map(item => item.product.name).join(', ')}</span><span>{campaign.metrics.reduce((total, item) => total + item.impressions, 0).toLocaleString()} impressions · {campaign.metrics.reduce((total, item) => total + item.clicks, 0).toLocaleString()} clicks</span></article>)}</div>}
    </section>
    <section className="card cardBody"><h2>Email marketing</h2><p>{!email.enabledForPlan ? 'Not enabled for this plan.' : `Included · ${email.counts.SUBSCRIBED ?? 0} subscribed of ${email.subscriberLimit} allowed · ${email.monthlySendLimit} sends/month limit.`}</p><p className="notice">{email.message}</p>
      {email.enabledForPlan && <form onSubmit={createEmailDraft}><label>Campaign name<input required minLength={2} maxLength={100} value={emailName} onChange={event => setEmailName(event.target.value)} /></label><label>Subject<input required minLength={2} maxLength={160} value={subject} onChange={event => setSubject(event.target.value)} /></label><label>Draft content<textarea required maxLength={2000} value={content} onChange={event => setContent(event.target.value)} /></label><button disabled={busy}>Save draft only</button></form>}
      {email.campaigns.length === 0 ? <div className="empty">No email campaign drafts.</div> : <ul>{email.campaigns.map(campaign => <li key={campaign.id}>{campaign.name} · {campaign.status}</li>)}</ul>}
      <p className="muted">Unsubscribe and suppression states are preserved. No email is sent to any address in this increment.</p>
    </section>
    <section className="card cardBody"><h2>Affiliate tools</h2><p>{!affiliate.included ? 'Not enabled for this plan.' : affiliate.marketplaceProgramAvailable ? 'Included and available through the existing platform affiliate program.' : 'Included, but the marketplace affiliate program is currently disabled.'}</p><label className="storePlanCheck"><input type="checkbox" checked={affiliate.enabled} disabled={busy || !affiliate.included || !affiliate.marketplaceProgramAvailable} onChange={event => void setAffiliateEnabled(event.target.checked)} />Allow approved affiliates to promote my Store products</label><p className="muted">Affiliate links remain consent-based and use the existing platform attribution and commission ledger. This Store plan does not create seller commissions or seller payouts; no payout capability is enabled here.</p></section>
    <p><a href="/dashboard">Back to seller dashboard</a></p>
  </section>;
}
