import React, { useEffect, useState } from 'react';
import { useSession, type SessionUser } from './session.js';

type PreferenceResponse = { preference: { language: 'en' | 'fil'; displayCurrency: string }; availableLanguages: string[]; baseCurrency: string; availableDisplayCurrencies: string[]; fxRatesConfigured: boolean };
type NotificationPreference = { channel: 'IN_APP' | 'EMAIL' | 'WEB_PUSH' | 'ANDROID_PUSH'; category: string; enabled: boolean };
type PersonalizationPreference = { personalizationEnabled: boolean; personalizationConsentAt: string | null };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

function uploadToSignedPost(url: string, fields: Record<string, string>, file: File, progress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = false;
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error('Managed media storage could not be reached. Your current profile photo remains active.'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Managed media storage rejected the upload. Your current profile photo remains active.'));
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    form.append('file', file);
    xhr.send(form);
  });
}

export function Settings() {
  const { user, setUser, refreshUser } = useSession();
  const [preferences, setPreferences] = useState<PreferenceResponse | null>(null);
  const [notifications, setNotifications] = useState<NotificationPreference[]>([]);
  const [personalization, setPersonalization] = useState<PersonalizationPreference>({ personalizationEnabled: false, personalizationConsentAt: null });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [name, setName] = useState(user?.name ?? '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [pendingAvatarId, setPendingAvatarId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [verificationBusy, setVerificationBusy] = useState(false);
  const load = async () => { try { const [pref, notificationPrefs, personalizationPref] = await Promise.all([request<PreferenceResponse>('/api/account/preferences'), request<NotificationPreference[]>('/api/account/notification-preferences'), user ? request<PersonalizationPreference>('/api/account/personalization') : Promise.resolve({ personalizationEnabled: false, personalizationConsentAt: null })]); setPreferences(pref); setNotifications(notificationPrefs); setPersonalization(personalizationPref); } catch (reason) { setError((reason as Error).message); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => { setName(user?.name ?? ''); }, [user?.name]);
  useEffect(() => { if (!photo) { setPreview(''); return undefined; } const url = URL.createObjectURL(photo); setPreview(url); return () => URL.revokeObjectURL(url); }, [photo]);
  const savePreferences = async (body: object) => { try { setPreferences(await request<PreferenceResponse>('/api/account/preferences', { method: 'PATCH', body: JSON.stringify(body) })); setMessage('Preferences saved.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const savePassword = async (event: React.FormEvent) => { event.preventDefault(); try { await request('/api/account/password', { method: 'PATCH', body: JSON.stringify(passwords) }); setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' }); setMessage('Password changed. Other sessions were signed out.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const toggle = async (item: NotificationPreference) => { try { const updated = await request<NotificationPreference>('/api/account/notification-preferences', { method: 'PATCH', body: JSON.stringify({ ...item, enabled: !item.enabled }) }); setNotifications(current => current.some(value => value.channel === item.channel && value.category === item.category) ? current.map(value => value.channel === item.channel && value.category === item.category ? updated : value) : [...current, updated]); } catch (reason) { setError((reason as Error).message); } };
  const togglePersonalization = async () => { try { const updated = await request<PersonalizationPreference>('/api/account/personalization', { method: 'PATCH', body: JSON.stringify({ enabled: !personalization.personalizationEnabled }) }); setPersonalization(updated); setMessage(updated.personalizationEnabled ? 'Personalized recommendations enabled.' : 'Personalization disabled and saved interest signals deleted.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const saveProfile = async (event: React.FormEvent) => { event.preventDefault(); try { const updated = await request<SessionUser>('/api/account/profile', { method: 'PATCH', body: JSON.stringify({ name }) }); setUser(updated); setMessage('Profile saved.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const resendVerification = async () => { setVerificationBusy(true); setError(''); try { const result = await request<{ verified: boolean; message: string }>('/api/auth/email-verification/resend', { method: 'POST', body: '{}' }); setMessage(result.message); await refreshUser(); } catch (reason) { setError((reason as Error).message); } finally { setVerificationBusy(false); } };
  const uploadPhoto = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!photo) { setError('Choose a PNG, JPEG, or WebP image first.'); return; }
    const form = event.currentTarget;
    setUploading(true); setUploadProgress(0); setError(''); setMessage('');
    try {
      const reservation = await request<{ id: string; upload: { url: string; fields: Record<string, string> } }>('/api/account/avatar/uploads', { method: 'POST', body: JSON.stringify({ fileName: photo.name, contentType: photo.type, sizeBytes: photo.size }) });
      await uploadToSignedPost(reservation.upload.url, reservation.upload.fields, photo, setUploadProgress);
      const result = await request<{ id: string; scanStatus: string; message?: string }>(`/api/account/avatar/${encodeURIComponent(reservation.id)}/finalize`, { method: 'POST', body: '{}' });
      const refreshedUser = await refreshUser();
      if (!refreshedUser) throw new Error('The upload completed but your account could not be refreshed. Please reload to confirm the saved photo.');
      form.reset();
      setPhoto(null);
      setPendingAvatarId(result.scanStatus === 'QUARANTINED' ? result.id : null);
      setMessage(result.message ?? (result.scanStatus === 'APPROVED' ? 'Profile photo updated.' : 'Your photo is awaiting the required security scan. Your current photo has been kept.'));
    } catch (reason) { form.reset(); setPhoto(null); setError((reason as Error).message); }
    finally { setUploading(false); setUploadProgress(0); }
  };
  const retryAvatarScan = async () => {
    if (!pendingAvatarId) return;
    setUploading(true); setError(''); setMessage('');
    try {
      const result = await request<{ scanStatus: string; message?: string }>(`/api/account/avatar/${encodeURIComponent(pendingAvatarId)}/scan-retry`, { method: 'POST', body: '{}' });
      if (result.scanStatus === 'APPROVED') { await refreshUser(); setPendingAvatarId(null); }
      setMessage(result.message ?? (result.scanStatus === 'APPROVED' ? 'Profile photo updated.' : 'The photo remains private until malware scanning approves it.'));
    } catch (reason) { setError((reason as Error).message); }
    finally { setUploading(false); }
  };
  const inApp = notifications.find(item => item.channel === 'IN_APP' && item.category === 'orders');
  const emailOrders = notifications.find(item => item.channel === 'EMAIL' && item.category === 'orders');
  const emailSupport = notifications.find(item => item.channel === 'EMAIL' && item.category === 'support');
  const emailAccount = notifications.find(item => item.channel === 'EMAIL' && item.category === 'account');
  if (!preferences && !error) return <section className="page"><h1>Settings</h1><p className="muted" role="status">Loading account settings…</p></section>;
  return <section className="page settingsPage"><p className="eyebrow">Your account</p><h1>{preferences?.preference.language === 'fil' ? 'Mga setting' : 'Settings'}</h1>{message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    {!user ? <div className="empty">Sign in to manage your profile and account settings. <a href="/?auth=login">Sign in</a></div> : <section className="setting profileSettings" id="profile"><div className="profileIdentity"><div className="profileAvatar" aria-label={`${user.name}'s profile photo`}>{preview || user.avatarUrl ? <img src={preview || user.avatarUrl} alt="" /> : <span aria-hidden="true">{user.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toLocaleUpperCase() ?? '').join('')}</span>}</div><div><p className="eyebrow">Profile</p><h2>Photo and display name</h2><p className="muted">Your photo is private to your signed-in account and only replaces the current one after validation and approval.</p></div></div><div className="settingRow"><span><strong>Email verification</strong><small>{user.email} · {user.emailVerifiedAt ? 'Verified' : 'Not verified. Verify your address to submit reviews and qualify for account rewards.'}</small></span>{!user.emailVerifiedAt && <button type="button" disabled={verificationBusy} onClick={() => void resendVerification()}>{verificationBusy ? 'Sending…' : 'Send verification email'}</button>}</div><form className="profileForm" onSubmit={saveProfile}><label>Display name<input value={name} autoComplete="name" minLength={2} maxLength={100} required onChange={event => setName(event.target.value)} /></label><button className="primary">Save name</button></form><form className="avatarUploadForm" onSubmit={uploadPhoto}><label>Profile photo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setPhoto(event.currentTarget.files?.[0] ?? null)} /></label><small>PNG, JPEG, or WebP, up to 5 MB. Upload requires managed private storage and a malware scanner; pending files remain private and do not replace your current photo.</small><div className="avatarUploadActions"><button type="submit" disabled={!photo || uploading}>{uploading ? `Uploading ${uploadProgress}%` : 'Upload photo'}</button>{photo && <button type="button" onClick={() => setPhoto(null)} disabled={uploading}>Cancel selection</button>}{pendingAvatarId && <button type="button" disabled={uploading} onClick={() => void retryAvatarScan()}>Retry malware scan</button>}</div>{uploading && <progress max="100" value={uploadProgress} aria-label="Photo upload progress" />}</form></section>}
    {preferences ? <div className="settingsGrid"><section className="setting settingsCard"><h2>{preferences.preference.language === 'fil' ? 'Wika at pera' : 'Language and currency'}</h2><div className="settingsPreferenceControls"><label>Language<select value={preferences.preference.language} onChange={event => void savePreferences({ language: event.target.value })}>{preferences.availableLanguages.map(language => <option key={language} value={language}>{language === 'fil' ? 'Filipino' : 'English'}</option>)}</select></label><label>Display currency<select value={preferences.preference.displayCurrency} onChange={event => void savePreferences({ displayCurrency: event.target.value })}>{preferences.availableDisplayCurrencies.map(currency => <option key={currency}>{currency}</option>)}</select></label></div><p className="muted">Display-currency totals are estimates based on currently available rates. Checkout, payment capture, and order ledgers remain in the platform base currency: <strong>{preferences.baseCurrency}</strong>. Only administrator-enabled bundled languages are selectable.</p></section>
      <section className="setting settingsCard"><h2>Security</h2><form className="settingsSecurityForm" onSubmit={savePassword}><label>Current password<input type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={event => setPasswords({ ...passwords, currentPassword: event.target.value })} /></label><label>New password<input type="password" autoComplete="new-password" minLength={10} required value={passwords.newPassword} onChange={event => setPasswords({ ...passwords, newPassword: event.target.value })} /></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength={10} required value={passwords.confirmPassword} onChange={event => setPasswords({ ...passwords, confirmPassword: event.target.value })} /></label><button className="primary">Change password</button></form><p className="muted">Changing the password signs out other sessions. MFA and session-management controls are not claimed here.</p></section>
      <section className="setting settingsCard"><h2>Personalization</h2><p>Recommendations may use your product views and selected categories only when you opt in. Stores receive aggregate reporting, not your individual history. Turning this off deletes stored interest signals.</p><div className="settingRow"><span>Use my activity for recommendations</span><button type="button" aria-pressed={personalization.personalizationEnabled} onClick={() => void togglePersonalization()}>{personalization.personalizationEnabled ? 'On' : 'Off'}</button></div></section>
      <section className="setting settingsCard"><h2>Notifications</h2><div className="settingsNotificationContent"><p>Transactional emails use platform SMTP after an administrator configures and verifies it. They go only to verified account addresses; this is separate from Store marketing subscriptions.</p><div className="settingRow"><span>Order updates in the app</span><button aria-pressed={inApp?.enabled !== false} onClick={() => void toggle(inApp ?? { channel: 'IN_APP', category: 'orders', enabled: true })}>{inApp?.enabled === false ? 'Off' : 'On'}</button></div><div className="settingRow"><span>Order and delivery emails</span><button aria-pressed={emailOrders?.enabled !== false} onClick={() => void toggle(emailOrders ?? { channel: 'EMAIL', category: 'orders', enabled: true })}>{emailOrders?.enabled === false ? 'Off' : 'On'}</button></div><div className="settingRow"><span>Support-ticket emails</span><button aria-pressed={emailSupport?.enabled !== false} onClick={() => void toggle(emailSupport ?? { channel: 'EMAIL', category: 'support', enabled: true })}>{emailSupport?.enabled === false ? 'Off' : 'On'}</button></div><div className="settingRow"><span>Account access notices</span><button aria-pressed={emailAccount?.enabled !== false} onClick={() => void toggle(emailAccount ?? { channel: 'EMAIL', category: 'account', enabled: true })}>{emailAccount?.enabled === false ? 'Off' : 'On'}</button></div><p className="muted">Password and email-verification security messages are not controlled by these preferences.</p><a href="/dashboard">Open buyer or seller dashboard</a></div></section>
    </div> : <p className="notice">Account preferences could not be loaded. Your profile remains available above.</p>}
  </section>;
}
