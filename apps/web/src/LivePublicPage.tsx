import React, { useEffect, useState } from 'react';
import { LiveKitViewer, LiveWatchModal, type LiveSession } from './LiveShopping.js';
import { LiveSocialActions } from './LiveSocialActions.js';
import { useSession } from './session.js';
import './LiveShopping.css';
import './LiveSocial.css';

async function loadPublicSession(sessionId: string) {
  const response = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'This live show is not available.');
  return body as LiveSession;
}

function useLiveSession(sessionId: string) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void loadPublicSession(sessionId).then(value => { if (active) setSession(value); })
      .catch(reason => { if (active) setError((reason as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId]);
  return { session, error, loading };
}

export function LivePublicPage({ sessionId }: { sessionId: string }) {
  const { user } = useSession();
  const { session, error, loading } = useLiveSession(sessionId);
  useEffect(() => {
    if (!session) return;
    const previousTitle = document.title;
    document.title = `${session.title} · Live Shopping`;
    return () => { document.title = previousTitle; };
  }, [session?.id, session?.title]);

  if (loading) return <main className="livePublicStatus" role="status"><span className="homeLiveDot" />Loading this live show…</main>;
  if (error || !session) return <main className="livePublicStatus"><p className="eyebrow">Live shopping</p><h1>This show isn’t available</h1><p className="notice" role="alert">{error || 'The live show may have ended or been unpublished.'}</p><a className="primary" href="/">Return to Market Lane</a></main>;
  if (session.status === 'LIVE' && session.realtimeAvailable) {
    return <LiveWatchModal sessions={[session]} canEarn={Boolean(user?.emailVerifiedAt)} canReact={Boolean(user)} onClose={() => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/');
    }} />;
  }
  if (session.status === 'ENDED' && session.replayAvailable && session.replayUrl) {
    return <main className="livePublicReplayPage">
      <p className="livePublicReplayMeta">Live replay · {session.seller?.store?.name ?? 'Market Lane'}</p>
      <section className="livePublicReplayCard">
        <p className="eyebrow">Published replay · {session.seller?.store?.name ?? 'Independent store'}</p>
        <h1>{session.title}</h1>
        {session.description && <p className="muted">{session.description}</p>}
        <video className="liveReplayPlayer" controls preload="metadata" playsInline src={session.replayUrl}>Your browser does not support replay video.</video>
        <LiveSocialActions sessionId={session.id} title={session.title} />
        {!!session.products?.length && <div className="liveProductRail" aria-label="Products linked to this replay">{session.products.map(link => link.product && <a className="liveProductLink" key={link.productId} href={`/products/${encodeURIComponent(link.product.id)}`}><span>{link.shopFeatured ? link.shopPinned ? 'Featured during show' : 'Shop item' : link.featured ? 'Featured' : 'From this show'}</span><strong>{link.product.name}</strong><small>View product</small></a>)}</div>}
        <a href="/" className="livePublicBackLink">Back to Market Lane</a>
      </section>
    </main>;
  }
  return <main className="livePublicStatus"><p className="eyebrow">Live shopping</p><h1>{session.title}</h1><p className="muted">This show is not currently live or has no published replay.</p><a className="primary" href="/">Browse Market Lane</a></main>;
}

export function LiveEmbedPage({ sessionId }: { sessionId: string }) {
  const { session, error, loading } = useLiveSession(sessionId);
  if (loading) return <main className="liveEmbedPage" role="status">Preparing live video…</main>;
  if (error || !session) return <main className="liveEmbedPage liveEmbedUnavailable" role="status">This live show is unavailable.</main>;
  if (session.status === 'LIVE' && session.realtimeAvailable) {
    return <main className="liveEmbedPage liveEmbedPlayable" aria-label={session.title}>
      <LiveKitViewer sessionId={session.id} onVideo={() => undefined} onPlayback={() => undefined} onError={() => undefined} className="liveEmbedMount" />
      <span className="liveEmbedCaption">{session.title} · {session.seller?.store?.name ?? 'Market Lane'}</span>
    </main>;
  }
  if (session.status === 'ENDED' && session.replayAvailable && session.replayUrl) {
    return <main className="liveEmbedPage"><video controls preload="metadata" playsInline src={session.replayUrl} aria-label={session.title}>Your browser does not support replay video.</video><span className="liveEmbedCaption">{session.title} · {session.seller?.store?.name ?? 'Market Lane'}</span></main>;
  }
  return <main className="liveEmbedPage liveEmbedUnavailable" role="status">This show is offline or its replay is private.</main>;
}
