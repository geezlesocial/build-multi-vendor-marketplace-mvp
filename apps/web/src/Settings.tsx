import React, { useEffect, useState } from 'react';

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
  const [preferences, setPreferences] = useState<PreferenceResponse | null>(null);
  const [notifications, setNotifications] = useState<NotificationPreference[]>([]);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => { try { const [pref, notificationPrefs] = await Promise.all([request<PreferenceResponse>('/api/account/preferences'), request<NotificationPreference[]>('/api/account/notification-preferences')]); setPreferences(pref); setNotifications(notificationPrefs); } catch (reason) { setError((reason as Error).message); } };
  useEffect(() => { void load(); }, []);
  const savePreferences = async (body: object) => { try { setPreferences(await request<PreferenceResponse>('/api/account/preferences', { method: 'PATCH', body: JSON.stringify(body) })); setMessage('Preferences saved.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const savePassword = async (event: React.FormEvent) => { event.preventDefault(); try { await request('/api/account/password', { method: 'PATCH', body: JSON.stringify(passwords) }); setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' }); setMessage('Password changed. Other sessions were signed out.'); setError(''); } catch (reason) { setError((reason as Error).message); } };
  const toggle = async (item: NotificationPreference) => { try { const updated = await request<NotificationPreference>('/api/account/notification-preferences', { method: 'PATCH', body: JSON.stringify({ ...item, enabled: !item.enabled }) }); setNotifications(current => current.some(value => value.channel === item.channel && value.category === item.category) ? current.map(value => value.channel === item.channel && value.category === item.category ? updated : value) : [...current, updated]); } catch (reason) { setError((reason as Error).message); } };
  if (!preferences) return <section className="page"><h1>Settings</h1><p className={error ? 'notice' : 'muted'}>{error || 'Loading settings…'}</p></section>;
  const inApp = notifications.find(item => item.channel === 'IN_APP' && item.category === 'orders');
  return <section className="page settingsPage"><p className="eyebrow">Your account</p><h1>{preferences.preference.language === 'fil' ? 'Mga setting' : 'Settings'}</h1>{message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    <div className="settingsGrid"><section className="setting"><h2>{preferences.preference.language === 'fil' ? 'Wika at pera' : 'Language and currency'}</h2><label>Language<select value={preferences.preference.language} onChange={event => void savePreferences({ language: event.target.value })}><option value="en">English</option><option value="fil">Filipino</option></select></label><label>Display currency<select value={preferences.preference.displayCurrency} onChange={event => void savePreferences({ displayCurrency: event.target.value })}>{preferences.availableDisplayCurrencies.map(currency => <option key={currency}>{currency}</option>)}</select></label><p className="muted">Checkout and order ledgers remain in the platform base currency: <strong>{preferences.baseCurrency}</strong>. Other currencies stay unavailable until an administrator configures verified rates; no stale conversion is shown.</p></section>
      <section className="setting"><h2>Security</h2><form onSubmit={savePassword}><label>Current password<input type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={event => setPasswords({ ...passwords, currentPassword: event.target.value })} /></label><label>New password<input type="password" autoComplete="new-password" minLength={10} required value={passwords.newPassword} onChange={event => setPasswords({ ...passwords, newPassword: event.target.value })} /></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength={10} required value={passwords.confirmPassword} onChange={event => setPasswords({ ...passwords, confirmPassword: event.target.value })} /></label><button className="primary">Change password</button></form><p className="muted">Changing the password signs out other sessions. MFA and session-management controls are not claimed here.</p></section>
      <section className="setting"><h2>Notifications</h2><p>In-app preferences are persisted. Email, web-push, and Android delivery remain unavailable until their providers are configured.</p><div className="settingRow"><span>Order updates in the app</span><button onClick={() => void toggle(inApp ?? { channel: 'IN_APP', category: 'orders', enabled: true })}>{inApp?.enabled === false ? 'Off' : 'On'}</button></div><a href="/dashboard">Open buyer or seller dashboard</a></section>
    </div>
  </section>;
}
