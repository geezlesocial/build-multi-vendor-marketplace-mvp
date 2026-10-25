import React, { useEffect, useState } from 'react';

type CredentialStatus = { key: string; referenceConfigured: boolean; referenceType: string; maskedReference: string | null; runtimeValuePresent: boolean };
type ProviderConfiguration = { id: string; provider: 'STRIPE' | 'PAYPAL'; context: 'MARKETPLACE_CHECKOUT' | 'WALLET_FUNDING'; environment: 'SANDBOX' | 'LIVE'; name: string; enabled: boolean; archivedAt: string | null; lastCheckedAt: string | null; readiness: { ready: boolean; code: string; message: string; credentials: CredentialStatus[] }; credentialReferences: CredentialStatus[] };
type PaymentMethod = { method: 'STRIPE' | 'PAYPAL' | 'COD' | 'POS'; enabled: boolean };
type IntegrationData = { configurations: ProviderConfiguration[]; paymentMethods: PaymentMethod[]; liveConfigurationGate: boolean; storeBillingSandbox: { enabled: boolean; liveBillingEnabled: false }; notes: { secrets: string; checkout: string; wallet: string; storeBilling: string } };
type Provider = 'STRIPE' | 'PAYPAL';
type Context = 'MARKETPLACE_CHECKOUT' | 'WALLET_FUNDING';
type ReferenceField = 'apiSecret' | 'webhookSecret' | 'clientId' | 'clientSecret' | 'webhookId';

const fieldsFor = (provider: Provider, context: Context): ReferenceField[] => context === 'WALLET_FUNDING' || provider === 'STRIPE' ? ['apiSecret', 'webhookSecret'] : ['clientId', 'clientSecret', 'webhookId'];
const envNames: Record<ReferenceField, string> = { apiSecret: 'STRIPE_SECRET_KEY', webhookSecret: 'STRIPE_WEBHOOK_SECRET', clientId: 'PAYPAL_CLIENT_ID', clientSecret: 'PAYPAL_CLIENT_SECRET', webhookId: 'PAYPAL_WEBHOOK_ID' };
const title = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/(^| )\w/g, part => part.toUpperCase());

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

const blankForm = () => ({ provider: 'STRIPE' as Provider, context: 'MARKETPLACE_CHECKOUT' as Context, environment: 'SANDBOX' as 'SANDBOX' | 'LIVE', name: 'Stripe buyer checkout', references: {} as Partial<Record<ReferenceField, string>>, reason: '' });

export function AdminIntegrations({ section = 'providers' }: { section?: 'providers' | 'methods' }) {
  const [data, setData] = useState<IntegrationData | null>(null);
  const [form, setForm] = useState(blankForm);
  const [reason, setReason] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editName, setEditName] = useState('');
  const [editReferences, setEditReferences] = useState<Partial<Record<ReferenceField, string>>>({});
  const [removeReferences, setRemoveReferences] = useState<ReferenceField[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => setData(await api<IntegrationData>('/api/admin/integrations'));
  useEffect(() => { load().catch(error => setMessage(error.message)).finally(() => setLoading(false)); }, []);
  const perform = async (work: () => Promise<unknown>, success: string) => {
    setSaving(true); setMessage('');
    try { await work(); await load(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save integration settings.'); }
    finally { setSaving(false); }
  };
  const requiredFields = fieldsFor(form.provider, form.context);
  const create = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.reason.trim()) { setMessage('Enter a reason for this configuration change.'); return; }
    const references = Object.fromEntries(Object.entries(form.references).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value!.trim()]));
    void perform(() => api('/api/admin/integrations', { method: 'POST', body: JSON.stringify({ provider: form.provider, context: form.context, environment: form.environment, name: form.name, credentialReferences: references, reason: form.reason }) }), 'Provider configuration saved. No provider call was made.');
  };
  const saveEdit = (event: React.FormEvent<HTMLFormElement>, item: ProviderConfiguration) => {
    event.preventDefault();
    if (!reason.trim()) { setMessage('Enter a reason for this configuration change.'); return; }
    const references: Record<string, string | null> = Object.fromEntries(Object.entries(editReferences).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value!.trim()]));
    for (const key of removeReferences) references[key] = null;
    void perform(() => api(`/api/admin/integrations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ name: editName, ...(Object.keys(references).length ? { credentialReferences: references } : {}), reason }) }), 'Configuration updated. Reference values were not returned or written to audit history.');
    setEditingId(''); setRemoveReferences([]); setEditReferences({});
  };
  const changeEnabled = (item: ProviderConfiguration, enabled: boolean) => {
    if (!reason.trim()) { setMessage('Enter a reason before changing a provider configuration.'); return; }
    void perform(() => api(`/api/admin/integrations/${item.id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled, reason }) }), enabled ? 'Configuration enabled. Financial feature switches remain separate.' : 'Configuration disabled.');
  };
  const archive = (item: ProviderConfiguration) => {
    if (!reason.trim()) { setMessage('Enter a reason before archiving a provider configuration.'); return; }
    if (!window.confirm(`Archive ${item.name}? Its history will be retained, and it cannot be re-enabled.`)) return;
    void perform(() => api(`/api/admin/integrations/${item.id}/archive`, { method: 'POST', body: JSON.stringify({ reason }) }), 'Configuration archived and retained for audit.');
  };
  const changeMethod = (method: PaymentMethod['method'], enabled: boolean) => {
    if (!reason.trim()) { setMessage('Enter a reason before changing a payment-method switch.'); return; }
    if (!window.confirm(`${enabled ? 'Enable' : 'Disable'} ${method} for new marketplace transactions? Existing records are preserved.`)) return;
    void perform(() => api(`/api/admin/integrations/payment-methods/${method}`, { method: 'PATCH', body: JSON.stringify({ enabled, reason }) }), `${method} payment-method setting updated.`);
  };

  if (loading) return <p className="empty" role="status">Loading integrations and payment methods…</p>;
  if (!data) return <div className="notice" role="alert">{message || 'Integrations could not be loaded.'}</div>;
  return <section className="adminIntegrations">
    <h2>{section === 'providers' ? 'Provider configurations' : 'Buyer payment methods'}</h2>
    <p className="muted">{section === 'providers' ? 'Manage platform integration references. Configuration state does not call a provider or activate checkout.' : 'Manage existing server-enforced buyer checkout switches. Provider configuration is managed separately.'}</p>
    {message && <p className="notice" role="status" aria-live="polite">{message}</p>}
    <label className="integrationReason">Reason for administrative changes<input value={reason} minLength={3} maxLength={500} onChange={event => setReason(event.target.value)} /></label>

    {section === 'providers' && <><section className="card cardBody" aria-labelledby="provider-config-title">
      <h3 id="provider-config-title">Platform provider configurations</h3>
      <p className="muted">Only implemented adapters are offered: Stripe and PayPal for marketplace buyer checkout, and Stripe for wallet funding. Store subscriptions, seller-owned accounts, and external seller payout adapters are not configured here.</p>
      <p className="notice" role="note">Credential fields accept environment-variable names or secret-manager references only. The application never stores a credential value. Runtime secret injection and provider connectivity are not tested here.</p>
      <p>Live configuration gate: <strong>{data.liveConfigurationGate ? 'Permitted by deployment configuration' : 'Blocked (default)'}</strong>. Matching mode and credential presence is not provider verification; live buyer payment activation remains server-blocked in this increment.</p>
      {data.configurations.length === 0 ? <div className="empty">No provider configurations have been recorded.</div> : <div className="settings">{data.configurations.map(item => <article className="card cardBody providerConfigurationCard" key={item.id}>
        <header><div><p className="eyebrow">{title(item.context)} · {item.environment}</p><h4>{item.name}</h4><p>{item.provider} · Configuration {item.enabled ? 'enabled' : 'disabled'}</p></div><span className={item.readiness.ready ? 'statusReady' : 'statusBlocked'}>{item.readiness.code}</span></header>
        <p>{item.readiness.message}</p>
        <ul className="credentialReferenceList">{item.credentialReferences.map(credential => <li key={credential.key}><strong>{title(credential.key)}</strong>: {credential.referenceConfigured ? `${credential.referenceType.toLowerCase().replace('_', ' ')} reference ${credential.maskedReference}` : 'reference missing'} · runtime value {credential.runtimeValuePresent ? 'present and mode-matched' : 'missing or mode-mismatched'}</li>)}</ul>
        {item.lastCheckedAt && <p className="muted">Local configuration check: {new Date(item.lastCheckedAt).toLocaleString()}. No provider request was made.</p>}
        {editingId === item.id ? <form className="integrationEditForm" onSubmit={event => saveEdit(event, item)}>
          <label>Configuration name<input required minLength={2} maxLength={80} value={editName} onChange={event => setEditName(event.target.value)} /></label>
          <fieldset><legend>Replace references only (never enter secret values)</legend>{item.credentialReferences.map(credential => <div key={credential.key}>
            <label>{title(credential.key)} reference<input disabled={item.enabled} autoComplete="off" value={editReferences[credential.key as ReferenceField] ?? ''} placeholder={credential.maskedReference ?? `env:${envNames[credential.key as ReferenceField]}`} onChange={event => setEditReferences({ ...editReferences, [credential.key]: event.target.value })} /></label>
            {credential.referenceConfigured && <label className="storePlanCheck"><input type="checkbox" disabled={item.enabled} checked={removeReferences.includes(credential.key as ReferenceField)} onChange={event => setRemoveReferences(event.target.checked ? [...removeReferences, credential.key as ReferenceField] : removeReferences.filter(key => key !== credential.key))} />Remove this saved reference</label>}
          </div>)}</fieldset>
          <button className="primary" disabled={saving}>Save configuration changes</button><button type="button" onClick={() => setEditingId('')}>Cancel</button>
        </form> : <div className="toolbar">
          <button type="button" onClick={() => { setEditingId(item.id); setEditName(item.name); setEditReferences({}); setRemoveReferences([]); }}>Edit references</button>
          <button type="button" disabled={saving || (!item.enabled && !item.readiness.ready)} onClick={() => changeEnabled(item, !item.enabled)}>{item.enabled ? 'Disable configuration' : 'Enable configuration'}</button>
          <button type="button" disabled={saving} onClick={() => archive(item)}>Archive</button>
        </div>}
      </article>)}</div>}
      <form className="card cardBody providerConfigurationForm" onSubmit={create}>
        <h4>Add a provider configuration</h4>
        <div className="storePlanNumberGrid">
          <label>Context<select value={form.context} onChange={event => { const context = event.target.value as Context; const provider = context === 'WALLET_FUNDING' ? 'STRIPE' : form.provider; setForm({ ...form, context, provider, references: {} }); }}><option value="MARKETPLACE_CHECKOUT">Marketplace buyer checkout</option><option value="WALLET_FUNDING">Wallet funding (hard-gated)</option></select></label>
          <label>Provider<select value={form.provider} disabled={form.context === 'WALLET_FUNDING'} onChange={event => setForm({ ...form, provider: event.target.value as Provider, references: {} })}><option value="STRIPE">Stripe</option>{form.context === 'MARKETPLACE_CHECKOUT' && <option value="PAYPAL">PayPal</option>}</select></label>
          <label>Environment<select value={form.environment} onChange={event => setForm({ ...form, environment: event.target.value as 'SANDBOX' | 'LIVE' })}><option value="SANDBOX">Sandbox</option><option value="LIVE">Live (deployment-gated)</option></select></label>
          <label>Configuration name<input required minLength={2} maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        </div>
        <fieldset><legend>Credential references (optional until you enable the configuration)</legend>{requiredFields.map(key => <label key={key}>{title(key)} reference<input autoComplete="off" value={form.references[key] ?? ''} placeholder={`env:${envNames[key]} or secret-ref:payments/${form.provider.toLowerCase()}/${key}`} onChange={event => setForm({ ...form, references: { ...form.references, [key]: event.target.value } })} /></label>)}</fieldset>
        <label>Reason<input required minLength={3} maxLength={500} value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} /></label>
        <button className="primary" disabled={saving}>Save disabled configuration</button>
      </form>
    </section>

    <section className="card cardBody"><h3>Other payment contexts</h3><p>{data.notes.checkout}</p><p>{data.notes.wallet}</p><p>{data.notes.storeBilling}</p><p className="muted">Store Plan checkout uses a separate Stripe test-mode-only gate and is disabled by default. It does not reuse buyer checkout, enable live billing, or connect seller payment accounts. Seller-owned provider accounts and Stripe Connect/PayPal Payouts transfers are not implemented by this registry. Wallet and Club Coins hard-disable policy is unchanged.</p></section></>}

    {section === 'methods' && <section className="card cardBody" aria-labelledby="payment-method-title">
      <h3 id="payment-method-title">Buyer checkout payment methods</h3>
      <p className="muted">These switches are the existing server-enforced controls for new Stripe, PayPal, COD, and POS transactions. They remain independent of plan eligibility and provider configuration inventory.</p>
      <div className="settings">{data.paymentMethods.map(item => <div className="setting" key={item.method}><div><strong>{item.method}</strong><p>New transactions: {item.enabled ? 'enabled by marketplace setting' : 'disabled by marketplace setting'}.</p></div><button type="button" disabled={saving} aria-pressed={item.enabled} onClick={() => changeMethod(item.method, !item.enabled)}>{item.enabled ? 'Disable' : 'Enable'}</button></div>)}</div>
      <p><a href="/admin/platform?section=integrations">Manage provider configurations and readiness</a></p>
    </section>}
  </section>;
}
