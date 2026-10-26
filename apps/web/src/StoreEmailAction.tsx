import React, { useState } from 'react';

type ActionKind = 'confirm' | 'unsubscribe';

export function StoreEmailAction({ kind }: { kind: ActionKind }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const confirm = kind === 'confirm';
  const submit = async () => {
    if (!token) { setError('This link is incomplete. Request a fresh link from the Store.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/store-email/${confirm ? 'confirm' : 'unsubscribe'}/${encodeURIComponent(token)}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'This link could not be processed.');
      setMessage(body.message ?? (confirm ? 'Your subscription is confirmed.' : 'You have been unsubscribed.'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'This link could not be processed.'); }
    finally { setBusy(false); }
  };
  return <section className="narrow storeEmailAction">
    <p className="eyebrow">Store email preferences</p>
    <h1>{confirm ? 'Confirm your subscription' : 'Unsubscribe from updates'}</h1>
    <p className="muted">{confirm ? 'Confirm only if you asked this Store to send you email updates. The link is single-use and expires after 48 hours.' : 'You can stop optional marketing updates from this Store at any time. This does not affect order or service messages.'}</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {!message && <button className={confirm ? 'primary' : undefined} disabled={busy || !token} onClick={() => void submit()}>{busy ? 'Processing…' : confirm ? 'Confirm email updates' : 'Unsubscribe'}</button>}
    <p><a href="/">Return to the marketplace</a></p>
  </section>;
}
