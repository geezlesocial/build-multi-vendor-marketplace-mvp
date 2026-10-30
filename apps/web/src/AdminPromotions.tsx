import React, { useEffect, useMemo, useRef, useState } from 'react';
import './AdminPromotions.css';

type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'PAUSED' | 'ARCHIVED';
type CampaignMedia = { id: string; kind: 'IMAGE' | 'VIDEO'; position: number; href: string | null; altText: string | null; buttonLabel: string | null; originalName: string; sizeBytes: number; scanStatus: 'QUARANTINED' | 'APPROVED' | 'REJECTED'; scanErrorCode: string | null; uploadStatus: 'PENDING' | 'VERIFYING' | 'COMPLETE' | 'FAILED'; previewUrl: string };
type Campaign = { id: string; name: string; status: CampaignStatus; placements: string[]; contentJson: Record<string, unknown>; priority: number; startsAt: string | null; endsAt: string | null; updatedAt: string; media: CampaignMedia[] };
type CampaignForm = { name: string; headline: string; body: string; ctaLabel: string; ctaPath: string; placements: string[]; priority: string; startsAt: string; endsAt: string; reason: string };
type PendingImage = { key: string; file: File; previewUrl: string; href: string; altText: string };
type PendingVideo = { key: string; file: File; previewUrl: string; href: string; buttonLabel: string };

const placements = [
  ['home', 'Marketplace home'],
  ['collection', 'Collections'],
  ['category', 'Category pages'],
  ['storefront', 'Storefronts']
] as const;
const emptyForm = (): CampaignForm => ({ name: '', headline: '', body: '', ctaLabel: '', ctaPath: '', placements: ['home'], priority: '0', startsAt: '', endsAt: '', reason: '' });

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

function toLocalInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function campaignPayload(form: CampaignForm) {
  return {
    name: form.name.trim(), placements: form.placements,
    contentJson: { headline: form.headline.trim(), body: form.body.trim(), ctaLabel: form.ctaLabel.trim(), ctaPath: form.ctaPath.trim() },
    priority: Number(form.priority), startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
    endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null, reason: form.reason.trim()
  };
}
function dateLabel(value: string | null) { return value ? new Date(value).toLocaleString() : 'No limit'; }
function contentText(campaign: Campaign, key: string) { const value = campaign.contentJson?.[key]; return typeof value === 'string' ? value : ''; }
function safeCampaignHref(value: string) {
  const href = value.trim();
  if (!href) return true;
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') && !href.includes('..')) return true;
  try { const url = new URL(href); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
function safeInternalCampaignPath(value: string) { return !value || (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.includes('..')); }
function csrfToken() { return document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1]; }

async function uploadCampaignMedia(campaignId: string, item: PendingImage | PendingVideo, reason: string) {
  const isImage = item.file.type.startsWith('image/');
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(item.file.name), 'x-file-type': item.file.type, 'x-audit-reason': encodeURIComponent(reason.trim()), 'x-destination-url': encodeURIComponent(item.href.trim()), ...(csrfToken() ? { 'x-csrf-token': csrfToken()! } : {}) };
  if (isImage) headers['x-alt-text'] = encodeURIComponent((item as PendingImage).altText.trim());
  else headers['x-button-label'] = encodeURIComponent((item as PendingVideo).buttonLabel.trim());
  const response = await fetch(`/api/admin/campaigns/${encodeURIComponent(campaignId)}/media`, { method: 'POST', credentials: 'include', headers, body: item.file });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Promotion media could not be uploaded.');
  return body as { media: CampaignMedia; message: string };
}

export function AdminPromotions() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [form, setForm] = useState<CampaignForm>(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [filter, setFilter] = useState<'ALL' | CampaignStatus>('ALL');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [savedMedia, setSavedMedia] = useState<CampaignMedia[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingVideo, setPendingVideo] = useState<PendingVideo | null>(null);
  const originalMedia = useRef<CampaignMedia[]>([]);
  const previewUrls = useRef(new Set<string>());

  useEffect(() => () => { previewUrls.current.forEach(url => URL.revokeObjectURL(url)); previewUrls.current.clear(); }, []);

  const load = async () => { const data = await api<Campaign[]>('/api/admin/campaigns'); setCampaigns(data); };
  useEffect(() => { let active = true; void api<Campaign[]>('/api/admin/campaigns').then(data => { if (active) { setCampaigns(data); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Campaigns could not be loaded.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);

  const counts = useMemo(() => campaigns.reduce<Record<CampaignStatus, number>>((acc, campaign) => { acc[campaign.status] += 1; return acc; }, { DRAFT: 0, SCHEDULED: 0, PUBLISHED: 0, PAUSED: 0, ARCHIVED: 0 }), [campaigns]);
  const visible = filter === 'ALL' ? campaigns : campaigns.filter(campaign => campaign.status === filter);
  const updateField = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) => setForm(current => ({ ...current, [key]: value }));

  const beginEdit = (campaign: Campaign) => {
    setEditingId(campaign.id);
    setSavedMedia(campaign.media ?? []); originalMedia.current = campaign.media ?? [];
    clearPendingMedia();
    setForm({ name: campaign.name, headline: contentText(campaign, 'headline'), body: contentText(campaign, 'body'), ctaLabel: contentText(campaign, 'ctaLabel'), ctaPath: contentText(campaign, 'ctaPath'), placements: campaign.placements, priority: String(campaign.priority), startsAt: toLocalInput(campaign.startsAt), endsAt: toLocalInput(campaign.endsAt), reason: '' });
    document.getElementById('promotion-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const clearPendingMedia = () => {
    setPendingImages(items => { items.forEach(item => { URL.revokeObjectURL(item.previewUrl); previewUrls.current.delete(item.previewUrl); }); return []; });
    setPendingVideo(item => { if (item) { URL.revokeObjectURL(item.previewUrl); previewUrls.current.delete(item.previewUrl); } return null; });
  };
  const cancelEdit = () => { clearPendingMedia(); setEditingId(''); setForm(emptyForm()); setSavedMedia([]); originalMedia.current = []; };

  const chooseImages = (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (savedMedia.filter(item => item.kind === 'IMAGE').length + pendingImages.length + selected.length > 6) { setError('A promotion can include up to six images. Remove an image before adding more.'); return; }
    if (selected.some(file => !file.type.startsWith('image/'))) { setError('Choose supported image files only.'); return; }
    const additions = selected.map(file => { const previewUrl = URL.createObjectURL(file); previewUrls.current.add(previewUrl); return { key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, previewUrl, href: '', altText: '' }; });
    setPendingImages(items => [...items, ...additions]); setError('');
  };
  const chooseVideo = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) { setError('Choose a supported video file.'); return; }
    if (savedMedia.some(item => item.kind === 'VIDEO')) { setError('Remove the current video before adding another.'); return; }
    if (pendingVideo) { setError('Remove the selected video before choosing another.'); return; }
    const previewUrl = URL.createObjectURL(file); previewUrls.current.add(previewUrl);
    setPendingVideo({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, previewUrl, href: '', buttonLabel: '' }); setError('');
  };
  const releasePreview = (url: string) => { URL.revokeObjectURL(url); previewUrls.current.delete(url); };
  const retryMediaScan = async (item: CampaignMedia) => {
    if (!editingId) return;
    setBusy(true); setError('');
    try {
      await api(`/api/admin/campaigns/${encodeURIComponent(editingId)}/media/${encodeURIComponent(item.id)}/scan-retry`, { method: 'POST', body: JSON.stringify({ reason: form.reason.trim() || 'Retry campaign media safety scan' }) });
      const refreshed = await api<Campaign[]>('/api/admin/campaigns');
      const current = refreshed.find(campaign => campaign.id === editingId)?.media ?? [];
      setSavedMedia(current); originalMedia.current = current; setCampaigns(refreshed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Media scan could not be retried.');
      try {
        const refreshed = await api<Campaign[]>('/api/admin/campaigns');
        const current = refreshed.find(campaign => campaign.id === editingId)?.media ?? [];
        setSavedMedia(current); originalMedia.current = current; setCampaigns(refreshed);
      } catch { /* Keep the scanner result message visible; the next page refresh can reconcile state. */ }
    }
    finally { setBusy(false); }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.placements.length) { setError('Select at least one placement.'); return; }
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) { setError('End time must be later than start time.'); return; }
    if (!safeInternalCampaignPath(form.ctaPath)) { setError('Campaign CTA must use a safe internal path, such as /shop.'); return; }
    if (savedMedia.some(item => item.kind === 'IMAGE' && !item.altText?.trim()) || pendingImages.some(item => !item.altText.trim())) { setError('Add descriptive alt text for every image.'); return; }
    if ((savedMedia.some(item => item.kind === 'VIDEO') && (!savedMedia.find(item => item.kind === 'VIDEO')?.href?.trim() || !savedMedia.find(item => item.kind === 'VIDEO')?.buttonLabel?.trim())) || (pendingVideo && (!pendingVideo.href.trim() || !pendingVideo.buttonLabel.trim()))) { setError('The video needs a button label and destination URL.'); return; }
    if ([...savedMedia.map(item => item.href ?? ''), ...pendingImages.map(item => item.href), ...(pendingVideo ? [pendingVideo.href] : [])].some(href => !safeCampaignHref(href))) { setError('Media links must be safe internal paths or HTTP(S) URLs.'); return; }
    if (form.reason.trim().length < 5) { setError('Enter an audit reason of at least 5 characters.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const payload = campaignPayload(form);
      let campaignId = editingId;
      if (campaignId) await api(`/api/admin/campaigns/${encodeURIComponent(campaignId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else {
        const created = await api<Campaign>('/api/admin/campaigns', { method: 'POST', body: JSON.stringify(payload) });
        campaignId = created.id; setEditingId(campaignId); originalMedia.current = [];
      }
      const currentIds = new Set(savedMedia.map(item => item.id));
      for (const item of savedMedia) {
        const initial = originalMedia.current.find(current => current.id === item.id);
        if (initial && (initial.href !== item.href || initial.altText !== item.altText || initial.buttonLabel !== item.buttonLabel)) {
          await api(`/api/admin/campaigns/${encodeURIComponent(campaignId)}/media/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ href: item.href, altText: item.altText, buttonLabel: item.buttonLabel, reason: form.reason.trim() }) });
          originalMedia.current = originalMedia.current.map(current => current.id === item.id ? item : current);
        }
      }
      for (const item of originalMedia.current) if (!currentIds.has(item.id)) {
        await api(`/api/admin/campaigns/${encodeURIComponent(campaignId)}/media/${encodeURIComponent(item.id)}`, { method: 'DELETE', headers: { 'x-audit-reason': encodeURIComponent(form.reason.trim()), ...(csrfToken() ? { 'x-csrf-token': csrfToken()! } : {}) } });
        originalMedia.current = originalMedia.current.filter(current => current.id !== item.id);
      }
      for (const item of [...pendingImages, ...(pendingVideo ? [pendingVideo] : [])]) {
        const uploaded = await uploadCampaignMedia(campaignId, item, form.reason);
        setSavedMedia(current => [...current, uploaded.media]);
        originalMedia.current = [...originalMedia.current, uploaded.media];
        if ('altText' in item) setPendingImages(current => current.filter(pending => pending.key !== item.key));
        else setPendingVideo(current => current?.key === item.key ? null : current);
        releasePreview(item.previewUrl);
      }
      const wasEditing = Boolean(editingId);
      await load(); setMessage(wasEditing ? 'Campaign and media changes saved. Unapproved media stays private until its scan completes.' : 'Draft campaign and media saved. Unapproved media stays private until its scan completes.'); cancelEdit();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign changes could not be saved.'); }
    finally { setBusy(false); }
  };

  const transition = async (campaign: Campaign, status: CampaignStatus) => {
    const reason = window.prompt(`Audit reason for ${status.toLowerCase()} “${campaign.name}” (at least 5 characters):`);
    if (!reason || reason.trim().length < 5) return;
    setBusy(true); setError(''); setMessage('');
    try { await api(`/api/admin/campaigns/${encodeURIComponent(campaign.id)}`, { method: 'PATCH', body: JSON.stringify({ status, reason: reason.trim() }) }); await load(); setMessage(`Campaign ${status.toLowerCase()} and verified.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign status could not be updated.'); }
    finally { setBusy(false); }
  };

  if (loading) return <section className="adminPromotions"><div className="empty" role="status">Loading promotion campaigns…</div></section>;
  return <section className="adminPromotions">
    <header className="adminPromotionsHeader"><div><p className="eyebrow">Growth operations</p><h2>Promotions &amp; ads</h2><p className="muted">Manage public marketing campaigns, their placements, and publishing windows.</p></div><button type="button" disabled={busy} onClick={() => { setLoading(true); void load().then(() => setError('')).catch(cause => setError(cause instanceof Error ? cause.message : 'Refresh failed.')).finally(() => setLoading(false)); }}>Refresh</button></header>
    {error && <p className="notice" role="alert">{error} <button type="button" onClick={() => { setLoading(true); void load().then(() => setError('')).catch(cause => setError(cause instanceof Error ? cause.message : 'Refresh failed.')).finally(() => setLoading(false)); }}>Retry</button></p>}
    {message && <p className="notice" role="status">{message}</p>}
    <div className="adminPromotionMetrics" aria-label="Campaign totals">{(['PUBLISHED', 'SCHEDULED', 'DRAFT', 'PAUSED'] as const).map(status => <article className="card cardBody" key={status}><strong>{counts[status]}</strong><span>{status.toLowerCase()} campaigns</span></article>)}</div>
    <div className="notice adminPromotionBoundary"><strong>Scope boundary:</strong> these are public content campaigns; scheduled campaigns become visible automatically at their start time. Uploaded media remains private until its safety scan is approved. Paid ad serving, impression/click billing, and seller charge capture are not implemented.</div>

    <form className="card cardBody adminPromotionEditor" id="promotion-editor" onSubmit={save}>
      <div><p className="eyebrow">{editingId ? 'Edit campaign' : 'Campaign setup'}</p><h3>{editingId ? 'Update campaign content' : 'Create a campaign draft'}</h3><p className="muted">Add up to six clickable banner images and one video with its own call-to-action. Files are checked before appearing publicly.</p></div>
      <div className="adminPromotionFields">
        <label>Internal campaign name<input required minLength={2} maxLength={160} value={form.name} onChange={event => updateField('name', event.target.value)} /></label>
        <label>Headline<input maxLength={160} value={form.headline} onChange={event => updateField('headline', event.target.value)} /></label>
        <label className="adminPromotionWide">Message<textarea maxLength={2000} rows={3} value={form.body} onChange={event => updateField('body', event.target.value)} /></label>
        <label>Button label<input maxLength={60} value={form.ctaLabel} onChange={event => updateField('ctaLabel', event.target.value)} /></label>
        <label>Internal destination<input placeholder="/shop" maxLength={300} value={form.ctaPath} onChange={event => updateField('ctaPath', event.target.value)} /></label>
        <label>Priority<input type="number" min={-1000} max={1000} value={form.priority} onChange={event => updateField('priority', event.target.value)} /></label>
        <label>Starts at (optional)<input type="datetime-local" value={form.startsAt} onChange={event => updateField('startsAt', event.target.value)} /></label>
        <label>Ends at (optional)<input type="datetime-local" value={form.endsAt} onChange={event => updateField('endsAt', event.target.value)} /></label>
      </div>
      <fieldset className="adminPromotionPlacement"><legend>Placements</legend>{placements.map(([value, label]) => <label key={value}><input type="checkbox" checked={form.placements.includes(value)} onChange={event => updateField('placements', event.target.checked ? [...form.placements, value] : form.placements.filter(item => item !== value))} />{label}</label>)}</fieldset>
      <section className="adminPromotionMedia" aria-labelledby="promotion-media-heading">
        <div className="adminPromotionMediaHeading"><div><h4 id="promotion-media-heading">Images and video</h4><p className="muted">Image banners rotate automatically on the marketplace. Video previews autoplay muted, inline, and with playback controls.</p></div><span>{savedMedia.filter(item => item.kind === 'IMAGE').length + pendingImages.length}/6 images · {savedMedia.some(item => item.kind === 'VIDEO') || pendingVideo ? 1 : 0}/1 video</span></div>
        <div className="adminPromotionMediaPickers">
          <label>Image banners<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => { chooseImages(event.currentTarget.files); event.currentTarget.value = ''; }} /><small>PNG, JPEG, WebP, or GIF · add one or more banners.</small></label>
          <label>Video banner<input type="file" accept="video/mp4,video/quicktime,video/webm,video/ogg" disabled={savedMedia.some(item => item.kind === 'VIDEO') || Boolean(pendingVideo)} onChange={event => { chooseVideo(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} /><small>One MP4, MOV, WebM, or Ogg video. Autoplay is muted for browser compatibility.</small></label>
        </div>
        {(savedMedia.length > 0 || pendingImages.length > 0 || pendingVideo) && <div className="adminPromotionMediaGrid" aria-label="Campaign media preview">
          {savedMedia.map(item => <article className="adminPromotionMediaTile" key={item.id}>
            {item.kind === 'VIDEO' ? <video src={item.previewUrl} autoPlay muted loop playsInline controls preload="metadata" aria-label="Saved campaign video preview" /> : <img src={item.previewUrl} alt={item.altText || 'Campaign banner preview'} />}
            <div className="adminPromotionMediaStatus"><strong>{item.originalName}</strong><span className={item.scanStatus === 'APPROVED' ? 'isApproved' : 'isPending'}>{item.scanStatus === 'APPROVED' ? 'Safety approved' : item.scanStatus === 'REJECTED' ? 'Rejected' : `Private · ${item.scanErrorCode ?? 'safety check pending'}`}</span></div>
            {item.kind === 'IMAGE' ? <><label>Image description (alt text)<input maxLength={300} value={item.altText ?? ''} onChange={event => setSavedMedia(items => items.map(current => current.id === item.id ? { ...current, altText: event.target.value } : current))} /></label><label>Clickable image destination (optional)<input maxLength={2000} placeholder="https://example.com or /shop" value={item.href ?? ''} onChange={event => setSavedMedia(items => items.map(current => current.id === item.id ? { ...current, href: event.target.value } : current))} /></label></> : <><label>Video button label<input maxLength={60} value={item.buttonLabel ?? ''} onChange={event => setSavedMedia(items => items.map(current => current.id === item.id ? { ...current, buttonLabel: event.target.value } : current))} /></label><label>Video button destination<input maxLength={2000} placeholder="https://example.com or /shop" value={item.href ?? ''} onChange={event => setSavedMedia(items => items.map(current => current.id === item.id ? { ...current, href: event.target.value } : current))} /></label></>}
            {item.scanStatus === 'QUARANTINED' && <button type="button" disabled={busy} onClick={() => void retryMediaScan(item)}>Retry safety scan</button>}
            <button type="button" className="danger" disabled={busy} onClick={() => setSavedMedia(items => items.filter(current => current.id !== item.id))}>Remove from campaign</button>
          </article>)}
          {pendingImages.map(item => <article className="adminPromotionMediaTile" key={item.key}><img src={item.previewUrl} alt={item.altText || 'Selected campaign banner preview'} /><div className="adminPromotionMediaStatus"><strong>{item.file.name}</strong><span>Local preview · upload on save</span></div><label>Image description (alt text)<input required maxLength={300} value={item.altText} onChange={event => setPendingImages(items => items.map(current => current.key === item.key ? { ...current, altText: event.target.value } : current))} /></label><label>Clickable image destination (optional)<input maxLength={2000} placeholder="https://example.com or /shop" value={item.href} onChange={event => setPendingImages(items => items.map(current => current.key === item.key ? { ...current, href: event.target.value } : current))} /></label><button type="button" className="danger" onClick={() => { releasePreview(item.previewUrl); setPendingImages(items => items.filter(current => current.key !== item.key)); }}>Remove image</button></article>)}
          {pendingVideo && <article className="adminPromotionMediaTile"><video src={pendingVideo.previewUrl} autoPlay muted loop playsInline controls preload="metadata" aria-label="Selected campaign video preview" /><div className="adminPromotionMediaStatus"><strong>{pendingVideo.file.name}</strong><span>Local preview · upload on save</span></div><label>Video button label<input required maxLength={60} value={pendingVideo.buttonLabel} onChange={event => setPendingVideo(current => current ? { ...current, buttonLabel: event.target.value } : current)} /></label><label>Video button destination<input required maxLength={2000} placeholder="https://example.com or /shop" value={pendingVideo.href} onChange={event => setPendingVideo(current => current ? { ...current, href: event.target.value } : current)} /></label><button type="button" className="danger" onClick={() => { releasePreview(pendingVideo.previewUrl); setPendingVideo(null); }}>Remove video</button></article>}
        </div>}
      </section>
      <label>Audit reason<input required minLength={5} maxLength={500} value={form.reason} onChange={event => updateField('reason', event.target.value)} placeholder="Why is this campaign being created or changed?" /></label>
      <div className="toolbar"><button className="primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save campaign changes' : 'Create draft'}</button>{editingId && <button type="button" disabled={busy} onClick={cancelEdit}>Cancel edit</button>}</div>
    </form>

    <div className="adminPromotionListHeader"><div><h3>Campaigns</h3><p className="muted">Scheduled campaigns go live automatically at their start time and stop at the end time. Archived campaigns are read-only.</p></div><label>Filter<select value={filter} onChange={event => setFilter(event.target.value as 'ALL' | CampaignStatus)}><option value="ALL">All statuses ({campaigns.length})</option>{(['PUBLISHED', 'SCHEDULED', 'DRAFT', 'PAUSED', 'ARCHIVED'] as const).map(status => <option key={status} value={status}>{status} ({counts[status]})</option>)}</select></label></div>
    {visible.length === 0 ? <div className="empty">{campaigns.length ? 'No campaigns match this status.' : 'No campaigns yet. Create a draft above to get started.'}</div> : <div className="adminPromotionList">{visible.map(campaign => <article className="card cardBody adminPromotionCard" key={campaign.id}>
      <header><div><span className={`adminPromotionStatus adminPromotionStatus-${campaign.status.toLowerCase()}`}>{campaign.status.replaceAll('_', ' ')}</span><h4>{campaign.name}</h4></div><div className="adminPromotionPriority">Priority <strong>{campaign.priority}</strong></div></header>
      {contentText(campaign, 'headline') && <strong>{contentText(campaign, 'headline')}</strong>}{contentText(campaign, 'body') && <p>{contentText(campaign, 'body')}</p>}
      {campaign.media?.length > 0 && <div className="adminPromotionCardMedia" aria-label="Campaign media status">{campaign.media.map(item => <span key={item.id}>{item.kind === 'IMAGE' ? 'Image' : 'Video'} · {item.scanStatus === 'APPROVED' ? 'approved' : 'private pending scan'} · {item.originalName}</span>)}</div>}
      <div className="adminPromotionMeta"><span>Placements: {campaign.placements.join(', ') || 'None'}</span><span>Starts: {dateLabel(campaign.startsAt)}</span><span>Ends: {dateLabel(campaign.endsAt)}</span><span>Updated: {dateLabel(campaign.updatedAt)}</span></div>
      <div className="toolbar">{campaign.status !== 'ARCHIVED' && <button type="button" disabled={busy} onClick={() => beginEdit(campaign)}>Edit content</button>}{campaign.status === 'DRAFT' && <>{campaign.startsAt && new Date(campaign.startsAt) > new Date() && <button type="button" disabled={busy} onClick={() => void transition(campaign, 'SCHEDULED')}>Schedule</button>}<button type="button" className="primary" disabled={busy} onClick={() => void transition(campaign, 'PUBLISHED')}>Publish now</button></>}{campaign.status === 'SCHEDULED' && <><button type="button" className="primary" disabled={busy} onClick={() => void transition(campaign, 'PUBLISHED')}>Publish now</button><button type="button" disabled={busy} onClick={() => void transition(campaign, 'PAUSED')}>Pause schedule</button></>}{campaign.status === 'PUBLISHED' && <button type="button" disabled={busy} onClick={() => void transition(campaign, 'PAUSED')}>Pause</button>}{campaign.status === 'PAUSED' && <button type="button" className="primary" disabled={busy} onClick={() => void transition(campaign, 'PUBLISHED')}>Resume publishing</button>}{campaign.status !== 'ARCHIVED' && <button type="button" className="danger" disabled={busy} onClick={() => void transition(campaign, 'ARCHIVED')}>Archive</button>}</div>
    </article>)}</div>}
  </section>;
}
