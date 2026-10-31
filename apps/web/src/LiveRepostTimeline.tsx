import React, { useCallback, useEffect, useState } from 'react';
import { useSession } from './session.js';
import { LiveSession } from './LiveShopping.js';

type Repost = { repostedAt: string; session: LiveSession };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Your profile activity could not be loaded.');
  return body as T;
}

export function LiveRepostTimeline() {
  const { user } = useSession();
  const [items, setItems] = useState<Repost[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!user) { setItems([]); setLoading(false); return; }
    try { setItems(await request<Repost[]>('/api/account/live-reposts')); setError(''); }
    catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  }, [user?.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    window.addEventListener('marketplace:live-reposts-changed', load);
    return () => window.removeEventListener('marketplace:live-reposts-changed', load);
  }, [load]);

  const unrepost = async (sessionId: string) => {
    if (busyId) return;
    setBusyId(sessionId); setError('');
    try {
      await request(`/api/live-sessions/${encodeURIComponent(sessionId)}/repost`, { method: 'DELETE' });
      setItems(current => current.filter(item => item.session.id !== sessionId));
      window.dispatchEvent(new CustomEvent('marketplace:live-reposts-changed', { detail: { sessionId } }));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusyId(''); }
  };

  return <section className="liveRepostTimeline" aria-labelledby="live-reposts-heading">
    <div className="sectionHeading"><div><p className="eyebrow">Profile activity</p><h3 id="live-reposts-heading">Live shows you reposted</h3><p className="muted">Only you can manage this activity list. Shows are hidden here if the seller removes them or makes a replay private.</p></div><button type="button" onClick={() => { setLoading(true); void load(); }}>Refresh</button></div>
    {error && <p className="notice" role="alert">{error} <button type="button" onClick={() => { setLoading(true); void load(); }}>Retry</button></p>}
    {loading && <div className="empty" role="status">Loading profile activity…</div>}
    {!loading && !error && items.length === 0 && <div className="empty">Your reposted live shows will appear here.</div>}
    {!loading && items.length > 0 && <div className="liveRepostTimelineList">{items.map(({ session, repostedAt }) => <article className="liveRepostTimelineCard" key={session.id}>
      <div><p className="eyebrow">{session.status === 'LIVE' ? 'Live now' : 'Published replay'} · {session.seller?.store?.name ?? 'Independent store'}</p><h4><a href={`/live/${encodeURIComponent(session.id)}`}>{session.title}</a></h4><small>Reposted {new Date(repostedAt).toLocaleString()}</small></div>
      <div className="liveRepostTimelineActions"><a href={`/live/${encodeURIComponent(session.id)}`}>Open show</a><button type="button" disabled={busyId === session.id} onClick={() => void unrepost(session.id)}>{busyId === session.id ? 'Removing…' : 'Unrepost'}</button></div>
    </article>)}</div>}
  </section>;
}
