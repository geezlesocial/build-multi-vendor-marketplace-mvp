import React, { useEffect, useMemo, useState } from 'react';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

type Provider = { id: string; label: string; host: string; port: number; secure: boolean; requireTls: boolean; username: string };
type DnsRecord = { type: 'TXT' | 'CNAME'; host: string; value: string };
type IntegrationData = {
  platformAdminOverride: boolean;
  customDomain: { eligible: boolean; targetConfigured: boolean; target: string | null; domain: { domain: string; status: string; verifiedAt: string | null; cnameTarget: string; lastCheckedAt: string | null } | null };
  email: { eligible: boolean; active: boolean; provider: string | null; host: string | null; port: number | null; secure: boolean | null; requireTls: boolean | null; usernameConfigured: boolean; passwordConfigured: boolean; credentialUnreadable: boolean; senderName: string; senderEmail: string; replyTo: string; verifiedAt: string | null; lastTestAt: string | null; lastTestCode: string | null };
  providers: Provider[];
  notes: { customDomain: string; email: string };
};

const emptySmtp = { host: '', port: 587, secure: false, requireTls: true, username: '', password: '', senderName: '', senderEmail: '', replyTo: '', reason: 'Configure Store SMTP delivery' };

export function SellerStoreIntegrations() {
  const [data, setData] = useState<IntegrationData | null>(null);
  const [selectedProvider, setSelectedProvider] = useState('MAILTRAP');
  const [smtp, setSmtp] = useState(emptySmtp);
  const [domainInput, setDomainInput] = useState('');
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selected = useMemo(() => data?.providers.find(provider => provider.id === selectedProvider), [data, selectedProvider]);
  const load = async () => {
    const current = await api<IntegrationData>('/api/seller/integrations');
    setData(current);
    if (current.email.provider && current.providers.some(item => item.id === current.email.provider)) setSelectedProvider(current.email.provider);
    if (current.customDomain.domain) setDomainInput(current.customDomain.domain.domain);
    setSmtp(value => ({ ...value, host: current.email.host ?? value.host, port: current.email.port ?? value.port, secure: current.email.secure ?? value.secure, requireTls: current.email.requireTls ?? value.requireTls, senderName: current.email.senderName || value.senderName, senderEmail: current.email.senderEmail, replyTo: current.email.replyTo }));
  };
  useEffect(() => { void load().catch(cause => setError((cause as Error).message)); }, []);
  useEffect(() => {
    if (!selected || data?.email.provider === selected.id) return;
    setSmtp(value => ({ ...value, host: selected.host, port: selected.port, secure: selected.secure, requireTls: selected.requireTls, username: selected.username, password: '' }));
  }, [selected, data?.email.provider]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { const result = await action(); await load(); setMessage(typeof result === 'string' ? result : success); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const addDomain = () => void run(async () => {
    const result = await api<{ records: DnsRecord[] }>('/api/seller/custom-domain', { method: 'PUT', body: JSON.stringify({ domain: domainInput }) });
    setRecords(result.records);
  }, 'Domain saved. Add the requested DNS records, then verify.');
  const rotateDomainToken = () => void run(async () => {
    const result = await api<{ records: DnsRecord[] }>('/api/seller/custom-domain/rotate-verification', { method: 'POST', body: '{}' });
    setRecords(result.records);
  }, 'New DNS verification records created. Replace the old TXT value with the new one.');
  const verifyDomain = () => void run(async () => {
    const result = await api<{ message: string }>('/api/seller/custom-domain/verify', { method: 'POST', body: '{}' });
    return result.message;
  }, 'DNS check completed.');
  const removeDomain = () => { if (window.confirm('Remove this Store domain connection? This does not remove the DNS records from your domain registrar.')) void run(() => api('/api/seller/custom-domain', { method: 'DELETE' }), 'Domain connection removed.'); };

  const saveSmtp = () => void run(() => api(`/api/seller/email/providers/${encodeURIComponent(selectedProvider)}`, { method: 'PUT', body: JSON.stringify(smtp) }), 'SMTP settings saved. Test the connection before activating it.');
  const testSmtp = () => void run(() => api(`/api/seller/email/providers/${encodeURIComponent(selectedProvider)}/test`, { method: 'POST', body: JSON.stringify({ reason: smtp.reason }) }), 'SMTP connection verified. No email was sent.');
  const setSmtpActive = (active: boolean) => void run(() => api(`/api/seller/email/providers/${encodeURIComponent(selectedProvider)}/activation`, { method: 'PATCH', body: JSON.stringify({ active, reason: smtp.reason }) }), active ? 'Seller SMTP activated for consent-based Store email.' : 'Seller SMTP deactivated.');

  if (!data) return <section className="card cardBody" role={error ? 'alert' : 'status'}>{error || 'Loading Store integrations…'}{error && <button onClick={() => { setError(''); void load().catch(cause => setError((cause as Error).message)); }}>Retry</button>}</section>;
  return <div className="sellerStoreIntegrations">
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    {data.platformAdminOverride && <p className="notice" role="status">Official marketplace Store: all Store Plan premium features are enabled without a subscription.</p>}
    <section className="card cardBody">
      <p className="eyebrow">STORE WEBSITE</p><h2>Custom domain</h2>
      <p>{data.notes.customDomain}</p>
      {!data.customDomain.eligible ? <p className="notice">Custom domains require a paid Store Plan with the custom-domain entitlement enabled. <a href="/seller/plan">Review Store plans</a>.</p> : !data.customDomain.targetConfigured ? <p className="notice">The marketplace hosting administrator has not configured a DNS target yet. Domain setup is unavailable until that is set up.</p> : <>
        <label>Your domain or subdomain<input value={domainInput} onChange={event => setDomainInput(event.target.value)} placeholder="shop.example.com" autoComplete="url" /></label>
        <button className="primary" disabled={busy || domainInput.trim().length < 3} onClick={addDomain}>{data.customDomain.domain ? 'Save / replace domain' : 'Add domain'}</button>
        {data.customDomain.domain && <div className="setting"><div><strong>{data.customDomain.domain.domain}</strong><p>Status: {data.customDomain.domain.status.replaceAll('_', ' ')}{data.customDomain.domain.verifiedAt ? ` · verified ${new Date(data.customDomain.domain.verifiedAt).toLocaleString()}` : ''}</p><p>Required CNAME target: {data.customDomain.domain.cnameTarget}</p></div><button disabled={busy} onClick={verifyDomain}>Verify DNS</button><button disabled={busy} onClick={rotateDomainToken}>Show fresh DNS records</button><button disabled={busy} onClick={removeDomain}>Remove</button></div>}
        {records.length > 0 && <div className="table" aria-label="DNS records to add">{records.map(record => <div className="row" key={`${record.type}:${record.host}`}><strong>{record.type}</strong><span>{record.host}</span><code>{record.value}</code></div>)}</div>}
        <p className="muted">After DNS is verified, add the hostname in your web-hosting dashboard and wait for its HTTPS certificate. Until the hosting provider routes the hostname and enables TLS, do not share it as a live Store website.</p>
      </>}
    </section>

    <section className="card cardBody">
      <p className="eyebrow">STORE EMAIL</p><h2>Connect an SMTP provider</h2>
      <p>{data.notes.email}</p>
      {!data.email.eligible ? <p className="notice">Seller SMTP requires a paid Store Plan with email marketing enabled. <a href="/seller/plan">Review Store plans</a>.</p> : <>
        <p className="statusPill">{data.email.active ? `Active: ${data.email.provider}` : data.email.provider ? 'Saved, not active' : 'No seller SMTP configured'}</p>
        <label>Email provider<select value={selectedProvider} onChange={event => setSelectedProvider(event.target.value)}>{data.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
        <div className="two"><label>SMTP hostname<input required value={smtp.host} onChange={event => setSmtp({ ...smtp, host: event.target.value })} placeholder="smtp.example.com" autoComplete="off" /></label><label>Port<input required type="number" min="1" max="65535" value={smtp.port} onChange={event => setSmtp({ ...smtp, port: Number(event.target.value) })} /></label></div>
        <div className="two"><label>SMTP username / API key<input value={smtp.username} onChange={event => setSmtp({ ...smtp, username: event.target.value })} placeholder={data.email.usernameConfigured ? 'Saved — leave blank to keep it' : 'Provider SMTP username'} autoComplete="off" /></label><label>SMTP password / API credential<input type="password" value={smtp.password} onChange={event => setSmtp({ ...smtp, password: event.target.value })} placeholder={data.email.credentialUnreadable ? 'Re-enter required credential' : data.email.passwordConfigured ? 'Saved — leave blank to keep it' : 'SMTP password or credential'} autoComplete="new-password" /></label></div>
        <div className="two"><label>Sender name<input required maxLength={120} value={smtp.senderName} onChange={event => setSmtp({ ...smtp, senderName: event.target.value })} /></label><label>Sender email<input required type="email" maxLength={320} value={smtp.senderEmail} onChange={event => setSmtp({ ...smtp, senderEmail: event.target.value })} placeholder="updates@yourdomain.com" /></label></div>
        <div className="two"><label>Reply-to email (optional)<input type="email" value={smtp.replyTo} onChange={event => setSmtp({ ...smtp, replyTo: event.target.value })} /></label><label>Reason for this change<input required minLength={5} maxLength={500} value={smtp.reason} onChange={event => setSmtp({ ...smtp, reason: event.target.value })} /></label></div>
        <div className="two"><label className="checkRow"><input type="checkbox" checked={smtp.secure} onChange={event => setSmtp({ ...smtp, secure: event.target.checked, requireTls: event.target.checked ? false : smtp.requireTls })} />Implicit TLS (typically port 465)</label><label className="checkRow"><input type="checkbox" checked={smtp.requireTls} disabled={smtp.secure} onChange={event => setSmtp({ ...smtp, requireTls: event.target.checked })} />Require STARTTLS</label></div>
        <div className="toolbar"><button disabled={busy || !smtp.host || !smtp.senderEmail || smtp.reason.trim().length < 5} onClick={saveSmtp}>Save provider</button><button disabled={busy || !data.email.provider} onClick={testSmtp}>Test connection</button><button className="primary" disabled={busy || !data.email.verifiedAt || Date.now() - Date.parse(data.email.verifiedAt) >= 24 * 60 * 60_000} onClick={() => setSmtpActive(true)}>Activate</button>{data.email.active && <button disabled={busy} onClick={() => setSmtpActive(false)}>Deactivate</button>}</div>
        <p className="muted">Connection tests do not send mail. Credentials are encrypted at rest. Provider verification expires after 24 hours. Zoho may require an app-specific password and a region-specific server. Configure SPF, DKIM, and DMARC with your provider before sending campaigns.</p>
      </>}
    </section>
  </div>;
}
