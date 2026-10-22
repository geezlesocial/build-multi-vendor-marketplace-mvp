import React, { useEffect, useState } from 'react';
import { useSession, type SessionUser } from './session.js';

type PreferenceResponse = { preference: { language: 'en' | 'fil'; displayCurrency: string }; availableLanguages: string[]; baseCurrency: string; availableDisplayCurrencies: string[]; fxRatesConfigured: boolean };
type NotificationPreference = { channel: 'IN_APP' | 'EMAIL' | 'WEB_PUSH' | 'ANDROID_PUSH'; category: string; enabled: boolean };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

export function Settings() {
  const { user, setUser, refreshUser } = useSession();
  const [preferences, setPreferences] = useState<PreferenceResponse | null>(null);
  const [notifications, setNotifications] = useState<NotificationPreference[]>([]);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [name, setName] = useState(user?.name ?? '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => { try { const [pref, notificationPrefs] = await Promise.all([request<PreferenceResponse>('/api/account/preferences'), request<NotificationPreference[]>('/api/account/notification-preferences')]); setPreferences(pref); setNotifications(notificationPrefs); } catch (reason) { setError((reason as Error).message); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => { setName(user?.name ?? ''); }, [user?.name]);
  useEffect(() => { if (!photo) { setPreview(''); return undefined; } const url = URL.createObjectURL(photo); setPreview(url); return () => URL.revokeObjectURL(url); }, [photo]);
  const savePreferences = async (body: object) => { try { setPreferences(await request<PreferenceResponse>('/api/account/preferences', { method: 'PATCH', body: JSON.stringify(body) })); setMessage('Preferences saved.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const savePassword = async (event: React.FormEvent) => { event.preventDefault(); try { await request('/api/account/password', { method: 'PATCH', body: JSON.stringify(passwords) }); setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' }); setMessage('Password changed. Other sessions were signed out.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const toggle = async (item: NotificationPreference) => { try { const updated = await request<NotificationPreference>('/api/account/notification-preferences', { method: 'PATCH', body: JSON.stringify({ ...item, enabled: !item.enabled }) }); setNotifications(current => current.some(value => value.channel === item.channel && value.category === item.category) ? current.map(value => value.channel === item.channel && value.category === item.category ? updated : value) : [...current, updated]); } catch (reason) { setError((reason as Error).message); } };
  const saveProfile = async (event: React.FormEvent) => { event.preventDefault(); try { const updated = await request<SessionUser>('/api/account/profile', { method: 'PATCH', body: JSON.stringify({ name }) }); setUser(updated); setMessage('Profile saved.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const uploadPhoto = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!photo) { setError('Choose a PNG, JPEG, or WebP image first.'); return; }
    setUploading(true); setUploadProgress(0); setError(''); setMessage('');
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    try {
      const result = await new Promise<{ scanStatus: string; message?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/account/avatar');
        xhr.withCredentials = true;
        xhr.responseType = 'json';
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
        xhr.upload.onprogress = progress => { if (progress.lengthComputable) setUploadProgress(Math.round(progress.loaded / progress.total * 100)); };
        xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
        xhr.onload = () => { const body = (xhr.response ?? {}) as { error?: string; message?: string; scanStatus?: string }; if (xhr.status >= 200 && xhr.status < 300) resolve({ scanStatus: body.scanStatus ?? '', message: body.message }); else reject(new Error(body.error ?? 'Profile photo upload failed.')); };
        xhr.send(photo);
      });
      const refreshedUser = await refreshUser();
      if (!refreshedUser) throw new Error('The upload completed but your account could not be refreshed. Please reload to confirm the saved photo.');
      setPhoto(null);
      setMessage(result.message ?? (result.scanStatus === 'APPROVED' ? 'Profile photo updated.' : 'Your photo is awaiting the required security scan. Your current photo has been kept.'));
    } catch (reason) { setError((reason as Error).message); }
    finally { setUploading(false); setUploadProgress(0); }
  };
  const inApp = notifications.find(item => item.channel === 'IN_APP' && item.category === 'orders');
  if (!preferences && !error) return <section className="page"><h1>Settings</h1><p className="muted" role="status">Loading account settings…</p></section>;
  return <section className="page settingsPage"><p className="eyebrow">Your account</p><h1>{preferences?.preference.language === 'fil' ? 'Mga setting' : 'Settings'}</h1>{message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    {!user ? <div className="empty">Sign in to manage your profile and account settings. <a href="/?auth=login">Sign in</a></div> : <section className="setting profileSettings" id="profile"><div className="profileIdentity"><div className="profileAvatar" aria-label={`${user.name}'s profile photo`}>{preview || user.avatarUrl ? <img src={preview || user.avatarUrl} alt="" /> : <span aria-hidden="true">{user.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toLocaleUpperCase() ?? '').join('')}</span>}</div><div><p className="eyebrow">Profile</p><h2>Photo and display name</h2><p className="muted">Your photo is private to your signed-in account and only replaces the current one after validation and approval.</p></div></div><form className="profileForm" onSubmit={saveProfile}><label>Display name<input value={name} autoComplete="name" minLength={2} maxLength={100} required onChange={event => setName(event.target.value)} /></label><button className="primary">Save name</button></form><form className="avatarUploadForm" onSubmit={uploadPhoto}><label>Profile photo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setPhoto(event.currentTarget.files?.[0] ?? null)} /></label><small>PNG, JPEG, or WebP, up to 5 MB. Images are normalized before storage; quarantined uploads are not delivered.</small><div className="avatarUploadActions"><button type="submit" disabled={!photo || uploading}>{uploading ? `Uploading ${uploadProgress}%` : 'Upload photo'}</button>{photo && <button type="button" onClick={() => setPhoto(null)} disabled={uploading}>Cancel selection</button>}</div>{uploading && <progress max="100" value={uploadProgress} aria-label="Photo upload progress" />}</form></section>}
    {preferences ? <div className="settingsGrid"><section className="setting"><h2>{preferences.preference.language === 'fil' ? 'Wika at pera' : 'Language and currency'}</h2><label>Language<select value={preferences.preference.language} onChange={event => void savePreferences({ language: event.target.value })}><option value="en">English</option><option value="fil">Filipino</option></select></label><label>Display currency<select value={preferences.preference.displayCurrency} onChange={event => void savePreferences({ displayCurrency: event.target.value })}>{preferences.availableDisplayCurrencies.map(currency => <option key={currency}>{currency}</option>)}</select></label><p className="muted">Checkout and order ledgers remain in the platform base currency: <strong>{preferences.baseCurrency}</strong>. Other currencies stay unavailable until an administrator configures verified rates; no stale conversion is shown.</p></section>
      <section className="setting"><h2>Security</h2><form onSubmit={savePassword}><label>Current password<input type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={event => setPasswords({ ...passwords, currentPassword: event.target.value })} /></label><label>New password<input type="password" autoComplete="new-password" minLength={10} required value={passwords.newPassword} onChange={event => setPasswords({ ...passwords, newPassword: event.target.value })} /></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength={10} required value={passwords.confirmPassword} onChange={event => setPasswords({ ...passwords, confirmPassword: event.target.value })} /></label><button className="primary">Change password</button></form><p className="muted">Changing the password signs out other sessions. MFA and session-management controls are not claimed here.</p></section>
      <section className="setting"><h2>Notifications</h2><p>In-app preferences are persisted. Email, web-push, and Android delivery remain unavailable until their providers are configured.</p><div className="settingRow"><span>Order updates in the app</span><button onClick={() => void toggle(inApp ?? { channel: 'IN_APP', category: 'orders', enabled: true })}>{inApp?.enabled === false ? 'Off' : 'On'}</button></div><a href="/dashboard">Open buyer or seller dashboard</a></section>
    </div> : <p className="notice">Account preferences could not be loaded. Your profile remains available above.</p>}
  </section>;
}
