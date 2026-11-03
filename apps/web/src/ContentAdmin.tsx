import React, { useEffect, useState } from 'react';

type ContentItem = { id: string; title: string; slug: string; status: string; updatedAt: string; publishedAt?: string | null };
type MediaAsset = { id: string; originalName: string; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'CAPTION'; sizeBytes: number; scanStatus: string; scanErrorCode: string | null; uploadStatus: string; storageProvider: string };

async function contentApi<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? 'Request failed');
  return body as T;
}

function uploadToSignedPost(url: string, fields: Record<string, string>, file: File, progress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = false;
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error('Managed media storage could not be reached.'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Managed storage rejected the upload.'));
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    form.append('file', file);
    xhr.send(form);
  });
}

export function ContentAdmin() {
  const [posts, setPosts] = useState<ContentItem[]>([]);
  const [pages, setPages] = useState<ContentItem[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [kind, setKind] = useState<'posts' | 'pages'>('posts');
  const [form, setForm] = useState({ title: '', slug: '', excerpt: '' });
  const [selectedMedia, setSelectedMedia] = useState<MediaAsset | null>(null);
  const [mediaAlt, setMediaAlt] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    const [nextPosts, nextPages, nextMedia] = await Promise.all([
      contentApi<ContentItem[]>('/api/admin/content/posts'), contentApi<ContentItem[]>('/api/admin/content/pages'), contentApi<MediaAsset[]>('/api/admin/content/media')
    ]);
    setPosts(nextPosts); setPages(nextPages); setMedia(nextMedia);
  };
  useEffect(() => { load().catch(reason => setError(reason.message)); }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setMessage('');
    try {
      const body: Array<Record<string, unknown>> = [{ type: 'paragraph', text: form.excerpt || form.title }];
      if (selectedMedia?.kind === 'IMAGE') body.push({ type: 'image', mediaId: selectedMedia.id, alt: mediaAlt || selectedMedia.originalName });
      if (selectedMedia?.kind === 'VIDEO') body.push({ type: 'video', mediaId: selectedMedia.id, title: selectedMedia.originalName });
      if (selectedMedia?.kind === 'DOCUMENT') body.push({ type: 'file', mediaId: selectedMedia.id, label: selectedMedia.originalName });
      const path = kind === 'posts' ? '/api/admin/content/posts' : '/api/admin/content/pages';
      await contentApi(path, { method: 'POST', body: JSON.stringify(kind === 'posts' ? { title: form.title, slug: form.slug, excerpt: form.excerpt, body } : { title: form.title, slug: form.slug, body, pageType: 'STANDARD', navPlacement: 'NONE' }) });
      setForm({ title: '', slug: '', excerpt: '' }); setSelectedMedia(null); setMediaAlt('');
      await load(); setMessage('Draft saved. Media is only available in published content after a successful scan.');
    } catch (reason) { setError((reason as Error).message); }
  };
  const action = async (item: ContentItem, value: 'publish' | 'archive') => { setError(''); setMessage(''); try { await contentApi(`/api/admin/content/${kind}/${item.id}/action`, { method: 'POST', body: JSON.stringify({ action: value }) }); await load(); setMessage(value === 'publish' ? 'Content published.' : 'Content archived.'); } catch (reason) { setError((reason as Error).message); } };
  const upload = async (file: File) => {
    setBusy(true); setError(''); setMessage(''); setUploadProgress(0);
    try {
      const reservation = await contentApi<{ id: string; upload: { url: string; fields: Record<string, string> } }>('/api/admin/content/media/uploads', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size }) });
      await uploadToSignedPost(reservation.upload.url, reservation.upload.fields, file, setUploadProgress);
      const result = await contentApi<{ scanStatus: string; message?: string }>(`/api/admin/content/media/${encodeURIComponent(reservation.id)}/finalize`, { method: 'POST', body: '{}' });
      await load();
      setMessage(result.message ?? (result.scanStatus === 'APPROVED' ? 'File scanned and available for draft use.' : 'File remains private in quarantine until scanned.'));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); setUploadProgress(null); }
  };
  const retryScan = async (id: string) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await contentApi<{ scanStatus: string }>(`/api/admin/content/media/${encodeURIComponent(id)}/scan-retry`, { method: 'POST', body: '{}' });
      await load(); setMessage(result.scanStatus === 'APPROVED' ? 'The malware scan approved this asset.' : 'The asset remains private in quarantine.');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const items = kind === 'posts' ? posts : pages;
  const attachable = media.filter(asset => asset.uploadStatus === 'COMPLETE' && asset.scanStatus === 'APPROVED' && asset.kind !== 'CAPTION');
  return <section className="page">
    <p className="eyebrow">Content control room</p><h1>Blog and pages</h1>
    <p className="muted">Structured content only. Drafts stay private; media requires managed object storage and an actual malware scan before publication.</p>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice" role="alert">{error}</p>}
    <div className="toolbar"><button type="button" onClick={() => setKind('posts')} aria-pressed={kind === 'posts'}>Blog posts</button><button type="button" onClick={() => setKind('pages')} aria-pressed={kind === 'pages'}>Pages</button></div>
    <form onSubmit={create} className="narrow">
      <label>Title<input required value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={event => setForm({ ...form, slug: event.target.value })} /></label>
      {kind === 'posts' && <label>Excerpt<textarea value={form.excerpt} onChange={event => setForm({ ...form, excerpt: event.target.value })} /></label>}
      <label>Approved media for this draft<select value={selectedMedia?.id ?? ''} onChange={event => { const next = attachable.find(asset => asset.id === event.target.value) ?? null; setSelectedMedia(next); setMediaAlt(next?.originalName ?? ''); }}><option value="">No media</option>{attachable.map(asset => <option key={asset.id} value={asset.id}>{asset.originalName} · {asset.kind.toLowerCase()}</option>)}</select></label>
      {selectedMedia?.kind === 'IMAGE' && <label>Image description<input required maxLength={300} value={mediaAlt} onChange={event => setMediaAlt(event.target.value)} /></label>}
      <button className="primary">Save draft</button>
    </form>
    <section className="setting contentMediaPanel"><h2>Private media library</h2><p className="muted">Uploads use short-lived object-scoped authorization. Missing storage or scanner configuration keeps files unavailable or quarantined; it never marks them clean.</p>
      <label>Choose image, video, or file<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/ogg,application/pdf,text/csv,text/vtt,.docx,.xlsx,.pptx" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} /></label>
      {uploadProgress !== null && <progress max="100" value={uploadProgress} aria-label="Media upload progress" />}
      {media.length === 0 ? <div className="empty">No media uploaded yet. Configure private object storage and a ClamAV scanner before uploads can be completed.</div> : <div className="table" aria-label="Content media assets">{media.map(asset => <div className="row" key={asset.id}><span><strong>{asset.originalName}</strong><br /><small>{asset.kind} · {asset.sizeBytes.toLocaleString()} bytes · {asset.uploadStatus.toLowerCase()} · {asset.scanStatus.toLowerCase()}{asset.scanErrorCode ? ` (${asset.scanErrorCode.toLowerCase().replaceAll('_', ' ')})` : ''}</small></span>{asset.scanStatus === 'QUARANTINED' && asset.uploadStatus === 'COMPLETE' ? <button type="button" disabled={busy} onClick={() => void retryScan(asset.id)}>Retry malware scan</button> : asset.scanStatus === 'APPROVED' ? <span>Approved for draft use</span> : <span className="muted">Private; not available for publication</span>}</div>)}</div>}
    </section>
    <div className="table">{items.map(item => <div className="row" key={item.id}><span><strong>{item.title}</strong> · /{kind === 'posts' ? 'blog' : 'pages'}/{item.slug}</span><span>{item.status}</span><span><button type="button" onClick={() => void action(item, 'publish')} disabled={item.status === 'PUBLISHED'}>Publish</button><button type="button" onClick={() => void action(item, 'archive')} disabled={item.status === 'ARCHIVED'}>Archive</button></span></div>)}</div>
  </section>;
}
