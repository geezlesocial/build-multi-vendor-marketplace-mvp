import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useSession } from './session.js';
import { formatMinor } from './money.js';
import './ProductReviews.css';
import './LiveShopping.css';

type LiveProduct = { id: string; name: string; priceMinor?: number; currency?: string; availableStock?: number };
export type LiveSession = { id: string; title: string; description?: string | null; status: string; scheduledAt?: string | null; startedAt?: string | null; recordingStatus?: string; replayPublishedAt?: string | null; replayAvailable?: boolean; replayUrl?: string; seller?: { store?: { name: string; slug?: string } | null }; products?: { productId: string; featured: boolean; product?: LiveProduct }[]; playbackAvailable?: boolean; realtimeAvailable?: boolean; playbackUrl?: string };
type Attendance = { attendance: { eligibleDurationSeconds: number; rewardedAt: string | null } | null; rewardThresholdSeconds: number };
type Engagement = { viewCount: number; viewersNow: number | null; reactions: Record<'LIKE' | 'LOVE' | 'HAPPY' | 'CONGRATS', number>; myReaction: 'LIKE' | 'LOVE' | 'HAPPY' | 'CONGRATS' | null };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

export function LiveShopping() {
  const { user } = useSession();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [watchOpen, setWatchOpen] = useState(false);
  const closeViewer = useCallback(() => setWatchOpen(false), []);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== 'visible') return;
    inFlight.current = true;
    try {
      const items = await request<LiveSession[]>('/api/live-sessions');
      setSessions(items);
      setMessage('');
    } catch (error) { setSessions([]); setMessage((error as Error).message); }
    finally { setLoading(false); }
    inFlight.current = false;
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const visibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [load]);
  const liveSessions = sessions.filter(session => session.status === 'LIVE' && session.realtimeAvailable);
  useEffect(() => { if (!liveSessions.length) setWatchOpen(false); }, [liveSessions.length]);
  return <section className="liveShopping">
    <header className="sectionHeading"><div><p className="eyebrow">Live from independent stores</p><h2>Live shopping</h2><p className="muted">Session status refreshes every 10 seconds. Attendance rewards count only while a provider-backed live video is actively playing in this visible tab.</p></div><div className="liveDashboardHeaderActions">{liveSessions.length > 0 && <button type="button" className="primary liveWatchDashboardButton" onClick={() => setWatchOpen(true)}><span className="homeLiveDot" />Watch live sellers <b>{liveSessions.length}</b></button>}<span className="ordersLiveBadge"><i aria-hidden="true" />Updates every 10 seconds</span></div></header>
    {message && <p className="notice" role="status">Live shopping is unavailable or could not refresh: {message}</p>}
    {user && !user.emailVerifiedAt && <p className="notice">Verify your email in <a href="/settings#profile">account settings</a> before earning live-attendance rewards.</p>}
    {loading && <div className="empty" role="status">Loading live sessions…</div>}
    {!loading && !message && !sessions.length && <div className="empty">No live sessions are available right now.</div>}
    <div className="adminReviewList">{sessions.map(session => session.status === 'ENDED' && session.replayAvailable
      ? <LiveReplayCard key={session.id} session={session} />
      : <LiveSessionCard key={session.id} session={session} canEarn={Boolean(user?.emailVerifiedAt)} />)}</div>
    {watchOpen && <LiveWatchModal sessions={liveSessions} onClose={closeViewer} canEarn={Boolean(user?.emailVerifiedAt)} canReact={Boolean(user)} />}
  </section>;
}

function LiveReplayCard({ session }: { session: LiveSession }) {
  return <article className="card cardBody liveReplayCard">
    <p className="eyebrow">Published live replay</p><h3>{session.title}</h3>
    <p className="muted">{session.seller?.store?.name ?? 'Independent store'}{session.startedAt ? ` · Recorded ${new Date(session.startedAt).toLocaleString()}` : ''}</p>
    {session.description && <p>{session.description}</p>}
    {session.replayUrl && <video className="liveReplayPlayer" controls preload="metadata" playsInline src={session.replayUrl}>Your browser does not support replay video.</video>}
    {!!session.products?.length && <div className="liveProductRail" aria-label="Products featured in this replay">{session.products.map(link => link.product && <a className="liveProductLink" key={link.productId} href={`/products/${encodeURIComponent(link.product.id)}`}><span>{link.featured ? 'Featured' : 'From this show'}</span><strong>{link.product.name}</strong><small>View product</small></a>)}</div>}
  </article>;
}

function LiveSessionCard({ session, canEarn }: { session: LiveSession; canEarn: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const heartbeatQueue = useRef<Promise<void>>(Promise.resolve());
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [playing, setPlaying] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState('');
  const duration = attendance?.attendance?.eligibleDurationSeconds ?? 0;
  const threshold = attendance?.rewardThresholdSeconds ?? 300;
  const rewarded = Boolean(attendance?.attendance?.rewardedAt);

  const heartbeat = async (isPlaying: boolean) => {
    if (!canEarn) return;
    heartbeatQueue.current = heartbeatQueue.current.then(async () => {
      try {
        const result = await request<{ eligibleDurationSeconds: number; rewardThresholdSeconds: number; rewarded: boolean }>(`/api/live-sessions/${encodeURIComponent(session.id)}/attendance/heartbeat`, { method: 'POST', body: JSON.stringify({ playing: isPlaying }) });
        setAttendance(current => ({ attendance: { eligibleDurationSeconds: result.eligibleDurationSeconds, rewardedAt: result.rewarded ? new Date().toISOString() : current?.attendance?.rewardedAt ?? null }, rewardThresholdSeconds: result.rewardThresholdSeconds }));
        setError('');
      } catch (reason) { setError((reason as Error).message); }
    });
  };

  useEffect(() => {
    const player = video.current;
    if (!playing || !player || !canEarn) return undefined;
    let previousTime = player.currentTime;
    const tick = () => {
      const visible = document.visibilityState === 'visible';
      const progressed = visible && !player.paused && !player.ended && player.currentTime > previousTime + 0.25;
      previousTime = player.currentTime;
      void heartbeat(progressed);
    };
    const timer = window.setInterval(tick, 30_000);
    const visibility = () => { previousTime = player.currentTime; void heartbeat(false); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); void heartbeat(false); };
  }, [playing, canEarn, session.id]);

  useEffect(() => {
    let active = true;
    void request<Attendance>(`/api/live-sessions/${encodeURIComponent(session.id)}/attendance`).then(value => { if (active) setAttendance(value); }).catch(reason => { if (active) setError((reason as Error).message); });
    return () => { active = false; };
  }, [session.id]);

  const beginPlayback = () => { setPlaying(true); if (video.current) video.current.dataset.lastTime = String(video.current.currentTime); void heartbeat(true); };
  const pausePlayback = () => { setPlaying(false); void heartbeat(false); };
  const percent = Math.min(100, Math.round(duration / threshold * 100));
  return <article className="card adminReviewCard liveSessionCard">
    <div className="sectionHeading"><div><span className="adminWalletBadge">{session.status.replaceAll('_', ' ')}</span><h3>{session.title}</h3><p className="muted">{session.seller?.store?.name ?? 'Independent store'}{session.scheduledAt ? ` · ${new Date(session.scheduledAt).toLocaleString()}` : ''}</p></div><strong>{rewarded ? 'Reward earned' : `${Math.floor(duration / 60)} / ${Math.ceil(threshold / 60)} min`}</strong></div>
    {session.description && <p>{session.description}</p>}
    {!!session.products?.length && <div className="liveProductRail" aria-label="Products featured in this show">{session.products.map(link => link.product && <a className="liveProductLink" key={link.productId} href={`/products/${encodeURIComponent(link.product.id)}`}><span>{link.featured ? 'Featured' : 'In this show'}</span><strong>{link.product.name}</strong>{typeof link.product.availableStock === 'number' && <small>{link.product.availableStock} available</small>}</a>)}</div>}
    {session.status === 'LIVE' && session.realtimeAvailable ? watching ? <><LiveKitViewer sessionId={session.id} onVideo={element => { video.current = element; }} onPlayback={active => { if (active) beginPlayback(); else pausePlayback(); }} onError={reason => { setPlaying(false); setError(reason); }} /><button type="button" className="liveRefreshButton" onClick={() => { setWatching(false); pausePlayback(); }}>Stop watching</button></> : <button type="button" className="liveInlinePreview" onClick={() => setWatching(true)}><span className="liveInlinePreviewMark" aria-hidden="true">▶</span><span><strong>Watch this live show</strong><small>Connect to the live stream when you are ready.</small></span><span className="liveInlinePreviewArrow" aria-hidden="true">↗</span></button> : <p className="muted">The session is not currently broadcasting with a playable provider stream.</p>}
    <progress max={100} value={percent} aria-label={`${percent}% of live attendance reward time`} />
    <small className="muted">{rewarded ? 'Attendance reward recorded.' : 'Five minutes of eligible playback are required. Paused, hidden-tab, and disconnected time does not count.'}</small>
    {error && <p className="notice" role="alert">{error}</p>}
  </article>;
}

function LiveKitViewer({ sessionId, onVideo, onPlayback, onError, className = '' }: { sessionId: string; onVideo: (element: HTMLVideoElement) => void; onPlayback: (active: boolean) => void; onError: (message: string) => void; className?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let room: Room | null = null;
    let active = true;
    const connect = async () => {
      try {
        const credentials = await request<{ serverUrl: string; token: string }>(`/api/live-sessions/${encodeURIComponent(sessionId)}/token`);
        if (!active || !mount.current) return;
        room = new Room({ adaptiveStream: true, dynacast: true });
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (!mount.current) return;
          const element = track.attach();
          mount.current.appendChild(element);
          if (element instanceof HTMLVideoElement) {
            element.className = 'liveSessionPlayer';
            element.autoplay = true;
            element.playsInline = true;
            element.muted = true;
            onVideo(element);
            element.onplaying = () => onPlayback(true);
            element.onpause = () => onPlayback(false);
            void element.play().then(() => onPlayback(true)).catch(() => onError('Allow video playback in your browser to watch this show.'));
          }
        });
        room.on(RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(element => element.remove()); onPlayback(false); });
        room.on(RoomEvent.Disconnected, () => onPlayback(false));
        await room.connect(credentials.serverUrl, credentials.token);
      } catch (reason) { if (active) onError((reason as Error).message); }
    };
    void connect();
    return () => { active = false; onPlayback(false); room?.disconnect(); if (mount.current) mount.current.replaceChildren(); };
  }, [sessionId]);
  return <div ref={mount} className={`liveKitMount ${className}`} aria-label="Live video" />;
}

const reactionOptions = [
  { key: 'LIKE', label: 'Like', emoji: '👍' },
  { key: 'LOVE', label: 'Love', emoji: '❤️' },
  { key: 'HAPPY', label: 'Happy', emoji: '😊' },
  { key: 'CONGRATS', label: 'Congrats', emoji: '🎉' }
] as const;

export function LiveWatchModal({ sessions, onClose, canEarn, canReact }: { sessions: LiveSession[]; onClose: () => void; canEarn: boolean; canReact: boolean }) {
  const feed = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const liveSessions = sessions.filter(session => session.status === 'LIVE' && session.realtimeAvailable);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = Array.from(document.querySelectorAll<HTMLElement>('.liveWatchOverlay button:not(:disabled), .liveWatchOverlay a[href]'));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        return;
      }
      if (!['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
      const next = Math.max(0, Math.min(liveSessions.length - 1, activeIndex + direction));
      feed.current?.children[next]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveIndex(next);
    };
    document.addEventListener('keydown', handleKeys);
    return () => document.removeEventListener('keydown', handleKeys);
  }, [activeIndex, liveSessions.length, onClose]);

  useEffect(() => { setActiveIndex(index => Math.min(index, Math.max(0, liveSessions.length - 1))); }, [liveSessions.length]);

  useEffect(() => {
    const root = feed.current;
    if (!root) return undefined;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) {
        const index = Array.from(root.children).indexOf(visible.target);
        if (index >= 0) setActiveIndex(index);
      }
    }, { root, threshold: [0.55, 0.75] });
    Array.from(root.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [liveSessions.length]);

  const move = (direction: number) => {
    const next = Math.max(0, Math.min(liveSessions.length - 1, activeIndex + direction));
    feed.current?.children[next]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveIndex(next);
  };

  if (!liveSessions.length) return null;
  return <div className="liveWatchOverlay" role="dialog" aria-modal="true" aria-label="Watch live sellers" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="liveWatchTopbar"><a href="/" className="liveWatchBrand">Live shopping <span>{liveSessions.length} live</span></a><button ref={closeButton} type="button" className="liveWatchClose" onClick={onClose} aria-label="Close live shopping">× <span>Close</span></button></div>
    <div className="liveWatchFeed" ref={feed}>
      {liveSessions.map((session, index) => <LiveWatchSlide key={session.id} session={session} active={index === activeIndex} canEarn={canEarn} canReact={canReact} />)}
    </div>
    {liveSessions.length > 1 && <div className="liveWatchNav" aria-label="Change live seller"><button type="button" onClick={() => move(-1)} disabled={activeIndex === 0} aria-label="Previous live seller">↑</button><span>{activeIndex + 1} / {liveSessions.length}</span><button type="button" onClick={() => move(1)} disabled={activeIndex === liveSessions.length - 1} aria-label="Next live seller">↓</button></div>}
  </div>;
}

function LiveWatchSlide({ session, active, canEarn, canReact }: { session: LiveSession; active: boolean; canEarn: boolean; canReact: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const heartbeatQueue = useRef<Promise<void>>(Promise.resolve());
  const viewed = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [message, setMessage] = useState('');
  const [reactionPending, setReactionPending] = useState(false);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [playbackError, setPlaybackError] = useState('');
  const duration = attendance?.attendance?.eligibleDurationSeconds ?? 0;
  const threshold = attendance?.rewardThresholdSeconds ?? 300;
  const rewarded = Boolean(attendance?.attendance?.rewardedAt);

  const heartbeat = useCallback((isPlaying: boolean) => {
    if (!canEarn) return;
    heartbeatQueue.current = heartbeatQueue.current.then(async () => {
      try {
        const result = await request<{ eligibleDurationSeconds: number; rewardThresholdSeconds: number; rewarded: boolean }>(`/api/live-sessions/${encodeURIComponent(session.id)}/attendance/heartbeat`, { method: 'POST', body: JSON.stringify({ playing: isPlaying }) });
        setAttendance(current => ({ attendance: { eligibleDurationSeconds: result.eligibleDurationSeconds, rewardedAt: result.rewarded ? new Date().toISOString() : current?.attendance?.rewardedAt ?? null }, rewardThresholdSeconds: result.rewardThresholdSeconds }));
      } catch { /* Attendance errors should not interrupt watching. */ }
    });
  }, [canEarn, session.id]);

  const refreshEngagement = useCallback(async () => {
    try {
      const value = await request<Engagement>(`/api/live-sessions/${encodeURIComponent(session.id)}/engagement`);
      setEngagement(current => ({ ...value, viewCount: Math.max(value.viewCount, current?.viewCount ?? 0) }));
      setMessage('');
    } catch (error) { setMessage((error as Error).message); }
  }, [session.id]);

  useEffect(() => {
    if (!active || document.visibilityState !== 'visible') return undefined;
    void refreshEngagement();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshEngagement(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [active, refreshEngagement, session.id]);

  useEffect(() => {
    if (!active || !playing || document.visibilityState !== 'visible' || viewed.current) return undefined;
    let current = true;
    void request<{ viewCount: number }>(`/api/live-sessions/${encodeURIComponent(session.id)}/view`, { method: 'POST', body: '{}' }).then(result => {
      if (!current) return;
      viewed.current = true;
      setEngagement(value => ({ viewCount: Math.max(result.viewCount, value?.viewCount ?? 0), viewersNow: value?.viewersNow ?? null, reactions: value?.reactions ?? { LIKE: 0, LOVE: 0, HAPPY: 0, CONGRATS: 0 }, myReaction: value?.myReaction ?? null }));
    }).catch(() => undefined);
    return () => { current = false; };
  }, [active, playing, session.id]);

  useEffect(() => {
    let current = true;
    if (!active || !canEarn) return undefined;
    void request<Attendance>(`/api/live-sessions/${encodeURIComponent(session.id)}/attendance`).then(value => { if (current) setAttendance(value); }).catch(() => undefined);
    return () => { current = false; };
  }, [active, canEarn, session.id]);

  useEffect(() => {
    const player = video.current;
    if (!active || !playing || !canEarn || !player) return undefined;
    let previousTime = player.currentTime;
    const tick = () => {
      const progressed = document.visibilityState === 'visible' && !player.paused && !player.ended && player.currentTime > previousTime + 0.25;
      previousTime = player.currentTime;
      void heartbeat(progressed);
    };
    const timer = window.setInterval(tick, 30_000);
    const visibility = () => { previousTime = player.currentTime; if (document.visibilityState !== 'visible') void heartbeat(false); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); void heartbeat(false); };
  }, [active, playing, canEarn, heartbeat]);

  const changeReaction = async (reaction: Engagement['myReaction'] | 'LIKE' | 'LOVE' | 'HAPPY' | 'CONGRATS') => {
    if (!canReact || reactionPending) return;
    setReactionPending(true);
    setMessage('');
    try {
      const next = engagement?.myReaction === reaction ? null : reaction;
      const result = await request<Engagement>(`/api/live-sessions/${encodeURIComponent(session.id)}/reaction`, { method: 'PUT', body: JSON.stringify({ reaction: next }) });
      setEngagement(result);
    } catch (error) { setMessage((error as Error).message); }
    finally { setReactionPending(false); }
  };

  const storeName = session.seller?.store?.name ?? 'Independent store';
  const storeSlug = session.seller?.store?.slug;
  return <article className="liveWatchSlide" aria-label={`${session.title}, ${storeName}`}>
    <div className="liveWatchVideo">
      {active ? <LiveKitViewer sessionId={session.id} className="liveWatchMount" onVideo={element => { video.current = element; }} onPlayback={value => { setPlaying(value); if (value) void heartbeat(true); else void heartbeat(false); }} onError={reason => { setPlaybackError(reason); setPlaying(false); void heartbeat(false); }} /> : <div className="liveWatchStandby" aria-hidden="true"><span>LIVE</span></div>}
      <div className="liveWatchVideoShade" />
      <div className="liveWatchLiveTag"><span /> LIVE</div>
      <div className="liveWatchVideoCounts"><span aria-label={`${engagement?.viewCount ?? 'View count loading'} total views`}>◉ {engagement?.viewCount ?? '—'}</span><span aria-label={`${engagement?.viewersNow ?? 'Viewer count unavailable'} watching now`}>● {engagement?.viewersNow ?? '—'} watching</span></div>
      <div className="liveWatchOverlayCopy"><p className="eyebrow">{storeName}</p><h2>{session.title}</h2>{session.description && <p>{session.description}</p>}{storeSlug && <a href={`/store/${encodeURIComponent(storeSlug)}`}>Visit store <span aria-hidden="true">↗</span></a>}</div>
      <div className="liveWatchReactionRail" aria-label="Live reactions">
        {reactionOptions.map(option => <button key={option.key} type="button" className={engagement?.myReaction === option.key ? 'liveReaction active' : 'liveReaction'} onClick={() => void changeReaction(option.key)} disabled={!canReact || reactionPending} aria-pressed={engagement?.myReaction === option.key} aria-label={`${option.label}, ${engagement?.reactions[option.key] ?? 0}${!canReact ? ', sign in to react' : ''}`} title={canReact ? option.label : 'Sign in to react'}><span>{option.emoji}</span><small>{engagement?.reactions[option.key] ?? 0}</small></button>)}
      </div>
    </div>
    <div className="liveWatchInfo">
      <div className="liveWatchInfoHeading"><strong>{storeName}</strong><span>{engagement?.viewCount ?? 0} views</span></div>
      {!!session.products?.length && <div className="liveWatchProducts" aria-label="Shop products in this live show">{session.products.map(link => link.product && <a className="liveWatchProduct" key={link.productId} href={`/products/${encodeURIComponent(link.product.id)}`}><span>{link.featured ? 'Featured now' : 'From this show'}</span><strong>{link.product.name}</strong><small>{typeof link.product.priceMinor === 'number' && link.product.currency ? formatMinor(link.product.priceMinor, link.product.currency) : 'View item'} · Shop item</small></a>)}</div>}
      {canEarn && <div className="liveWatchAttendance"><span>{rewarded ? 'Live attendance reward earned' : `Attendance ${Math.floor(duration / 60)} / ${Math.ceil(threshold / 60)} min`}</span><progress max={threshold} value={Math.min(duration, threshold)} aria-label="Live attendance reward progress" /></div>}
      {!canReact && <p className="liveWatchHint"><a href="/?auth=login">Sign in</a> to react and join the conversation.{!canEarn && ' Verify your email to qualify for attendance rewards.'}</p>}
      {canReact && !canEarn && <p className="liveWatchHint">Verify your email in <a href="/settings#profile">account settings</a> to qualify for live attendance rewards.</p>}
      {playbackError && <p className="liveWatchMessage" role="status">{playbackError}</p>}
      {message && <p className="liveWatchMessage" role="status">{message}</p>}
    </div>
  </article>;
}

function LiveKitHost({ sessionId, onPublished, onError }: { sessionId: string; onPublished: (published: boolean) => void; onError: (message: string) => void }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let room: Room | null = null;
    let active = true;
    const connect = async () => {
      try {
        const credentials = await request<{ serverUrl: string; token: string }>(`/api/seller/live-sessions/${encodeURIComponent(sessionId)}/stream-token`);
        if (!active || !mount.current) return;
        room = new Room({ adaptiveStream: true, dynacast: true });
        room.on(RoomEvent.LocalTrackPublished, publication => {
          if (publication.kind !== Track.Kind.Video || !publication.track || !mount.current) return;
          const element = publication.track.attach();
          if (element instanceof HTMLVideoElement) { element.className = 'liveSessionPlayer'; element.autoplay = true; element.playsInline = true; element.muted = true; mount.current.appendChild(element); }
          onPublished(true);
        });
        room.on(RoomEvent.Disconnected, () => onPublished(false));
        await room.connect(credentials.serverUrl, credentials.token);
        await room.localParticipant.enableCameraAndMicrophone();
        const publishing = Array.from(room.localParticipant.trackPublications.values()).some(publication => publication.kind === Track.Kind.Video);
        onPublished(publishing);
      } catch (reason) { if (active) { onPublished(false); onError((reason as Error).message); } }
    };
    void connect();
    return () => { active = false; onPublished(false); room?.disconnect(); if (mount.current) mount.current.replaceChildren(); };
  }, [sessionId]);
  return <div ref={mount} className="liveKitMount" aria-label="Live broadcast preview" />;
}

type LiveReadiness = { effectiveEnabled: boolean; deploymentGate: boolean; runtimeEnabled: boolean; reason: string; recordingAvailable?: boolean; recordingStorageConfigured?: boolean; readiness: { provider: string | null; configured: boolean; healthy: boolean; attendanceVerificationAvailable: boolean; reason: string } };
type LiveProviderConfiguration = { provider: 'LIVEKIT'; configured: boolean; serverUrl: string | null; apiKeyConfigured: boolean; apiSecretConfigured: boolean; apiKeyMasked: string | null; deploymentGateEnabled: boolean; source: 'ADMIN_DASHBOARD' | 'DEPLOYMENT_ENVIRONMENT' | 'NOT_CONFIGURED'; configurationError: string | null };
type AdminLiveProvider = { configuration: LiveProviderConfiguration; readiness: LiveReadiness['readiness'] };
type SellerLiveSession = LiveSession & { scheduledAt: string | null; timezone: string; deletedAt?: string | null; products: { productId: string; featured: boolean; product?: LiveProduct }[] };

export function SellerLiveStudio({ products }: { products: LiveProduct[] }) {
  const [sessions, setSessions] = useState<SellerLiveSession[]>([]);
  const [deletedSessions, setDeletedSessions] = useState<SellerLiveSession[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [readiness, setReadiness] = useState<LiveReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [productIds, setProductIds] = useState<string[]>([]);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== 'visible') return;
    inFlight.current = true;
    try {
      const [items, deletedItems, liveState] = await Promise.all([
        request<SellerLiveSession[]>('/api/seller/live-sessions'),
        request<SellerLiveSession[]>('/api/seller/live-sessions?view=deleted'),
        request<LiveReadiness>('/api/live-shopping/status')
      ]);
      setSessions(items);
      setDeletedSessions(deletedItems);
      setReadiness(liveState);
      setMessage('');
    } catch (error) { setMessage((error as Error).message); }
    finally { inFlight.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const visibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [load]);

  const createSession = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setMessage('');
    try {
      await request('/api/seller/live-sessions', { method: 'POST', body: JSON.stringify({
        title, description, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}), productIds
      }) });
      setTitle(''); setDescription(''); setScheduledAt(''); setProductIds([]);
      setMessage('Show saved. It will appear publicly after live shopping is enabled and the stream provider is ready.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const updateSession = async (sessionId: string, input: { title: string; description: string; scheduledAt: string }) => {
    if (saving) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({
        title: input.title, description: input.description,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : null
      }) });
      setMessage('Show details saved.'); await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const cancelSession = async (session: SellerLiveSession) => {
    if (saving || !window.confirm(`Cancel “${session.title}”? This keeps the session record for audit history.`)) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}/transition`, { method: 'POST', body: JSON.stringify({ status: 'CANCELLED' }) });
      setMessage('Show cancelled.'); await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const setShowPublished = async (session: SellerLiveSession, published: boolean) => {
    if (saving) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}/transition`, { method: 'POST', body: JSON.stringify({ status: published ? 'SCHEDULED' : 'DRAFT' }) });
      setMessage(published ? 'Show published. Shoppers can see its schedule while live shopping is available.' : 'Show unpublished and returned to drafts. Its schedule and details were kept.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const deleteShow = async (session: SellerLiveSession) => {
    if (saving || !window.confirm(`Move “${session.title}” to Deleted shows? It will be unpublished and can be restored later.`)) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      setMessage('Show moved to Deleted shows. Any replay is private until the show is restored.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const restoreShow = async (session: SellerLiveSession) => {
    if (saving) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}/restore`, { method: 'POST', body: JSON.stringify({}) });
      setMessage('Show restored. It is not publicly listed until you publish it again.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const setReplayPublished = async (session: SellerLiveSession, published: boolean) => {
    if (saving) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}/replay`, { method: 'POST', body: JSON.stringify({ published }) });
      setMessage(published ? 'Replay published and now visible in Live Shopping.' : 'Replay is private again.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const deleteReplay = async (session: SellerLiveSession) => {
    if (saving || !window.confirm(`Permanently delete the replay for “${session.title}”? This cannot be undone.`)) return;
    setSaving(true); setMessage('');
    try {
      await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}/replay`, { method: 'DELETE' });
      setMessage('Replay permanently deleted from recording storage.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };

  const providerReady = Boolean(readiness?.effectiveEnabled);
  return <section className="liveShopping liveStudio">
    <header className="sectionHeading"><div><p className="eyebrow">Seller studio</p><h2>Live shows</h2><p className="muted">Prepare a show, schedule it, and attach approved products. Publishing and viewer playback require a real, healthy streaming provider.</p></div><span className="ordersLiveBadge"><i aria-hidden="true" />Refreshes every 10 seconds</span></header>
    {readiness && <div className={providerReady ? 'liveReadiness liveReadinessReady' : 'liveReadiness'}><strong>{providerReady ? 'Streaming is ready' : 'Publishing is not configured'}</strong><span>{providerReady ? `Provider: ${readiness.readiness.provider ?? 'configured'}` : readiness.reason}</span><small>{providerReady ? `Create or schedule a show, then start it and allow camera and microphone access. Viewer attendance rewards count during provider-verified playback. ${readiness.recordingAvailable ? 'Private replay storage is configured; LiveKit Egress must also be enabled, and you choose whether to publish each replay.' : 'Replay recording is not configured; live streaming remains available, but shows will not be recorded.'}` : 'Drafts and schedules can be managed now. Starting a broadcast stays unavailable until the platform owner configures and verifies a provider.'}</small></div>}
    {message && <p className="notice" role="status">{message}</p>}
    <form className="liveSessionForm" onSubmit={event => void createSession(event)}>
      <div><p className="eyebrow">Plan a show</p><h3>Create a live show</h3></div>
      <label>Show title<input required minLength={3} maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Description<textarea maxLength={5000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>Schedule (your local time)<input type="datetime-local" value={scheduledAt} onChange={event => setScheduledAt(event.target.value)} /><small>Leave blank to save as a draft. Scheduled shows remain private until live shopping is enabled.</small></label>
      <label>Featured products<select multiple size={Math.min(6, Math.max(3, products.length))} value={productIds} onChange={event => setProductIds(Array.from(event.currentTarget.selectedOptions, option => option.value))}>{products.filter(product => (product as LiveProduct & { status?: string }).status === 'APPROVED').map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select><small>Only approved products from your Store are listed. Use Ctrl/Cmd to select multiple items.</small></label>
      <button className="primary" disabled={saving}>{saving ? 'Saving show…' : 'Save draft or schedule'}</button>
    </form>
    <div className="liveSessionListHeading"><h3>{showDeleted ? 'Deleted shows' : 'Your shows'}</h3><div className="liveShowListActions"><span>{showDeleted ? deletedSessions.length : sessions.length} total</span><button type="button" onClick={() => setShowDeleted(value => !value)}>{showDeleted ? 'Back to your shows' : `Deleted shows (${deletedSessions.length})`}</button></div></div>
    {showDeleted && <p className="muted liveArchiveExplanation">Deleted shows are hidden from shoppers and their replays are unpublished. Restore a show to manage it again; replay files can be permanently removed from here.</p>}
    {loading && <div className="empty" role="status">Loading your shows…</div>}
    {!loading && !showDeleted && sessions.length === 0 && <div className="empty">No shows yet. Create a draft or add a schedule above.</div>}
    {!loading && showDeleted && deletedSessions.length === 0 && <div className="empty">Deleted shows appear here and can be restored.</div>}
    <div className="liveSellerSessionList">{(showDeleted ? deletedSessions : sessions).map(session => <SellerSessionCard key={session.id} session={session} saving={saving} onSave={updateSession} onCancel={cancelSession} onRefresh={load} providerReady={providerReady} onReplayChange={setReplayPublished} onReplayDelete={deleteReplay} onShowPublish={setShowPublished} onShowDelete={deleteShow} onRestore={restoreShow} archived={showDeleted} />)}</div>
  </section>;
}

function SellerSessionCard({ session, saving, onSave, onCancel, onRefresh, providerReady, onReplayChange, onReplayDelete, onShowPublish, onShowDelete, onRestore, archived }: {
  session: SellerLiveSession; saving: boolean;
  onSave: (sessionId: string, input: { title: string; description: string; scheduledAt: string }) => Promise<void>;
  onCancel: (session: SellerLiveSession) => Promise<void>; onRefresh: () => Promise<void>; providerReady: boolean;
  onReplayChange: (session: SellerLiveSession, published: boolean) => Promise<void>; onReplayDelete: (session: SellerLiveSession) => Promise<void>;
  onShowPublish: (session: SellerLiveSession, published: boolean) => Promise<void>; onShowDelete: (session: SellerLiveSession) => Promise<void>;
  onRestore: (session: SellerLiveSession) => Promise<void>; archived: boolean;
}) {
  const [title, setTitle] = useState(session.title);
  const [description, setDescription] = useState(session.description ?? '');
  const [scheduledAt, setScheduledAt] = useState(toLocalDateTime(session.scheduledAt));
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [hostPublished, setHostPublished] = useState(false);
  const [hostError, setHostError] = useState('');
  useEffect(() => { setTitle(session.title); setDescription(session.description ?? ''); setScheduledAt(toLocalDateTime(session.scheduledAt)); }, [session]);
  const editable = !archived && (session.status === 'DRAFT' || session.status === 'SCHEDULED');
  const canDelete = !['STARTING', 'LIVE', 'PAUSED'].includes(session.status) && !['STARTING', 'RECORDING', 'PROCESSING'].includes(session.recordingStatus ?? 'NOT_CONFIGURED');
  const canPublish = Boolean(session.scheduledAt && new Date(session.scheduledAt).getTime() > Date.now());
  const transition = async (status: 'STARTING' | 'LIVE' | 'ENDED') => {
    if (broadcastBusy) return;
    setBroadcastBusy(true); setHostError('');
    try { await request(`/api/seller/live-sessions/${encodeURIComponent(session.id)}/transition`, { method: 'POST', body: JSON.stringify({ status }) }); await onRefresh(); }
    catch (reason) { setHostError((reason as Error).message); }
    finally { setBroadcastBusy(false); }
  };
  return <article className="liveSellerSession card">
    <header><div><span className="liveStatusPill">{archived ? 'DELETED' : session.status.replaceAll('_', ' ')}</span><h4>{session.title}</h4><p className="muted">{session.scheduledAt ? new Date(session.scheduledAt).toLocaleString() : 'Not scheduled'} · {session.products.length} linked products{archived && session.deletedAt ? ` · Deleted ${new Date(session.deletedAt).toLocaleDateString()}` : ''}</p></div><div className="liveSellerSessionActions">
      {archived ? <button type="button" disabled={saving || broadcastBusy} onClick={() => void onRestore(session)}>Restore show</button> : <>
        {session.status === 'DRAFT' && <button type="button" disabled={saving || broadcastBusy || !canPublish} title={!canPublish ? 'Add a future schedule in Edit show details before publishing.' : undefined} onClick={() => void onShowPublish(session, true)}>Publish show</button>}
        {session.status === 'SCHEDULED' && <><button type="button" disabled={saving || broadcastBusy} onClick={() => void onShowPublish(session, false)}>Unpublish show</button><button type="button" disabled={saving || broadcastBusy || !providerReady} onClick={() => void transition('STARTING')}>{broadcastBusy ? 'Starting…' : 'Start broadcast'}</button></>}
        {session.status === 'STARTING' && <button type="button" disabled={saving || broadcastBusy || !hostPublished} onClick={() => void transition('LIVE')}>{broadcastBusy ? 'Going live…' : 'Go live'}</button>}
        {session.status === 'LIVE' && <button type="button" disabled={saving || broadcastBusy} onClick={() => void transition('ENDED')}>{broadcastBusy ? 'Ending…' : 'End broadcast'}</button>}
        {session.status === 'ENDED' && session.recordingStatus === 'READY' && <><button type="button" disabled={saving || broadcastBusy} onClick={() => void onReplayChange(session, !session.replayPublishedAt)}>{session.replayPublishedAt ? 'Unpublish replay' : 'Publish replay'}</button>{!session.replayPublishedAt && <button type="button" disabled={saving || broadcastBusy} onClick={() => void onReplayDelete(session)}>Delete replay</button>}</>}
        {editable && <button type="button" disabled={saving || broadcastBusy} onClick={() => void onCancel(session)}>Cancel show</button>}
        {canDelete && <button type="button" className="liveDeleteShowButton" disabled={saving || broadcastBusy} onClick={() => void onShowDelete(session)}>Delete show</button>}
      </>}
    </div></header>
    {!!session.products.length && <ul className="liveLinkedProducts">{session.products.map(link => <li key={link.productId}>{link.featured ? 'Featured: ' : ''}{link.product?.name ?? 'Product'}</li>)}</ul>}
    {['STARTING', 'LIVE', 'PAUSED'].includes(session.status) && <><LiveKitHost sessionId={session.id} onPublished={setHostPublished} onError={setHostError} /><small className="muted">{session.status === 'STARTING' ? (hostPublished ? 'Camera and microphone are ready. You can go live.' : 'Allow camera and microphone access, then wait for the preview.') : 'Your live broadcast is connected.'}</small></>}
    {!archived && ['STARTING', 'LIVE', 'PAUSED'].includes(session.status) && <p className="muted">An active broadcast stays visible while it is on air. End the broadcast to take it offline; you can unpublish its replay after recording finishes.</p>}
    {session.status === 'ENDED' && session.recordingStatus && session.recordingStatus !== 'NOT_CONFIGURED' && <div className="liveReplayStatus" role="status"><strong>Replay: {session.recordingStatus.toLowerCase()}</strong>{session.recordingStatus === 'READY' ? <><p>{session.replayPublishedAt ? 'This replay is published and visible to shoppers.' : 'This replay is private. Publish it when you are ready.'}</p><video className="liveReplayPlayer" controls preload="metadata" playsInline src={`/api/seller/live-sessions/${encodeURIComponent(session.id)}/replay`}>Your browser does not support replay video.</video>{archived && <button type="button" disabled={saving || broadcastBusy} onClick={() => void onReplayDelete(session)}>Permanently delete replay file</button>}</> : <p>{session.recordingStatus === 'FAILED' ? 'The recording could not be completed. Live streaming was not affected.' : 'The recording is being finalized in private storage. This card will update automatically.'}</p>}</div>}
    {session.status === 'ENDED' && session.recordingStatus === 'NOT_CONFIGURED' && <p className="muted">Replay recording was not configured when this show went live, so there is no recording to publish.</p>}
    {hostError && <p className="notice" role="alert">{hostError}</p>}
    {editable && <details className="liveSessionEdit"><summary>Edit show details</summary><form onSubmit={event => { event.preventDefault(); void onSave(session.id, { title, description, scheduledAt }); }}><label>Title<input required minLength={3} maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Description<textarea maxLength={5000} rows={2} value={description} onChange={event => setDescription(event.target.value)} /></label><label>Schedule<input type="datetime-local" value={scheduledAt} onChange={event => setScheduledAt(event.target.value)} /><small>Set a date to schedule the show, or clear it to keep a draft.</small></label><button disabled={saving}>Save show details</button></form></details>}
    {!archived && <button className="liveRefreshButton" type="button" onClick={() => void onRefresh()}>Refresh status</button>}
  </article>;
}

function toLocalDateTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type AdminLiveSession = SellerLiveSession & { seller?: { store?: { name: string } | null }; reports?: { id: string; reason: string; status: string; createdAt: string }[] };
type AdminLiveReport = { id: string; reason: string; status: string; createdAt: string; session: { id: string; title: string; status: string }; reporter?: { name?: string | null; email: string } | null };

export function AdminLiveShopping() {
  const [readiness, setReadiness] = useState<LiveReadiness | null>(null);
  const [providerConfig, setProviderConfig] = useState<LiveProviderConfiguration | null>(null);
  const [providerForm, setProviderForm] = useState({ serverUrl: '', apiKey: '', apiSecret: '', deploymentGateEnabled: false, reason: '' });
  const [sessions, setSessions] = useState<AdminLiveSession[]>([]);
  const [reports, setReports] = useState<AdminLiveReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const providerFormLoaded = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== 'visible') return;
    inFlight.current = true;
    try {
      const [settings, liveSessions, liveReports, liveProviderConfig] = await Promise.all([
        request<{ liveShopping: LiveReadiness }>('/api/admin/settings'),
        request<AdminLiveSession[]>('/api/admin/live-sessions'),
        request<AdminLiveReport[]>('/api/admin/live-reports'),
        request<AdminLiveProvider>('/api/admin/live-provider')
      ]);
      setReadiness(settings.liveShopping); setSessions(liveSessions); setReports(liveReports); setProviderConfig(liveProviderConfig.configuration);
      if (!providerFormLoaded.current) {
        setProviderForm({ serverUrl: liveProviderConfig.configuration.serverUrl ?? '', apiKey: '', apiSecret: '', deploymentGateEnabled: liveProviderConfig.configuration.deploymentGateEnabled, reason: '' });
        providerFormLoaded.current = true;
      }
      setMessage('');
    } catch (error) { setMessage((error as Error).message); }
    finally { inFlight.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const visibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [load]);

  const adminAction = async (path: string, options: RequestInit, success: string) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await request(path, options); setMessage(success); await load(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    if (providerSaving) return;
    setProviderSaving(true); setMessage('');
    try {
      const result = await request<AdminLiveProvider>('/api/admin/live-provider', { method: 'PUT', body: JSON.stringify(providerForm) });
      setProviderConfig(result.configuration);
      setReadiness(current => current ? { ...current, deploymentGate: result.configuration.deploymentGateEnabled, readiness: result.readiness } : current);
      setProviderForm(current => ({ ...current, serverUrl: result.configuration.serverUrl ?? current.serverUrl, apiKey: '', apiSecret: '', reason: '' }));
      setMessage('LiveKit configuration saved and verified.');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setProviderSaving(false); }
  };
  const canEnable = Boolean(readiness?.deploymentGate && readiness.readiness.configured && readiness.readiness.healthy);
  return <section className="liveShopping adminLiveShopping">
    <header className="sectionHeading"><div><p className="eyebrow">Platform governance</p><h2>Live shopping</h2><p className="muted">Review readiness, scheduled sessions, provider status, and viewer reports.</p></div><span className="ordersLiveBadge"><i aria-hidden="true" />Refreshes every 10 seconds</span></header>
    {message && <p className="notice" role="status">{message}</p>}
    <section className="liveProviderConfig card">
      <div className="sectionHeading"><div><p className="eyebrow">Streaming integration</p><h3>LiveKit provider configuration</h3><p className="muted">Enter the LiveKit project credentials used for real-time broadcasts, host tokens, viewer playback, and attendance verification.</p></div><span className={providerConfig?.configured ? 'liveConfigStatus liveConfigStatusReady' : 'liveConfigStatus'}>{providerConfig?.configured ? 'Configured' : 'Not configured'}</span></div>
      {providerConfig?.source === 'DEPLOYMENT_ENVIRONMENT' && <p className="notice">The current provider comes from deployment environment variables. Saving here creates an encrypted dashboard-managed configuration and takes effect without an API restart.</p>}
      {providerConfig?.configurationError && <p className="notice" role="alert">{providerConfig.configurationError}</p>}
      <form className="liveProviderForm" onSubmit={saveProvider}>
        <label>LiveKit server URL<input required type="url" placeholder="https://your-project.livekit.cloud" value={providerForm.serverUrl} onChange={event => setProviderForm(current => ({ ...current, serverUrl: event.target.value }))} /></label>
        <label>LiveKit API key<input type="text" autoComplete="off" placeholder={providerConfig?.apiKeyMasked ?? 'your-api-key'} value={providerForm.apiKey} onChange={event => setProviderForm(current => ({ ...current, apiKey: event.target.value }))} /><small>Leave blank to keep the currently stored key.</small></label>
        <label>LiveKit API secret<input type="password" autoComplete="new-password" placeholder={providerConfig?.apiSecretConfigured ? '••••••••••••' : 'your-api-secret'} value={providerForm.apiSecret} onChange={event => setProviderForm(current => ({ ...current, apiSecret: event.target.value }))} /><small>Secrets are encrypted at rest and are never returned to the browser.</small></label>
        <label className="liveProviderCheckbox"><input type="checkbox" checked={providerForm.deploymentGateEnabled} onChange={event => setProviderForm(current => ({ ...current, deploymentGateEnabled: event.target.checked }))} /> Enable LIVE_SHOPPING_AVAILABLE deployment gate</label>
        <label>Reason for administrative change<input required minLength={3} maxLength={500} value={providerForm.reason} onChange={event => setProviderForm(current => ({ ...current, reason: event.target.value }))} placeholder="Configured the production LiveKit project" /></label>
        <button type="submit" disabled={providerSaving || !providerForm.serverUrl}>{providerSaving ? 'Saving and verifying…' : 'Save and verify LiveKit'}</button>
      </form>
      <small className="muted">Server URL: {providerConfig?.serverUrl ?? 'Not configured'} · API key: {providerConfig?.apiKeyConfigured ? 'configured' : 'missing'} · API secret: {providerConfig?.apiSecretConfigured ? 'configured' : 'missing'} · Deployment gate: {providerConfig?.deploymentGateEnabled ? 'on' : 'off'}</small>
    </section>
    <section className="liveReadinessPanel"><div><strong>{readiness?.effectiveEnabled ? 'Live shopping enabled' : 'Live shopping safely disabled'}</strong><p>{readiness?.reason ?? 'Loading live provider readiness…'}</p><small>All controls fail closed if the deployment gate, admin switch, or provider health check is unavailable.</small></div><button type="button" disabled={busy || (!readiness?.runtimeEnabled && !canEnable)} onClick={() => void adminAction('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ liveShoppingEnabled: !readiness?.runtimeEnabled, reason: 'Updated live-shopping availability in Control Center' }) }, readiness?.runtimeEnabled ? 'Live shopping disabled.' : 'Live shopping enabled.')}>{readiness?.runtimeEnabled ? 'Disable live shopping' : 'Enable live shopping'}</button></section>
    {!canEnable && readiness && <div className="notice">Enable is unavailable: {readiness.reason} No simulated streams or credentials are accepted.</div>}
    {readiness && <p className="muted">Attendance rewards: {readiness.readiness.attendanceVerificationAvailable ? 'provider-verified playback is available' : 'disabled until the provider can verify viewer playback server-side'}.</p>}
    <div className="liveSessionListHeading"><h3>Sessions</h3><span>{sessions.length} records</span></div>
    {loading && <div className="empty" role="status">Loading live sessions…</div>}
    {!loading && sessions.length === 0 && <div className="empty">No live sessions have been created.</div>}
    <div className="liveSellerSessionList">{sessions.map(session => <article className="liveSellerSession card" key={session.id}><header><div><span className="liveStatusPill">{session.status.replaceAll('_', ' ')}</span><h4>{session.title}</h4><p className="muted">{session.seller?.store?.name ?? 'Store'} · {session.scheduledAt ? new Date(session.scheduledAt).toLocaleString() : 'Not scheduled'} · {session.products.length} products</p></div>{!['ENDED', 'CANCELLED', 'FAILED'].includes(session.status) && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Terminate “${session.title}”? This action is audited and the session history is retained.`)) void adminAction(`/api/admin/live-sessions/${encodeURIComponent(session.id)}/terminate`, { method: 'POST', body: '{}' }, 'Session terminated.'); }}>Terminate session</button>}</header><p>{session.description || 'No show description.'}</p>{session.reports?.length ? <small>{session.reports.filter(report => report.status === 'OPEN').length} open report(s)</small> : <small>No reports</small>}</article>)}</div>
    <div className="liveSessionListHeading"><h3>Viewer reports</h3><span>{reports.filter(report => report.status === 'OPEN').length} open</span></div>
    {reports.length === 0 ? <div className="empty">No viewer reports.</div> : <div className="liveAdminReports">{reports.map(report => <article className="liveAdminReport card" key={report.id}><div><span className="liveStatusPill">{report.status}</span><h4>{report.session.title}</h4><p>{report.reason}</p><small>{report.reporter?.name || report.reporter?.email || 'Anonymous'} · {new Date(report.createdAt).toLocaleString()}</small></div>{report.status === 'OPEN' && <div className="liveSellerSessionActions"><button type="button" disabled={busy} onClick={() => void adminAction(`/api/admin/live-reports/${encodeURIComponent(report.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'REVIEWED' }) }, 'Report marked reviewed.')}>Mark reviewed</button><button type="button" disabled={busy} onClick={() => void adminAction(`/api/admin/live-reports/${encodeURIComponent(report.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'DISMISSED' }) }, 'Report dismissed.')}>Dismiss</button></div>}</article>)}</div>}
  </section>;
}
