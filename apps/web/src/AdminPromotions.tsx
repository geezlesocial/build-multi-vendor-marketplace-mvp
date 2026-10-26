import React, { useEffect, useMemo, useState } from 'react';
import './AdminPromotions.css';

type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'PAUSED' | 'ARCHIVED';
type Campaign = { id: string; name: string; status: CampaignStatus; placements: string[]; contentJson: Record<string, unknown>; priority: number; startsAt: string | null; endsAt: string | null; updatedAt: string };
type CampaignForm = { name: string; headline: string; body: string; ctaLabel: string; ctaPath: string; placements: string[]; priority: string; startsAt: string; endsAt: string; reason: string };

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

export function AdminPromotions() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [form, setForm] = useState<CampaignForm>(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [filter, setFilter] = useState<'ALL' | CampaignStatus>('ALL');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => { const data = await api<Campaign[]>('/api/admin/campaigns'); setCampaigns(data); };
  useEffect(() => { let active = true; void api<Campaign[]>('/api/admin/campaigns').then(data => { if (active) { setCampaigns(data); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Campaigns could not be loaded.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);

  const counts = useMemo(() => campaigns.reduce<Record<CampaignStatus, number>>((acc, campaign) => { acc[campaign.status] += 1; return acc; }, { DRAFT: 0, SCHEDULED: 0, PUBLISHED: 0, PAUSED: 0, ARCHIVED: 0 }), [campaigns]);
  const visible = filter === 'ALL' ? campaigns : campaigns.filter(campaign => campaign.status === filter);
  const updateField = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) => setForm(current => ({ ...current, [key]: value }));

  const beginEdit = (campaign: Campaign) => {
    setEditingId(campaign.id);
    setForm({ name: campaign.name, headline: contentText(campaign, 'headline'), body: contentText(campaign, 'body'), ctaLabel: contentText(campaign, 'ctaLabel'), ctaPath: contentText(campaign, 'ctaPath'), placements: campaign.placements, priority: String(campaign.priority), startsAt: toLocalInput(campaign.startsAt), endsAt: toLocalInput(campaign.endsAt), reason: '' });
    document.getElementById('promotion-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const cancelEdit = () => { setEditingId(''); setForm(emptyForm()); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.placements.length) { setError('Select at least one placement.'); return; }
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) { setError('End time must be later than start time.'); return; }
    if (form.ctaPath && (!form.ctaPath.startsWith('/') || form.ctaPath.startsWith('//') || form.ctaPath.includes('..') || form.ctaPath.includes('\\'))) { setError('CTA link must be a safe internal path, such as /shop.'); return; }
    if (form.reason.trim().length < 5) { setError('Enter an audit reason of at least 5 characters.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const payload = campaignPayload(form);
      if (editingId) await api(`/api/admin/campaigns/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api('/api/admin/campaigns', { method: 'POST', body: JSON.stringify(payload) });
      await load(); setMessage(editingId ? 'Campaign changes saved and verified.' : 'Draft campaign created and verified.'); cancelEdit();
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
    <div className="notice adminPromotionBoundary"><strong>Scope boundary:</strong> these are public content campaigns; scheduled campaigns become visible automatically at their start time. Paid ad serving, impression/click billing, and seller charge capture are not implemented. Store Buster sponsored controls remain separately gated in Store Buster &amp; email.</div>

    <form className="card cardBody adminPromotionEditor" id="promotion-editor" onSubmit={save}>
      <div><p className="eyebrow">{editingId ? 'Edit campaign' : 'Campaign setup'}</p><h3>{editingId ? 'Update campaign content' : 'Create a campaign draft'}</h3><p className="muted">Content is rendered as text by this tool; external HTML and unsafe links are rejected.</p></div>
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
      <label>Audit reason<input required minLength={5} maxLength={500} value={form.reason} onChange={event => updateField('reason', event.target.value)} placeholder="Why is this campaign being created or changed?" /></label>
      <div className="toolbar"><button className="primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save campaign changes' : 'Create draft'}</button>{editingId && <button type="button" disabled={busy} onClick={cancelEdit}>Cancel edit</button>}</div>
    </form>

    <div className="adminPromotionListHeader"><div><h3>Campaigns</h3><p className="muted">Scheduled campaigns go live automatically at their start time and stop at the end time. Archived campaigns are read-only.</p></div><label>Filter<select value={filter} onChange={event => setFilter(event.target.value as 'ALL' | CampaignStatus)}><option value="ALL">All statuses ({campaigns.length})</option>{(['PUBLISHED', 'SCHEDULED', 'DRAFT', 'PAUSED', 'ARCHIVED'] as const).map(status => <option key={status} value={status}>{status} ({counts[status]})</option>)}</select></label></div>
    {visible.length === 0 ? <div className="empty">{campaigns.length ? 'No campaigns match this status.' : 'No campaigns yet. Create a draft above to get started.'}</div> : <div className="adminPromotionList">{visible.map(campaign => <article className="card cardBody adminPromotionCard" key={campaign.id}>
      <header><div><span className={`adminPromotionStatus adminPromotionStatus-${campaign.status.toLowerCase()}`}>{campaign.status.replaceAll('_', ' ')}</span><h4>{campaign.name}</h4></div><div className="adminPromotionPriority">Priority <strong>{campaign.priority}</strong></div></header>
      {contentText(campaign, 'headline') && <strong>{contentText(campaign, 'headline')}</strong>}{contentText(campaign, 'body') && <p>{contentText(campaign, 'body')}</p>}
      <div className="adminPromotionMeta"><span>Placements: {campaign.placements.join(', ') || 'None'}</span><span>Starts: {dateLabel(campaign.startsAt)}</span><span>Ends: {dateLabel(campaign.endsAt)}</span><span>Updated: {dateLabel(campaign.updatedAt)}</span></div>
      <div className="toolbar">{campaign.status !== 'ARCHIVED' && <button type="button" disabled={busy} onClick={() => beginEdit(campaign)}>Edit content</button>}{campaign.status === 'DRAFT' && <>{campaign.startsAt && new Date(campaign.startsAt) > new Date() && <button type="button" disabled={busy} onClick={() => void transition(campaign, 'SCHEDULED')}>Schedule</button>}<button type="button" className="primary" disabled={busy} onClick={() => void transition(campaign, 'PUBLISHED')}>Publish now</button></>}{campaign.status === 'SCHEDULED' && <><button type="button" className="primary" disabled={busy} onClick={() => void transition(campaign, 'PUBLISHED')}>Publish now</button><button type="button" disabled={busy} onClick={() => void transition(campaign, 'PAUSED')}>Pause schedule</button></>}{campaign.status === 'PUBLISHED' && <button type="button" disabled={busy} onClick={() => void transition(campaign, 'PAUSED')}>Pause</button>}{campaign.status === 'PAUSED' && <button type="button" className="primary" disabled={busy} onClick={() => void transition(campaign, 'PUBLISHED')}>Resume publishing</button>}{campaign.status !== 'ARCHIVED' && <button type="button" className="danger" disabled={busy} onClick={() => void transition(campaign, 'ARCHIVED')}>Archive</button>}</div>
    </article>)}</div>}
  </section>;
}
