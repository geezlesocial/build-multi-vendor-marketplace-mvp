import React, { useCallback, useEffect, useRef, useState } from 'react';
import { announceHeaderActivityChange, HEADER_ACTIVITY_STORAGE_KEY } from './header-activity-events.js';
import { MessageVideoPreview } from './MessageVideoPreview.js';
import './HeaderActivity.css';

type HeaderNotification = { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };
type ReactionKind = 'LIKE' | 'LOVE' | 'HAPPY';
type HeaderAttachment = { id: string; kind: 'IMAGE' | 'VIDEO'; originalName: string; sizeBytes: number; scanStatus: 'QUARANTINED' | 'APPROVED' | 'REJECTED'; scanErrorCode: string | null; uploadStatus: string; url: string | null };
type HeaderMessage = { id: string; conversationId: string; senderId: string; senderName: string; body: string; sentAt: string; readAt: string | null; productName: string | null; conversationStatus: 'OPEN' | 'CLOSED' | 'BLOCKED'; attachments: HeaderAttachment[]; reactions: Record<ReactionKind, number>; myReaction: ReactionKind | null };
type MessageDraft = { key: string; file: File; previewUrl: string; attachmentId?: string; assetId?: string; scanStatus?: string };
type HeaderSummary = { favoriteCount: number; unreadNotificationCount: number; unreadMessageCount: number; notifications: HeaderNotification[]; messages: HeaderMessage[] };
type Popover = 'messages' | 'notifications' | null;

const emptySummary: HeaderSummary = { favoriteCount: 0, unreadNotificationCount: 0, unreadMessageCount: 0, notifications: [], messages: [] };
const messageMediaAccept = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/ogg';
const messageReactions: { kind: ReactionKind; emoji: string; label: string }[] = [
  { kind: 'LIKE', emoji: '👍', label: 'Like' },
  { kind: 'LOVE', emoji: '❤️', label: 'Love' },
  { kind: 'HAPPY', emoji: '😊', label: 'Happy' }
];

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Could not update your inbox.');
  return body as T;
}

function formatCount(count: number) { return count > 99 ? '99+' : String(count); }

function FavoriteIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.8 8.8c0 5.2-8.8 10.2-8.8 10.2S3.2 14 3.2 8.8A4.3 4.3 0 0 1 12 6.6a4.3 4.3 0 0 1 8.8 2.2Z" /></svg>;
}

function CountBadge({ count }: { count: number }) {
  return count > 0 ? <span className="headerActivityBadge" aria-hidden="true">{formatCount(count)}</span> : null;
}

export function HeaderActivity({ userId, role }: { userId: string; role: string }) {
  const [summary, setSummary] = useState<HeaderSummary>(emptySummary);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [openPopover, setOpenPopover] = useState<Popover>(null);
  const [replyMessageId, setReplyMessageId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [reactionBusyId, setReactionBusyId] = useState<string | null>(null);
  const [scanRetryBusyId, setScanRetryBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<MessageDraft[]>([]);
  const summaryRequestId = useRef(0);
  const previewUrls = useRef(new Set<string>());
  const activityRef = useRef<HTMLDivElement>(null);
  const messagesButtonRef = useRef<HTMLButtonElement>(null);
  const notificationsButtonRef = useRef<HTMLButtonElement>(null);

  const refreshSummary = useCallback(async () => {
    const requestId = ++summaryRequestId.current;
    try {
      const current = await request<HeaderSummary>('/api/member/header-summary');
      if (requestId !== summaryRequestId.current) return null;
      setSummary(current);
      setLoadError('');
      setLoaded(true);
      return current;
    } catch (error) {
      if (requestId === summaryRequestId.current) {
        setLoadError((error as Error).message || 'Inbox activity could not be loaded.');
        setLoaded(true);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active && document.visibilityState === 'visible') void refreshSummary(); };
    setSummary(emptySummary); setLoaded(false); setLoadError('');
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const refreshFromStorage = (event: StorageEvent) => { if (event.key === HEADER_ACTIVITY_STORAGE_KEY) void refresh(); };
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('storage', refreshFromStorage);
    window.addEventListener('marketplace:favorite-changed', refreshWhenVisible);
    window.addEventListener('marketplace:header-activity-changed', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      summaryRequestId.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('storage', refreshFromStorage);
      window.removeEventListener('marketplace:favorite-changed', refreshWhenVisible);
      window.removeEventListener('marketplace:header-activity-changed', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshSummary, userId]);

  useEffect(() => {
    const root = activityRef.current;
    const topbar = root?.closest<HTMLElement>('.topbar');
    if (!root || !topbar) return undefined;
    const updatePosition = () => root.style.setProperty('--header-activity-top', `${Math.ceil(topbar.getBoundingClientRect().bottom)}px`);
    updatePosition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    observer?.observe(topbar);
    window.addEventListener('resize', updatePosition);
    return () => { observer?.disconnect(); window.removeEventListener('resize', updatePosition); };
  }, [userId]);

  useEffect(() => () => { for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl); }, []);

  useEffect(() => {
    if (!openPopover) return undefined;
    const closeOutside = (event: PointerEvent) => { if (!activityRef.current?.contains(event.target as Node)) setOpenPopover(null); };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = openPopover === 'messages' ? messagesButtonRef.current : notificationsButtonRef.current;
      setOpenPopover(null);
      target?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [openPopover]);

  const markNotificationRead = async (notificationId: string) => {
    setActionError('');
    try {
      await request(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST', body: '{}' });
      await refreshSummary();
      announceHeaderActivityChange();
      return true;
    } catch (error) { setActionError((error as Error).message || 'Notification could not be marked as read.'); return false; }
  };

  const openNotification = async (notification: HeaderNotification) => {
    if (!notification.readAt && !(await markNotificationRead(notification.id))) return;
    setOpenPopover(null);
    if (notification.link?.startsWith('/')) {
      const destination = new URL(notification.link, window.location.origin);
      if (destination.origin === window.location.origin) window.location.assign(destination.toString());
    }
  };

  const toggleMessages = async () => {
    const opening = openPopover !== 'messages';
    setOpenPopover(opening ? 'messages' : null);
    setActionError('');
    if (!opening) return;
    const current = await refreshSummary();
    if (!current) return;
    const unread = current.messages.filter(message => message.senderId !== userId && !message.readAt);
    if (!unread.length) return;
    try {
      await Promise.all(unread.map(message => request(`/api/messages/${encodeURIComponent(message.id)}/read`, { method: 'POST', body: '{}' })));
      await refreshSummary();
      announceHeaderActivityChange();
    } catch (error) { setActionError((error as Error).message || 'Messages could not be marked as read.'); }
  };

  const addFiles = (files: File[]) => {
    setActionError('');
    const remaining = Math.max(0, 5 - drafts.length);
    if (!remaining) { setActionError('A message can include up to five images or videos.'); return; }
    const supported = new Set(messageMediaAccept.split(','));
    const accepted: File[] = [];
    const errors: string[] = [];
    for (const file of files) {
      if (!supported.has(file.type)) { errors.push(`${file.name} is not a supported image or video.`); continue; }
      const image = file.type.startsWith('image/');
      if (file.size > (image ? 5_000_000 : 50_000_000)) { errors.push(`${file.name} exceeds the ${image ? '5 MB image' : '50 MB video'} limit.`); continue; }
      accepted.push(file);
    }
    if (accepted.length > remaining) errors.push('Only five attachments can be added to one message.');
    const next = accepted.slice(0, remaining).map((file, index) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      return { key: `${Date.now()}-${index}-${file.name}`, file, previewUrl };
    });
    setDrafts(current => [...current, ...next]);
    if (errors.length) setActionError(errors.join(' '));
  };

  const revokeDraftPreview = (draft: MessageDraft) => {
    URL.revokeObjectURL(draft.previewUrl);
    previewUrls.current.delete(draft.previewUrl);
  };

  const removeDraft = async (message: HeaderMessage, draft: MessageDraft) => {
    setActionError('');
    try {
      if (draft.attachmentId) await request(`/api/conversations/${encodeURIComponent(message.conversationId)}/attachments/${encodeURIComponent(draft.attachmentId)}`, { method: 'DELETE' });
      revokeDraftPreview(draft);
      setDrafts(current => current.filter(item => item.key !== draft.key));
    } catch (error) { setActionError((error as Error).message || 'This attachment could not be removed.'); }
  };

  const uploadDraft = async (message: HeaderMessage, draft: MessageDraft) => {
    if (draft.attachmentId) return draft;
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    const response = await fetch(`/api/conversations/${encodeURIComponent(message.conversationId)}/attachments`, {
      method: 'POST', credentials: 'include', body: draft.file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(draft.file.name),
        'X-File-Type': draft.file.type,
        ...(csrf ? { 'x-csrf-token': csrf } : {})
      }
    });
    const result = await response.json().catch(() => ({})) as { id?: string; assetId?: string; scanStatus?: string; error?: string };
    if (!response.ok || !result.id) throw new Error(result.error ?? 'This attachment could not be uploaded.');
    return { ...draft, attachmentId: result.id, assetId: result.assetId, scanStatus: result.scanStatus };
  };

  const beginReply = async (message: HeaderMessage) => {
    if (replyBusy) return;
    if (replyMessageId === message.id) {
      setReplyBusy(true); setActionError('');
      try {
        for (const draft of drafts) {
          if (draft.attachmentId) await request(`/api/conversations/${encodeURIComponent(message.conversationId)}/attachments/${encodeURIComponent(draft.attachmentId)}`, { method: 'DELETE' });
          revokeDraftPreview(draft);
        }
        setDrafts([]); setReplyText(''); setReplyMessageId(null);
      } catch (error) { setActionError((error as Error).message || 'The unsent attachment could not be discarded. Remove it and retry.'); }
      finally { setReplyBusy(false); }
      return;
    }
    setReplyMessageId(current => current === message.id ? null : message.id);
    setReplyText(''); setActionError('');
    if (message.senderId === userId || message.readAt) return;
    try {
      await request(`/api/conversations/${encodeURIComponent(message.conversationId)}/read`, { method: 'POST', body: '{}' });
      await refreshSummary();
      announceHeaderActivityChange();
    } catch (error) { setActionError((error as Error).message || 'Message could not be marked as read.'); }
  };

  const sendReply = async (event: React.FormEvent<HTMLFormElement>, message: HeaderMessage) => {
    event.preventDefault();
    const body = replyText.trim();
    if ((!body && !drafts.length) || replyBusy) return;
    setReplyBusy(true); setActionError('');
    try {
      const uploaded: MessageDraft[] = [];
      for (const draft of drafts) {
        const result = await uploadDraft(message, draft);
        uploaded.push(result);
        setDrafts(current => current.map(item => item.key === result.key ? result : item));
      }
      const attachmentIds = uploaded.map(draft => {
        if (!draft.attachmentId) throw new Error('An attachment upload did not return a reference. Please retry.');
        return draft.attachmentId;
      });
      await request(`/api/conversations/${encodeURIComponent(message.conversationId)}/messages`, { method: 'POST', body: JSON.stringify({ body, attachmentIds }) });
      for (const draft of uploaded) revokeDraftPreview(draft);
      setDrafts([]); setReplyText(''); setReplyMessageId(null);
      await refreshSummary();
      announceHeaderActivityChange();
    } catch (error) { setActionError((error as Error).message || 'Your reply could not be sent.'); }
    finally { setReplyBusy(false); }
  };

  const reactToMessage = async (message: HeaderMessage, kind: ReactionKind) => {
    if (reactionBusyId) return;
    setReactionBusyId(message.id); setActionError('');
    try {
      const reaction = message.myReaction === kind ? null : kind;
      const updated = await request<{ reactions: Record<ReactionKind, number>; myReaction: ReactionKind | null }>(
        `/api/conversations/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}/reaction`,
        { method: 'PUT', body: JSON.stringify({ reaction }) }
      );
      setSummary(current => ({ ...current, messages: current.messages.map(item => item.id === message.id ? { ...item, ...updated } : item) }));
      announceHeaderActivityChange();
    } catch (error) { setActionError((error as Error).message || 'Reaction could not be saved.'); }
    finally { setReactionBusyId(null); }
  };

  const retryAttachmentScan = async (message: HeaderMessage, attachment: HeaderAttachment) => {
    if (scanRetryBusyId) return;
    setScanRetryBusyId(attachment.id); setActionError('');
    try {
      await request(`/api/conversations/${encodeURIComponent(message.conversationId)}/attachments/${encodeURIComponent(attachment.id)}/scan-retry`, { method: 'POST', body: '{}' });
      await refreshSummary();
      announceHeaderActivityChange();
    } catch (error) { setActionError((error as Error).message || 'The safety scan could not be retried.'); }
    finally { setScanRetryBusyId(null); }
  };

  const sellerInbox = role === 'ADMIN' || role === 'SELLER' || role === 'CASHIER';
  const messagesHref = sellerInbox ? '/dashboard?mode=seller&tab=messages' : '/dashboard?mode=buyer&tab=messages';

  return <div className="headerActivity" ref={activityRef}>
    <a className="navPill favoriteNav" href="/favorites" aria-label={summary.favoriteCount ? `Favorites, ${summary.favoriteCount} saved` : 'Favorites'}>
      <FavoriteIcon /> Favorites
      <CountBadge count={summary.favoriteCount} />
    </a>
    <div className="headerActivityTriggers">
      <button ref={messagesButtonRef} className="navPill headerActivityTrigger" type="button" aria-label={summary.unreadMessageCount ? `Messages, ${summary.unreadMessageCount} unread` : 'Messages'} aria-expanded={openPopover === 'messages'} aria-controls="header-messages-popover" onClick={() => void toggleMessages()}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5.5h16v11H9l-5 3v-14Z" /><path d="M8 9h8M8 13h5" /></svg>
        <span>Messages</span><CountBadge count={summary.unreadMessageCount} />
      </button>
      {openPopover === 'messages' && <section className="headerActivityPopover headerMessagesPopover" id="header-messages-popover" aria-label="Messages">
          <div className="headerPopoverHeading"><div><strong>Messages</strong><small>{summary.unreadMessageCount ? `${summary.unreadMessageCount} unread` : 'Your recent conversations'}</small></div><button type="button" className="headerPopoverClose" aria-label="Close messages" onClick={() => setOpenPopover(null)}>Close</button></div>
        {actionError && <p className="headerPopoverError" role="alert">{actionError}</p>}
        {!loaded && <p className="headerPopoverEmpty" role="status">Loading messages...</p>}
        {loaded && loadError && <div className="headerPopoverEmpty" role="alert">{loadError}<button type="button" onClick={() => void refreshSummary()}>Retry</button></div>}
        {loaded && !loadError && summary.messages.length === 0 && <p className="headerPopoverEmpty">No messages yet.</p>}
        {loaded && !loadError && summary.messages.length > 0 && <>
          <p className="headerPopoverHint">Showing the latest {summary.messages.length} messages. Reply here or open your inbox for the full conversation.</p>
          <div className="headerPopoverList">{summary.messages.map(message => <article className={`headerMessageItem${message.senderId !== userId && !message.readAt ? ' isUnread' : ''}`} key={message.id}>
            <div className="headerMessageMeta"><strong>{message.senderId === userId ? 'You' : message.senderName}</strong>{message.senderId !== userId && !message.readAt && <span className="headerUnreadLabel">New</span>}<time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time></div>
            {message.productName && <small className="headerMessageProduct">Re: {message.productName}</small>}
            <p>{message.body || 'Sent an attachment'}</p>
            {!!message.attachments.length && <div className="headerMessageAttachments" aria-label="Message attachments">{message.attachments.map(attachment => <div className="headerMessageAttachment" key={attachment.id}>
              {attachment.scanStatus === 'APPROVED' && attachment.uploadStatus === 'COMPLETE' && attachment.url
                ? attachment.kind === 'IMAGE'
                  ? <a href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.originalName} loading="lazy" /></a>
                  : <MessageVideoPreview src={attachment.url} label={attachment.originalName} />
                : <div className="headerAttachmentPending"><p className="headerAttachmentStatus" role="status">{attachment.scanStatus === 'REJECTED' ? 'This file did not pass the safety scan and cannot be opened.' : attachment.scanErrorCode === 'SCANNER_UNAVAILABLE' ? `${attachment.originalName} is private because the malware scanner is unavailable. It will appear here after an approved scan.` : `${attachment.originalName} is private while it is being safety-checked.`}</p>{attachment.scanStatus === 'QUARANTINED' && message.senderId === userId && <button type="button" className="headerAttachmentRetry" disabled={scanRetryBusyId === attachment.id} onClick={() => void retryAttachmentScan(message, attachment)}>{scanRetryBusyId === attachment.id ? 'Checking…' : 'Retry safety scan'}</button>}</div>}
              {attachment.scanStatus === 'APPROVED' && <small>{attachment.originalName}</small>}
            </div>)}</div>}
            <div className="headerMessageReactions" aria-label="React to message">{messageReactions.map(option => <button type="button" key={option.kind} aria-label={`${option.label}${message.reactions[option.kind] ? `, ${message.reactions[option.kind]}` : ''}`} aria-pressed={message.myReaction === option.kind} disabled={reactionBusyId === message.id} onClick={() => void reactToMessage(message, option.kind)}><span aria-hidden="true">{option.emoji}</span><span>{message.reactions[option.kind]}</span></button>)}</div>
            {message.conversationStatus === 'OPEN' ? <button type="button" className="headerReplyToggle" disabled={replyBusy || (replyMessageId !== null && replyMessageId !== message.id)} onClick={() => void beginReply(message)}>{replyMessageId === message.id ? 'Cancel reply' : 'Reply'}</button> : <span className="headerClosedConversation">Conversation closed</span>}
            {message.conversationStatus === 'OPEN' && replyMessageId === message.id && <form className="headerQuickReply" onSubmit={event => void sendReply(event, message)}>
              <label className="visuallyHidden" htmlFor={`header-reply-${message.id}`}>Reply to {message.senderName}</label>
              <textarea id={`header-reply-${message.id}`} maxLength={4000} rows={3} value={replyText} onChange={event => setReplyText(event.target.value)} placeholder="Write a reply..." disabled={replyBusy} />
              {drafts.length > 0 && <div className="headerMessageDrafts" aria-label="Files to send">{drafts.map(draft => <figure key={draft.key}>
                {draft.file.type.startsWith('image/') ? <img src={draft.previewUrl} alt={`Preview of ${draft.file.name}`} /> : <MessageVideoPreview src={draft.previewUrl} label={`Preview of ${draft.file.name}`} />}
                <figcaption>{draft.file.name}{draft.scanStatus === 'QUARANTINED' ? ' · private pending scan' : ''}</figcaption>
                <button type="button" disabled={replyBusy} aria-label={`Remove ${draft.file.name}`} onClick={() => void removeDraft(message, draft)}>Remove</button>
              </figure>)}</div>}
              <div className="headerQuickReplyActions">
                <label className="headerMessageFileButton">Add images or video<input type="file" multiple accept={messageMediaAccept} disabled={replyBusy || drafts.length >= 5} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); if (files.length) addFiles(files); event.currentTarget.value = ''; }} /></label>
                <small>Up to 5 files · images 5 MB · videos 50 MB</small>
                <button className="primary" type="submit" disabled={replyBusy || (!replyText.trim() && !drafts.length)}>{replyBusy ? 'Sending...' : 'Send reply'}</button>
              </div>
            </form>}
          </article>)}</div>
        </>}
        <a className="headerViewAll" href={messagesHref} onClick={() => setOpenPopover(null)}>View all messages</a>
      </section>}

      <button ref={notificationsButtonRef} className="navPill headerActivityTrigger" type="button" aria-label={summary.unreadNotificationCount ? `Notifications, ${summary.unreadNotificationCount} unread` : 'Notifications'} aria-expanded={openPopover === 'notifications'} aria-controls="header-notifications-popover" onClick={() => { const opening = openPopover !== 'notifications'; setOpenPopover(opening ? 'notifications' : null); setActionError(''); if (opening) void refreshSummary(); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>
        <span>Notifications</span><CountBadge count={summary.unreadNotificationCount} />
      </button>
      {openPopover === 'notifications' && <section className="headerActivityPopover headerNotificationsPopover" id="header-notifications-popover" aria-label="Notifications">
          <div className="headerPopoverHeading"><div><strong>Notifications</strong><small>{summary.unreadNotificationCount ? `${summary.unreadNotificationCount} unread` : 'Recent activity'}</small></div><button type="button" className="headerPopoverClose" aria-label="Close notifications" onClick={() => setOpenPopover(null)}>Close</button></div>
        {actionError && <p className="headerPopoverError" role="alert">{actionError}</p>}
        {!loaded && <p className="headerPopoverEmpty" role="status">Loading notifications...</p>}
        {loaded && loadError && <div className="headerPopoverEmpty" role="alert">{loadError}<button type="button" onClick={() => void refreshSummary()}>Retry</button></div>}
        {loaded && !loadError && summary.notifications.length === 0 && <p className="headerPopoverEmpty">No notifications yet.</p>}
        {loaded && !loadError && summary.notifications.length > 0 && <div className="headerPopoverList">{summary.notifications.map(notification => <button type="button" className={`headerNotificationItem${notification.readAt ? '' : ' isUnread'}`} key={notification.id} onClick={() => void openNotification(notification)}>
          <span className="headerNotificationDot" aria-hidden="true" />
          <span className="headerNotificationCopy"><strong>{notification.title}</strong><span>{notification.body}</span><time dateTime={notification.createdAt}>{new Date(notification.createdAt).toLocaleString()}</time></span>
          {!notification.readAt && <span className="headerUnreadLabel">New</span>}
        </button>)}</div>}
      </section>}
    </div>
  </div>;
}
