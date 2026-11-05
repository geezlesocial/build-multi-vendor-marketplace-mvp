import React, { useEffect, useMemo, useState } from 'react';
import { uploadToSignedPost } from './media-upload.js';

type ContentItem = { id: string; title: string; slug: string; status: string; bodyJson: { type?: string; text?: string; mediaId?: string; alt?: string }[]; excerpt?: string | null };
type Data = { store: { id: string; name: string; slug: string }; posts: ContentItem[]; pages: ContentItem[]; entitlements: { blogPostLimit: number; contentPageLimit: number; mediaStorageLimitBytes: number; scheduledPublishingEnabled: boolean; advancedContentSeoEnabled: boolean }; publicPrefix: string };
type MediaAsset = { id: string; originalName: string; kind: string; detectedMime: string; sizeBytes: number; width: number | null; height: number | null; scanStatus: string; scanErrorCode?: string | null; uploadStatus: string; createdAt: string };
type MediaLibrary = { usedBytes: number; limitBytes: number; assets: MediaAsset[] };
type Kind = 'posts' | 'pages';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

const slugFromTitle = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 150);
const draftFor = (storeId: string) => `marketlane:store-content-draft:${storeId}`;

export function SellerStoreContent() {
  const [data, setData] = useState<Data | null>(null);
  const [mediaLibrary, setMediaLibrary] = useState<MediaLibrary | null>(null);
  const [kind, setKind] = useState<Kind>('posts');
  const [editingId, setEditingId] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [body, setBody] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [localDraftState, setLocalDraftState] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [mediaAttachment, setMediaAttachment] = useState('');
  const [mediaAlt, setMediaAlt] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const load = async () => setData(await api<Data>('/api/seller/store-content'));
  const loadMedia = async () => setMediaLibrary(await api<MediaLibrary>('/api/seller/store-media'));
  useEffect(() => { void Promise.all([load(), loadMedia()]).catch(reason => setError(reason.message)); }, []);
  useEffect(() => {
    if (!data) return;
    try {
      const saved = localStorage.getItem(draftFor(data.store.id));
      if (saved) {
        const draft = JSON.parse(saved) as { kind?: Kind; title?: string; slug?: string; body?: string; mediaAttachment?: string; mediaAlt?: string };
        if (draft.kind) setKind(draft.kind);
        if (draft.title) setTitle(draft.title);
        if (draft.slug) setSlug(draft.slug);
        if (draft.body) setBody(draft.body);
        if (draft.mediaAttachment) setMediaAttachment(draft.mediaAttachment);
        if (draft.mediaAlt) setMediaAlt(draft.mediaAlt);
      }
    } catch { setLocalDraftState('Browser storage is unavailable; the editor is still usable, but local draft recovery is off.'); }
  }, [data?.store.id]);
  useEffect(() => {
    if (!data || (!title && !slug && !body)) return;
    try {
      localStorage.setItem(draftFor(data.store.id), JSON.stringify({ kind, title, slug, body, mediaAttachment, mediaAlt, savedAt: new Date().toISOString() }));
      setLocalDraftState('Working copy autosaved in this browser. Browser storage is not permanent or a backup.');
    } catch { setLocalDraftState('Browser storage is full or unavailable; save your draft to the server.'); }
  }, [data?.store.id, kind, title, slug, body, mediaAttachment, mediaAlt]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const items = useMemo(() => kind === 'posts' ? data?.posts ?? [] : data?.pages ?? [], [data, kind]);
  const startNew = () => { setEditingId(''); setTitle(''); setSlug(''); setBody(''); setMediaAttachment(''); setMediaAlt(''); setMessage(''); setError(''); };
  const edit = (item: ContentItem) => { const image = item.bodyJson?.find(block => block.type === 'image'); setEditingId(item.id); setTitle(item.title); setSlug(item.slug); setBody(item.bodyJson?.find(block => block.type === 'paragraph')?.text ?? ''); setMediaAttachment(image?.mediaId ?? ''); setMediaAlt(image?.alt ?? ''); setMessage(''); setError(''); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!data) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const payload = kind === 'posts'
        ? { title, slug, excerpt: body.slice(0, 300), body: [{ type: 'paragraph', text: body }, ...(mediaAttachment ? [{ type: 'image', mediaId: mediaAttachment, alt: mediaAlt }] : [])] }
        : { title, slug, pageType: 'STANDARD', body: [{ type: 'paragraph', text: body }, ...(mediaAttachment ? [{ type: 'image', mediaId: mediaAttachment, alt: mediaAlt }] : [])] };
      const route = `/api/seller/store-content/${kind}${editingId ? `/${encodeURIComponent(editingId)}` : ''}`;
      await api(route, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      try { localStorage.removeItem(draftFor(data.store.id)); } catch { /* Optional browser recovery only. */ }
      startNew(); await Promise.all([load(), loadMedia()]); setMessage('Draft saved to your Store. Basic publishing is included on every plan.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save content.'); }
    finally { setBusy(false); }
  };
  const publish = async (item: ContentItem) => {
    setBusy(true); setError(''); setMessage('');
    try { await api(`/api/seller/store-content/${kind}/${encodeURIComponent(item.id)}/action`, { method: 'POST', body: JSON.stringify({ action: 'publish' }) }); await load(); setMessage(`${item.title} is published.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not publish this content.'); }
    finally { setBusy(false); }
  };
  const uploadFile = async (file: File) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const reservation = await api<{ id: string; upload: { url: string; fields: Record<string, string> }; publicAfterUpload: boolean }>('/api/seller/store-media/uploads', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size }) });
      await uploadToSignedPost(reservation.upload.url, reservation.upload.fields, file, setUploadProgress);
      const finalized = await api<{ scanStatus: string; uploadStatus: string }>('/api/seller/store-media/' + encodeURIComponent(reservation.id) + '/finalize', { method: 'POST', body: '{}' });
      setMessage(finalized.scanStatus === 'APPROVED' ? 'Upload complete and scanned. It can now be selected for a draft.' : finalized.scanStatus === 'REJECTED' ? 'The scanner rejected the file. It remains private and cannot be used.' : 'Upload complete and private in quarantine while malware scanning is unavailable or pending.'); await loadMedia();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Upload failed.'); }
    finally { setBusy(false); setUploadProgress(null); }
  };
  const retryScan = async (assetId: string) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ scanStatus: string }>('/api/seller/store-media/' + encodeURIComponent(assetId) + '/scan-retry', { method: 'POST', body: '{}' });
      await loadMedia();
      setMessage(result.scanStatus === 'APPROVED' ? 'The malware scan approved this asset. It can now be added to a content draft.' : 'The asset remains private in quarantine.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The media scan could not be retried.'); }
    finally { setBusy(false); }
  };

  if (error && !data) return <section className="page"><p className="eyebrow">Store content</p><h1>Content studio</h1><p className="notice" role="alert">{error}</p></section>;
  if (!data) return <section className="page"><h1>Content studio</h1><p className="empty" role="status">Loading Store content…</p></section>;
  const used = kind === 'posts' ? data.posts.filter(item => item.status !== 'ARCHIVED').length : data.pages.filter(item => item.status !== 'ARCHIVED').length;
  const quota = kind === 'posts' ? data.entitlements.blogPostLimit : data.entitlements.contentPageLimit;

  return <section className="page sellerContentPage">
    <p className="eyebrow">{data.store.name}</p><h1>Content studio</h1>
    <p className="muted">Create and publish Store pages and blog posts. Basic publishing is included on free and paid plans; quotas and advanced options vary by plan.</p>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}{localDraftState && <p className="muted" role="status">{localDraftState}</p>}
    <div className="toolbar" role="group" aria-label="Content type"><button type="button" aria-pressed={kind === 'posts'} onClick={() => setKind('posts')}>Blog posts</button><button type="button" aria-pressed={kind === 'pages'} onClick={() => setKind('pages')}>Pages</button><span>{used} of {quota} used</span><a href="/seller/plan">View plan and upgrade options</a></div>
    <div className="grid sellerContentGrid">
      <section className="card cardBody"><h2>{editingId ? 'Edit draft' : `New ${kind === 'posts' ? 'blog post' : 'page'}`}</h2>
        {used >= quota && !editingId && <p className="notice">Limit reached. Upgrade options are available on your plan page.</p>}
        <form onSubmit={submit}>
          <label>Title<input required maxLength={160} value={title} onChange={event => { setTitle(event.target.value); if (!editingId) setSlug(slugFromTitle(event.target.value)); }} /></label>
          <label>Public URL slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={160} value={slug} onChange={event => setSlug(slugFromTitle(event.target.value))} /></label>
          <label>Content<textarea required maxLength={5000} rows={8} value={body} onChange={event => setBody(event.target.value)} /></label>
          {mediaAttachment && <div className="card cardBody"><p>Image selected for this draft</p><label>Accessible image description<input required maxLength={300} value={mediaAlt} onChange={event => setMediaAlt(event.target.value)} /></label><button type="button" onClick={() => { setMediaAttachment(''); setMediaAlt(''); }}>Remove image</button></div>}
          <p className="muted">Structured text only. Scripts and arbitrary HTML are not accepted. Draft autosave uses browser storage when available; it is not permanent.</p>
          <button className="primary" disabled={busy || (used >= quota && !editingId)}>{busy ? 'Saving…' : editingId ? 'Save draft' : 'Create draft'}</button>
          {editingId && <button type="button" disabled={busy} onClick={startNew}>Cancel edit</button>}
        </form>
      </section>
      <section className="card cardBody"><h2>Media library</h2><p>Images, video, and attachments require managed object storage and malware scanning. A completed upload remains quarantined until approved.</p><label>Choose media from device<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/ogg,application/pdf,text/csv,text/vtt,.docx,.xlsx,.pptx" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadFile(file); event.currentTarget.value = ''; }} /></label>{uploadProgress !== null && <p className="muted" role="status">Direct upload progress: {uploadProgress}%</p>}<p className="muted">Storage: {mediaLibrary?.usedBytes.toLocaleString() ?? '…'} of {mediaLibrary?.limitBytes.toLocaleString() ?? data.entitlements.mediaStorageLimitBytes.toLocaleString()} bytes in use. Browser uploads are only enabled when the deployment's managed object-storage gate is configured.</p>
        {mediaLibrary && mediaLibrary.assets.length > 0 && <div className="table" aria-label="Store media assets">{mediaLibrary.assets.map(asset => <div className="row" key={asset.id}><span><strong>{asset.originalName}</strong><br /><small>{asset.kind} · {asset.sizeBytes.toLocaleString()} bytes · {asset.scanStatus.toLowerCase()}{asset.scanErrorCode ? ` (${asset.scanErrorCode.toLowerCase().replaceAll('_', ' ')})` : ''} · {asset.uploadStatus.toLowerCase()}</small></span>{asset.kind === 'IMAGE' && asset.scanStatus === 'APPROVED' && asset.uploadStatus === 'COMPLETE' ? <button type="button" disabled={busy} onClick={() => { setMediaAttachment(asset.id); setMediaAlt(asset.originalName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')); setMessage('Approved image added to the draft.'); }}>Add approved image to draft</button> : asset.scanStatus === 'QUARANTINED' && asset.uploadStatus === 'COMPLETE' ? <button type="button" disabled={busy} onClick={() => void retryScan(asset.id)}>Retry malware scan</button> : <span className="muted">Not available for public content</span>}</div>)}</div>}
        <label>Local image preview (not uploaded)<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { if (previewUrl) URL.revokeObjectURL(previewUrl); const file = event.target.files?.[0]; setPreviewUrl(file && file.type.startsWith('image/') ? URL.createObjectURL(file) : ''); }} /></label>{previewUrl && <img className="contentLocalPreview" src={previewUrl} alt="Selected local preview" />}
      </section>
    </div>
    <section className="card cardBody"><h2>{kind === 'posts' ? 'Your posts' : 'Your pages'}</h2>{items.length === 0 ? <div className="empty">No {kind === 'posts' ? 'posts' : 'pages'} yet. Start with a draft above.</div> : <div className="table">{items.map(item => <div className="row" key={item.id}><span><strong>{item.title}</strong><br /><small>{item.status} · {item.slug}</small></span><span>{item.status === 'PUBLISHED' ? <a href={`${data.publicPrefix}/${kind === 'posts' ? 'blog' : 'pages'}/${encodeURIComponent(item.slug)}`} target="_blank" rel="noreferrer">View published</a> : <button type="button" onClick={() => edit(item)}>Edit</button>}</span>{item.status !== 'PUBLISHED' && item.status !== 'ARCHIVED' && <button type="button" disabled={busy} onClick={() => void publish(item)}>Publish</button>}</div>)}</div>}</section>
  </section>;
}
