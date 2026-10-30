import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Settings = { enabled: boolean; sponsoredEnabled: boolean; moderationRequired: boolean; maxMonthlyBudgetMinor: number; maxCampaignsPerStore: number; pricePerClickMinor: number; pricePer100ViewsMinor: number; minimumCampaignUsdMinor: number; maxCampaignDurationDays: number; sponsoredDeploymentGate: boolean; sponsoredBillingAvailable: boolean; sponsoredBillingProviders: string[]; currency: string };
type Campaign = { id: string; name: string; headline?: string | null; adDescription?: string | null; goal: string; status: string; sponsored: boolean; billingModel?: string | null; audience?: string | null; targetCountryCodes?: string[]; durationDays?: number | null; dailyBudgetMinor?: number | null; lifetimeBudgetMinor?: number | null; budgetCurrency?: string | null; budgetTotalMinor?: number | null; endsAt?: string | null; monthlyBudgetMinor: number; store: { name: string; slug: string }; products: { product: { name: string; status: string } }[]; creatives?: { mediaAsset: { id: string; kind: string; originalName: string; scanStatus: string; uploadStatus: string } }[]; metrics: { impressions: number; clicks: number; spendMinor: number }[] };
type AdFundingData = { fundingIntents: { id: string; amountMinor: number; currency: string; provider: string; status: string; providerOrderRef: string | null; providerPaymentRef: string | null; providerCheckoutRef: string | null; createdBy: { email: string }; account: { id: string; store: { name: string } }; events: { eventType: string; reviewReason: string | null; createdAt: string }[]; ledgerEntry: { id: string } | null }[]; frozenAccounts: { id: string; availableMinor: number; currency: string; store: { name: string }; fundingIntents: { id: string; ledgerEntry: { id: string } | null }[] }[] };
type EmailProvider = { configured: boolean; transactionalConfigured: boolean; enabled: boolean; deploymentGate: boolean; connectionVerified: boolean; verifiedAt: string | null; hostConfigured: boolean; host?: string | null; provider?: string | null; providerLabel?: string | null; configurationSource?: string; port: number; secureTransport: boolean; authenticationConfigured: boolean; senderConfigured: boolean; replyToConfigured: boolean; unsubscribeSigningConfigured: boolean; message: string; transactionalQueue: Partial<Record<'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED', number>> };
type AccountEmailStatus = { configured: boolean; connectionVerified: boolean; available: boolean };
type ProviderConfig = { id: string; label: string; host: string; port: number; secure: boolean; requireTls: boolean; username: string; senderName: string; senderEmail: string; replyTo: string; usernameConfigured: boolean; passwordConfigured: boolean; credentialUnreadable: boolean; saved: boolean; active: boolean; verifiedAt: string | null; lastTestAt: string | null; lastTestCode: string | null };
type ProviderDirectory = { activeProvider: string | null; deploymentFallbackConfigured: boolean; providers: ProviderConfig[] };
type ProviderForm = { host: string; port: number; secure: boolean; requireTls: boolean; username: string; password: string; senderName: string; senderEmail: string; replyTo: string; reason: string };

const providerHelp: Record<string, string> = {
  MAILTRAP: 'Mailtrap sandbox is useful for testing. Use your Mailtrap SMTP credentials; production sending may require a separate Mailtrap sending domain.',
  BREVO: 'Use the SMTP key as the password (not the account login password).',
  GMAIL: 'Use a Google App Password with 2-Step Verification; normal account passwords are not accepted.',
  SENDGRID: 'The SMTP username is “apikey”; enter your SendGrid API key as the password.',
  MAILGUN: 'Use the SMTP credentials generated for your sending domain and the correct Mailgun region host.',
  AMAZON_SES: 'Use SES-generated SMTP credentials for the selected AWS region, not the raw IAM secret access key.',
  POSTMARK: 'Use the SMTP credentials for the Postmark Server. Ensure the sender domain/address is verified.',
  SMTP2GO: 'Use the SMTP username and password from SMTP2GO; API tokens are not SMTP passwords.',
  MAILJET: 'Use the Mailjet API key as SMTP username and the secret key as SMTP password.',
  MAILERSEND: 'Use SMTP credentials generated in MailerSend, not a REST API token.',
  ZOHO: 'Use your Zoho account SMTP username and password or an app-specific password. The correct hostname may vary by account/data center; confirm it in Zoho Mail settings.',
  NAMECHEAP: 'Namecheap Private Email commonly uses mail.privateemail.com with SSL on port 465. Confirm the account-specific settings in your Namecheap email dashboard.',
  MANUAL_SMTP: 'Enter a public SMTP hostname, port, TLS mode, and optional credentials supplied by your mail host.'
};

function EmailProviderManager({ onUpdated }: { onUpdated: () => Promise<void> }) {
  const [directory, setDirectory] = useState<ProviderDirectory | null>(null);
  const [selectedId, setSelectedId] = useState('MAILTRAP');
  const [form, setForm] = useState<ProviderForm>({ host: '', port: 587, secure: false, requireTls: true, username: '', password: '', senderName: 'Market Lane', senderEmail: '', replyTo: '', reason: 'Configure platform email delivery' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selected = directory?.providers.find(item => item.id === selectedId);
  const verifiedRecently = Boolean(selected?.verifiedAt && Date.now() - Date.parse(selected.verifiedAt) < 24 * 60 * 60_000);
  const load = async () => {
    const result = await api<ProviderDirectory>('/api/admin/store-email/providers');
    setDirectory(result);
    if (!result.providers.some(item => item.id === selectedId)) setSelectedId(result.providers[0]?.id ?? 'MAILTRAP');
  };
  useEffect(() => { void load().catch(cause => setError((cause as Error).message)); }, []);
  useEffect(() => {
    if (!selected) return;
    setForm(current => ({ ...current, host: selected.host, port: selected.port, secure: selected.secure, requireTls: selected.requireTls, username: selected.username, password: '', senderName: selected.senderName, senderEmail: selected.senderEmail, replyTo: selected.replyTo }));
  }, [selectedId, directory]);
  const perform = async (action: 'save' | 'test' | 'activate' | 'deactivate') => {
    if (!selected) return;
    setBusy(true); setMessage(''); setError('');
    try {
      let result: { message?: string };
      if (action === 'save') {
        result = await api<{ message?: string }>(`/api/admin/store-email/providers/${selected.id}`, { method: 'PUT', body: JSON.stringify(form) });
      } else if (action === 'test') {
        result = await api<{ message?: string }>(`/api/admin/store-email/providers/${selected.id}/test`, { method: 'POST', body: JSON.stringify({ reason: form.reason }) });
      } else {
        result = await api<{ message?: string }>(`/api/admin/store-email/providers/${selected.id}/activation`, { method: 'PATCH', body: JSON.stringify({ active: action === 'activate', reason: form.reason }) });
      }
      await load(); await onUpdated(); setMessage(result.message ?? 'Email provider settings updated.');
      if (action === 'save') setForm(current => ({ ...current, password: '' }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Email provider action failed.'); }
    finally { setBusy(false); }
  };
  return <section className="card cardBody adminEmailProviderManager">
    <div className="adminEmailSectionHeading"><div><p className="eyebrow">PLATFORM DELIVERY</p><h3>SMTP providers and credentials</h3></div><span className="statusPill">{directory?.activeProvider ? `Active: ${directory.providers.find(item => item.id === directory.activeProvider)?.label ?? directory.activeProvider}` : directory?.deploymentFallbackConfigured ? 'Using deployment SMTP' : 'No provider active'}</span></div>
    <p className="muted">Configure each provider independently, test its SMTP connection without sending an email, then activate the verified provider. SMTP credentials and API keys are encrypted at rest and never returned to the browser. Updating an active provider deactivates it until it is tested and activated again.</p>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    <div className="adminEmailProviderForm">
      <label>Email service<select value={selectedId} onChange={event => setSelectedId(event.target.value)}>{directory?.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <p className="muted adminEmailProviderHelp">{providerHelp[selectedId]}</p>
      <div className="adminEmailProviderFields">
        <label>SMTP host<input required value={form.host} onChange={event => setForm({ ...form, host: event.target.value })} placeholder="smtp.example.com" autoComplete="off" /></label>
        <label>SMTP port<input required type="number" min="1" max="65535" value={form.port} onChange={event => setForm({ ...form, port: Number(event.target.value) })} /></label>
        <label>SMTP username / API key<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} placeholder={selected?.usernameConfigured ? 'Saved — leave blank to keep current value' : 'Provider SMTP username'} autoComplete="off" /></label>
        <label>SMTP password / API credential<input type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder={selected?.credentialUnreadable ? 'Re-enter required — stored credential cannot be decrypted' : selected?.passwordConfigured ? 'Saved — leave blank to keep current credential' : 'Provider SMTP password or API credential'} autoComplete="new-password" /></label>
        <label>Sender name<input required maxLength={120} value={form.senderName} onChange={event => setForm({ ...form, senderName: event.target.value })} /></label>
        <label>Verified sender email<input required type="email" value={form.senderEmail} onChange={event => setForm({ ...form, senderEmail: event.target.value })} placeholder="no-reply@example.com" /></label>
        <label>Reply-to email (optional)<input type="email" value={form.replyTo} onChange={event => setForm({ ...form, replyTo: event.target.value })} /></label>
      </div>
      <div className="adminEmailTlsOptions"><label><input type="checkbox" checked={form.secure} onChange={event => setForm({ ...form, secure: event.target.checked, requireTls: event.target.checked ? false : form.requireTls })} />Implicit TLS (usually port 465)</label><label><input type="checkbox" checked={form.requireTls} disabled={form.secure} onChange={event => setForm({ ...form, requireTls: event.target.checked })} />Require STARTTLS (usually port 587)</label></div>
      <label>Audit reason<input required minLength={3} maxLength={500} value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} /></label>
      <div className="toolbar adminEmailProviderActions"><button type="button" className="primary" disabled={busy || !form.host || !form.senderEmail} onClick={() => void perform('save')}>{busy ? 'Saving…' : 'Save provider settings'}</button><button type="button" disabled={busy || !selected?.saved} onClick={() => void perform('test')}>Test connection (sends no email)</button>{selected?.active ? <button type="button" disabled={busy} onClick={() => void perform('deactivate')}>Deactivate provider</button> : <button type="button" disabled={busy || !selected?.saved || !verifiedRecently || !form.reason.trim()} onClick={() => void perform('activate')}>Activate verified provider</button>}</div>
      <p className="muted">{selected?.active ? 'This provider currently sends platform transactional email. Marketing campaigns also require the separate deployment gate and unsubscribe signing secret.' : verifiedRecently ? `Connection verified ${new Date(selected!.verifiedAt!).toLocaleString()}. Verification expires after 24 hours.` : selected?.saved ? 'Saved, but a fresh connection test is required before activation.' : 'Not configured. Save settings to enable its independent connection test.'}</p>
    </div>
  </section>;
}

function AccountVerificationEmailStatus() {
  const [status, setStatus] = useState<AccountEmailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = async () => { const result = await api<{ accountVerification: AccountEmailStatus }>('/api/admin/store-email/status'); setStatus(result.accountVerification); };
  useEffect(() => { void load().catch(error => setMessage((error as Error).message)); }, []);
  const verify = async () => { setBusy(true); setMessage(''); try { const result = await api<{ message: string }>('/api/admin/store-email/verify', { method: 'POST', body: '{}' }); await load(); setMessage(result.message); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } };
  return <section className="card cardBody"><h2>Transactional account verification email</h2><p className="muted">Independent of Store marketing consent and its deployment gate. Requires SMTP host, sender, and TLS, plus a verified connection in this API process.</p><p><strong>{status?.available ? 'Ready to send verification links' : status?.configured ? 'SMTP connection must be verified' : 'SMTP is not configured'}</strong></p>{message && <p className="muted" role="status">{message}</p>}<button type="button" disabled={busy || !status?.configured} onClick={() => void verify()}>{busy ? 'Verifying…' : 'Verify account email SMTP'}</button></section>;
}

export function AdminStoreGrowth() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [funding, setFunding] = useState<AdFundingData>({ fundingIntents: [], frozenAccounts: [] });
  const [emailProvider, setEmailProvider] = useState<EmailProvider | null>(null);
  const [reason, setReason] = useState('Reviewed Store growth policy');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { const [nextSettings, nextCampaigns, nextEmailProvider, nextFunding] = await Promise.all([api<Settings>('/api/admin/store-buster/settings'), api<Campaign[]>('/api/admin/store-buster/campaigns'), api<EmailProvider>('/api/admin/store-email/status'), api<AdFundingData>('/api/admin/store-buster/funding')]); setSettings(nextSettings); setCampaigns(nextCampaigns); setEmailProvider(nextEmailProvider); setFunding(nextFunding); };
  useEffect(() => { void load().catch(reason => setError(reason.message)); }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!settings) return; setBusy(true); setMessage(''); setError('');
    try { await api('/api/admin/store-buster/settings', { method: 'PATCH', body: JSON.stringify({ enabled: settings.enabled, sponsoredEnabled: settings.sponsoredEnabled, moderationRequired: settings.moderationRequired, maxMonthlyBudgetMinor: settings.maxMonthlyBudgetMinor, maxCampaignsPerStore: settings.maxCampaignsPerStore, pricePerClickMinor: settings.pricePerClickMinor, pricePer100ViewsMinor: settings.pricePer100ViewsMinor, minimumCampaignUsdMinor: settings.minimumCampaignUsdMinor, maxCampaignDurationDays: settings.maxCampaignDurationDays, reason }) }); await load(); setMessage('Store Buster settings saved and audited.'); }
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
  const resolveFunding = async (intent: AdFundingData['fundingIntents'][number], decision: 'CREDIT' | 'VOID') => {
    const providerReference = decision === 'CREDIT' ? window.prompt('After verifying a completed capture in the provider dashboard, enter the exact provider reference shown below:', intent.providerPaymentRef ?? intent.providerOrderRef ?? intent.providerCheckoutRef ?? '') : undefined;
    if (decision === 'CREDIT' && !providerReference) return;
    const reviewReason = window.prompt(`Audit reason for ${decision === 'CREDIT' ? 'crediting' : 'voiding'} this funding intent. Confirm provider-side reconciliation before crediting:`);
    if (!reviewReason || reviewReason.trim().length < 8) return;
    setBusy(true); setError(''); setMessage('');
    try { await api(`/api/admin/store-buster/funding/${intent.id}/resolve`, { method: 'PATCH', body: JSON.stringify({ decision, ...(providerReference ? { providerReference } : {}), reason: reviewReason.trim() }) }); await load(); setMessage(`Ad funding ${decision === 'CREDIT' ? 'credited' : 'voided'} after review.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Funding review could not be resolved.'); }
    finally { setBusy(false); }
  };
  const changeAdAccountStatus = async (account: AdFundingData['frozenAccounts'][number], status: 'ACTIVE' | 'FROZEN') => {
    const riskAcknowledgement = status === 'ACTIVE' && account.fundingIntents.some(intent => intent.ledgerEntry);
    if (riskAcknowledgement && !window.confirm(`Finance risk acknowledgement: ${account.store.name}'s account had an already-credited funding payment later refunded or disputed. Remaining prepaid ad credit (${formatMinor(account.availableMinor, account.currency)}) will be reversed to zero; any ad spend already consumed may be unrecoverable. Continue only after provider-side reconciliation.`)) return;
    const auditReason = window.prompt(`Audit reason to set ${account.store.name}'s ad account to ${status}:`);
    if (!auditReason || auditReason.trim().length < 8) return;
    setBusy(true); setError('');
    try { await api(`/api/admin/store-buster/ad-accounts/${account.id}/status`, { method: 'PATCH', body: JSON.stringify({ status, riskAcknowledgement, reason: auditReason.trim() }) }); await load(); setMessage(`Advertising account ${status.toLowerCase()}.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Advertising account status could not be changed.'); }
    finally { setBusy(false); }
  };
  const verifyEmailProvider = async () => {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api<{ message: string }>('/api/admin/store-email/verify', { method: 'POST', body: '{}' }); await load(); setMessage(result.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'SMTP connection could not be verified.'); }
    finally { setBusy(false); }
  };
  const retryFailedTransactionalEmails = async () => {
    const failed = emailProvider?.transactionalQueue?.FAILED ?? 0;
    if (!failed || !window.confirm(`Retry up to ${Math.min(failed, 500)} failed transactional emails? If SMTP accepted a message before a connection failure, a retry can cause a duplicate.`)) return;
    const retryReason = window.prompt('Audit reason for retrying failed transactional email:');
    if (!retryReason || retryReason.trim().length < 8) return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await api<{ message: string }>('/api/admin/store-email/outbox/retry-failed', { method: 'POST', body: JSON.stringify({ reason: retryReason }) }); await load(); setMessage(result.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed emails could not be requeued.'); }
    finally { setBusy(false); }
  };
  if (error && !settings) return <section><h2>Store Buster</h2><p className="notice" role="alert">{error}</p></section>;
  if (!settings) return <section><h2>Store Buster</h2><p className="empty" role="status">Loading growth controls…</p></section>;
  return <section className="adminStoreGrowth">
    <EmailProviderManager onUpdated={load} />
    <AccountVerificationEmailStatus />
    <h2>Store Buster controls</h2><p className="muted">Organic recommendations use opted-in first-party signals. Stores see aggregate performance only, never individual browsing histories. Recommendation ranking is explainable and is not described as AI.</p>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    <form className="card cardBody" onSubmit={save}>
      <label className="storePlanCheck"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />Enable organic Store Buster recommendations</label>
      <label className="storePlanCheck"><input type="checkbox" checked={settings.moderationRequired} onChange={event => setSettings({ ...settings, moderationRequired: event.target.checked })} />Require admin moderation before campaigns are included</label>
      <label className="storePlanCheck"><input type="checkbox" checked={settings.sponsoredEnabled} disabled={!settings.sponsoredDeploymentGate} onChange={event => setSettings({ ...settings, sponsoredEnabled: event.target.checked })} />Allow sponsored placements (deployment gate: {settings.sponsoredDeploymentGate ? 'available' : 'OFF'})</label>
      <div className="storePlanNumberGrid"><label>Admin maximum monthly budget (minor units, {settings.currency})<input type="number" min="0" value={settings.maxMonthlyBudgetMinor} onChange={event => setSettings({ ...settings, maxMonthlyBudgetMinor: Number(event.target.value) })} /></label><label>Maximum campaigns per Store<input type="number" min="0" value={settings.maxCampaignsPerStore} onChange={event => setSettings({ ...settings, maxCampaignsPerStore: Number(event.target.value) })} /></label><label>CPC price per qualified click (minor units, {settings.currency})<input type="number" min="0" value={settings.pricePerClickMinor} onChange={event => setSettings({ ...settings, pricePerClickMinor: Number(event.target.value) })} /></label><label>CPV price per 100 qualified views (minor units, {settings.currency}; e.g. 100 = USD $1.00 when currency is USD)<input type="number" min="0" value={settings.pricePer100ViewsMinor} onChange={event => setSettings({ ...settings, pricePer100ViewsMinor: Number(event.target.value) })} /></label><label>Minimum campaign total (USD minor units; at least $10)<input type="number" min="1000" value={settings.minimumCampaignUsdMinor} onChange={event => setSettings({ ...settings, minimumCampaignUsdMinor: Math.max(1000, Number(event.target.value)) })} /></label><label>Maximum ad duration (days)<input type="number" min="1" max="365" value={settings.maxCampaignDurationDays} onChange={event => setSettings({ ...settings, maxCampaignDurationDays: Number(event.target.value) })} /></label></div>
      <label>Audit reason<input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <p className="muted">Paid ad delivery is {settings.enabled && settings.sponsoredEnabled && settings.sponsoredDeploymentGate && settings.sponsoredBillingAvailable && settings.moderationRequired && (settings.pricePerClickMinor > 0 || settings.pricePer100ViewsMinor > 0) && settings.maxMonthlyBudgetMinor > 0 ? 'eligible to run' : 'closed'}. Deployment gate: {settings.sponsoredDeploymentGate ? 'open' : 'off'} · payment/webhook: {settings.sponsoredBillingAvailable ? settings.sponsoredBillingProviders.join(', ') : 'not ready'} · mandatory moderation: {settings.moderationRequired ? 'on' : 'off'}. CPC bills verified clicks; CPV bills only qualified ad cards at the configured amount per 100 visible views. All debits use the seller’s separate prepaid ad ledger.</p>
      <button className="primary" disabled={busy}>Save growth policy</button>
    </form>
    <h3>Campaign review</h3>{campaigns.length === 0 ? <div className="empty">No Store Buster campaigns have been submitted.</div> : <div className="table">{campaigns.map(campaign => <article className="row" key={campaign.id}><span><strong>{campaign.name}</strong><br />{campaign.store.name} · {campaign.goal} · {campaign.status} · {campaign.sponsored ? `SPONSORED · cap ${formatMinor(campaign.monthlyBudgetMinor, settings.currency)}` : 'ORGANIC'}<br />{campaign.metrics.reduce((sum, item) => sum + item.impressions, 0).toLocaleString()} served · {campaign.metrics.reduce((sum, item) => sum + item.clicks, 0).toLocaleString()} clicks · {campaign.sponsored ? formatMinor(campaign.metrics.reduce((sum, item) => sum + item.spendMinor, 0), settings.currency) : 'no spend'}</span><span>{campaign.products.map(item => item.product.name).join(', ')}</span>{campaign.status === 'PENDING_REVIEW' && <span className="toolbar"><button type="button" disabled={busy} onClick={() => void review(campaign, 'APPROVED')}>Approve</button><button type="button" disabled={busy} onClick={() => void review(campaign, 'REJECTED')}>Reject</button></span>}</article>)}</div>}
    <h3>Active ad controls</h3>{campaigns.some(campaign => campaign.sponsored && ['APPROVED', 'PAUSED'].includes(campaign.status)) ? <div className="table">{campaigns.filter(campaign => campaign.sponsored && ['APPROVED', 'PAUSED'].includes(campaign.status)).map(campaign => <article className="row" key={campaign.id}><span><strong>{campaign.headline || campaign.name}</strong><br />{campaign.store.name} · {campaign.status} · {campaign.billingModel ?? 'CPC'} · ends {campaign.endsAt ? new Date(campaign.endsAt).toLocaleString() : 'not scheduled'}</span><button type="button" disabled={busy} onClick={() => void review(campaign, campaign.status === 'APPROVED' ? 'PAUSED' : 'APPROVED')}>{campaign.status === 'APPROVED' ? 'Pause ad' : 'Resume ad'}</button></article>)}</div> : <div className="empty">No active or paused sponsored ads.</div>}
    <h3>Sponsored creative inspection</h3>{campaigns.filter(campaign => campaign.sponsored).length > 0 && <div className="adminAdCreativeList">{campaigns.filter(campaign => campaign.sponsored).map(campaign => <article className="card cardBody" key={campaign.id}><p className="eyebrow">{campaign.store.name} · {campaign.status} · {campaign.billingModel ?? 'CPC'}</p><h4>{campaign.headline || campaign.name}</h4><p>{campaign.adDescription}</p><p className="muted">{campaign.audience ?? 'All audiences'} · {campaign.targetCountryCodes?.length ? campaign.targetCountryCodes.join(', ') : 'All countries'} · {campaign.durationDays ?? '—'} days · {campaign.budgetCurrency && campaign.budgetTotalMinor != null ? formatMinor(campaign.budgetTotalMinor, campaign.budgetCurrency) : 'Budget not set'}</p><div className="adminAdReviewCreatives">{campaign.creatives?.map(({ mediaAsset }) => { const src = `/api/admin/store-buster/campaigns/${encodeURIComponent(campaign.id)}/creatives/${encodeURIComponent(mediaAsset.id)}`; return mediaAsset.kind === 'VIDEO' ? <video key={mediaAsset.id} src={src} controls preload="metadata" aria-label={mediaAsset.originalName} /> : <img key={mediaAsset.id} src={src} alt={mediaAsset.originalName} />; })}</div></article>)}</div>}
    <h3>Prepaid ad funding review</h3><p className="muted">Credits are added only from provider-confirmed captures. Refunds, reversals, mismatches, and late captures freeze the affected ad account until manually reconciled. This balance is not a seller payout or withdrawable wallet.</p>
    {funding.fundingIntents.length === 0 && funding.frozenAccounts.length === 0 ? <div className="empty">No funding intents need review.</div> : <div className="table">{funding.fundingIntents.map(intent => <article className="row" key={intent.id}><span><strong>{intent.account.store.name}</strong><br />{intent.status} · {intent.provider} · {formatMinor(intent.amountMinor, intent.currency)} · {intent.createdBy.email}<br /><small>Provider reference: {intent.providerPaymentRef ?? intent.providerOrderRef ?? intent.providerCheckoutRef ?? 'not recorded'}</small><br /><small>{intent.events[0]?.reviewReason ?? intent.events[0]?.eventType ?? 'Awaiting verified payment confirmation'}</small>{intent.ledgerEntry && <><br /><small>Previously credited: keep frozen until provider dispute/refund and remaining ad credit are reconciled.</small></>}</span><span className="toolbar"><button type="button" disabled={busy || intent.status !== 'REVIEW' || Boolean(intent.ledgerEntry)} onClick={() => void resolveFunding(intent, 'CREDIT')}>Credit after verification</button><button type="button" disabled={busy || intent.status !== 'REVIEW' || Boolean(intent.ledgerEntry)} onClick={() => void resolveFunding(intent, 'VOID')}>Void uncredited intent</button></span></article>)}{funding.frozenAccounts.map(account => { const hasUncreditedReview = account.fundingIntents.some(intent => !intent.ledgerEntry); return <article className="row" key={account.id}><span><strong>{account.store.name} ad balance frozen</strong><br />Available credit {formatMinor(account.availableMinor, account.currency)}{account.fundingIntents.some(intent => intent.ledgerEntry) && <><br /><small>Provider reversal/dispute found. Restoring will reverse remaining credit; already-spent credit may be unrecoverable.</small></>}</span><button type="button" disabled={busy || hasUncreditedReview} onClick={() => void changeAdAccountStatus(account, 'ACTIVE')}>Restore after reconciliation</button></article>; })}</div>}
    <h2>Email marketing delivery</h2>{emailProvider && <div className="card cardBody adminEmailProvider"><p><strong>{emailProvider.enabled ? 'Marketing delivery enabled' : !emailProvider.configured ? 'Marketing settings incomplete' : !emailProvider.deploymentGate ? 'Marketing deployment gate is off' : 'Marketing connection verification required'}</strong></p><p>{emailProvider.message}</p><dl><div><dt>Active provider</dt><dd>{emailProvider.providerLabel ?? (emailProvider.hostConfigured ? 'Deployment SMTP' : 'Not selected')}</dd></div><div><dt>SMTP host</dt><dd>{emailProvider.host ?? 'Missing'}</dd></div><div><dt>Transport</dt><dd>{emailProvider.port} · {emailProvider.secureTransport ? 'TLS enabled' : 'TLS not enabled'}</dd></div><div><dt>SMTP credentials</dt><dd>{emailProvider.authenticationConfigured ? 'Configured (value hidden)' : 'Not configured'}</dd></div><div><dt>Sender</dt><dd>{emailProvider.senderConfigured ? 'Configured' : 'Missing'}</dd></div><div><dt>Unsubscribe signing secret</dt><dd>{emailProvider.unsubscribeSigningConfigured ? 'Configured (value hidden)' : 'Missing in deployment settings'}</dd></div><div><dt>Connection check</dt><dd>{emailProvider.connectionVerified && emailProvider.verifiedAt ? `Verified ${new Date(emailProvider.verifiedAt).toLocaleString()}` : 'Not verified'}</dd></div></dl><p className="muted">The active, verified SMTP provider is shared by transactional and marketing delivery. Transactional messages do not require marketing consent, the unsubscribe secret, or the marketing deployment gate. The unsubscribe signing secret remains a deployment secret.</p><button type="button" disabled={busy || !emailProvider.transactionalConfigured} onClick={() => void verifyEmailProvider()}>Verify active provider (sends no email)</button><h3>Transactional notification queue</h3><p className="muted">Order, support, and account notifications are queued only for active accounts with verified email addresses and enabled notification preferences.</p><div className="adminEmailQueueStats">{(['PENDING', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED'] as const).map(status => <span key={status}><strong>{emailProvider.transactionalQueue?.[status] ?? 0}</strong>{status.toLowerCase()}</span>)}</div><p className="muted">Retries are at-least-once: if an SMTP server accepted a message before a connection failure, a retry may send a duplicate.</p><button type="button" disabled={busy || !(emailProvider.transactionalQueue?.FAILED ?? 0)} onClick={() => void retryFailedTransactionalEmails()}>Retry up to 500 failed transactional emails</button></div>}
  </section>;
}
