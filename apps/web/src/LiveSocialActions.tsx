import React, { useEffect, useId, useRef, useState } from 'react';
import { useSession } from './session.js';
import './LiveSocial.css';

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'That live-shopping action could not be completed.');
  return body as T;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Copy is unavailable in this browser. Select and copy the link instead.');
}

function canonicalUrl(sessionId: string) {
  return new URL(`/live/${encodeURIComponent(sessionId)}`, window.location.origin).toString();
}

export function LiveSocialActions({ sessionId, title, allowRepost = true, compact = false }: {
  sessionId: string;
  title: string;
  allowRepost?: boolean;
  compact?: boolean;
}) {
  const { user } = useSession();
  const shareGroup = useId();
  const embedDialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [social, setSocial] = useState<{ repostCount: number; reposted: boolean }>({ repostCount: 0, reposted: false });
  const [shareOpen, setShareOpen] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const url = canonicalUrl(sessionId);
  const embedCode = `<iframe src="${new URL(`/live/${encodeURIComponent(sessionId)}/embed`, window.location.origin)}" title="${escapeHtml(title || 'Live shopping video')}" width="640" height="360" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void request<{ repostCount: number; reposted: boolean }>(`/api/live-sessions/${encodeURIComponent(sessionId)}/social`)
        .then(value => { if (current) setSocial(value); })
        .catch(() => undefined);
    };
    const onRepostsChanged = (event: Event) => {
      const changedSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (changedSessionId === sessionId) refresh();
    };
    refresh();
    window.addEventListener('marketplace:live-reposts-changed', onRepostsChanged);
    return () => { current = false; window.removeEventListener('marketplace:live-reposts-changed', onRepostsChanged); };
  }, [sessionId]);

  useEffect(() => {
    if (!embedOpen) return undefined;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = embedDialog.current;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setEmbedOpen(false); }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, textarea, a[href]')).filter(element => !element.hasAttribute('disabled'));
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus.current?.focus(); };
  }, [embedOpen]);

  const copy = async (value: string, copiedMessage: string) => {
    try { await copyText(value); setMessage(copiedMessage); }
    catch (error) { setMessage((error as Error).message); }
  };

  const toggleRepost = async () => {
    if (!user || busy) return;
    setBusy(true); setMessage('');
    try {
      const next = await request<{ reposted: boolean; repostCount?: number }>(`/api/live-sessions/${encodeURIComponent(sessionId)}/repost`, {
        method: social.reposted ? 'DELETE' : 'POST',
        ...(social.reposted ? {} : { body: JSON.stringify({}) })
      });
      setSocial(current => ({ reposted: next.reposted, repostCount: next.repostCount ?? Math.max(0, current.repostCount + (next.reposted ? 1 : -1)) }));
      window.dispatchEvent(new CustomEvent('marketplace:live-reposts-changed', { detail: { sessionId } }));
      setMessage(next.reposted ? 'Added to your profile activity.' : 'Removed from your profile activity.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const titleText = title || 'Live shopping';
  const shareTargets = [
    { label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
    { label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${titleText} ${url}`)}` },
    { label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}` },
    { label: 'X / Twitter', href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(titleText)}&url=${encodeURIComponent(url)}` }
  ];

  return <div className={compact ? 'liveSocialActions compact' : 'liveSocialActions'}>
    <details className="liveShareMenu" open={shareOpen} onToggle={event => setShareOpen(event.currentTarget.open)}>
      <summary aria-controls={`live-share-${shareGroup}`}>Share</summary>
      <div id={`live-share-${shareGroup}`} className="liveShareMenuPanel" role="group" aria-label="Share this live show">
        {shareTargets.map(target => <a key={target.label} href={target.href} target="_blank" rel="noopener noreferrer">{target.label}</a>)}
        <button type="button" onClick={() => void copy(url, 'Live link copied.')}>Copy link</button>
        {typeof navigator !== 'undefined' && 'share' in navigator && <button type="button" onClick={() => { void navigator.share({ title: titleText, url }).then(() => setMessage('Share sheet opened.')).catch(error => { if ((error as DOMException).name !== 'AbortError') setMessage('Native share is unavailable.'); }); }}>Share from device</button>}
        <button type="button" onClick={() => { setEmbedOpen(true); setShareOpen(false); }}>Embed video</button>
      </div>
    </details>
    {allowRepost && (user ? <button type="button" className={social.reposted ? 'liveRepostButton active' : 'liveRepostButton'} aria-pressed={social.reposted} disabled={busy} onClick={() => void toggleRepost()}>{busy ? 'Saving…' : social.reposted ? 'Reposted' : 'Repost'} <span aria-label={`${social.repostCount} reposts`}>{social.repostCount}</span></button> : <a className="liveRepostButton" href="/?auth=login" target="_blank" rel="noopener noreferrer">Sign in to repost</a>)}
    {message && <span className="liveSocialStatus" role="status">{message}</span>}
    {embedOpen && <div className="liveEmbedBackdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setEmbedOpen(false); }}>
      <section className="liveEmbedDialog" role="dialog" aria-modal="true" aria-labelledby={`live-embed-title-${shareGroup}`} ref={embedDialog}>
        <div><p className="eyebrow">Share your show</p><h3 id={`live-embed-title-${shareGroup}`}>Embed video</h3><p className="muted">The responsive player checks the show’s public visibility and provider status. No stream URL or playback token is included in this code.</p></div>
        <label>Embed code<textarea readOnly rows={5} value={embedCode} onFocus={event => event.currentTarget.select()} /></label>
        <div className="liveEmbedActions"><button type="button" onClick={() => void copy(embedCode, 'Embed code copied.')}>Copy embed code</button><a href={`/live/${encodeURIComponent(sessionId)}/embed`} target="_blank" rel="noopener noreferrer">Preview embed</a><button type="button" onClick={() => setEmbedOpen(false)}>Close</button></div>
      </section>
    </div>}
  </div>;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
