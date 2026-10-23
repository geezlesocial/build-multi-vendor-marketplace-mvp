import React, { useEffect, useState } from 'react';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Settings = { enabled: boolean; sponsoredEnabled: boolean; moderationRequired: boolean; maxMonthlyBudgetMinor: number; maxCampaignsPerStore: number; pricePerClickMinor: number; sponsoredDeploymentGate: boolean };
type Campaign = { id: string; name: string; goal: string; status: string; sponsored: boolean; store: { name: string; slug: string }; products: { product: { name: string; status: string } }[] };

export function AdminStoreGrowth() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [reason, setReason] = useState('Reviewed Store growth policy');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { const [nextSettings, nextCampaigns] = await Promise.all([api<Settings>('/api/admin/store-buster/settings'), api<Campaign[]>('/api/admin/store-buster/campaigns')]); setSettings(nextSettings); setCampaigns(nextCampaigns); };
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!settings) return; setBusy(true); setMessage(''); setError('');
    try { await api('/api/admin/store-buster/settings', { method: 'PATCH', body: JSON.stringify({ enabled: settings.enabled, sponsoredEnabled: settings.sponsoredEnabled, moderationRequired: settings.moderationRequired, maxMonthlyBudgetMinor: settings.maxMonthlyBudgetMinor, maxCampaignsPerStore: settings.maxCampaignsPerStore, pricePerClickMinor: settings.pricePerClickMinor, reason }) }); await load(); setMessage('Store Buster settings saved and audited.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Settings could not be saved.'); }
    finally { setBusy(false); }
  };
  const review = async (campaign: Campaign, status: 'APPROVED' | 'REJECTED' | 'PAUSED') => {
    const reviewReason = window.prompt(`Reason to ${status.toLowerCase()} ${campaign.name}`); if (!reviewReason || reviewReason.trim().length < 3) return;
    setBusy(true); setError('');
    try { await api(`/api/admin/store-buster/campaigns/${campaign.id}/review`, { method: 'PATCH', body: JSON.stringify({ status, reason: reviewReason }) }); await load(); setMessage(`Campaign ${status.toLowerCase()}.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign could not be reviewed.'); }
    finally { setBusy(false); }
  };
  if (error && !settings) return <section><h2>Store Buster</h2><p className="notice" role="alert">{error}</p></section>;
  if (!settings) return <section><h2>Store Buster</h2><p className="empty" role="status">Loading growth controls…</p></section>;
  return <section className="adminStoreGrowth">
    <h2>Store Buster controls</h2><p className="muted">Organic recommendations use opted-in first-party signals. Stores see aggregate performance only, never individual browsing histories. Recommendation ranking is explainable and is not described as AI.</p>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    <form className="card cardBody" onSubmit={save}>
      <label className="storePlanCheck"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />Enable organic Store Buster recommendations</label>
      <label className="storePlanCheck"><input type="checkbox" checked={settings.moderationRequired} onChange={event => setSettings({ ...settings, moderationRequired: event.target.checked })} />Require admin moderation before campaigns are included</label>
      <label className="storePlanCheck"><input type="checkbox" checked={settings.sponsoredEnabled} disabled={!settings.sponsoredDeploymentGate} onChange={event => setSettings({ ...settings, sponsoredEnabled: event.target.checked })} />Allow sponsored placements (deployment gate: {settings.sponsoredDeploymentGate ? 'available' : 'OFF'})</label>
      <div className="storePlanNumberGrid"><label>Admin maximum monthly budget (minor units)<input type="number" min="0" value={settings.maxMonthlyBudgetMinor} onChange={event => setSettings({ ...settings, maxMonthlyBudgetMinor: Number(event.target.value) })} /></label><label>Maximum campaigns per Store<input type="number" min="0" value={settings.maxCampaignsPerStore} onChange={event => setSettings({ ...settings, maxCampaignsPerStore: Number(event.target.value) })} /></label><label>Price per click (minor units)<input type="number" min="0" value={settings.pricePerClickMinor} onChange={event => setSettings({ ...settings, pricePerClickMinor: Number(event.target.value) })} /></label></div>
      <label>Audit reason<input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <p className="muted">Budget/pricing fields are policy configuration only. No billing, ad serving, or charge capture is implemented. Paid placements remain disabled until the separate deployment gate and funding workflow are reviewed.</p>
      <button className="primary" disabled={busy}>Save growth policy</button>
    </form>
    <h3>Campaign review</h3>{campaigns.length === 0 ? <div className="empty">No Store Buster campaigns have been submitted.</div> : <div className="table">{campaigns.map(campaign => <article className="row" key={campaign.id}><span><strong>{campaign.name}</strong><br />{campaign.store.name} · {campaign.goal} · {campaign.status} · {campaign.sponsored ? 'SPONSORED' : 'ORGANIC'}</span><span>{campaign.products.map(item => item.product.name).join(', ')}</span>{campaign.status === 'PENDING_REVIEW' && <span className="toolbar"><button type="button" disabled={busy} onClick={() => void review(campaign, 'APPROVED')}>Approve</button><button type="button" disabled={busy} onClick={() => void review(campaign, 'REJECTED')}>Reject</button></span>}</article>)}</div>}
    <h2>Email marketing readiness</h2><div className="empty"><strong>Sending disabled</strong><p>Consent-first subscriber records and draft campaigns are supported. No confirmation or campaign delivery provider is configured, so no email is sent and public subscription requests are not stored until a verified provider exists.</p></div>
  </section>;
}
