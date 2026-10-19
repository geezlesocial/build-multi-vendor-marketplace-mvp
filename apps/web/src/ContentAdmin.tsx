import React, { useEffect, useState } from 'react';

type ContentItem = { id: string; title: string; slug: string; status: string; updatedAt: string; publishedAt?: string | null };
type ContentResponse = { error?: string; [key: string]: unknown };

async function contentApi<T extends ContentResponse | ContentItem[]>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? 'Request failed');
  return body as T;
}

export function ContentAdmin() {
  const [posts, setPosts] = useState<ContentItem[]>([]);
  const [pages, setPages] = useState<ContentItem[]>([]);
  const [kind, setKind] = useState<'posts' | 'pages'>('posts');
  const [form, setForm] = useState({ title: '', slug: '', excerpt: '' });
  const [message, setMessage] = useState('');
  const load = async () => { setPosts(await contentApi<ContentItem[]>('/api/admin/content/posts')); setPages(await contentApi<ContentItem[]>('/api/admin/content/pages')); };
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);
  const create = async (event: React.FormEvent) => { event.preventDefault(); try { const body = [{ type: 'paragraph', text: form.excerpt || form.title }]; const path = kind === 'posts' ? '/api/admin/content/posts' : '/api/admin/content/pages'; await contentApi(path, { method: 'POST', body: JSON.stringify(kind === 'posts' ? { title: form.title, slug: form.slug, excerpt: form.excerpt, body } : { title: form.title, slug: form.slug, body, pageType: 'STANDARD', navPlacement: 'NONE' }) }); setForm({ title: '', slug: '', excerpt: '' }); await load(); setMessage('Draft saved. An administrator must review and publish it.'); } catch (error) { setMessage((error as Error).message); } };
  const action = async (item: ContentItem, value: 'publish' | 'archive') => { try { await contentApi(`/api/admin/content/${kind}/${item.id}/action`, { method: 'POST', body: JSON.stringify({ action: value }) }); await load(); } catch (error) { setMessage((error as Error).message); } };
  const items = kind === 'posts' ? posts : pages;
  return <section className="page"><p className="eyebrow">Content control room</p><h1>Blog and pages</h1><p className="muted">Structured content only. Drafts stay private; publishing and media release remain server-authorized.</p>{message && <p className="notice" role="status">{message}</p>}<div className="toolbar"><button onClick={() => setKind('posts')} aria-pressed={kind === 'posts'}>Blog posts</button><button onClick={() => setKind('pages')} aria-pressed={kind === 'pages'}>Pages</button></div><form onSubmit={create} className="narrow"><label>Title<input required value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label><label>Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={event => setForm({ ...form, slug: event.target.value })} /></label>{kind === 'posts' && <label>Excerpt<textarea value={form.excerpt} onChange={event => setForm({ ...form, excerpt: event.target.value })} /></label>}<button className="primary">Save draft</button></form><div className="table">{items.map(item => <div className="row" key={item.id}><span><strong>{item.title}</strong> · /{kind === 'posts' ? 'blog' : 'pages'}/{item.slug}</span><span>{item.status}</span><span><button onClick={() => action(item, 'publish')} disabled={item.status === 'PUBLISHED'}>Publish</button><button onClick={() => action(item, 'archive')} disabled={item.status === 'ARCHIVED'}>Archive</button></span></div>)}</div></section>;
}
