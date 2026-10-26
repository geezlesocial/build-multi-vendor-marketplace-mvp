import React, { useState } from 'react';
import { useSession } from './session.js';

export function EmailVerificationAction() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const { refreshUser } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    if (!/^[a-f0-9]{64}$/i.test(token)) { setError('This verification link is incomplete. Request a fresh link from account settings.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/auth/verify-email', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'This verification link could not be processed.');
      await refreshUser();
      setMessage(body.message ?? 'Your email address is verified.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'This verification link could not be processed.'); }
    finally { setBusy(false); }
  };
  return <section className="narrow storeEmailAction">
    <p className="eyebrow">Account security</p><h1>Verify your email</h1>
    <p className="muted">Verification links are single-use and expire after 24 hours. Email verification is required before submitting a product review or earning the account-verification reward.</p>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    {!message && <button className="primary" disabled={busy || !token} onClick={() => void submit()}>{busy ? 'Verifying…' : 'Verify email address'}</button>}
    <p><a href="/settings#profile">Account settings</a> · <a href="/">Return to marketplace</a></p>
  </section>;
}
