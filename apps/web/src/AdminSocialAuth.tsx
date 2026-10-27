import React, { useEffect, useState } from 'react';
import { BrandingImageControl } from './BrandingImageControl.js';

type Provider = { id: string; label: string; enabled: boolean; configured: boolean; clientId: string; clientIdMasked: string | null; clientSecretConfigured: boolean; issuerUrl: string; logoUrl: string; callbackUrl: string; requiresIssuer: boolean };
type AuthPage = { id?: string; signInHeading: string; signInText: string; signUpHeading: string; signUpText: string; logoMediaId: string | null; layout: 'CENTERED' | 'SPLIT' | 'EDITORIAL'; motion: 'NONE' | 'FADE' | 'SLIDE'; accentColor: string };
const defaultPage: AuthPage = { signInHeading: 'Sign in', signInText: 'Welcome back. Sign in to continue.', signUpHeading: 'Create account', signUpText: 'Join the marketplace and discover independent stores.', logoMediaId: null, layout: 'CENTERED', motion: 'FADE', accentColor: '#315d47' };
const providerHelp: Record<string, string> = {
  GOOGLE: 'Create a Web OAuth client in Google Cloud. Add the callback URL shown here as an authorized redirect URI. Request openid, email, and profile.',
  LINKEDIN: 'Create a LinkedIn app and request the “Sign In with LinkedIn using OpenID Connect” product. Add the exact callback URL and request openid, profile, and email.',
  FACEBOOK: 'Create a Facebook Login app, add this exact callback URL to Valid OAuth Redirect URIs, and enable public_profile and email permissions.',
  X: 'Create an X OAuth 2.0 Web App. Register this callback and request tweet.read, users.read, and users.email; enable email access in the X developer console.',
  SCROLITH: 'No public Scrolith developer/API or OIDC documentation was found. Keep disabled until Scrolith provides its official issuer URL and confirms third-party OIDC sign-in.'
};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function AdminSocialAuth() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [page, setPage] = useState<AuthPage>(defaultPage);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const [providerResult, pageResult] = await Promise.all([
      api<{ providers: Provider[] }>('/api/admin/auth/social/providers'),
      api<AuthPage>('/api/admin/auth/presentation')
    ]);
    setProviders(providerResult.providers);
    setPage(pageResult);
  };
  useEffect(() => { void load().catch(error => setMessage(error.message)).finally(() => setLoading(false)); }, []);

  const saveProvider = async (event: React.FormEvent<HTMLFormElement>, provider: Provider) => {
    event.preventDefault(); setBusy(provider.id); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/admin/auth/social/providers/${provider.id.toLowerCase()}`, { method: 'PUT', body: JSON.stringify({
        clientId: String(form.get('clientId') ?? ''), clientSecret: secrets[provider.id] ?? '', issuerUrl: String(form.get('issuerUrl') ?? ''),
        logoUrl: String(form.get('logoUrl') ?? ''), enabled: form.get('enabled') === 'on'
      }) });
      setSecrets(current => ({ ...current, [provider.id]: '' }));
      await load();
      setMessage(`${provider.label} settings saved and refreshed from the server.`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(null); }
  };

  const savePage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy('page'); setMessage('');
    try {
      const saved = await api<AuthPage>('/api/admin/auth/presentation', { method: 'PUT', body: JSON.stringify({ signInHeading: page.signInHeading, signInText: page.signInText, signUpHeading: page.signUpHeading, signUpText: page.signUpText, logoMediaId: page.logoMediaId, layout: page.layout, motion: page.motion, accentColor: page.accentColor }) });
      setPage(saved);
      setMessage('Sign-in and sign-up appearance saved and active immediately.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(null); }
  };

  if (loading) return <section><p className="muted">Loading sign-in settings…</p></section>;
  return <section className="adminSocialAuth">
    <div className="sectionHeading"><div><p className="eyebrow">Members and security</p><h2>Sign-in &amp; social login</h2><p className="muted">Provider credentials are encrypted by the API and never returned to the browser. Activating a provider adds its button to both account entry modes.</p></div></div>
    {message && <p className="notice" role="status">{message}</p>}

    <section className="card cardBody"><h3>Sign-in and sign-up appearance</h3><p className="muted">Changes are saved immediately. The logo must be an approved platform image; layout motion respects the visitor’s reduced-motion preference.</p>
      <form className="authAdminForm" onSubmit={event => void savePage(event)}>
        <div className="two"><label>Sign-in heading<input maxLength={100} value={page.signInHeading} onChange={event => setPage({ ...page, signInHeading: event.target.value })} required /></label><label>Sign-up heading<input maxLength={100} value={page.signUpHeading} onChange={event => setPage({ ...page, signUpHeading: event.target.value })} required /></label></div>
        <div className="two"><label>Sign-in supporting text<textarea maxLength={240} value={page.signInText} onChange={event => setPage({ ...page, signInText: event.target.value })} /></label><label>Sign-up supporting text<textarea maxLength={240} value={page.signUpText} onChange={event => setPage({ ...page, signUpText: event.target.value })} /></label></div>
        <div className="two"><label>Page layout<select value={page.layout} onChange={event => setPage({ ...page, layout: event.target.value as AuthPage['layout'] })}><option value="CENTERED">Centered card</option><option value="SPLIT">Split editorial</option><option value="EDITORIAL">Minimal editorial</option></select></label><label>Motion style<select value={page.motion} onChange={event => setPage({ ...page, motion: event.target.value as AuthPage['motion'] })}><option value="NONE">None</option><option value="FADE">Subtle fade</option><option value="SLIDE">Subtle slide</option></select></label></div>
        <label>Accent color<input type="color" value={page.accentColor} onChange={event => setPage({ ...page, accentColor: event.target.value })} /></label>
        <BrandingImageControl label="Sign-in page logo" ratio={3} value={page.logoMediaId} publishedValue={page.logoMediaId} onChange={logoMediaId => setPage({ ...page, logoMediaId })} listUrl="/api/admin/platform/branding-media" uploadUrl="/api/admin/platform/branding-media/uploads" previewUrl={id => `/api/admin/platform/branding-media/${encodeURIComponent(id)}/preview`} />
        <button className="primary" disabled={busy !== null}>{busy === 'page' ? 'Saving…' : 'Save sign-in appearance'}</button>
      </form>
    </section>

    <div className="adminSocialProviderList"><h3>Social account providers</h3><p className="muted">For each provider, register the callback URI shown below in that provider’s developer console. Local testing works over localhost; hosted production callbacks must use HTTPS and match exactly.</p>
      {providers.map(provider => <article className="card cardBody adminSocialProvider" key={provider.id}>
        <header><div><p className="eyebrow">{provider.id === 'SCROLITH' ? 'OIDC adapter · documentation pending' : 'OAuth sign-in'}</p><h3>{provider.label}</h3></div><span className={provider.enabled && provider.configured ? 'authAdminStatus active' : 'authAdminStatus'}>{provider.enabled && provider.configured ? 'Active' : provider.configured ? 'Configured · off' : 'Not configured'}</span></header>
        <p className="muted">{providerHelp[provider.id]}</p>
        <form className="authAdminForm" onSubmit={event => void saveProvider(event, provider)}>
          <div className="two"><label>OAuth client ID<input name="clientId" autoComplete="off" defaultValue={provider.clientId} required /></label><label>OAuth client secret<input type="password" autoComplete="new-password" value={secrets[provider.id] ?? ''} onChange={event => setSecrets({ ...secrets, [provider.id]: event.target.value })} placeholder={provider.clientSecretConfigured ? 'Saved securely — leave blank to keep' : 'Enter the provider client secret'} required={!provider.clientSecretConfigured} /></label></div>
          {provider.requiresIssuer && <label>Official Scrolith OIDC issuer URL<input name="issuerUrl" type="url" defaultValue={provider.issuerUrl} placeholder="https://issuer.scrolith.com" /><small>Only an HTTPS issuer on the scrolith.com domain is accepted. The server verifies the OIDC discovery document before activation.</small></label>}
          <label>Provider logo URL (optional)<input name="logoUrl" type="url" defaultValue={provider.logoUrl} placeholder="https://…" /><small>Use an HTTPS logo URL; leave empty to show the built-in accessible mark.</small></label>
          <label className="authAdminCallback">Callback URL to register<input readOnly value={provider.callbackUrl} onFocus={event => event.currentTarget.select()} /><small>Copy this exact URL into the provider’s allowed redirect/callback list.</small></label>
          <label className="authAdminEnable"><input type="checkbox" name="enabled" defaultChecked={provider.enabled} /> Enable {provider.label} sign-in</label>
          <button className="primary" disabled={busy !== null}>{busy === provider.id ? 'Saving…' : 'Save provider settings'}</button>
        </form>
      </article>)}
    </div>
    <p className="muted">New social accounts are created as buyers. Provider email claims are verified before they can be used to link to an existing account. Password and email sign-in remain available.</p>
  </section>;
}
